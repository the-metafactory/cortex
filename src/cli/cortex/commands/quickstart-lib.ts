/**
 * `cortex quickstart` — pure logic + guarded config-write (cortex#2094, L3).
 *
 * Collapses the validated Debian runbook (README-AGENTS.md Appendix A + §5,
 * merged PR#2090) into ONE idempotent command driven by the DD-L5 env
 * contract (arc `design/linux-host-support.md`, arc#309). This module holds
 * everything that does NOT need an injected port (`quickstart-ports.ts`):
 *
 *   - the `CTX_*` env-contract validation matrix (§2 of the issue)
 *   - the Appendix-A `.conf` renderer (§4/A.1)
 *   - the guarded, comment-preserving YAML patch for the three formerly-manual
 *     edits (§5): `surfaces/surfaces.yaml`, `stacks/<slug>.yaml`,
 *     `system/system.yaml`
 *   - the §5 healthy-boot gate line-matcher
 *
 * Config-file I/O here is real `fs` (mirrors `stack.ts` / `network-config-
 * write.ts` — config reads/writes are NOT behind an injected port in this
 * codebase; only external processes/network calls are, via
 * `quickstart-ports.ts`). Tests point every path at a tmp dir.
 *
 * The YAML patcher follows `network-config-write.ts`'s `writeNetworksGuarded`
 * pattern verbatim: `parseDocument` + `setIn` (comments survive — proven
 * against the REAL scaffold output cortex#2094 verification, not assumed),
 * a timestamped backup, an atomic temp+rename write, and a re-parse
 * round-trip check that restores the original on any mismatch. New here:
 * a NO-OP short-circuit when the desired value is already in place — the
 * `yaml` library's `parseDocument().toString()` is not perfectly
 * byte-identical to hand-written source on the FIRST parse (it normalizes
 * some comment spacing), but it IS a stable fixed point after that first
 * pass — so re-running quickstart against an already-patched file reads,
 * re-serializes, and compares BYTE-IDENTICAL, and the write is skipped
 * entirely. That is what makes "second run: zero file mutations"
 * (cortex#2094 acceptance criteria) hold.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { parseDocument } from "yaml";

import { validateConfigLoads } from "../../../common/config/validate-on-write";

// =============================================================================
// Env contract (DD-L5)
// =============================================================================

/** Every non-secret `CTX_*` key quickstart requires. */
export const CTX_REQUIRED_KEYS = [
  "CTX_PRINCIPAL",
  "CTX_SLUG",
  "CTX_NATS_PORT",
  "CTX_NATS_MON",
  "CTX_GUILD_ID",
  "CTX_CHANNEL_ID",
  "CTX_LOG_CHANNEL_ID",
  "CTX_MY_DISCORD_ID",
] as const;
export type CtxRequiredKey = (typeof CTX_REQUIRED_KEYS)[number];

/**
 * The two secret env vars. NEVER echoed — every table/report built from
 * {@link validateEnvContract} carries only `"set" | "missing"` for these,
 * never the value (cortex#2094 acceptance criteria: "Secret values never
 * appear in stdout, stderr, or logs").
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` is optional even when present in the schema
 * below — "optional on native hosts where `claude` login exists" (the issue
 * body): quickstart's step 1 preflight already confirms `claude` is
 * authenticated via its OWN credential store, so this var is only load-
 * bearing for a headless/container host with no interactive login. It is
 * validated for SHAPE (non-empty when present) but never REQUIRED.
 */
export const CTX_SECRET_KEYS = ["CTX_DISCORD_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
export type CtxSecretKey = (typeof CTX_SECRET_KEYS)[number];

/**
 * The surface a quickstart run provisions (cortex#2153, epic #2164). Explicit —
 * chosen by `--surface <discord|web>`, NEVER auto-detected from which `CTX_*`
 * keys happen to be present (an explicit flag is greppable + testable; the
 * planner decision in #2164). `discord` (the default) is byte-identical to the
 * pre-#2153 behaviour.
 */
export type Surface = "discord" | "web";

/**
 * The web/gateway surface's non-secret env contract (cortex#2153). Reuses the
 * SHARED identity/transport keys (`CTX_PRINCIPAL`, `CTX_SLUG`, `CTX_NATS_PORT`,
 * `CTX_NATS_MON` — the genuinely-useful NATS-identity + stack-scaffold parts
 * quickstart keeps across surfaces) and swaps the four Discord snowflakes for
 * the web binding's host/port. NO Discord snowflake is required.
 */
export const CTX_WEB_REQUIRED_KEYS = [
  "CTX_PRINCIPAL",
  "CTX_SLUG",
  "CTX_NATS_PORT",
  "CTX_NATS_MON",
  "CTX_WEB_HOST",
  "CTX_WEB_PORT",
] as const;
export type CtxWebRequiredKey = (typeof CTX_WEB_REQUIRED_KEYS)[number];

/**
 * The web surface's secret env vars. `CTX_WEB_TOKEN` is the web analogue of
 * `CTX_DISCORD_TOKEN` — it GATES success (a web scaffold that "succeeded" with
 * no token would bind an unauthenticated surface) and is validated
 * PRESENCE-ONLY, never echoed. `CLAUDE_CODE_OAUTH_TOKEN` stays optional, same
 * as the Discord contract.
 */
export const CTX_WEB_SECRET_KEYS = ["CTX_WEB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
export type CtxWebSecretKey = (typeof CTX_WEB_SECRET_KEYS)[number];

// Mirrors stack.ts's SLUG_RE / PRINCIPAL_ID_RE (the `cortex stack create`
// grammar) — not exported from that module, so duplicated here rather than
// widen stack.ts's surface for a one-line regex. Keep in sync if that
// grammar ever changes.
const SLUG_RE = /^[a-z][a-z0-9_-]*$/;
const PRINCIPAL_ID_RE = /^[a-z][a-z0-9-]*$/;
/** Discord snowflakes are unsigned 64-bit integers rendered as decimal
 *  strings — too large for `Number` to round-trip safely, so validated as a
 *  digit-string, never parsed to a JS number. */
const SNOWFLAKE_RE = /^[0-9]{1,20}$/;
const PORT_RE = /^[0-9]{1,5}$/;
/** A web bind host — an IP or hostname (letters, digits, dots, hyphens). Kept
 *  deliberately permissive (`127.0.0.1`, `0.0.0.0`, `localhost`, a DNS name);
 *  rejects whitespace, slashes, and scheme prefixes. */
const HOST_RE = /^[a-zA-Z0-9.-]+$/;

/** One required key's validation verdict. `key` is a plain string so the same
 *  shape serves both the Discord and web ({@link CtxWebRequiredKey}) contracts. */
export interface CtxKeyCheck {
  key: string;
  /** `undefined` when missing entirely (distinct from present-but-invalid). */
  value?: string;
  ok: boolean;
  /** Present only when `!ok` — the shape rule that failed. */
  reason?: string;
}

/** One secret key's presence verdict — value NEVER carried here. */
export interface CtxSecretCheck {
  key: string;
  status: "set" | "missing";
  /** `true` when this secret GATES `ok` (the surface's primary token —
   *  `CTX_DISCORD_TOKEN` for discord, `CTX_WEB_TOKEN` for web). A missing
   *  gating secret renders as a hard ✗; a missing non-gating one (the optional
   *  `CLAUDE_CODE_OAUTH_TOKEN`) as a soft ○. */
  gates: boolean;
}

export interface EnvValidationResult<K extends string = CtxRequiredKey> {
  ok: boolean;
  checks: CtxKeyCheck[];
  secrets: CtxSecretCheck[];
  /** Convenience: the typed values, only present when `ok`. Callers still
   *  must not log `secrets` values — this map never carries the secret keys. */
  values?: Record<K, string>;
}

/**
 * Validate the full `CTX_*` env contract against `env` (normally
 * `process.env`). Never throws. `ok === false` ⇒ caller exits 2 with a table
 * of what's missing/invalid (cortex#2094 §2 + acceptance criteria).
 */
export function validateEnvContract(env: NodeJS.ProcessEnv): EnvValidationResult {
  const checks: CtxKeyCheck[] = CTX_REQUIRED_KEYS.map((key) => {
    const raw = env[key];
    if (raw === undefined || raw.length === 0) {
      return { key, ok: false, reason: "missing" };
    }
    const shape = shapeCheck(key, raw);
    return shape.ok
      ? { key, value: raw, ok: true }
      : { key, value: raw, ok: false, reason: shape.reason };
  });

  const secrets: CtxSecretCheck[] = CTX_SECRET_KEYS.map((key) => ({
    key,
    status: env[key] !== undefined && env[key].length > 0 ? "set" : "missing",
    gates: key === "CTX_DISCORD_TOKEN",
  }));

  // CTX_DISCORD_TOKEN gates `ok` (§5 needs a real token to patch into
  // surfaces.yaml — a quickstart run that "succeeds" with a placeholder
  // token would leave the daemon unable to connect) even though it is
  // validated PRESENCE-ONLY here and never enters `checks`/`values` — it
  // must never carry a value into anything that gets echoed or table-
  // rendered. CLAUDE_CODE_OAUTH_TOKEN does NOT gate `ok` — it is optional on
  // a native host with an existing `claude` login (step 1 already confirmed
  // that); only a headless/container consumer needs it.
  const discordTokenSet = secrets.some((s) => s.key === "CTX_DISCORD_TOKEN" && s.status === "set");
  const ok = checks.every((c) => c.ok) && discordTokenSet;
  // `c.value` is always set when `c.ok` (validateEnvContract's own
  // construction above never emits `ok: true` without `value`) — TS can't
  // narrow that across the `.map`, so fall back to "" rather than an
  // assertion (`as`/`!` are both banned here); the fallback is unreachable
  // in practice since this whole branch is gated on `checks.every(ok)`.
  const values = checks.every((c) => c.ok)
    ? (Object.fromEntries(checks.map((c) => [c.key, c.value ?? ""])) as Record<CtxRequiredKey, string>)
    : undefined;

  return values !== undefined ? { ok, checks, secrets, values } : { ok, checks, secrets };
}

/**
 * Validate the web/gateway surface's `CTX_*` env contract (cortex#2153). The
 * web analogue of {@link validateEnvContract}: same never-throw / `ok`-gating
 * contract, but keyed on {@link CTX_WEB_REQUIRED_KEYS} (host/port instead of
 * the Discord snowflakes) with {@link CTX_WEB_SECRET_KEYS} (`CTX_WEB_TOKEN`
 * gates). NO Discord snowflake is required or consulted — a web deployment
 * never feeds placeholder snowflakes.
 */
export function validateWebEnvContract(
  env: NodeJS.ProcessEnv,
): EnvValidationResult<CtxWebRequiredKey> {
  const checks: CtxKeyCheck[] = CTX_WEB_REQUIRED_KEYS.map((key) => {
    const raw = env[key];
    if (raw === undefined || raw.length === 0) {
      return { key, ok: false, reason: "missing" };
    }
    const shape = shapeCheck(key, raw);
    return shape.ok
      ? { key, value: raw, ok: true }
      : { key, value: raw, ok: false, reason: shape.reason };
  });

  const secrets: CtxSecretCheck[] = CTX_WEB_SECRET_KEYS.map((key) => ({
    key,
    status: env[key] !== undefined && env[key].length > 0 ? "set" : "missing",
    gates: key === "CTX_WEB_TOKEN",
  }));

  // CTX_WEB_TOKEN gates `ok` (the web binding needs a real auth secret — a run
  // that "succeeded" with a placeholder token would bind an unauthenticated
  // surface), same PRESENCE-ONLY / never-echoed discipline CTX_DISCORD_TOKEN
  // gets. CLAUDE_CODE_OAUTH_TOKEN stays optional.
  const webTokenSet = secrets.some((s) => s.gates && s.status === "set");
  const ok = checks.every((c) => c.ok) && webTokenSet;
  const values = checks.every((c) => c.ok)
    ? (Object.fromEntries(checks.map((c) => [c.key, c.value ?? ""])) as Record<CtxWebRequiredKey, string>)
    : undefined;

  return values !== undefined ? { ok, checks, secrets, values } : { ok, checks, secrets };
}

/** Per-key shape rule. Extracted from {@link validateEnvContract} so the
 *  matrix is independently testable per key. Serves both the Discord and web
 *  contracts (hence the `string` key + `default`); every caller only ever
 *  passes a key from its own required-key list. */
function shapeCheck(key: string, value: string): { ok: boolean; reason?: string } {
  switch (key) {
    case "CTX_PRINCIPAL":
      return PRINCIPAL_ID_RE.test(value)
        ? { ok: true }
        : { ok: false, reason: "must be lowercase alphanumeric + hyphen, letter-prefixed" };
    case "CTX_SLUG":
      return SLUG_RE.test(value)
        ? { ok: true }
        : { ok: false, reason: "must be lowercase alphanumeric + hyphen/underscore, letter-prefixed" };
    case "CTX_NATS_PORT":
    case "CTX_NATS_MON":
    case "CTX_WEB_PORT":
      return PORT_RE.test(value) && Number(value) > 0 && Number(value) <= 65535
        ? { ok: true }
        : { ok: false, reason: "must be a numeric port (1-65535)" };
    case "CTX_GUILD_ID":
    case "CTX_CHANNEL_ID":
    case "CTX_LOG_CHANNEL_ID":
    case "CTX_MY_DISCORD_ID":
      return SNOWFLAKE_RE.test(value)
        ? { ok: true }
        : { ok: false, reason: "must be a numeric Discord snowflake" };
    case "CTX_WEB_HOST":
      return HOST_RE.test(value)
        ? { ok: true }
        : { ok: false, reason: "must be a hostname or IP (letters, digits, dots, hyphens)" };
    default:
      // Unreachable: every caller maps its own required-key list. A present,
      // non-empty value with no specific rule passes (shape unknown → accept).
      return { ok: true };
  }
}

/** Render the validation result as a human-readable ✓/✗ table. Never prints
 *  a secret VALUE — only `set`/`missing` for the two secret keys. Takes the
 *  structural subset both {@link validateEnvContract} and
 *  {@link validateWebEnvContract} share (checks + secrets), so it renders
 *  either surface's contract. */
export function renderEnvTable(result: { checks: CtxKeyCheck[]; secrets: CtxSecretCheck[] }): string {
  const lines: string[] = ["env contract (CTX_*):"];
  for (const c of result.checks) {
    const mark = c.ok ? "✓" : "✗";
    const detail = c.ok ? (c.value ?? "") : (c.reason ?? "missing");
    lines.push(`  ${mark} ${c.key}: ${detail}`);
  }
  for (const s of result.secrets) {
    // The surface's gating token (CTX_DISCORD_TOKEN / CTX_WEB_TOKEN) — missing
    // is a hard ✗, matching the required checks above. CLAUDE_CODE_OAUTH_TOKEN
    // is always optional — missing is a soft ○, never a failure mark.
    const mark = s.status === "set" ? "✓" : s.gates ? "✗" : "○";
    lines.push(`  ${mark} ${s.key}: ${s.status}`);
  }
  return lines.join("\n");
}

// =============================================================================
// nats conf (§4 / A.1 shape)
// =============================================================================

export interface NatsConfInputs {
  slug: string;
  principal: string;
  port: string;
  monitorPort: string;
  /** `~/.config/nats` by default — overridable for `--nats-dir` / tests. */
  natsDir: string;
}

/** `<natsDir>/<slug>.conf` — the file quickstart writes/verifies. */
export function natsConfPath(natsDir: string, slug: string): string {
  return join(natsDir, `${slug}.conf`);
}

/** Byte-for-byte the shape README-AGENTS.md §4 documents (jetstream
 *  store_dir under the SAME `natsDir`, `<slug>-jetstream`). */
export function renderNatsConf(inputs: NatsConfInputs): string {
  const { slug, principal, port, monitorPort, natsDir } = inputs;
  return `server_name: ${slug}-${principal}
listen: 127.0.0.1:${port}
http: 127.0.0.1:${monitorPort}
jetstream {
  store_dir: ${join(natsDir, `${slug}-jetstream`)}
  max_mem: 64mb
  max_file: 1gb
  domain: ${slug}-${principal}
}
`;
}

// =============================================================================
// Seed provisioning basename (mirrors postupgrade.sh's derivation)
// =============================================================================

/** `meta-factory` → `cortex` (the historical single-file default stack);
 *  everything else → `cortex-<slug>`. Verbatim mirror of postupgrade.sh's
 *  inline `if [ "${slug}" = "meta-factory" ]` branch. */
export function nkeyBasenameForSlug(slug: string): string {
  return slug === "meta-factory" ? "cortex" : `cortex-${slug}`;
}

// =============================================================================
// Config paths (config-split layout — mirrors stack-lib.ts's discoverStacks)
// =============================================================================

export function stackTargetDir(configDir: string, slug: string): string {
  return join(configDir, slug);
}
export function pointerConfigPath(configDir: string, slug: string): string {
  return join(stackTargetDir(configDir, slug), `${slug}.yaml`);
}
export function stackAgentConfigPath(configDir: string, slug: string): string {
  return join(stackTargetDir(configDir, slug), "stacks", `${slug}.yaml`);
}
export function surfacesConfigPath(configDir: string, slug: string): string {
  return join(stackTargetDir(configDir, slug), "surfaces", "surfaces.yaml");
}
export function systemConfigPath(configDir: string, slug: string): string {
  return join(stackTargetDir(configDir, slug), "system", "system.yaml");
}

// =============================================================================
// Guarded YAML patch (mirrors network-config-write.ts's writeNetworksGuarded)
// =============================================================================

export interface PatchResult {
  /** `false` when the desired value(s) were already in place — no write, no
   *  backup, the file's mtime/bytes are untouched. */
  changed: boolean;
  backupPath?: string;
}

/** Timestamped suffix for the pre-write backup — same shape as
 *  `network-config-write.ts`'s `backupStamp`. */
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

function atomicWriteFileSync(path: string, contents: string, mode: number): void {
  const tmpPath = `${path}.tmp`;
  // Pass `mode` at creation (closes the window where a secret-bearing tmp
  // file would otherwise sit at the umask default between create and chmod)
  // AND re-chmod after (umask can still mask the creation-time mode — belt-
  // and-braces, mirrors network-config-write.ts's atomicWriteFileSync).
  writeFileSync(tmpPath, contents, { encoding: "utf-8", mode });
  chmodSync(tmpPath, mode);
  renameSync(tmpPath, path);
}

/**
 * Apply `mutate` to a `parseDocument()` of `path`'s current contents, and
 * write back ONLY if the result differs from what's already on disk.
 * Preserves comments (proven against the real scaffold shape — see this
 * file's header). Backs up before writing, writes atomically, re-parses to
 * verify `verify(doc)` holds post-write, and restores the original on any
 * failure — the same guard shape `writeNetworksGuarded` uses, generalized
 * over an arbitrary mutation instead of one hardcoded to
 * `policy.federated.networks`.
 *
 * Throws (with the original restored) on a verify failure. Callers wrap this
 * in their own try/catch to turn that into a clean step failure.
 */
export function patchYamlGuarded(
  path: string,
  backupLabel: string,
  mutate: (doc: ReturnType<typeof parseDocument>) => void,
  verify: (doc: ReturnType<typeof parseDocument>) => boolean,
): PatchResult {
  if (!existsSync(path)) {
    throw new Error(`cannot patch ${path}: file does not exist`);
  }
  const originalText = readFileSync(path, "utf-8");
  const originalMode = statSync(path).mode & 0o777;

  const doc = parseDocument(originalText);
  mutate(doc);
  const nextText = doc.toString();

  if (nextText === originalText) {
    return { changed: false };
  }

  // The backup carries the SAME content as the file being patched — which,
  // on a re-run where the token/discordId was already set by an EARLIER
  // quickstart run, means the backup carries the live secret too. Every
  // patched file here is born 0600 (stack.ts's scaffold); write the backup
  // at that mode from creation (and re-chmod, umask-proof) so it never has a
  // world-readable window — the same treatment atomicWriteFileSync gives the
  // main file, applied here because the backup is an equally secret-bearing
  // copy, not a throwaway.
  const backupPath = `${path}.pre-${backupLabel}-${backupStamp()}.bak`;
  writeFileSync(backupPath, originalText, { encoding: "utf-8", mode: originalMode });
  chmodSync(backupPath, originalMode);

  try {
    atomicWriteFileSync(path, nextText, originalMode);
    const reparsed = parseDocument(readFileSync(path, "utf-8"));
    if (!verify(reparsed)) {
      throw new Error("patched file failed round-trip verification");
    }
  } catch (err) {
    atomicWriteFileSync(path, originalText, originalMode);
    throw new Error(
      `guarded YAML patch failed for ${path} — restored original (backup ${backupPath}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  return { changed: true, backupPath };
}

/** Find the index of the `policy.principals[]` entry whose `id` equals
 *  `principalId` — the human principal's entry (distinct from the agent's
 *  own entry, index 0 in the scaffold). Returns -1 when not found (a config
 *  that doesn't match the scaffold shape quickstart itself wrote — callers
 *  treat that as an error, not a silent skip). */
export function findPrincipalEntryIndex(
  doc: ReturnType<typeof parseDocument>,
  principalId: string,
): number {
  const seq = doc.getIn(["policy", "principals"], true) as
    | { items: { get: (k: string) => unknown }[] }
    | undefined;
  if (seq === undefined) return -1;
  return seq.items.findIndex((item) => item.get("id") === principalId);
}

/** Patch `stacks/<slug>.yaml`: `principal.discordId` +
 *  `policy.principals[<human>].platform_ids.discord[0]`. Also re-validates
 *  the composed whole via `validateConfigLoads(pointerPath)` post-write (FS-7
 *  discipline) — surfaced to the caller as part of the result so a
 *  composition-only failure (rare; each individual write already round-trip
 *  verifies itself) is reported rather than silently accepted. */
export function patchStackYaml(
  path: string,
  pointerPath: string,
  opts: { principal: string; discordId: string },
): PatchResult & { composeErrors?: string[] } {
  const result = patchYamlGuarded(
    path,
    "quickstart-stack",
    (doc) => {
      doc.setIn(["principal", "discordId"], opts.discordId);
      const idx = findPrincipalEntryIndex(doc, opts.principal);
      if (idx === -1) {
        throw new Error(
          `stacks/${opts.principal}.yaml: no policy.principals[] entry with id "${opts.principal}" — not the scaffold shape quickstart expects`,
        );
      }
      doc.setIn(["policy", "principals", idx, "platform_ids", "discord", 0], opts.discordId);
    },
    (doc) => {
      const idx = findPrincipalEntryIndex(doc, opts.principal);
      if (idx === -1) return false;
      return (
        doc.getIn(["principal", "discordId"]) === opts.discordId &&
        doc.getIn(["policy", "principals", idx, "platform_ids", "discord", 0]) === opts.discordId
      );
    },
  );
  if (!result.changed) return result;
  const validation = validateConfigLoads(pointerPath);
  return validation.ok ? result : { ...result, composeErrors: validation.errors };
}

/** Patch `surfaces/surfaces.yaml`: the sole `surfaces.discord[0].binding`
 *  entry the scaffold writes (`stack-lib.ts`'s `surfacesYaml`). */
export function patchSurfacesYaml(
  path: string,
  opts: { token: string; guildId: string; agentChannelId: string; logChannelId: string },
): PatchResult {
  return patchYamlGuarded(
    path,
    "quickstart-surfaces",
    (doc) => {
      doc.setIn(["surfaces", "discord", 0, "binding", "token"], opts.token);
      doc.setIn(["surfaces", "discord", 0, "binding", "guildId"], opts.guildId);
      doc.setIn(["surfaces", "discord", 0, "binding", "agentChannelId"], opts.agentChannelId);
      doc.setIn(["surfaces", "discord", 0, "binding", "logChannelId"], opts.logChannelId);
    },
    (doc) =>
      doc.getIn(["surfaces", "discord", 0, "binding", "token"]) === opts.token &&
      doc.getIn(["surfaces", "discord", 0, "binding", "guildId"]) === opts.guildId &&
      doc.getIn(["surfaces", "discord", 0, "binding", "agentChannelId"]) === opts.agentChannelId &&
      doc.getIn(["surfaces", "discord", 0, "binding", "logChannelId"]) === opts.logChannelId,
  );
}

// =============================================================================
// Web surface scaffold (cortex#2153) — REPLACE, not patch
// =============================================================================
//
// The Discord path PATCHES real values into the `<REPLACE_ME>` slots of the
// discord binding `cortex stack create` scaffolds. The web path can't do that:
// the scaffold writes a `discord:` block, and a web deployment must end up with
// a `web:` block instead (leaving a placeholder discord binding around would
// fail the daemon's registry pass at boot). So the web path REWRITES
// surfaces.yaml wholesale to a single `web:` binding.
//
// The authoritative web binding SCHEMA is out-of-tree: it lives in the
// `metafactory-cortex-adapter-web` bundle's own `src/schema.ts` (ADR-0024 /
// cortex#1794 S9 — cortex core hardcodes NO per-platform binding schema). At
// scaffold time only the STRUCTURAL pass runs (`{agent, stack?, binding:
// record}` — `SurfaceBindingEntrySchema`); the bundle's `WebBindingSchema`
// validates at the REGISTRY pass on daemon boot. The fields written here
// (instanceId/host/port + the gating token) follow the epic #2164 planner's
// `host/port/token` web contract; see the report note for the reconciliation
// risk against the bundle's exact required-field set.

/** Read the agent id off whichever surface binding the scaffold (or a prior
 *  web rewrite) left in `surfaces.yaml`. Prefers `web` (so a re-run reads the
 *  already-rewritten file), then the scaffold's `discord`, then slack/mattermost.
 *  Returns `undefined` when no binding entry carries a string `agent`. */
export function readSurfaceAgent(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const doc = parseDocument(readFileSync(path, "utf-8"));
  for (const platform of ["web", "discord", "slack", "mattermost"]) {
    const agent = doc.getIn(["surfaces", platform, 0, "agent"]);
    if (typeof agent === "string" && agent.length > 0) return agent;
  }
  return undefined;
}

export interface WebSurfaceInputs {
  agent: string;
  stack: string;
  instanceId: string;
  host: string;
  port: string;
  token: string;
}

/** Render a web-only `surfaces.yaml` (cortex#2153). Deterministic given its
 *  inputs — the byte-identical fixed point a re-run compares against for the
 *  "second run mutates nothing" guarantee. `port` is emitted UNQUOTED so YAML
 *  parses it as a number (matching the real web binding shape). `token` is the
 *  secret — quoted, and NEVER echoed anywhere but this file. */
export function renderWebSurfacesYaml(opts: WebSurfaceInputs): string {
  return `# =============================================================================
# surfaces/surfaces.yaml — web/gateway surface binding (cortex#2153)
# =============================================================================
# Written by \`cortex quickstart --surface web\`. Replaces the Discord binding
# \`cortex stack create\` scaffolds with a single \`web:\` binding. The web binding
# SCHEMA is owned by the metafactory-cortex-adapter-web bundle (ADR-0024) and
# validated at the daemon's registry pass on boot — not by cortex core.

surfaces:
  web:
    - agent: ${opts.agent}
      stack: ${opts.stack}
      binding:
        instanceId: ${opts.instanceId}
        host: ${opts.host}
        port: ${opts.port}
        token: "${opts.token}"            # web auth secret (chmod 600 the file)
`;
}

/** Write the web `surfaces.yaml` (cortex#2153) — a full-file REWRITE (see the
 *  section header). Idempotent: a re-run against an already-web file is
 *  byte-identical → no write, no backup. Backs up the pre-existing (Discord
 *  scaffold or prior web) file at its own mode before an atomic replace, and
 *  re-reads to verify the bytes landed. Every file here is born 0600 (stack.ts
 *  scaffold); the backup carries the secret too, so it gets the same mode. */
export function writeWebSurfacesYaml(path: string, opts: WebSurfaceInputs): PatchResult {
  const desired = renderWebSurfacesYaml(opts);
  const exists = existsSync(path);
  const mode = exists ? statSync(path).mode & 0o777 : 0o600;

  if (exists && readFileSync(path, "utf-8") === desired) {
    return { changed: false };
  }

  mkdirSync(dirname(path), { recursive: true });

  let backupPath: string | undefined;
  if (exists) {
    const originalText = readFileSync(path, "utf-8");
    backupPath = `${path}.pre-quickstart-web-surfaces-${backupStamp()}.bak`;
    writeFileSync(backupPath, originalText, { encoding: "utf-8", mode });
    chmodSync(backupPath, mode);
  }

  atomicWriteFileSync(path, desired, mode);
  if (readFileSync(path, "utf-8") !== desired) {
    throw new Error(`web surfaces write failed round-trip verification for ${path}`);
  }

  return backupPath !== undefined ? { changed: true, backupPath } : { changed: true };
}

/** Patch `system/system.yaml`'s `nats.url` port. Callers skip calling this
 *  entirely when `CTX_NATS_PORT === "4222"` (the scaffold's own default —
 *  nothing to change), matching the issue's "if CTX_NATS_PORT ≠ 4222" gate. */
export function patchSystemNatsPort(path: string, port: string): PatchResult {
  const url = `nats://127.0.0.1:${port}`;
  return patchYamlGuarded(
    path,
    "quickstart-system",
    (doc) => {
      doc.setIn(["nats", "url"], url);
    },
    (doc) => doc.getIn(["nats", "url"]) === url,
  );
}

// =============================================================================
// Healthy-boot gate (§5)
// =============================================================================

/** The exact five substrings README-AGENTS.md §5's grep -E alternation
 *  matches, in the order it lists them. */
export const HEALTHY_BOOT_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "Stack:", pattern: /Stack:/ },
  { label: "connected to nats", pattern: /connected to nats/ },
  { label: "policy-engine active", pattern: /policy-engine active/ },
  { label: "connected as", pattern: /connected as/ },
  { label: "Guild:", pattern: /Guild:/ },
];

export interface GateLineResult {
  label: string;
  matched: boolean;
}

/** Evaluate the §5 healthy-boot gate against the daemon log text.
 *  `logText === undefined` (log not written yet) ⇒ every line is unmatched. */
export function evaluateHealthyBootGate(logText: string | undefined): GateLineResult[] {
  return HEALTHY_BOOT_PATTERNS.map(({ label, pattern }) => ({
    label,
    matched: logText !== undefined && pattern.test(logText),
  }));
}

export function renderGateTable(lines: GateLineResult[], healthzOk: boolean): string {
  const rows = lines.map((l) => `  ${l.matched ? "✓" : "✗"} ${l.label}`);
  rows.push(`  ${healthzOk ? "✓" : "✗"} nats /healthz`);
  return ["healthy-boot gate:", ...rows].join("\n");
}

export function gatePassed(lines: GateLineResult[], healthzOk: boolean): boolean {
  return healthzOk && lines.every((l) => l.matched);
}

// =============================================================================
// Misc path helper
// =============================================================================

/** `~/.local/state/metafactory/cortex/logs/cortex-<slug>.log` — the path §5's
 *  grep targets. */
export function daemonLogPath(home: string, slug: string): string {
  return join(home, ".local", "state", "metafactory", "cortex", "logs", `cortex-${slug}.log`);
}
