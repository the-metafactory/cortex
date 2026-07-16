/**
 * C-1349 — the SHARED guarded config-write for `policy.federated.networks[]`.
 *
 * Slice 1 (#1460) added the offer.ts write-guard pattern to the JOIN adapter so
 * a member installing a sealed payload key K never corrupts its stack config.
 * Slice 2 (`rotate-key`) needs the IDENTICAL guard on the HUB side to advance the
 * network's `payload_key` + `payload_key_id` after a rotation. Rather than
 * re-implement it (and risk the two drifting), the guard core lives HERE and both
 * `network-adapters.ts` (join) and `network-secret-adapters.ts` (rotate-key key
 * store) call it. The one thing NOT in the core is join's `assertDaemonLoadsConfig`
 * pre-check — that stays in the join adapter (rotate-key is the hub admin editing
 * their OWN stack config and restarts the daemon themselves).
 *
 * The guard: VALIDATE-before-write (payload_key must base64-decode to 32 bytes,
 * the SAME refine the daemon enforces at boot) → timestamped backup → atomic
 * write (temp+rename) → re-parse verify the networks round-trip → restore the
 * original (or remove a freshly-created file) on any mismatch → chmod 600 when a
 * key is present (K is a secret at rest). K's VALUE is NEVER echoed into any error
 * or comparison — only entry ids + the field name + payload-key PRESENCE.
 */

import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "fs";
import { dirname } from "path";
import { parse as parseYaml, parseDocument } from "yaml";
import { validateConfigLoads } from "../../../common/config/validate-on-write";
import {
  PolicyFederatedNetworkSchema,
  type PolicyFederatedNetwork,
} from "../../../common/types/cortex-config";

/** Read `policy.federated.networks[]` from a stack config file (raw parse). */
export function readNetworksFromConfig(path: string): PolicyFederatedNetwork[] {
  if (!existsSync(path)) return [];
  const raw = parseYaml(readFileSync(path, "utf-8")) as
    | { policy?: { federated?: { networks?: PolicyFederatedNetwork[] } } }
    | null;
  return raw?.policy?.federated?.networks ?? [];
}

/**
 * POSIX-atomic write (temp + same-dir rename → old-or-new, never partial).
 *
 * `mode`, when given, is applied to the temp file (umask-proof re-chmod) BEFORE
 * the rename, so the live file's permissions are preserved across the write. FS-7
 * (cortex#1839) needs this: a monolith `cortex.yaml` is chmod-600-gated by the
 * loader, and the post-write whole-config validation re-reads it through the
 * loader — a non-atomic write that dropped the mode to the umask default (0644)
 * would trip that gate and spuriously fail validation.
 */
function atomicWriteFileSync(path: string, contents: string, mode?: number): void {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, contents, mode !== undefined ? { encoding: "utf-8", mode } : "utf-8");
  if (mode !== undefined) chmodSync(tmpPath, mode); // create mode is umask-masked; re-chmod.
  renameSync(tmpPath, path);
}

/** Timestamped suffix for the pre-write config backup (offer.ts write-guard). */
function backupStamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "T",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

/**
 * Guarded in-place write of `policy.federated.networks[]` into `path`. Preserves
 * comments (`parseDocument` + `setIn`, so the header/inline comments incl.
 * `# DO NOT EDIT BY HAND` survive) and is safe against partial/corrupt writes.
 *
 * `backupLabel` names the backup suffix (`.pre-<label>-<stamp>.bak`) so a
 * join-backup and a rotate-key-backup are distinguishable in the config dir.
 *
 * Throws (with the original restored / a fresh file removed) on a malformed
 * payload_key or a failed round-trip verify; the caller's orchestrator try/catch
 * converts that into a clean `{ ok: false }` abort BEFORE any half-written state.
 */
export function writeNetworksGuarded(
  path: string,
  networks: readonly PolicyFederatedNetwork[],
  opts: { backupLabel?: string; validateComposePath?: string } = {},
): void {
  const backupLabel = opts.backupLabel ?? "write";

  // (1) VALIDATE-before-write, SCOPED to the payload key K (never the whole entry
  // — that would newly reject hand-pinned peer shapes this writer has always
  // tolerated). A `payload_key` MUST base64-decode to exactly 32 bytes — the SAME
  // refine the daemon enforces at boot; a malformed K (that would boot into
  // cleartext-with-warning, ADR-0019 §5) aborts BEFORE any fs mutation. The entry
  // (which carries K) is never echoed — only its id + the field name.
  for (const n of networks) {
    if (n.payload_key === undefined) continue;
    const check = PolicyFederatedNetworkSchema.shape.payload_key.safeParse(n.payload_key);
    if (!check.success) {
      throw new Error(
        `refusing to write policy.federated.networks — entry "${n.id}" has an invalid payload_key (schema validation failed: must be base64 decoding to exactly 32 bytes)`,
      );
    }
  }

  const existed = existsSync(path);
  const originalText = existed ? readFileSync(path, "utf-8") : undefined;
  // FS-7 (cortex#1839) — preserve the live file's mode across the atomic write so
  // the post-write whole-config validation (which re-reads through the loader's
  // chmod-600 gate on a monolith cortex.yaml) sees the same permissions.
  const originalMode = existed ? statSync(path).mode & 0o777 : undefined;
  // FS-7 — only ENFORCE the whole-config check when the config was ALREADY
  // loadable BEFORE this write. The invariant this writer guarantees is "a write
  // must not BREAK a working config"; it is not this writer's job to fix a config
  // that was already unloadable. In production the daemon loaded the config (so it
  // IS loadable → the check runs); a partial/stub config or an already-broken one
  // is skipped rather than have the write blamed for a pre-existing fault.
  const enforceWholeConfig =
    opts.validateComposePath !== undefined && validateConfigLoads(opts.validateComposePath).ok;
  const doc = parseDocument(originalText ?? "");
  doc.setIn(["policy", "federated", "networks"], networks);
  const nextText = doc.toString();
  mkdirSync(dirname(path), { recursive: true });

  // (2) Timestamped backup (only when a file existed — a fresh file is removed on
  // failure instead). The backup carries the file's CURRENT content — which, when
  // a network entry already carries a payload_key from an earlier write, means the
  // backup carries that secret too. Written at the file's own mode from creation
  // (and re-chmodded, umask-proof) so a secret-bearing config never produces a
  // world-readable backup — `originalMode` is always defined here (`existed` guards
  // this branch, and `originalMode` is only ever `undefined` when `!existed`).
  let backupPath: string | undefined;
  if (existed && originalText !== undefined && originalMode !== undefined) {
    backupPath = `${path}.pre-${backupLabel}-${backupStamp()}.bak`;
    writeFileSync(backupPath, originalText, { encoding: "utf-8", mode: originalMode });
    chmodSync(backupPath, originalMode);
  }

  // (3) Atomic write, then (4) re-parse verify the networks round-trip. Any parse
  // failure / mismatch means the write corrupted the file → RESTORE the original
  // (or remove a freshly-created file) and rethrow.
  try {
    atomicWriteFileSync(path, nextText, originalMode);
    const reparsed = parseYaml(readFileSync(path, "utf-8")) as
      | { policy?: { federated?: { networks?: PolicyFederatedNetwork[] } } }
      | null;
    const readBack = reparsed?.policy?.federated?.networks ?? [];
    // Project each entry to id + encryption mode + payload-key PRESENCE (never K's
    // VALUE into a comparison that could reach an error path) + kid, then compare
    // the ordered projections. Length-sensitive; no index access.
    const project = (list: readonly PolicyFederatedNetwork[]): string =>
      JSON.stringify(
        list.map((n) => [
          n.id,
          n.encryption ?? null,
          n.payload_key !== undefined,
          n.payload_key_id ?? null,
        ]),
      );
    if (project(readBack) !== project(networks)) {
      throw new Error("policy.federated.networks did not round-trip after write");
    }
    // FS-7 (cortex#1839) — VALIDATE THE COMPOSED WHOLE. The payload_key + round-trip
    // checks above are SCOPED to the networks array; a write can still compose to a
    // config the daemon rejects at boot (e.g. an `accept_subjects` ADR-0001 scope
    // violation — a `policy.federated.networks` field!). When the caller threads the
    // config-split pointer AND the config was loadable before this write, run the
    // daemon's OWN boot validator over the composed whole; a throw here trips the
    // same restore-and-rethrow path as a bad round-trip.
    if (enforceWholeConfig && opts.validateComposePath !== undefined) {
      const validation = validateConfigLoads(opts.validateComposePath);
      if (!validation.ok) {
        throw new Error(
          `composed config failed boot validation:\n  ${validation.errors.join("\n  ")}`,
        );
      }
    }
  } catch (err) {
    if (originalText !== undefined) atomicWriteFileSync(path, originalText, originalMode);
    else rmSync(path, { force: true });
    throw new Error(
      `config write verification failed for ${path} — restored original${backupPath ? ` (backup ${backupPath})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // (5) K is a secret at rest — clamp the file to 0600 when any network carries a
  // payload key (mirrors the leaf-include 0600 floor; the create umask can
  // otherwise leave it group/world-readable).
  if (networks.some((n) => n.payload_key !== undefined)) {
    chmodSync(path, 0o600);
  }
}
