#!/usr/bin/env bun
/**
 * Cortex Path Guard — PreToolUse hook for the file tools (Read/Write/Edit/
 * Glob/Grep/NotebookEdit) in cortex sessions (EBH-1, cortex#2343, F1/F6).
 *
 * ## Why this exists
 *
 * Before this hook, NOTHING cortex-owned denied a file-tool call outside a
 * session's configured `allowedDirs`/`readOnlyDirs` — the boundary was
 * `--add-dir` (an ADDITIVE grant, not a deny) plus the natural-language
 * `FILESYSTEM RESTRICTION` / `READ-ONLY RESTRICTION` rules in
 * `security-preamble.ts`, which an injected instruction can simply ask the
 * model to ignore (docs/design-session-sandbox.md §1, F1/F6). This hook is
 * the deterministic Tier-0 guard that design spec commissions for the file
 * tools; `bash-guard.hook.ts`'s new path checks (cortex#2343 step 3) cover
 * the equivalent Bash read-command surface.
 *
 * ## I/O contract — mirrors bash-guard.hook.ts
 *
 *   - Activation gate: only acts when `CORTEX_CHANNEL` (or the legacy
 *     `GROVE_CHANNEL` read-fallback) is set — a non-cortex session passes
 *     through UNCHANGED (`{"continue":true}`).
 *   - `deny(reason)` / `pass()` emit the exact same
 *     `hookSpecificOutput.permissionDecision` JSON shapes bash-guard.hook.ts
 *     does, so the reason surfaces to the agent + the Cortex→Discord relay.
 *   - `grant(reason)` is this hook's own auto-approve terminal — Claude Code
 *     reads `hookSpecificOutput.permissionDecision:"allow"` and skips the
 *     normal approval prompt, exactly like bash-guard's grant().
 *
 * ## Deliberate divergence from bash-guard on stdin handling
 *
 * bash-guard races the stdin read against a 200ms timer and falls back to
 * `pass()` on a miss — sound for bash-guard because Bash is allow-by-default
 * there, so a missed read merely defers to Claude Code's own gate. THIS
 * hook's task explicitly requires FAIL CLOSED on any parse/resolve failure.
 * So instead it reads stdin to EOF (bounded by a hang-stop cap, mirroring
 * skill-guard.hook.ts's more recent, more conservative pattern) and treats
 * an empty/unparseable payload as a DENY, never a pass-through — this hook
 * is registered ONLY on the `Read|Write|Edit|Glob|Grep|NotebookEdit` matcher, so if it
 * runs at all the call is one of ours to gate; an empty read means the
 * payload capture failed, not "this isn't governed".
 *
 * ## Policy source — CORTEX_PATH_GUARD
 *
 * `CORTEX_PATH_GUARD` carries `{"allowedDirs":[...],"readOnlyDirs":[...]}`,
 * written unconditionally by `cc-session.ts` (mirroring how
 * `CORTEX_BASH_GUARD` is populated — {@link resolvePathGuardEnv} in
 * `cc-session.ts`). An EMPTY policy (`{}`, unset, or `{allowedDirs:[],
 * readOnlyDirs:[]}`) is treated as "no restriction configured" and passes
 * through — this matches the EXISTING contract `security-preamble.ts`
 * already encodes (`allDirs.length > 0` gates whether the FILESYSTEM
 * RESTRICTION prose even appears); this hook makes that SAME contract real
 * instead of advisory, it does not change WHEN restriction applies. A
 * MALFORMED `CORTEX_PATH_GUARD` (present but not parseable JSON, or not an
 * object) is a genuine failure, not "empty" — DENY.
 */

import { isAbsolute, join, resolve as resolvePath } from "path";
import { appendFileSync, mkdirSync, chmodSync, existsSync } from "fs";
import { EVENT_TYPES } from "../../taps/cc-events/hooks/lib/event-taxonomy";
import { eventsDir } from "../../common/events-path";
import { resolveSurfaceEnv } from "../../taps/cc-events/hooks/lib/surface-env";
import { resolvePrincipalEnv } from "../../taps/cc-events/hooks/lib/principal-env";
import { isContainedIn, expandUserPath, isUnresolvedShellToken } from "../../common/path-containment";

// =============================================================================
// Hook I/O types
// =============================================================================

interface FilePathToolInput {
  file_path?: unknown;
}

interface GlobGrepToolInput {
  path?: unknown;
  // Grep: content regex — NEVER a path. Glob: a filesystem glob — its
  // LITERAL directory prefix (everything before the first glob metachar)
  // IS a path and must be containment-checked (cortex#2343 adversarial
  // review finding B2) — see {@link derivePatternGlobRoot}.
  pattern?: unknown;
}

interface NotebookEditToolInput {
  notebook_path?: unknown;
}

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: FilePathToolInput | GlobGrepToolInput | NotebookEditToolInput | string | null;
}

/**
 * Tools this hook governs. Matches the `cortex-hooks.json` matcher exactly.
 * `NotebookEdit` added per cortex#2343 adversarial review finding B4: it is
 * a grantable, mutating file tool (`src/common/policy/tool-inventory.ts`)
 * that was previously omitted entirely — any stack granting it got
 * unchecked arbitrary-path read/write via `notebook_path`. `MultiEdit` is
 * NOT in `CLAUDE_TOOL_INVENTORY` (verified against tool-inventory.ts) — not
 * a grantable cortex tool at this version, so it is out of scope here.
 */
const GOVERNED_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"]);

/** Tools whose call MUTATES the filesystem — denied on a `readOnlyDirs` hit. */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/**
 * Glob metacharacters that mark the end of a pattern's LITERAL directory
 * prefix, EXCLUDING `{` — brace groups are handled separately by
 * {@link expandBraceAlternatives} so their CONTENTS get inspected rather
 * than treated as an opaque metachar boundary (cortex#2343 adversarial
 * review round 2, finding R2: `{../secret,x}/*` used to stop at `{` and
 * never see the `../secret` traversal hiding inside it).
 */
const GLOB_METACHAR_RE = /[*?[]/;

/**
 * Derive the containment-checkable directory prefix from a single Glob
 * pattern ALTERNATIVE (braces already resolved — see
 * {@link expandBraceAlternatives}). Takes everything before the first glob
 * metachar, then trims back to the last `/` in that prefix — a partial
 * trailing SEGMENT (e.g. the `fo` in `fo*o`) is not a real directory
 * boundary and is dropped rather than mis-containment-checked. Returns `""`
 * when the pattern has no directory prefix worth checking (e.g. `*.ts`,
 * `**\/*.ts`) — that case relies on the `path` field (if given) or the
 * session's already-scoped cwd. Exported for unit tests.
 */
export function derivePatternGlobRoot(pattern: string): string {
  const metaIdx = pattern.search(GLOB_METACHAR_RE);
  const prefix = metaIdx === -1 ? pattern : pattern.slice(0, metaIdx);
  const lastSlash = prefix.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return prefix.slice(0, lastSlash + 1);
}

export type BraceExpansionResult =
  | { kind: "none" } // no brace group at all — treat `pattern` as the sole alternative
  | { kind: "expanded"; alternatives: string[] } // one clean brace group, resolved
  | { kind: "ambiguous" }; // nested/unbalanced/multiple brace groups — FAIL CLOSED

/**
 * Expand ONE level of brace alternatives in a Glob pattern:
 * `"{a,b,c}/x"` → `["a/x", "b/x", "c/x"]` (cortex#2343 adversarial review
 * round 2, finding R2 — `derivePatternGlobRoot` alone stops at the first
 * metachar, so `{../secret,x}/*` never got its `../secret` alternative
 * inspected at all).
 *
 * FAILS CLOSED (`kind: "ambiguous"`) rather than guessing on anything this
 * simple one-level parser can't confidently handle: a nested brace group
 * inside the first one, more than one top-level brace group, or an
 * unbalanced `{`/`}`. The instruction from the adversarial review is
 * explicit: "if brace parsing is at all uncertain, DENY the pattern" —
 * legitimate Glob patterns never need nested/multiple brace groups, so
 * denying that shape costs nothing real. Exported for unit tests.
 */
export function expandBraceAlternatives(pattern: string): BraceExpansionResult {
  const firstOpen = pattern.indexOf("{");
  if (firstOpen === -1) return { kind: "none" };

  const firstClose = pattern.indexOf("}", firstOpen);
  if (firstClose === -1) return { kind: "ambiguous" }; // unbalanced

  const inner = pattern.slice(firstOpen + 1, firstClose);
  if (inner.includes("{") || inner.includes("}")) return { kind: "ambiguous" }; // nested

  const rest = pattern.slice(firstClose + 1);
  if (rest.includes("{") || rest.includes("}")) return { kind: "ambiguous" }; // a second group

  const prefix = pattern.slice(0, firstOpen);
  const options = inner.split(",");
  const alternatives = options.map((opt) => prefix + opt + rest);
  return { kind: "expanded", alternatives };
}

/**
 * True when `patternRoot` (a derived literal directory prefix — may be `""`
 * when the pattern has none) is inherently unsafe for a Glob `pattern`
 * argument: absolute, or carrying a `..` path segment. Per the adversarial
 * review: "legit globs never need `..`, absolute, or escaping braces" — a
 * risky alternative denies the WHOLE Glob call outright rather than being
 * handed to the normal containment check (which could, in principle, still
 * ALLOW an absolute pattern that happens to resolve inside scope — the
 * review wants a strictly narrower, unconditional rule for Glob's pattern
 * argument specifically). Exported for unit tests.
 */
export function isRiskyGlobPatternRoot(patternRoot: string): boolean {
  if (patternRoot === "") return false;
  if (isAbsolute(patternRoot)) return true;
  return patternRoot.split("/").some((segment) => segment === "..");
}

// =============================================================================
// CORTEX_PATH_GUARD config
// =============================================================================

export interface PathGuardPolicy {
  allowedDirs: string[];
  readOnlyDirs: string[];
}

export interface PathGuardConfigResult {
  /** false only for a GENUINE failure (present-but-malformed env value). */
  ok: boolean;
  policy: PathGuardPolicy;
  reason: string;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Parse `CORTEX_PATH_GUARD`. Absence is a LEGITIMATE empty policy (not a
 * failure) — see the module doc's "Policy source" section. A present value
 * that isn't parseable JSON, or doesn't parse to an object, IS a failure —
 * `ok:false` — callers must DENY rather than silently substitute an empty
 * policy for a malformed one. Exported for unit tests.
 */
export function parsePathGuardConfig(raw: string | undefined): PathGuardConfigResult {
  if (raw === undefined || raw.trim() === "") {
    return { ok: true, policy: { allowedDirs: [], readOnlyDirs: [] }, reason: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      policy: { allowedDirs: [], readOnlyDirs: [] },
      reason: `CORTEX_PATH_GUARD is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      policy: { allowedDirs: [], readOnlyDirs: [] },
      reason: "CORTEX_PATH_GUARD did not parse to a JSON object",
    };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    ok: true,
    policy: {
      allowedDirs: toStringArray(obj.allowedDirs),
      readOnlyDirs: toStringArray(obj.readOnlyDirs),
    },
    reason: "",
  };
}

// =============================================================================
// tool_input path extraction
// =============================================================================

export interface ExtractedPaths {
  /**
   * null = the call must be DENIED for this tool — either a required path is
   * missing (malformed call), or (Glob only) the `pattern` argument is
   * itself unsafe/ambiguous (absolute, carries a `..` segment, or brace
   * parsing was uncertain — cortex#2343 adversarial review round 2, R2).
   */
  paths: string[] | null;
  /** Populated when `paths` is null — WHY the call must be denied. Falls
   *  back to a generic reason at the call site when absent. */
  reason?: string;
}

/**
 * Extract the filesystem path(s) this tool call touches, for the tools this
 * hook governs. Exported for unit tests.
 *
 *   - Read/Write/Edit: `tool_input.file_path` — REQUIRED; missing/non-string
 *     is malformed (`paths: null`).
 *   - NotebookEdit: `tool_input.notebook_path` — REQUIRED, same treatment
 *     (cortex#2343 finding B4).
 *   - Grep: `tool_input.path` — OPTIONAL (defaults to searching the
 *     invoking process's cwd when omitted, which `dispatch-handler.ts`
 *     already sets to an allowed dir — see the module doc). Absent →
 *     `paths: []` (nothing to containment-check, not a failure). `pattern`
 *     is NEVER treated as a path for Grep — it's a content regex.
 *   - Glob: `tool_input.path` (OPTIONAL root) PLUS the literal directory
 *     prefix of `tool_input.pattern` (cortex#2343 finding B2 — unlike
 *     Grep's, Glob's `pattern` IS a filesystem path/glob and can itself be
 *     absolute or carry `../` traversal). A relative pattern prefix is
 *     resolved against `path` when given; an absolute one is checked as-is
 *     regardless of `path`. Both candidates are checked when both are
 *     present. Neither present ⇒ `paths: []` (relies on cwd scope).
 */
export function extractCandidatePaths(toolName: string, toolInput: HookInput["tool_input"]): ExtractedPaths {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};

  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    const fp = (input as FilePathToolInput).file_path;
    if (typeof fp !== "string" || fp.trim() === "") return { paths: null };
    return { paths: [fp] };
  }

  if (toolName === "NotebookEdit") {
    const np = (input as NotebookEditToolInput).notebook_path;
    if (typeof np !== "string" || np.trim() === "") return { paths: null };
    return { paths: [np] };
  }

  if (toolName === "Grep") {
    const p = (input as GlobGrepToolInput).path;
    if (typeof p !== "string" || p.trim() === "") return { paths: [] };
    return { paths: [p] };
  }

  if (toolName === "Glob") {
    const pathField = (input as GlobGrepToolInput).path;
    const hasExplicitPath = typeof pathField === "string" && pathField.trim() !== "";
    const explicitPath = hasExplicitPath ? (pathField as string) : undefined;

    const patternField = (input as GlobGrepToolInput).pattern;
    const paths: string[] = [];
    if (explicitPath !== undefined) paths.push(explicitPath);

    if (typeof patternField === "string") {
      // R2 fix (cortex#2343 adversarial review round 2): brace-aware
      // traversal/absolute check. Expand ONE level of brace alternatives
      // FIRST — `{../secret,x}/*` must have its `../secret` alternative
      // inspected, not hidden behind the `{` metachar boundary — then
      // treat every alternative (or the pattern itself, when there are no
      // braces) identically: any alternative whose derived literal
      // directory prefix is absolute or carries a `..` segment DENIES the
      // WHOLE Glob call outright (fail-closed; "legit globs never need
      // `..`, absolute, or escaping braces"). Ambiguous brace parsing
      // (nested/unbalanced/multiple groups) denies outright too.
      const braceResult = expandBraceAlternatives(patternField);
      const alternatives = braceResult.kind === "expanded" ? braceResult.alternatives : [patternField];

      if (braceResult.kind === "ambiguous") {
        return {
          paths: null,
          reason:
            `[Cortex Path Guard] Blocked Glob: pattern "${patternField}" has brace syntax ` +
            `this guard cannot confidently parse (nested, unbalanced, or multiple brace ` +
            `groups) — denying to stay fail-closed.`,
        };
      }

      for (const alt of alternatives) {
        const altRoot = derivePatternGlobRoot(alt);
        if (isRiskyGlobPatternRoot(altRoot)) {
          return {
            paths: null,
            reason:
              `[Cortex Path Guard] Blocked Glob: pattern "${patternField}" resolves to an ` +
              `absolute path or a ".." traversal segment ("${altRoot}") — Glob's pattern ` +
              `argument may never be absolute or traverse outside its root; use the ` +
              `\`path\` argument to point at a different (allowed) root instead.`,
          };
        }
        if (altRoot) {
          // Safe relative prefix — resolves against `path` when given
          // (mirrors how Glob itself would search relative to `path`);
          // with no `path`, pushed as-is and resolved against cwd
          // downstream (same treatment as every other relative candidate).
          paths.push(explicitPath === undefined ? altRoot : join(explicitPath, altRoot));
        }
      }
    }

    return { paths };
  }

  // Not a tool this hook governs (defensive — the matcher should already
  // exclude this call from ever reaching us).
  return { paths: [] };
}

// =============================================================================
// Decision emitters — byte-identical shapes to bash-guard.hook.ts
// =============================================================================

function pass(): void {
  console.log(JSON.stringify({ continue: true }));
}

function grant(reason: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: reason,
      },
    }),
  );
}

function deny(reason: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

// =============================================================================
// Telemetry — `tool.path.blocked`. Mirrors bash-guard.hook.ts's
// emitBlockEvent exactly (HTTP POST primary, JSONL fallback, best-effort —
// never throws, never delays or blocks the deny decision).
// =============================================================================

const INGEST_URL =
  process.env.CORTEX_INGEST_URL ?? "http://localhost:8766/api/events/ingest";
const EVENTS_DIR = eventsDir();
const RAW_DIR = join(EVENTS_DIR, "raw");

function buildBlockEvent(
  sessionId: string,
  reason: string,
  toolName: string,
  pathPreview: string,
): Record<string, unknown> {
  return {
    event_id: crypto.randomUUID(),
    event_type: EVENT_TYPES.PATH_BLOCKED,
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    cortex_channel: resolveSurfaceEnv("CHANNEL"),
    grove_channel: resolveSurfaceEnv("CHANNEL"),
    agent_id: resolveSurfaceEnv("AGENT_ID"),
    agent_name: resolveSurfaceEnv("AGENT_NAME"),
    network_id: resolveSurfaceEnv("NETWORK"),
    source: { hook: "PreToolUse", tool_name: toolName },
    payload: {
      reason,
      path_preview: pathPreview.slice(0, 200),
      project: resolveSurfaceEnv("PROJECT"),
      entity: resolveSurfaceEnv("ENTITY"),
      principal: resolvePrincipalEnv(""),
    },
  };
}

async function emitBlockEvent(
  sessionId: string,
  reason: string,
  toolName: string,
  pathPreview: string,
): Promise<void> {
  const event = buildBlockEvent(sessionId, reason, toolName, pathPreview);

  try {
    await fetch(INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(500),
    });
  } catch { /* dashboard down / refused — fall through to JSONL */ }

  try {
    if (!existsSync(RAW_DIR)) {
      mkdirSync(RAW_DIR, { recursive: true, mode: 0o700 });
    }
    const filePath = join(RAW_DIR, `${sessionId}.jsonl`);
    appendFileSync(filePath, JSON.stringify(event) + "\n");
    chmodSync(filePath, 0o600);
  } catch { /* filesystem unavailable — give up silently */ }
}

// =============================================================================
// stdin read — full read to EOF with a hang-stop cap. See the module doc
// ("Deliberate divergence from bash-guard on stdin handling") for why this
// hook does NOT use bash-guard's 200ms race.
// =============================================================================

const STDIN_READ_CAP_MS = 5_000;

async function readStdinToEof(): Promise<string> {
  const timedOut = Symbol("timedOut");
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Bun.stdin.text(),
    new Promise<typeof timedOut>((r) => {
      capTimer = setTimeout(() => {
        r(timedOut);
      }, STDIN_READ_CAP_MS);
    }),
  ]);
  if (capTimer !== undefined) clearTimeout(capTimer);
  if (outcome === timedOut) {
    throw new Error("path-guard: stdin read exceeded cap before EOF");
  }
  return outcome;
}

// =============================================================================
// Path decision — pure, exported for unit tests.
// =============================================================================

export interface PathDecision {
  allow: boolean;
  reason: string;
}

/**
 * Decide whether `absPath` is permitted for `toolName` under `policy`.
 * Pure — does its own realpath/containment I/O via `isContainedIn` but
 * takes no other state, so it's directly unit-testable against a real
 * temp-dir fixture. Exported for unit tests.
 */
export function decidePath(toolName: string, absPath: string, policy: PathGuardPolicy): PathDecision {
  const inAllowed = policy.allowedDirs.some((d) => isContainedIn(d, absPath));
  const inReadOnly = !inAllowed && policy.readOnlyDirs.some((d) => isContainedIn(d, absPath));

  if (!inAllowed && !inReadOnly) {
    return {
      allow: false,
      reason:
        `[Cortex Path Guard] Blocked ${toolName} "${absPath}": path resolves outside every ` +
        `configured allowedDirs/readOnlyDirs entry. This is a hard security boundary ` +
        `(EBH-1, cortex#2343) — ask the principal to widen allowedDirs if this path is ` +
        `genuinely needed.`,
    };
  }

  if (WRITE_TOOLS.has(toolName) && inReadOnly && !inAllowed) {
    return {
      allow: false,
      reason:
        `[Cortex Path Guard] Blocked ${toolName} "${absPath}": this path is inside a ` +
        `READ-ONLY directory — writes are refused (docs/security/reviews/` +
        `2026-07-23-nws-security-review.md F6). Reads remain permitted. Note: this is ` +
        `the read-only-write MECHANISM; F6 is fully closed in production once ` +
        `dispatch-handler.ts threads a distinct readOnlyDirs value through to ` +
        `CORTEX_PATH_GUARD on live sessions (EBH-1b).`,
    };
  }

  return { allow: true, reason: `[Cortex Path Guard] Auto-approved: "${absPath}" is within policy scope.` };
}

// =============================================================================
// main
// =============================================================================

async function main(): Promise<void> {
  // Gate — not a cortex session: pass through silently. Mirrors bash-guard's
  // gate 1 exactly (resolveSurfaceEnv reads CORTEX_CHANNEL with the legacy
  // GROVE_CHANNEL fallback).
  if (!resolveSurfaceEnv("CHANNEL")) {
    pass();
    return;
  }

  let input: HookInput;
  try {
    const raw = await readStdinToEof();
    if (!raw.trim()) {
      // This hook is registered ONLY on the Read|Write|Edit|Glob|Grep
      // matcher — an empty payload means capture failed, not "not ours".
      // FAIL CLOSED (see module doc).
      deny(
        "[Cortex Path Guard] Blocked: empty tool input — could not identify the " +
          "file-tool call; denying to stay fail-closed.",
      );
      return;
    }
    input = JSON.parse(raw) as HookInput;
  } catch (err) {
    deny(
      `[Cortex Path Guard] Blocked: could not read/parse the tool input (${err instanceof Error ? err.message : String(err)}) — denying to stay fail-closed.`,
    );
    return;
  }

  const toolName = input.tool_name ?? "";
  if (!GOVERNED_TOOLS.has(toolName)) {
    // Not one of ours (defensive — shouldn't happen given the matcher).
    pass();
    return;
  }

  const sessionId = input.session_id ?? process.env.CLAUDE_SESSION_ID ?? "unknown";

  const configResult = parsePathGuardConfig(process.env.CORTEX_PATH_GUARD);
  if (!configResult.ok) {
    const reason = `[Cortex Path Guard] Blocked ${toolName}: ${configResult.reason} — denying to stay fail-closed.`;
    deny(reason);
    await emitBlockEvent(sessionId, reason, toolName, "");
    return;
  }

  const { policy } = configResult;
  if (policy.allowedDirs.length === 0 && policy.readOnlyDirs.length === 0) {
    // No restriction configured for this session — matches the EXISTING
    // security-preamble.ts contract (see module doc's "Policy source").
    pass();
    return;
  }

  const extracted = extractCandidatePaths(toolName, input.tool_input);
  if (extracted.paths === null) {
    const reason =
      extracted.reason ??
      `[Cortex Path Guard] Blocked ${toolName}: no resolvable file_path in the tool ` +
        `input — denying to stay fail-closed.`;
    deny(reason);
    await emitBlockEvent(sessionId, reason, toolName, "");
    return;
  }

  if (extracted.paths.length === 0) {
    // Glob/Grep with no explicit `path` argument — nothing to containment-
    // check; relies on the session's cwd already being scoped inside
    // allowedDirs (dispatch-handler.ts sets cwd to the first allowed dir).
    grant(
      "[Cortex Path Guard] Auto-approved: no explicit path argument — relying on the " +
        "session's already-scoped working directory.",
    );
    return;
  }

  for (const rawPath of extracted.paths) {
    // B1 fix (cortex#2343 adversarial review): expand `~`/`$VAR` BEFORE
    // isAbsolute/resolve — see the identical rationale in bash-guard.hook.ts's
    // checkCommandPaths(). A file_path/path token of `~/.ssh/id_rsa` is not
    // absolute on its own, so without this it gets joined onto cwd as a
    // literal relative path and resolves harmlessly inside the allowed dir.
    const expandedPath = expandUserPath(rawPath);

    // R1 fix (cortex#2343 adversarial review round 2): FAIL CLOSED on
    // anything expandUserPath couldn't confidently resolve (a `~user` form,
    // or a literal `$` left over from an unmodelled expansion) — see the
    // identical rationale in bash-guard.hook.ts's checkCommandPaths().
    if (isUnresolvedShellToken(expandedPath)) {
      const reason =
        `[Cortex Path Guard] Blocked ${toolName}: path argument "${rawPath}" contains an ` +
        `unresolvable shell expansion (a ~user form or a literal "$") — denying to stay ` +
        `fail-closed.`;
      deny(reason);
      await emitBlockEvent(sessionId, reason, toolName, rawPath);
      return;
    }

    const absPath = isAbsolute(expandedPath) ? expandedPath : resolvePath(process.cwd(), expandedPath);
    const decision = decidePath(toolName, absPath, policy);
    if (!decision.allow) {
      deny(decision.reason);
      await emitBlockEvent(sessionId, decision.reason, toolName, absPath);
      return;
    }
  }

  grant(
    `[Cortex Path Guard] Auto-approved: ${toolName} path(s) resolve within the configured ` +
      `allowedDirs/readOnlyDirs policy.`,
  );
}

// Only execute the gate when run AS a script — mirrors skill-guard.hook.ts's
// `import.meta.main` guard so unit tests can import the pure helpers
// (parsePathGuardConfig / extractCandidatePaths / decidePath) without
// triggering main()'s stdin read.
if (import.meta.main) {
  main().catch((err: unknown) => {
    // An unexpected failure anywhere in the gate must fail CLOSED, not open.
    deny(
      `[Cortex Path Guard] Blocked: internal hook error (${err instanceof Error ? err.message : String(err)}) — denying to stay fail-closed.`,
    );
  });
}
