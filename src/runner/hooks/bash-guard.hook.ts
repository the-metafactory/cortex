#!/usr/bin/env bun
/**
 * Cortex Bash Guard — PreToolUse hook for Bash commands in cortex sessions.
 *
 * Only activates when the surface channel env var is set (cortex bot session):
 * cc-session sets `CORTEX_CHANNEL`; the legacy `GROVE_CHANNEL` name is retained
 * as a read-fallback during the GROVE_* → CORTEX_* transition (cortex#767/#774).
 * Enforces a command allowlist with repo restrictions for gh CLI.
 * Non-cortex sessions pass through unchanged.
 *
 * Config via CORTEX_BASH_GUARD env var (JSON):
 *   { "rules": [{ "pattern": "^gh\\s+pr", "repos": ["owner/repo"] }] }
 *
 * If no config env var, uses sensible defaults (gh, git read-only, ls, pwd).
 *
 * Block behaviour (cortex#bash-guard-observability):
 *   - Emits Claude Code's structured PreToolUse *deny* decision on stdout
 *     ({"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *       "permissionDecision":"deny","permissionDecisionReason":"…"}}).
 *     The reason surfaces to the agent (and the Cortex→Discord relay)
 *     instead of being lost in an exit-code-2 + stderr line.
 *   - Also emits a `tool.bash.blocked` telemetry event into the cc-events
 *     pipeline (HTTP POST to the dashboard ingest endpoint, with a JSONL
 *     fallback) so blocks are observable. Best-effort — never blocks the
 *     deny decision.
 */

import { appendFileSync, mkdirSync, chmodSync, existsSync } from "fs";
import { join } from "path";
import { EVENT_TYPES } from "../../taps/cc-events/hooks/lib/event-taxonomy";
import { resolveSurfaceEnv } from "../../taps/cc-events/hooks/lib/surface-env";
import { resolvePrincipalEnv } from "../../taps/cc-events/hooks/lib/principal-env";

interface HookInput {
  session_id?: string;
  tool_name: string;
  tool_input: { command?: string } | string;
}

interface AllowRule {
  pattern: string;
  repos?: string[];
}

/**
 * Read-only AWS CLI allowlist pattern.
 *
 * This is the regex halden's `bashAllowlist` uses for its `aws` rule. It is
 * exported (and unit-tested in bash-guard.hook.test.ts) so the live config
 * inherits a *proven* read-only-only pattern rather than a hand-rolled one.
 *
 * Tolerates, before the verb:
 *   - global flags `--profile <x>` / `--region <x>` / `--output <x>` and the
 *     valueless `--no-cli-pager`.
 *   (A leading env prefix — `AWS_PROFILE=… aws …` — is stripped by the hook's
 *    stripEnvPrefix() before matching, so it is not modelled in the regex.)
 *
 * Allows ONLY read-only verbs:
 *   - `sts get-caller-identity`
 *   - `<service> describe-*` / `<service> get-*` / `<service> list-*`
 *
 * MUST NOT match any write/exec verb: send-command, start-session,
 * run-instances, terminate-*, stop-*, start-*, *-create-*, delete-*, put-*,
 * modify-*, update-*, reboot-*, etc. Those never begin with describe/get/list,
 * so the verb-prefix anchor denies them by construction. When in doubt, deny.
 *
 * Note: this pattern only governs whether a single, well-formed `aws …`
 * invocation is *read-only*. The hook's metacharacter guard (rejectsChaining)
 * independently refuses any attempt to smuggle a second command via pipes,
 * substitution, backticks, redirects, background `&`, or newlines — so an
 * allow-match here can never carry a hidden destructive command.
 */
export const READONLY_AWS_PATTERN =
  // ^aws
  "^aws" +
  // optional global flags before the service. Each --profile/--region/--output
  // consumes its value via \S+ (which excludes whitespace, so a flag value can
  // never itself supply a "service verb" pair); --no-cli-pager is valueless.
  "(?:\\s+(?:--(?:profile|region|output)\\s+\\S+|--no-cli-pager))*" +
  // service + read-only verb
  "\\s+(?:" +
  // sts get-caller-identity (the one explicitly-allowed get on sts)
  "sts\\s+get-caller-identity" +
  "|" +
  // <service> describe-* / get-* / list-*. Service must start with a letter
  // so a flag token like `--profile` can never be mistaken for a service (which
  // would let `--profile describe-instances` smuggle a read verb past the flag
  // consumer).
  "[a-z][a-z0-9-]*\\s+(?:describe|get|list)-[a-z0-9-]+" +
  ")" +
  // must end here or be followed by whitespace (args) — never glued to more
  // verb characters (blocks `run-describe-hack` from matching `describe`).
  "(?:\\s|$)";

interface GuardConfig {
  rules: AllowRule[];
  repos?: string[];  // Global repo whitelist (applies to all gh commands)
}

const DEFAULT_CONFIG: GuardConfig = {
  rules: [
    { pattern: "^gh\\s+(pr|issue|repo|api|run)\\s" },
    { pattern: "^git\\s+(log|diff|show|status|branch|fetch|remote|rev-parse)\\b" },
    { pattern: "^ls\\b" },
    { pattern: "^pwd$" },
    { pattern: "^echo\\b" },
    { pattern: "^cat\\b" },
    { pattern: "^head\\b" },
    { pattern: "^tail\\b" },
    { pattern: "^wc\\b" },
    { pattern: "^which\\b" },
    { pattern: "^file\\b" },
  ],
  repos: [],
};

// Narrow projection of the CORTEX_BASH_GUARD env var payload. The hook
// reads only `disabled` / `rules` / `repos`; anything else is ignored.
interface GuardConfigRaw {
  disabled?: boolean;
  rules?: AllowRule[];
  repos?: string[];
}

function loadConfig(): GuardConfig | null {
  const raw = process.env.CORTEX_BASH_GUARD;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as GuardConfigRaw;
      // G-300: Principal DM disables bash guard entirely
      if (parsed.disabled) return null;
      return {
        rules: parsed.rules ?? DEFAULT_CONFIG.rules,
        repos: parsed.repos ?? [],
      };
    } catch { /* fall through */ }
  }
  return DEFAULT_CONFIG;
}

/**
 * Extract repo from gh CLI command (--repo owner/name or -R owner/name).
 * Also handles: gh api repos/owner/name/...
 */
function extractGhRepo(command: string): string | null {
  const repoFlag = /(?:--repo|-R)\s+([^\s]+)/.exec(command);
  if (repoFlag) return repoFlag[1] ?? null;

  const apiPath = /gh\s+api\s+repos\/([^/]+\/[^/\s]+)/.exec(command);
  if (apiPath) return apiPath[1] ?? null;

  return null;
}

/**
 * Strip leading env var assignments to prevent bypass.
 * e.g., LANG=C gh pr view ... → gh pr view ...
 */
function stripEnvPrefix(command: string): string {
  return command.replace(
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+)*/,
    "",
  );
}

/**
 * No-bypass guard: detect shell metacharacters that could smuggle a SECOND
 * command past an allow-prefix.
 *
 * The allowlist matcher below splits on `&& || ;` and validates each segment,
 * so a chain of *allowed* commands (`ls && pwd`) is fine. But the following
 * constructs can carry a command that the segment-matcher never inspects, so
 * any command containing them is denied outright — regardless of which allow
 * pattern the head matches. This protects EVERY pattern (gh / git / aws / …),
 * not just the read-only aws rule.
 *
 *   |          pipe — RHS command never validated
 *   $(  )      command substitution
 *   `  `       backtick command substitution
 *   &          background / job-control (a lone `&`, not part of `&&`)
 *   <  >       redirection (can clobber files / read secrets)
 *   newline    a second command on the next line
 *
 * Returns true when the command must be rejected.
 *
 * Note: this is intentionally conservative. It does not attempt to parse
 * quoting — a `|` inside a quoted argument is rare in the read-only command
 * surface this guard governs, and denying it (false positive) is the safe
 * direction. When in doubt, deny.
 */
function rejectsChaining(command: string): boolean {
  // Newline (any flavour) → a second command line.
  if (/[\r\n]/.test(command)) return true;
  // Command substitution `$(` (covers `$(( ))` too) and backticks.
  if (command.includes("$(")) return true;
  if (command.includes("`")) return true;
  // Redirection — can clobber files or read secrets.
  if (/[<>]/.test(command)) return true;
  // A single pipe `|` that is NOT one half of the `||` chain token. We
  // collapse every `||` to a placeholder first, then look for a remaining `|`.
  if (command.replace(/\|\|/g, "").includes("|")) return true;
  // A single `&` that is NOT part of the `&&` chain token (i.e. background
  // / job-control). Same collapse trick.
  if (command.replace(/&&/g, "").includes("&")) return true;
  return false;
}

// =============================================================================
// Pass / grant / deny output — Claude Code PreToolUse hook protocol.
//
// Three decisions, three meanings:
//   pass()  — pass-through ({"continue": true}). Defer to Claude Code's normal
//             permission flow. Used by the paths that are out of this guard's
//             scope (non-cortex / CLI-principal / disabled-guard / non-Bash /
//             empty command). NOT an approval: in a restricted default-mode
//             session the normal gate still applies. That is intentional for
//             these paths — they are either already-permissive or not ours.
//   grant() — auto-approve (permissionDecision:"allow"). The STRICT success
//             terminal of the allowlist (cortex#777). Emitted ONLY after a
//             command passed rejectsChaining, matched an allowlist rule for
//             every chained part, and cleared any gh repo-restriction. This is
//             what lets an allowlisted+safe command run in async `--print`
//             dispatch without a "requires approval" prompt.
//   deny()  — permissionDecision:"deny" with a reason that surfaces to the
//             agent and the Cortex→Discord relay.
// =============================================================================

/** Emit the pass-through decision (unchanged contract). Defers to CC's gate. */
function pass(): void {
  console.log(JSON.stringify({ continue: true }));
}

/**
 * Emit Claude Code's structured PreToolUse *auto-approve* decision (cortex#777).
 *
 * This is the allowlist's success terminal. The harness reads
 * `hookSpecificOutput.permissionDecision` — "allow" tells Claude Code to run
 * the tool call WITHOUT prompting, so an allowlisted command actually executes
 * in a restricted async `--print` session instead of stalling on "requires
 * approval".
 *
 * SECURITY INVARIANT: grant() is the strict success terminal. It is reachable
 * ONLY from the end of main() — after rejectsChaining passed, every chained
 * part matched an allowlist rule, and any gh repo-restriction passed. There is
 * no other call site, and every deny-worthy branch returns BEFORE this point.
 */
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

/**
 * Emit Claude Code's structured PreToolUse *deny* decision. The
 * `permissionDecisionReason` surfaces back to the agent (and the
 * Cortex→Discord relay) — it replaces the old `process.exit(2)` +
 * stderr line, which got swallowed on the way to the principal.
 */
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
// Telemetry — emit a `tool.bash.blocked` event into the cc-events pipeline.
// Mirrors EventLogger.hook.ts: HTTP POST to the dashboard ingest endpoint as
// primary delivery, JSONL append as fallback/archive. Best-effort — a failure
// here must never affect the deny decision.
// =============================================================================

// Default targets the local dashboard ingest endpoint. Overridable via
// CORTEX_INGEST_URL so tests can point the POST at an ephemeral port instead of
// the hardcoded 8766 (which collides with sibling Bun.serve suites under the
// full test run). Production leaves the env unset → unchanged behaviour.
const INGEST_URL =
  process.env.CORTEX_INGEST_URL ?? "http://localhost:8766/api/events/ingest";
const EVENTS_DIR = join(process.env.HOME ?? "~", ".claude", "events");
const RAW_DIR = join(EVENTS_DIR, "raw");

/** Shape mirrors `RawEvent` from src/taps/cc-events/hooks/lib/event-types.ts. */
function buildBlockEvent(
  sessionId: string,
  reason: string,
  command: string,
): Record<string, unknown> {
  return {
    event_id: crypto.randomUUID(),
    event_type: EVENT_TYPES.BASH_BLOCKED,
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    // G-2a (cortex#779): read CORTEX_* with a GROVE_* fallback via the shared
    // surface/principal resolvers — same chain the EventLogger hooks use. Since
    // cc-session now SETS the CORTEX_* names (not GROVE_*), reading GROVE_* only
    // would emit undefined channel/agent/network metadata on every block event.
    // GV-2 (cortex#1077): DUAL-WRITE the channel label — canonical
    // `cortex_channel` AND legacy `grove_channel` (retires at v3.0.0). The
    // GROVE_* env fallback inside resolveSurfaceEnv is the cortex#774 shim and
    // is intentionally left intact.
    cortex_channel: resolveSurfaceEnv("CHANNEL"),
    grove_channel: resolveSurfaceEnv("CHANNEL"),
    agent_id: resolveSurfaceEnv("AGENT_ID"),
    agent_name: resolveSurfaceEnv("AGENT_NAME"),
    network_id: resolveSurfaceEnv("NETWORK"),
    source: { hook: "PreToolUse", tool_name: "Bash" },
    payload: {
      reason,
      command_preview: command.slice(0, 200),
      project: resolveSurfaceEnv("PROJECT"),
      entity: resolveSurfaceEnv("ENTITY"),
      // R9 operator→principal rename: CORTEX_PRINCIPAL → GROVE_OPERATOR fallback.
      principal: resolvePrincipalEnv(""),
    },
  };
}

/**
 * Emit the block event. Never throws — telemetry is observability, not a
 * gate. Returns once both the POST attempt and the JSONL append have been
 * tried (each independently best-effort).
 */
async function emitBlockEvent(
  sessionId: string,
  reason: string,
  command: string,
): Promise<void> {
  const event = buildBlockEvent(sessionId, reason, command);

  // Primary: HTTP POST to the dashboard ingest endpoint (500ms cap).
  try {
    await fetch(INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(500),
    });
  } catch { /* dashboard down / refused — fall through to JSONL */ }

  // Fallback/archive: JSONL append next to the EventLogger's raw events.
  try {
    if (!existsSync(RAW_DIR)) {
      mkdirSync(RAW_DIR, { recursive: true, mode: 0o700 });
    }
    const filePath = join(RAW_DIR, `${sessionId}.jsonl`);
    appendFileSync(filePath, JSON.stringify(event) + "\n");
    chmodSync(filePath, 0o600);
  } catch { /* filesystem unavailable — give up silently */ }
}

async function main(): Promise<void> {
  // Gate 1 — not a cortex session: pass through silently. cc-session sets
  // CORTEX_CHANNEL; GROVE_CHANNEL is the deprecated transition read-fallback
  // (cortex#767/#774). Reading GROVE_ only would mean a real bot session —
  // which now carries CORTEX_CHANNEL, not GROVE_CHANNEL — fails this gate and
  // every allowlisted command falls through to Claude Code's approval prompt.
  if (!resolveSurfaceEnv("CHANNEL")) {
    pass();
    return;
  }

  // Gate 2 — CLI-principal bypass (full trust), guarded so it is CLI-only.
  // cldyo-live (the CLI principal wrapper) sets the agent-id AND disables the
  // guard via CORTEX_BASH_GUARD='{"disabled":true}'. Bot sessions ALSO set the
  // agent-id, but they additionally set a NON-disabled CORTEX_BASH_GUARD
  // (runtime.bashAllowlist). Gating the bypass on the ABSENCE of CORTEX_BASH_GUARD
  // keeps bot sessions out of this short-circuit so they fall through to
  // loadConfig() + grant/deny below (cortex#401). A bare CLI session with an
  // agent-id and no guard config still bypasses, as intended.
  if (resolveSurfaceEnv("AGENT_ID") && !process.env.CORTEX_BASH_GUARD) {
    pass();
    return;
  }


  // Read stdin with timeout (same pattern as SecurityValidator)
  let input: HookInput;
  try {
    const reader = Bun.stdin.stream().getReader();
    let raw = "";
    const readLoop = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += new TextDecoder().decode(value, { stream: true });
      }
    })();
    await Promise.race([readLoop, new Promise<void>((r) => setTimeout(r, 200))]);

    if (!raw.trim()) {
      pass();
      return;
    }
    input = JSON.parse(raw) as HookInput;
  } catch {
    pass();
    return;
  }

  // Only guard Bash commands
  if (input.tool_name !== "Bash") {
    pass();
    return;
  }

  const rawCommand =
    typeof input.tool_input === "string"
      ? input.tool_input
      : input.tool_input.command ?? "";

  const command = stripEnvPrefix(rawCommand).trim();

  if (!command) {
    pass();
    return;
  }

  const sessionId =
    input.session_id ?? process.env.CLAUDE_SESSION_ID ?? "unknown";

  const config = loadConfig();

  // G-300: Guard disabled (principal DM) — pass through, defer to the already-
  // permissive bypass session. Intentionally NOT a grant: this path is out of
  // the allowlist's scope, and broadening it to auto-approve would be a strictly
  // wider authority than the disabled-guard contract promises (cortex#777).
  if (config === null) {
    pass();
    return;
  }

  // No-bypass guard: refuse shell metacharacters that could smuggle a second
  // command past an allow-prefix (pipes, $( ), backticks, redirects, lone `&`,
  // newlines). Runs BEFORE the allowlist match so it protects every rule. The
  // segment splitter below only neutralises `&& || ;` chains of allowed
  // commands; everything else is denied here.
  //
  // CRITICAL: this checks the RAW command, not the env-stripped one. The shell
  // evaluates an env-assignment prefix value — including command substitution —
  // when building the command's environment, so `X="$(curl evil)" aws sts …`
  // RUNS `curl evil` even though the visible command is an allowed `aws` call.
  // stripEnvPrefix() would launder that `$( )` out of `command` before we look,
  // so the metacharacter scan must see the original input the shell will run.
  if (rejectsChaining(rawCommand)) {
    const reason =
      `[Cortex Bash Guard] Blocked "${rawCommand.slice(0, 80)}": ` +
      `command contains a shell metacharacter (pipe, command substitution, ` +
      `backtick, redirect, background '&', or newline) that could chain a ` +
      `second command. Split it into separate, individually-allowed commands.`;
    deny(reason);
    await emitBlockEvent(sessionId, reason, command);
    return;
  }

  // Handle chained commands: split on && ; || and check each part
  const parts = command.split(/\s*(?:&&|\|\||;)\s*/);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    let matched = false;

    for (const rule of config.rules) {
      try {
        if (new RegExp(rule.pattern, "i").test(trimmed)) {
          // Check repo restriction for gh commands
          if (trimmed.startsWith("gh ")) {
            const repos = rule.repos ?? config.repos ?? [];
            if (repos.length > 0) {
              const repo = extractGhRepo(trimmed);
              if (repo && !repos.includes(repo)) {
                const reason =
                  `[Cortex Bash Guard] Blocked "${trimmed.slice(0, 80)}": ` +
                  `repo "${repo}" is not in the allowed repo list ` +
                  `[${repos.join(", ")}].`;
                // Write the security decision FIRST — telemetry I/O
                // (a filesystem appendFileSync) must never delay a deny.
                deny(reason);
                await emitBlockEvent(sessionId, reason, command);
                return;
              }
            }
          }
          matched = true;
          break;
        }
      } catch { /* invalid regex, skip */ }
    }

    if (!matched) {
      const reason =
        `[Cortex Bash Guard] Blocked "${trimmed.slice(0, 80)}": ` +
        `command does not match any rule in the bash allowlist. ` +
        `Ask the principal to widen the allowlist if this command is needed.`;
      // Write the security decision FIRST — telemetry I/O
      // (a filesystem appendFileSync) must never delay a deny.
      deny(reason);
      await emitBlockEvent(sessionId, reason, command);
      return;
    }
  }

  // All parts matched, no chaining metacharacters, repo-restriction (if any)
  // cleared — this is the STRICT success terminal. Auto-approve so the
  // allowlisted+safe command runs in async dispatch without a "requires
  // approval" prompt (cortex#777). Every deny-worthy branch returned above.
  grant(
    "[Cortex Bash Guard] Auto-approved: command matches the bash allowlist " +
      "and contains no chaining metacharacters.",
  );
}

main().catch(() => {
  // Fail open to Claude Code's normal permission gate (pass-through), NOT to an
  // auto-approve. An unexpected error must never silently grant.
  pass();
});
