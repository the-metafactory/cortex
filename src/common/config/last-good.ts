/**
 * FS-7 / D-3 (cortex#1839, epic #1818 Wave 0) — last-known-good config snapshot.
 *
 * Design §3 D-3 (RATIFIED #1819): *"At boot, a broken config falls back to
 * last-known-good — never a keepalive crash-loop."* On every SUCCESSFUL boot the
 * daemon persists a snapshot of the config it just loaded; on a subsequent boot
 * where `loadConfigWithAgents` throws, the boot path loads this snapshot and
 * boots DEGRADED instead of crash-looping (see `src/cortex.ts` boot + the
 * degraded-state marker in `degraded-state.ts`).
 *
 * WHAT is snapshotted: the COMPOSED RAW config object (`composeRawConfig` — the
 * deep-merged config-split layers, or the verbatim single-file cortex.yaml),
 * serialized back to YAML. Reloading the snapshot via `loadConfigWithAgents`
 * re-runs the FULL validate + env-placeholder resolution on it, so the fallback
 * boots through the identical path a normal boot uses — just against the
 * last-good bytes. `__ENV__` surface-token placeholders stay UNRESOLVED in the
 * snapshot (resolution happens inside the loader), so no live secret is written
 * to the snapshot for config-split stacks; a legacy single-file cortex.yaml that
 * carries inline tokens is copied verbatim, which is why the snapshot is 0600.
 *
 * Known limitation (acceptable for a degraded fallback): a config-split stack's
 * `networks/` fragment directory is resolved relative to the config dir, so a
 * single-file snapshot in `.last-good/` does not carry those fragments. Inline
 * `policy.federated.networks[]` (what `cortex network join` writes) IS in the
 * composed raw and survives; the legacy G-500 `networks/*.yaml` mechanism does
 * not. Degraded mode trades that fidelity for staying up.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { stringify as stringifyYaml } from "yaml";

import { composeRawConfig, expandTilde } from "./loader";

/** The `.last-good/` directory beside the config pointer. */
export function lastGoodDir(pointerPath: string): string {
  return join(dirname(expandTilde(pointerPath)), ".last-good");
}

/**
 * Well-known snapshot path for a pointer: `<config-dir>/.last-good/<basename>.snapshot`.
 * Keyed by the pointer BASENAME (without `.yaml`/`.yml`) so per-stack pointers in
 * a shared config dir get distinct snapshots — the same per-stack identity the
 * PID file derives from the pointer basename.
 */
export function lastGoodSnapshotPath(pointerPath: string): string {
  const base = basename(expandTilde(pointerPath)).replace(/\.ya?ml$/i, "");
  return join(lastGoodDir(pointerPath), `${base.length > 0 ? base : "config"}.snapshot`);
}

/** Return the snapshot path if one exists for this pointer, else `null`. */
export function readLastGoodSnapshotPath(pointerPath: string): string | null {
  const snapshotPath = lastGoodSnapshotPath(pointerPath);
  return existsSync(snapshotPath) ? snapshotPath : null;
}

/** Outcome of a snapshot write — success carries the path; failure the reason. */
export type SnapshotResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Persist the composed raw config at `pointerPath` as a 0600 YAML snapshot in
 * `<config-dir>/.last-good/`. Called on every SUCCESSFUL boot.
 *
 * NEVER throws — a snapshot-write failure must not turn a good boot into a
 * failed one (the snapshot is a recovery convenience, not a boot dependency).
 * The failure is returned so the boot path can log it; the daemon boots normally
 * regardless.
 */
export function writeLastGoodSnapshot(pointerPath: string): SnapshotResult {
  try {
    const raw = composeRawConfig(expandTilde(pointerPath));
    const yaml = stringifyYaml(raw, { indent: 2, lineWidth: 0 });
    const dir = lastGoodDir(pointerPath);
    mkdirSync(dir, { recursive: true });
    const snapshotPath = lastGoodSnapshotPath(pointerPath);
    // 0600: a legacy single-file cortex.yaml carries inline platform tokens, so
    // its verbatim snapshot is a secret-at-rest. The create `mode` is masked by
    // the umask, so re-chmod explicitly (mirrors the cortex.yaml chmod-600 floor).
    writeFileSync(snapshotPath, yaml, { encoding: "utf-8", mode: 0o600 });
    chmodSync(snapshotPath, 0o600);
    return { ok: true, path: snapshotPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
