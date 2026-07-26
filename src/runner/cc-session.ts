/**
 * Streaming Claude Code session wrapper.
 * Spawns CC with --output-format stream-json and emits typed events.
 * The single CC invocation primitive in cortex — the legacy synchronous
 * `invokeClaudeCode()` was retired in MIG-4.8.
 */

import { EventEmitter } from "events";
import { homedir } from "os";
import { dirname, join } from "path";
import { parseStreamLine, StreamLineBuffer, type UsageStats, type StreamEvent } from "./stream-parser";
import { buildClaudeArgs, type ClaudeInvocationOpts } from "./claude-invoker";
import {
  createIsolatedSettings,
  scopeSessionEnv,
  resolveAgentEnv,
  CORTEX_SKILL_GRANTS_ENV,
  CORTEX_MCP_GRANTS_ENV,
  type IsolatedSettings,
} from "./session-settings";
import { activeConfigHomeEnv } from "../common/substrates/config-home";
import {
  createSessionSandbox,
  SANDBOX_EXEC_ALLOW_SEED,
  SANDBOX_EGRESS_ALLOW_SEED,
  type SandboxMode,
  type SandboxPosture,
  type SandboxProfile,
  type SandboxUnavailableEvent,
  type SandboxDenialEvent,
} from "./session-sandbox";
import { EgressProxy, type EgressDenialEvent } from "./egress-proxy";

// Re-export for convenience
export type { UsageStats, StreamEvent };

export interface CCSessionOpts {
  prompt: string;
  channel?: string;
  /** G-501: Network identifier for event routing */
  network?: string;
  agentName?: string;
  agentId?: string;
  resumeSessionId?: string;
  /**
   * ST-P1 (cortex#964, refs #952) — the parent session id for this spawn. When
   * set, `buildSessionEnv` stamps `CORTEX_PARENT_SESSION_ID` on the child's env
   * so the child's EventLogger links its events to the parent session
   * (CONTEXT.md §Session tree). Unset for an agent-rooted session.
   */
  parentSessionId?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  allowedDirs?: string[];
  /**
   * EBH-1 (cortex#2343) — directories the session may READ but not modify.
   * Passed to path-guard.hook.ts / bash-guard.hook.ts's path checks via the
   * `CORTEX_PATH_GUARD` env var (mirrors `allowedDirs`'s own role there).
   * Distinct from `allowedDirs` so a write into one of these is DENIED
   * (closes F6) while a read is permitted — see {@link resolvePathGuardEnv}.
   * EBH-1b (cortex#2352) threads a distinct value through every live
   * dispatch path (dispatch-handler.ts no longer flattens this into the
   * merged `allowedDirs` it builds for `CORTEX_PATH_GUARD` purposes —
   * `resolvePathGuardEnv` subtracts `readOnlyDirs` from `allowedDirs` before
   * emitting, so a dir in both wins as read-only, the safe default).
   */
  readOnlyDirs?: string[];
  /**
   * EBH-2 (cortex#2344) — DD-5 staged-rollout posture for the `SessionSandbox`
   * kernel-level projection of this SAME `allowedDirs`/`readOnlyDirs` policy
   * (see {@link deriveSandboxProfile}). Undefined behaves exactly like
   * `"off"` — the cortex#2344 HARD HOLD default — so every existing caller
   * that doesn't set this field is unaffected. No dispatch path threads a
   * config-resolved value through here yet (deliberately out of scope for
   * EBH-2's structure-only slice); wiring `system.sandbox.mode` from config
   * through to this field is follow-up work for the backend that actually
   * enforces it (EBH-3).
   */
  sandboxMode?: SandboxMode;
  /**
   * cortex#2409 part 2 — DD-10's filesystem posture (`"guarded"` v1's
   * `(allow default)` + denylist, or `"strict"` v2's `(deny default)` +
   * derived explicit-allow). Undefined behaves exactly like `"guarded"` —
   * the HARD HOLD default, unchanged from every prior EBH slice: no live
   * dispatch path sets `"strict"`. Orthogonal to {@link sandboxMode}: mode
   * gates whether the profile enforces at all; posture gates what its
   * default rule is. See `session-sandbox.ts`'s `SandboxPosture` doc.
   */
  sandboxPosture?: SandboxPosture;
  /**
   * EBH-4 (cortex#2346) — additional egress hostnames for THIS session, on
   * top of {@link SANDBOX_EGRESS_ALLOW_SEED}'s static seed (the compat-
   * ibility-contract hosts every session needs: the model API, GitHub).
   * Merged into {@link SandboxProfile.egressAllow} by {@link
   * deriveSandboxProfile} — see that function's doc for the merge shape.
   * Undefined/empty behaves exactly like today (seed-only allowlist).
   * UNENFORCED unless `sandboxMode` is `"audit"`/`"enforce"` — see
   * `egress-proxy.ts`'s module doc for what "enforced" means here (a
   * cooperating-client proxy, not a kernel boundary).
   */
  egressAllow?: string[];
  timeoutMs?: number;
  cwd?: string;
  additionalArgs?: string[];
  /** Bash allowlist config — passed to bash-guard.hook.ts via CORTEX_BASH_GUARD env var. */
  bashAllowlist?: { rules: { pattern: string; repos?: string[] }[]; repos: string[] };
  /** G-300: When true, disables bash guard entirely (principal DM). */
  bashGuardDisabled?: boolean;
  /** H-001: Explicit project context (e.g., "grove", "meta-factory") */
  project?: string;
  /** H-001: Entity context (e.g., "issue/43", "pr/45", "g-204") */
  entity?: string;
  /** H-001: Principal who triggered this session (Discord username or ID) */
  principal?: string;
  /**
   * cortex#701 (Part A — session settings isolation). When `true` (the
   * DEFAULT for every bot session), the session spawns under a
   * cortex-owned curated settings scope: `--setting-sources ""` (loads NO
   * ambient setting source — not the principal's global `user`, nor the
   * cwd repo's `project`/`local` `.claude/`, which `--settings` would
   * otherwise load additively) plus a generated `--settings` file carrying
   * ONLY cortex's own hooks. The child env is scoped so principal-personal
   * `CLAUDE_*` vars can't re-introduce hooks/plugins/settings. See
   * `session-settings.ts`.
   *
   * Set to `false` ONLY for a session the principal runs as themselves
   * (where inheriting their global settings is the intent). Bot sessions
   * spawned from the dispatch path leave this unset → isolated.
   */
  settingsIsolation?: boolean;
  /**
   * cortex#701 — override the cortex-owned `.claude` directory holding the
   * installed hook symlinks. Defaults to `${HOME}/.claude`. Exists so
   * tests can point at a fixture dir; production leaves it unset.
   */
  claudeDir?: string;
  /**
   * cortex#710 (Part B) — per-skill grant list for this session. When
   * NON-EMPTY, the curated settings file registers the Skill Guard
   * PreToolUse hook (matcher `Skill`), the bare `Skill` tool is broadly
   * allowed, and this list is passed to the hook via the
   * `CORTEX_SKILL_GRANTS` env var so it denies any skill ∉ the list.
   *
   * When `undefined`/empty, no Skill hook is registered and the caller is
   * expected to keep `disallowedTools: ["Skill"]` (default-deny, no Skill
   * tool). Set together as an atomic pair by the dispatch path — never
   * {`Skill(name)` allow + bare `Skill` deny}, which is broken (cortex#706).
   *
   * Only honoured when `settingsIsolation` is on (the default). A
   * principal-as-self session (`settingsIsolation:false`) inherits the
   * principal's full skill set and does not register the gate.
   */
  allowedSkills?: string[];
  /**
   * cortex#2111 — per-principal MCP grant list for this session, in the MCP
   * Guard pattern grammar (`"*"` | `"<server>"` | `"<server>.<tool>"`,
   * lowercase). When DEFINED (including `[]`), the curated settings file
   * registers the MCP Guard PreToolUse hook (matcher `mcp__.*`) and this
   * list is passed to it via the `CORTEX_MCP_GRANTS` env var — any `mcp__*`
   * invocation not covered by a pattern is denied. `[]` means NO MCP at all
   * (the dispatch path additionally appends `--strict-mcp-config` for that
   * case, so un-granted servers don't even load).
   *
   * When `undefined`, no MCP hook is registered — a path that never went
   * through `resolvePolicyAccess` keeps existing (allow-by-default)
   * behaviour.
   *
   * Only honoured when `settingsIsolation` is on (the default) — the hook
   * lives in the curated settings file. A principal-as-self session
   * (`settingsIsolation:false`) runs as the home principal with their own
   * settings; that principal holds the implicit full grant anyway.
   */
  mcpGrants?: string[];
  /**
   * The substrate's config-home env var to export on the child, resolved by the
   * dispatch layer from the deployment `substrates:` block (claude-code →
   * `{ name: "CLAUDE_CONFIG_DIR", value: <home> }`). Set on the child env AFTER
   * `scopeSessionEnv`, so isolation stays strict default-deny while the config
   * home is still an intentional, named export (not an inherited passthrough).
   * Undefined = use the substrate's default home. See
   * common/substrates/config-home.ts.
   */
  configHomeEnv?: { name: string; value: string };
  /**
   * cortex#2133 (epic #2164) — the target agent's declared `env:` passthrough
   * map (`NAME → literal-or-`env:NAME`-reference`; see `AgentSchema.env`).
   * Layered onto the child env by `start()` AFTER `scopeSessionEnv` and BEFORE
   * cortex's own `CORTEX_*`/config-home/grant vars, so a declared var can
   * neither shadow cortex's pipeline vars nor touch the `CLAUDE_*` namespace
   * (resolution + the re-asserted deny-by-default allowlist live in
   * `resolveAgentEnv`, session-settings.ts). Undefined/absent ⇒ no passthrough
   * (byte-identical to the pre-#2133 env).
   */
  agentEnv?: Record<string, string>;
}

export interface CCSessionResult {
  success: boolean;
  response: string;
  sessionId?: string;
  exitCode: number;
  durationMs: number;
  usage?: UsageStats;
  /**
   * True when the session was killed from outside (inactivity timeout,
   * manual `kill()`, future shutdown signals) rather than exiting on its
   * own. Distinct from `success === false`: a CC process can fail without
   * being aborted, and the abort path settles `wait()` via the `error`
   * listener with `exitCode: 1` BEFORE the eventual SIGTERM/143 fires —
   * so callers cannot rely on `exitCode === 143` alone to detect aborts.
   *
   * Consumers (see `dispatch-listener`) use this to emit
   * `dispatch.task.aborted` instead of `dispatch.task.failed`.
   */
  aborted?: boolean;
  /**
   * Reason for the abort, when `aborted === true`. Currently the only
   * value emitted is `"timeout"` (inactivity timer fired); the field is
   * left open-ended so future kill paths (principal cancel, runner
   * shutdown) can populate it without a breaking change.
   */
  abortReason?: "timeout";
  /**
   * cortex#2055 — accumulated stderr from the CC process (empty string when
   * none). Surfaced so failure classifiers can spot substrate-level errors
   * (e.g. `authentication_failed`) that exit non-zero with no stdout response.
   */
  stderr?: string;
}

/**
 * cortex#774 (G-2a/G-3a) — layer cortex's instrumentation env vars onto the
 * (already-scoped) base env for a spawned CC session.
 *
 * Sets the canonical `CORTEX_*` names — `CORTEX_CHANNEL`, `CORTEX_NETWORK`,
 * `CORTEX_AGENT_NAME`, `CORTEX_AGENT_ID`, `CORTEX_PROJECT`, `CORTEX_ENTITY`,
 * and `CORTEX_PRINCIPAL` — that the EventLogger / SurfaceContext hooks read.
 * The legacy `GROVE_*` instrumentation names are NO LONGER set here; the
 * hooks retain a `GROVE_*` read-fallback (see `surface-env.ts` /
 * `principal-env.ts`) so external setters still on `GROVE_*` keep resolving
 * during the transition.
 *
 * Does not mutate `baseEnv` — but NOT referentially transparent: it reads the
 * process-wide config home (`activeConfigHomeEnv`) published at daemon boot, so
 * the same inputs yield a different `CLAUDE_CONFIG_DIR` across deployments.
 * Tests that care must set it explicitly (`setActiveSubstrates`) or pass
 * `opts.configHomeEnv`. Extracted from `start()` so the
 * spawned env is unit-testable without invoking the `claude` binary.
 */
export function buildSessionEnv(
  baseEnv: Record<string, string>,
  opts: Pick<
    CCSessionOpts,
    | "channel"
    | "network"
    | "agentName"
    | "agentId"
    | "project"
    | "entity"
    | "principal"
    | "parentSessionId"
    | "configHomeEnv"
  >,
): Record<string, string> {
  // The substrate's config-home var (claude-code → CLAUDE_CONFIG_DIR): explicit
  // `opts.configHomeEnv` override, else the process-wide `substrates:` block
  // published at daemon boot. Applied HERE — `baseEnv` is post-`scopeSessionEnv`
  // — so it survives isolation's CLAUDE_* strip WITHOUT widening the env
  // allowlist, while staying a pure/testable transform rather than a mutation
  // buried in `start()`. Without it a child authenticates on the vendor-default
  // credential, which refreshes independently of the principal's and expires.
  //
  // Honest boundary: relocating a config HOME also relocates its `.claude.json`
  // MCP servers — isolation is strict at the ENV-allowlist layer, but
  // `--setting-sources ""` does not gate config-dir MCP config. That is inherent
  // to any config home (default or otherwise), not introduced here.
  const configHomeEnv = opts.configHomeEnv ?? activeConfigHomeEnv("claude-code");
  return {
    ...baseEnv,
    ...(opts.channel && { CORTEX_CHANNEL: opts.channel }),
    ...(opts.network && { CORTEX_NETWORK: opts.network }),
    ...(opts.agentName && { CORTEX_AGENT_NAME: opts.agentName }),
    ...(opts.agentId && { CORTEX_AGENT_ID: opts.agentId }),
    ...(opts.project && { CORTEX_PROJECT: opts.project }),
    ...(opts.entity && { CORTEX_ENTITY: opts.entity }),
    ...(opts.principal && { CORTEX_PRINCIPAL: opts.principal }),
    // ST-P1 (cortex#964) — child-session linkage. The spawned child's
    // EventLogger reads CORTEX_PARENT_SESSION_ID to parent its events.
    ...(opts.parentSessionId && { CORTEX_PARENT_SESSION_ID: opts.parentSessionId }),
    ...(configHomeEnv && { [configHomeEnv.name]: configHomeEnv.value }),
  };
}

/**
 * Resolve the AUTHORITATIVE `CORTEX_BASH_GUARD` value cortex writes onto every
 * spawned session env (cortex#2133, defense-in-depth for MAJOR-1). Total —
 * ALWAYS returns a string — so `start()` can write it unconditionally and no
 * stale/injected base-env value can survive:
 *
 *   - `bashGuardDisabled`  → `{"disabled":true}` — the principal-DM / CLI-trust
 *     posture (the guard hook's `loadConfig()` returns null ⇒ pass-through).
 *   - `bashAllowlist`      → the serialised allowlist (guard active, that list).
 *   - neither              → `{}` — the SAFE DEFAULT. The guard hook's
 *     `loadConfig()` treats `{}` IDENTICALLY to an unset var: guard ACTIVE with
 *     the built-in read-only default-deny allowlist (its `DEFAULT_CONFIG`). It
 *     carries no `disabled:true`, so it never weakens the guard's default-deny.
 *     Writing it also removes a bot session from the hook's Gate-2 CLI-principal
 *     bypass (keyed on `CORTEX_BASH_GUARD` being ABSENT), so a bot session with
 *     no allowlist config falls through to default-deny, never full-trust
 *     pass-through.
 *
 * Extracted so the MAJOR-1 property (a declared `CORTEX_BASH_GUARD` cannot
 * survive) is unit-testable without spawning the `claude` binary.
 */
export function resolveBashGuardEnv(
  opts: Pick<CCSessionOpts, "bashGuardDisabled" | "bashAllowlist">,
): string {
  if (opts.bashGuardDisabled) return JSON.stringify({ disabled: true });
  if (opts.bashAllowlist) return JSON.stringify(opts.bashAllowlist);
  return JSON.stringify({});
}

/**
 * Resolve the AUTHORITATIVE `CORTEX_PATH_GUARD` value cortex writes onto
 * every spawned session env (EBH-1, cortex#2343 step 5) — mirrors
 * {@link resolveBashGuardEnv}'s "always a string, always written" contract
 * so a stale/injected value can never survive and so path-guard.hook.ts /
 * bash-guard.hook.ts's path checks always read the SAME policy this
 * session's `--add-dir`/preamble were built from (design spec DD-1).
 *
 * Total — ALWAYS returns a JSON string:
 *   - `{allowedDirs:[...], readOnlyDirs:[...]}` from the opts the caller
 *     resolved (may legitimately both be `[]` — the hooks treat an empty
 *     policy as "no restriction configured", matching the EXISTING
 *     `security-preamble.ts` contract; see path-guard.hook.ts's module doc).
 *
 * **EBH-1b (cortex#2352) correctness subtlety — the subtraction.**
 * `opts.allowedDirs` is `invokeDirs`, a caller-built UNION that also
 * includes `readOnlyDirs` (kept that way deliberately so `--add-dir` still
 * grants read access to read-only dirs — see `claude-invoker.ts`, which
 * reads `opts.allowedDirs` UNCHANGED and never sees this function's output).
 * So the guard's `allowedDirs` is the caller's `allowedDirs` MINUS
 * `readOnlyDirs` (exact-string membership); `readOnlyDirs` is carried
 * unchanged. Overlap rule: a dir present in both inputs resolves to
 * READ-ONLY in the emitted policy — the safe default.
 *
 * cortex#2359 round 2 (F1) note: this subtraction is EXACT-STRING only (see
 * {@link splitGuardDirs}) — it does NOT catch a `readOnlyDirs` entry that is
 * merely CONTAINED WITHIN a broader `allowedDirs` entry rather than equal to
 * it (`allowedDirs:["/repo"], readOnlyDirs:["/repo/.claude"]` subtracts
 * nothing, since neither string equals the other). That nested case used to
 * be a live bypass because `decidePath`'s `inReadOnly` check was ALSO gated
 * on `!inAllowed`, so the two gaps compounded. `decidePath` now computes
 * `inAllowed`/`inReadOnly` independently and lets read-only win by
 * CONTAINMENT, not exact-string overlap (see path-guard.hook.ts's module
 * doc, "Read-only vs. allowed on overlap") — so the nested case is closed at
 * the DECISION layer regardless of what this subtraction does or doesn't
 * catch. This function's exact-match subtraction is therefore no longer the
 * mechanism F6/F1 depend on; it remains as defense-in-depth (it keeps a
 * read-only dir out of the emitted `allowedDirs` list at all, for any other
 * consumer — e.g. {@link deriveSandboxProfile} — that might read that field
 * without going through `decidePath`'s precedence logic). Made
 * containment-aware here too would be redundant work for zero behavior
 * change at the hook, so it was deliberately left as-is.
 */
export function resolvePathGuardEnv(
  opts: Pick<CCSessionOpts, "allowedDirs" | "readOnlyDirs">,
): string {
  const { allowedDirs, readOnlyDirs } = splitGuardDirs(opts);
  return JSON.stringify({ allowedDirs, readOnlyDirs });
}

/**
 * The actual `allowedDirs MINUS readOnlyDirs` subtraction (EBH-1b,
 * cortex#2352) — extracted from {@link resolvePathGuardEnv} so EBH-2's
 * {@link deriveSandboxProfile} projects from the SAME computed split rather
 * than re-implementing it (DD-1: one resolved policy, N projections; two
 * copies of this subtraction is exactly the drift DD-1 exists to prevent).
 * See `resolvePathGuardEnv`'s doc comment for the full correctness
 * rationale — this function IS that rationale's code.
 */
function splitGuardDirs(
  opts: Pick<CCSessionOpts, "allowedDirs" | "readOnlyDirs">,
): { allowedDirs: string[]; readOnlyDirs: string[] } {
  const readOnlyDirs = opts.readOnlyDirs ?? [];
  const allowedDirs = (opts.allowedDirs ?? []).filter((d) => !readOnlyDirs.includes(d));
  return { allowedDirs, readOnlyDirs };
}

/**
 * EBH-2 (cortex#2344) — project the SAME resolved `CCSessionOpts` policy
 * `resolvePathGuardEnv` reads into a kernel-level {@link SandboxProfile}
 * (DD-1's third projection, alongside the preamble text and the CC
 * `--allowedTools`/`--add-dir` flags). Consumes {@link splitGuardDirs}
 * directly — NOT a re-derivation — so the read-only/read-write split can
 * never disagree between the L1 path guard and the L2 sandbox profile: a
 * dir in both `allowedDirs` and `readOnlyDirs` resolves to `readOnly` here
 * for the identical reason it resolves to read-only in
 * `CORTEX_PATH_GUARD` (the safe default, EBH-1b).
 *
 * `execAllow` is NOT derived from `opts` — it's the static compatibility-
 * contract seed (see `session-sandbox.ts`), unenforced until a real exec
 * jail exists (no backend enforces it yet). `egressAllow` IS now enforced
 * (EBH-4, `egress-proxy.ts`) — it's the seed PLUS `opts.egressAllow`
 * (deduplicated), so a caller can extend the allowlist per session without
 * touching the static compatibility-contract list.
 */
export function deriveSandboxProfile(
  opts: Pick<CCSessionOpts, "allowedDirs" | "readOnlyDirs" | "egressAllow" | "sandboxPosture">,
  mode: SandboxMode,
  /**
   * cortex#2409 part 2 — session-internal read-only paths ONLY the STRICT
   * generator needs (see `SandboxProfile.internalReadOnly`'s doc): today,
   * the per-session isolated-settings temp dir. A separate parameter
   * (not folded into `opts`) because it is NOT part of the caller-facing
   * policy `opts` represents — it's plumbing `CCSession.start()` computes
   * for itself (`createIsolatedSettings`'s `settingsPath`) and threads
   * through explicitly, so `deriveSandboxProfile` stays a pure function of
   * its own inputs rather than reaching into session-construction state.
   */
  internalReadOnly: string[] = [],
): SandboxProfile {
  const { allowedDirs, readOnlyDirs } = splitGuardDirs(opts);
  return {
    readWrite: allowedDirs,
    readOnly: readOnlyDirs,
    execAllow: [...SANDBOX_EXEC_ALLOW_SEED],
    egressAllow: [...new Set([...SANDBOX_EGRESS_ALLOW_SEED, ...(opts.egressAllow ?? [])])],
    mode,
    // cortex#2409 part 2 HARD HOLD — defaults to "guarded" (DD-10 v1,
    // unchanged) whenever the caller doesn't set `sandboxPosture`, which is
    // every live dispatch path today. See `SandboxPosture`'s doc.
    posture: opts.sandboxPosture ?? "guarded",
    internalReadOnly,
  };
}

export class CCSession extends EventEmitter {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private timeoutId: Timer | null = null;
  private lineBuffer = new StreamLineBuffer();
  private startTime = 0;
  private stdoutDone: Promise<void> = Promise.resolve();
  private stderrDone: Promise<void> = Promise.resolve();
  /** cortex#2055 — accumulated stderr text, surfaced on the result so callers
   *  can detect substrate-level failures (e.g. `authentication_failed`) that
   *  never reach the stdout stream. */
  private stderrText = "";
  /** cortex#701 — materialised curated-settings file for this session; cleaned up on exit. */
  private isolatedSettings: IsolatedSettings | null = null;

  sessionId?: string;
  result?: string;
  usage?: UsageStats;

  constructor(private opts: CCSessionOpts) {
    super();
  }

  /** Override timeout (must be called before start()). */
  setTimeout(ms: number): void {
    this.opts.timeoutMs = ms;
  }

  /** Spawn the CC process and start parsing stream-json output. */
  start(): this {
    this.startTime = performance.now();

    // cortex#701 (Part A) — settings isolation. Default ON for every bot
    // session: load NO ambient setting source (not the principal's global
    // `user`, nor the cwd repo's `project`/`local` `.claude/`) and load a
    // cortex-owned curated settings file with ONLY cortex's hooks. The args
    // are appended to additionalArgs so they sit before `-p <prompt>`
    // (buildClaudeArgs puts the prompt last).
    const isolate = this.opts.settingsIsolation !== false;
    // cortex#710 — per-skill grants. Non-empty → curated settings registers
    // the Skill Guard hook AND the grant list is exported to it via env. The
    // two MUST move together (the #706 atomicity lesson).
    const skillGrants = this.opts.allowedSkills;
    const hasSkillGrants =
      isolate && skillGrants !== undefined && skillGrants.length > 0;
    // cortex#2111 — per-principal MCP grants. Defined (even []) → curated
    // settings register the MCP Guard hook AND the grant list is exported to
    // it via env. The two MUST move together (same atomicity contract as the
    // skill pair above). Note `!== undefined` — an EMPTY list still arms the
    // guard (deny-all), unlike skills where empty skips the hook.
    const mcpGrants = this.opts.mcpGrants;
    const hasMcpGuard = isolate && mcpGrants !== undefined;
    // cortex#2111 — structural backstop, CENTRALIZED here so every
    // construction path gets it (dispatch-handler direct paths, the bus
    // harness, agent-team, gateway-published envelopes): a session whose
    // policy decision granted ZERO MCP patterns loads no MCP servers at
    // all. Deduped against caller-supplied args (the dispatch-handler also
    // appends it for agent-level strictMcpConfig). Deliberately NOT gated
    // on `isolate`: even a non-isolated session must not fail open when a
    // deny-all MCP decision was made.
    // Adversarial-review M3 — the flag fires in TWO confinement cases:
    //   1. ZERO grants (any isolation mode): no MCP at all.
    //   2. PARTIAL grants on a NON-ISOLATED session: the guard hook lives
    //      in the curated settings file, which a non-isolated session
    //      doesn't load — so fine-grained enforcement is impossible there.
    //      Denying the granted servers too (fail-closed) beats silently
    //      granting the whole namespace (fail-open). Full grant ("*")
    //      needs no confinement.
    const mcpConfinementRequired =
      mcpGrants !== undefined &&
      (mcpGrants.length === 0 ||
        (!isolate && !mcpGrants.includes("*")));
    const strictMcpArgs =
      mcpConfinementRequired &&
      this.opts.additionalArgs?.includes("--strict-mcp-config") !== true
        ? ["--strict-mcp-config"]
        : [];
    const isolationArgs: string[] = [];
    if (isolate) {
      // cortex#990 A1 — granted skills are symlinked from the claude-code
      // config home's `skills/` dir (the same home the child authenticates
      // against, #2132), falling back to `~/.claude/skills` when no config
      // home was declared. Resolved here, at the single spawn site, so every
      // dispatch path uses the same source without threading it through.
      const skillSourceDir = join(
        activeConfigHomeEnv("claude-code")?.value ?? `${homedir()}/.claude`,
        "skills",
      );
      this.isolatedSettings = createIsolatedSettings(
        this.opts.claudeDir ?? `${homedir()}/.claude`,
        skillGrants,
        mcpGrants,
        skillSourceDir,
      );
      isolationArgs.push(...this.isolatedSettings.args);
    }

    // cortex#710 — when grants are present, the bare `Skill` tool must be
    // PERMITTED at the permission layer so the Skill Guard hook (registered
    // in the curated settings) is the real gate. Normalise the tool lists
    // here so CCSession is self-consistent regardless of which caller built
    // them (harness pre-pairs them; the dispatch-handler direct paths rely on
    // this). Strip any `Skill` deny, and add `Skill` to a NON-EMPTY allowlist
    // that lacks it (an empty allowlist means "no --allowedTools flag →
    // allow-by-default", which already permits the bare Skill tool).
    let effectiveAllowedTools = this.opts.allowedTools;
    let effectiveDisallowedTools = this.opts.disallowedTools;
    if (hasSkillGrants) {
      if (effectiveDisallowedTools?.includes("Skill")) {
        effectiveDisallowedTools = effectiveDisallowedTools.filter((t) => t !== "Skill");
      }
      if (
        effectiveAllowedTools !== undefined &&
        effectiveAllowedTools.length > 0 &&
        !effectiveAllowedTools.includes("Skill")
      ) {
        effectiveAllowedTools = [...effectiveAllowedTools, "Skill"];
      }
    }

    // Build args from existing buildClaudeArgs, then inject stream-json
    const invokerOpts: ClaudeInvocationOpts = {
      prompt: this.opts.prompt,
      channel: this.opts.channel,
      network: this.opts.network,
      resumeSessionId: this.opts.resumeSessionId,
      allowedTools: effectiveAllowedTools,
      disallowedTools: effectiveDisallowedTools,
      allowedDirs: this.opts.allowedDirs,
      additionalArgs: [
        "--verbose",
        "--output-format", "stream-json",
        ...isolationArgs,
        ...strictMcpArgs,
        ...(this.opts.additionalArgs ?? []),
      ],
    };

    const args = buildClaudeArgs(invokerOpts);

    // cortex#701 — scope the child env when isolating: drop principal-
    // personal CLAUDE_* vars that could re-introduce hooks/plugins/settings
    // (default-deny, allowlist in session-settings.ts). Cortex's own
    // pipeline vars (GROVE_*/CORTEX_*) are layered ON TOP below so they
    // always survive. When not isolating (principal-as-self), inherit the
    // full parent env unchanged (legacy behaviour).
    const baseEnv: Record<string, string> = isolate
      ? scopeSessionEnv(process.env)
      : { ...(process.env as Record<string, string>) };

    // cortex#2133 — the agent's declarative `env:` passthrough. Resolved (refs
    // read from the daemon env; deny-by-default allowlist re-asserted as
    // defence-in-depth) and layered on the scoped base BEFORE buildSessionEnv
    // applies cortex's own CORTEX_*/config-home/grant vars — so cortex's pipeline
    // vars always win and a declared var can never reach the CLAUDE_* namespace
    // scopeSessionEnv guards. Undefined/empty ⇒ {} ⇒ byte-identical to pre-#2133.
    const agentEnv = resolveAgentEnv(this.opts.agentEnv, process.env);

    const env: Record<string, string> = {
      ...buildSessionEnv({ ...baseEnv, ...agentEnv }, this.opts),
      // cortex#710 — pass the per-skill grant list to the Skill Guard hook.
      // Only set when the curated settings actually registered the hook
      // (hasSkillGrants), so the env var and the hook move atomically. Layered
      // here (after scopeSessionEnv) alongside cortex's other pipeline vars; it
      // is not a CLAUDE_* var so scoping passes it through regardless.
      ...(hasSkillGrants && {
        [CORTEX_SKILL_GRANTS_ENV]: JSON.stringify(skillGrants),
      }),
      // cortex#2111 — pass the MCP grant list to the MCP Guard hook. Only set
      // when the curated settings actually registered the hook (hasMcpGuard),
      // so the env var and the hook move atomically. The hook itself treats a
      // missing var as deny-all, so even a registration-without-env bug fails
      // CLOSED, never open.
      ...(hasMcpGuard && {
        [CORTEX_MCP_GRANTS_ENV]: JSON.stringify(mcpGrants),
      }),
    };

    // Pass bash allowlist config to bash-guard.hook.ts. CORTEX_BASH_GUARD is
    // written UNCONDITIONALLY (cortex#2133, defense-in-depth for MAJOR-1): cortex
    // is always the authoritative writer of this var — this assignment OVERWRITES
    // whatever the layered base/agent env carried, so a stale/injected value can
    // never win. The deny-by-default allowlist (resolveAgentEnv / AgentEnvSchema)
    // already blocks a declared CORTEX_* key at the key layer (it isn't in
    // ALLOWED_AGENT_ENV_KEYS); writing the guard var here makes it authoritative
    // even if a value reaches the base env by any other route. See
    // {@link resolveBashGuardEnv} for the value semantics.
    env.CORTEX_BASH_GUARD = resolveBashGuardEnv(this.opts);

    // EBH-1 (cortex#2343 step 5) — pass allowedDirs/readOnlyDirs to
    // path-guard.hook.ts / bash-guard.hook.ts's path checks. Written
    // UNCONDITIONALLY for the same reason CORTEX_BASH_GUARD is: cortex is
    // always the authoritative writer, so this OVERWRITES anything the
    // layered base/agent env carried.
    env.CORTEX_PATH_GUARD = resolvePathGuardEnv(this.opts);

    // Suppress ANTHROPIC_API_KEY when OAuth token is present
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      delete env.ANTHROPIC_API_KEY;
    }

    // EBH-2 (cortex#2344, DD-2) — the choke point. Every `claude --print`
    // spawn in cortex funnels through `SessionSandbox.spawn`, not a direct
    // `Bun.spawn`. EBH-3a (cortex#2345) adds the real `macos-sbpl` backend
    // — `createSessionSandbox` (session-sandbox.ts) resolves it from the
    // BOOT-warmed capability probe's sync snapshot; a session spawned before
    // boot warms the probe (or any test that never calls
    // `getSandboxCapabilityProbe`) still gets `none`, byte-identical to
    // EBH-2. The `mode` on the projected profile still defaults to `"off"`
    // on every live dispatch path (`CCSessionOpts.sandboxMode`) — resolving
    // a real backend class is not the same as enforcing anything; see
    // `session-sandbox-macos.ts`'s class doc for the `mode` gate.
    const sandboxMode: SandboxMode = this.opts.sandboxMode ?? "off";
    // cortex#2409 part 2 — the isolated-settings temp dir (when isolating)
    // is cortex-internal plumbing, not part of the caller's `allowedDirs`/
    // `readOnlyDirs` policy, but the STRICT posture's `(deny default)` still
    // needs an explicit allow for it (`claude` reads its own `--settings
    // <path>` argument at startup) or every isolated session breaks under
    // `strict`. `dirname`, not the file itself — the strict generator
    // realpath-resolves + subpath-allows the directory (also covers the
    // materialised skills plugin dir, cortex#990 A1, which lives alongside
    // `settings.json` in the SAME temp dir).
    const sandboxProfile = deriveSandboxProfile(
      this.opts,
      sandboxMode,
      this.isolatedSettings ? [dirname(this.isolatedSettings.settingsPath)] : [],
    );
    const sandbox = createSessionSandbox({
      onUnavailable: (event: SandboxUnavailableEvent) => {
        // Observable to any listener (a future bus publisher included) —
        // see the "security-event" doc on this emit for why this stays an
        // EventEmitter emission rather than a direct bus publish in EBH-2.
        this.emit("security-event", event);
        process.stderr.write(
          `[cc-session] ${event.type} backend=${event.backend} mode=${event.mode} — ` +
            `no kernel execution boundary is enforcing this session (EBH-2; EBH-3a landed the ` +
            `macos-sbpl backend). See docs/design-session-sandbox.md.\n`,
        );
      },
    });
    // DD-7's boot capability probe (`getSandboxCapabilityProbe`,
    // session-sandbox.ts) is DELIBERATELY NOT warmed from here. It shells
    // out to `sandbox-exec`/`bwrap` to test viability (E1/E5's own repro
    // shape), and this is the single choke point every CCSession —
    // including the many tests across this repo that mock `Bun.spawn` to
    // assert an exact claude-spawn call count — passes through. Triggering
    // a real subprocess spawn from inside that choke point breaks those
    // counts (confirmed: cc-session-isolation.test.ts) and adds
    // platform-dependent flakiness to every boot in the test suite. EBH-3a
    // wires the FIRST call into `cortex.ts`'s `startCortex` instead (a
    // one-time boot-path call, well away from this per-session choke point).
    // EBH-4 (cortex#2346) — the L3 egress allowlist. Declared at function
    // scope (not inside the try block below) so the `catch` can tear a
    // successfully-started proxy back down if `sandbox.spawn` itself throws
    // after the proxy bound its port — see `egress-proxy.ts` for the
    // mechanism and its claim-hygiene doc (cooperating-client proxy, NOT a
    // kernel boundary).
    let egressProxy: EgressProxy | undefined;
    try {
      // `mode: "off"` (the only value any live dispatch path sets —
      // `sandboxMode` HARD HOLD, same as the FS backend) never constructs an
      // `EgressProxy` at all: zero behaviour change, no listening socket, no
      // env mutation. Only `audit`/`enforce` reach this branch.
      if (sandboxProfile.mode !== "off") {
        try {
          egressProxy = new EgressProxy(sandboxProfile.egressAllow, sandboxProfile.mode);
          const bound = egressProxy.start();
          // Force the child through the proxy. Written UNCONDITIONALLY
          // (upper+lowercase — different tools honor different casing) —
          // same "cortex is the authoritative writer" discipline as
          // CORTEX_BASH_GUARD/CORTEX_PATH_GUARD above. A NO_PROXY the parent
          // env carried is deleted: leaving it would hand a cooperating
          // client an explicit, config-driven bypass of the very proxy we
          // just stood up (see egress-proxy.ts's module doc for the OTHER,
          // non-cooperating bypass this does NOT close).
          env.HTTP_PROXY = bound.proxyUrl;
          env.HTTPS_PROXY = bound.proxyUrl;
          env.http_proxy = bound.proxyUrl;
          env.https_proxy = bound.proxyUrl;
          delete env.NO_PROXY;
          delete env.no_proxy;
        } catch (proxyErr) {
          const message = proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
          egressProxy = undefined;
          if (sandboxProfile.mode === "enforce") {
            // Fail closed (repo hard constraint) — "proxy unavailable while
            // enabled" denies, it never silently launches with unfiltered
            // egress. Thrown here so the outer catch's existing
            // cleanupSettings + emit("error")/emit("exit") path handles it
            // identically to a spawn failure.
            throw new Error(
              `[cc-session] EBH-4 egress proxy failed to start under mode "enforce" — refusing ` +
                `to launch (fail-closed): ${message}`,
              { cause: proxyErr },
            );
          }
          // audit — no worse than "off" (mirrors MacosSbplSandbox's
          // audit-canary-fail precedent): warn loudly, launch anyway,
          // WITHOUT proxy env vars, so this run simply has no egress
          // observability rather than a broken/inconsistent proxy config.
          process.stderr.write(
            `[cc-session] WARNING: EBH-4 egress proxy failed to start in audit mode (${message}) — ` +
              `this session launches WITHOUT egress filtering or observability this run. ` +
              `See docs/design-session-sandbox.md §4.3.\n`,
          );
        }
      }

      this.proc = sandbox.spawn(["claude", ...args], sandboxProfile, {
        stdout: "pipe",
        stderr: "pipe",
        env,
        cwd: this.opts.cwd,
      });

      if (egressProxy) {
        const proxy = egressProxy;
        // Tear the proxy down with the session — a listener left running
        // past the child's exit is a leaked local port, not a security
        // issue (127.0.0.1-only, deny-by-default even while orphaned), but
        // leaking it is still sloppy and would eventually exhaust ephemeral
        // ports on a long-lived daemon.
        void this.proc.exited.finally(() => {
          proxy.stop();
        });
        // EBH-4 (DD-6-style observability) — drain the proxy's denial
        // stream for the lifetime of this session, mirroring EXACTLY the
        // `SessionSandbox.denials()` loop below (same AsyncIterable
        // consumption shape, same "security-event" EventEmitter payload,
        // same never-let-the-drain-loop-crash-the-session discipline).
        void (async () => {
          try {
            for await (const denial of proxy.denials()) {
              const event: EgressDenialEvent = {
                type: "system.security.egress-denial",
                mode: sandboxProfile.mode as "audit" | "enforce",
                host: denial.host,
                port: denial.port,
                reason: denial.reason,
                blocked: denial.blocked,
                timestamp: denial.timestamp,
              };
              this.emit("security-event", event);
              process.stderr.write(
                `[cc-session] ${event.type} mode=${event.mode} host=${event.host} ` +
                  `port=${event.port} blocked=${event.blocked} reason="${event.reason}"\n`,
              );
            }
          } catch (err) {
            console.warn(
              "cc-session: egress-proxy denial stream ended unexpectedly:",
              err instanceof Error ? err.message : String(err),
            );
          }
        })();
      }

      // EBH-3a (DD-6) — drain the backend's denial stream in the background
      // for the lifetime of this session and surface each one the same way
      // `onUnavailable` is surfaced above: a "security-event" EventEmitter
      // payload (not yet a direct bus publish — same "future bus publisher"
      // scoping as sandbox-unavailable) plus a stderr line. `none`'s
      // `denials()` never yields (nothing enforced, nothing to deny), so
      // this loop is a permanent no-op for every session until a real
      // backend resolves AND its mode is audit/enforce — see
      // `session-sandbox-macos.ts`.
      void (async () => {
        try {
          for await (const denial of sandbox.denials()) {
            const event: SandboxDenialEvent = {
              type: "system.security.sandbox-denial",
              backend: sandbox.backend,
              mode: sandboxProfile.mode,
              ...(denial.path && { path: denial.path }),
              ...(denial.host && { host: denial.host }),
              reason: denial.reason,
              timestamp: denial.timestamp,
            };
            this.emit("security-event", event);
            process.stderr.write(
              `[cc-session] ${event.type} backend=${event.backend} mode=${event.mode} ` +
                `path=${event.path ?? "-"} host=${event.host ?? "-"} reason="${event.reason}"\n`,
            );
          }
        } catch (err) {
          // A denial-stream failure (e.g. `log stream` itself crashed) must
          // never take the session down with it — log and move on.
          console.warn(
            "cc-session: sandbox denial stream ended unexpectedly:",
            err instanceof Error ? err.message : String(err),
          );
        }
      })();

      // Start inactivity-based timeout (resets on every stream event)
      this.resetInactivityTimer();

      // Wire stdout streaming (track promise so wireExit can await drain)
      this.stdoutDone = this.pipeStdout();

      // Wire stderr (for error detection). Tracked so wireExit can await the
      // drain before settling — an auth failure's message must be captured
      // before the result resolves (cortex#2055).
      this.stderrDone = this.pipeStderr();

      // Wire exit (waits for stdout drain before emitting "exit")
      void this.wireExit();
    } catch (error) {
      // Spawn failed before the process existed — clean up the curated
      // settings temp dir we just created (cortex#701), and any EBH-4
      // egress proxy that bound its port before the failure (whether the
      // failure WAS the proxy — the enforce fail-closed throw above — or a
      // later `sandbox.spawn` failure with a proxy already listening).
      this.cleanupSettings();
      egressProxy?.stop();
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit("error", err);
      this.emit("exit", 1);
    }

    return this;
  }

  /**
   * cortex#701 — remove the per-session curated-settings temp dir. Called
   * on process exit (wireExit) and on spawn failure. Idempotent.
   */
  private cleanupSettings(): void {
    if (this.isolatedSettings) {
      this.isolatedSettings.cleanup();
      this.isolatedSettings = null;
    }
  }

  /** Kill the CC process with graceful escalation (SIGINT → 2s → SIGTERM). */
  kill(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (!this.proc) return;
    // Give CC a chance to clean up child sessions
    this.proc.kill("SIGINT");
    const proc = this.proc;
    setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch (err) {
        console.warn("cc-session: SIGTERM failed (process likely already exited):", err instanceof Error ? err.message : err);
      }
    }, 2_000);
  }

  /**
   * Await full completion — returns a CCSessionResult.
   * The sync-compatible path: `start() + wait()` produces the same
   * final blob as a request/response invocation, while the underlying
   * stream still emits incremental tool-use / text events for callers
   * that listen.
   */
  async wait(): Promise<CCSessionResult> {
    if (!this.proc) {
      this.start();
    }

    return new Promise<CCSessionResult>((resolve) => {
      // Must listen for "error" to prevent unhandled EventEmitter crash
      // (e.g. timeout fires emit("error") with no listener → process crash).
      //
      // The inactivity-timeout path settles HERE first (with exitCode: 1),
      // BEFORE wireExit() observes the eventual SIGTERM and emits "exit"
      // with exitCode: 143. Callers therefore cannot rely on exit code 143
      // alone to detect aborts — they must check `aborted` instead.
      this.on("error", (err: Error) => {
        void err; // referenced by name above for documentation; payload is on `this.timedOut`
        const durationMs = Math.round(performance.now() - this.startTime);
        resolve({
          success: false,
          response: this.result ?? "",
          sessionId: this.sessionId,
          exitCode: 1,
          durationMs,
          usage: this.usage,
          ...(this.stderrText && { stderr: this.stderrText }),
          ...(this.timedOut && { aborted: true, abortReason: "timeout" as const }),
        });
      });

      this.on("exit", (code: number) => {
        const durationMs = Math.round(performance.now() - this.startTime);
        resolve({
          success: code === 0,
          response: this.result ?? "",
          sessionId: this.sessionId,
          exitCode: code,
          durationMs,
          usage: this.usage,
          ...(this.stderrText && { stderr: this.stderrText }),
          // The exit path can also be reached on inactivity timeout —
          // wireExit() races with the error listener and may win when CC
          // exits in response to SIGINT before the error has been emitted.
          // Either way, `this.timedOut` is the source of truth.
          ...(this.timedOut && { aborted: true, abortReason: "timeout" as const }),
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Inactivity timeout — resets on every stream event from CC
  // ---------------------------------------------------------------------------

  private resetInactivityTimer(): void {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    const timeout = this.opts.timeoutMs ?? 120_000;
    this.timeoutId = setTimeout(() => {
      const mins = Math.round(timeout / 60_000);
      console.error(`cc-session: timed out after ${mins} minutes of inactivity`);
      this.timedOut = true;
      this.kill();
      this.emit("error", new Error(`Timed out after ${mins} minute${mins !== 1 ? "s" : ""} of inactivity`));
    }, timeout);
  }

  // ---------------------------------------------------------------------------
  // Internal stream wiring
  // ---------------------------------------------------------------------------

  private async pipeStdout(): Promise<void> {
    if (!this.proc?.stdout) return;

    const stdout = this.proc.stdout;
    if (typeof stdout === "number") return;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = this.lineBuffer.feed(chunk);

        for (const line of lines) {
          this.processLine(line);
        }
      }

      // Flush any remaining buffer
      const remaining = this.lineBuffer.flush();
      if (remaining) this.processLine(remaining);
    } catch (_err) {
      // Stream closed — expected on process exit
    }
  }

  private async pipeStderr(): Promise<void> {
    if (!this.proc?.stderr) return;
    const stderr = this.proc.stderr;
    if (typeof stderr === "number") return;

    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];

    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      console.warn("cc-session: stderr stream closed:", err instanceof Error ? err.message : String(err));
    }

    const stderrText = chunks.join("");
    // cortex#2055 — retain the raw stderr on the session so the result can
    // carry it (auth failures print here and never reach the stdout stream).
    this.stderrText = stderrText;
    if (stderrText.trim()) {
      // Only emit if there's meaningful stderr (not just progress indicators)
      const meaningful = stderrText.trim().split("\n").filter(
        (l: string) => !l.startsWith("⠋") && !l.startsWith("⠙") && l.trim()
      ).join("\n");
      if (meaningful) {
        this.emit("stderr", meaningful);
      }
    }
  }

  private timedOut = false;

  private async wireExit(): Promise<void> {
    if (!this.proc) return;

    const exitCode = await this.proc.exited;

    // Wait for stdout to fully drain before firing exit — prevents race
    // where clearProgress runs before late tool-use events are processed.
    await this.stdoutDone;
    // cortex#2055 — also drain stderr so `this.stderrText` is complete before
    // the result settles (auth-failure detection reads it).
    await this.stderrDone;

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    // cortex#701 — drop the curated-settings temp dir now the process has
    // exited (the file is only needed for the lifetime of the CC process).
    this.cleanupSettings();

    // Don't emit a second "error" if timeout already handled it (exit 143 = SIGTERM from kill)
    if (exitCode !== 0 && !this.result && !this.timedOut) {
      this.emit("error", new Error(`Claude exited with code ${exitCode}`));
    }

    this.emit("exit", exitCode);
  }

  private processLine(line: string): void {
    const event = parseStreamLine(line);
    if (!event) return;

    // Any parsed event = CC is alive. Reset inactivity timer.
    this.resetInactivityTimer();

    switch (event.type) {
      case "init":
        if (event.sessionId) {
          this.sessionId = event.sessionId;
          this.emit("session-id", event.sessionId);
        }
        break;

      case "text":
        if (event.text) {
          this.emit("text", event.text);
        }
        break;

      case "tool_use":
        if (event.toolName) {
          this.emit("tool-use", event.toolName, event.toolInput ?? {});
        }
        break;

      case "result":
        this.result = event.text ?? "";
        if (event.sessionId) {
          this.sessionId = event.sessionId;
        }
        if (event.usage) {
          this.usage = event.usage;
          this.emit("usage", event.usage);
        }
        this.emit("result", this.result);
        break;
    }
  }
}
