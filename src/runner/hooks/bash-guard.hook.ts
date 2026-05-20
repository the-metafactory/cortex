#!/usr/bin/env bun
/**
 * Grove Bash Guard — PreToolUse hook for Bash commands in Grove sessions.
 *
 * Only activates when GROVE_CHANNEL env var is set (Grove bot session).
 * Enforces a command allowlist with repo restrictions for gh CLI.
 * Non-Grove sessions pass through unchanged.
 *
 * Config via GROVE_BASH_GUARD env var (JSON):
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

interface HookInput {
  session_id?: string;
  tool_name: string;
  tool_input: { command?: string } | string;
}

interface AllowRule {
  pattern: string;
  repos?: string[];
}

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

// Narrow projection of the GROVE_BASH_GUARD env var payload. The hook
// reads only `disabled` / `rules` / `repos`; anything else is ignored.
interface GuardConfigRaw {
  disabled?: boolean;
  rules?: AllowRule[];
  repos?: string[];
}

function loadConfig(): GuardConfig | null {
  const raw = process.env.GROVE_BASH_GUARD;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as GuardConfigRaw;
      // G-300: Operator DM disables bash guard entirely
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

// =============================================================================
// Pass / deny output — Claude Code PreToolUse hook protocol.
// =============================================================================

/** Emit the pass-through decision (unchanged contract). */
function allow(): void {
  console.log(JSON.stringify({ continue: true }));
}

/**
 * Emit Claude Code's structured PreToolUse *deny* decision. The
 * `permissionDecisionReason` surfaces back to the agent (and the
 * Cortex→Discord relay) — it replaces the old `process.exit(2)` +
 * stderr line, which got swallowed on the way to the operator.
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

const INGEST_URL = "http://localhost:8766/api/events/ingest";
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
    grove_channel: process.env.GROVE_CHANNEL,
    agent_id: process.env.GROVE_AGENT_ID,
    agent_name: process.env.GROVE_AGENT_NAME,
    network_id: process.env.GROVE_NETWORK,
    source: { hook: "PreToolUse", tool_name: "Bash" },
    payload: {
      reason,
      command_preview: command.slice(0, 200),
      project: process.env.GROVE_PROJECT,
      entity: process.env.GROVE_ENTITY,
      operator: process.env.GROVE_OPERATOR,
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
  // Not a Grove session — pass through silently
  if (!process.env.GROVE_CHANNEL) {
    allow();
    return;
  }

  // CLI operator session (cldyo-live sets GROVE_AGENT_ID) — full trust, bypass guard.
  // Bot sessions also set GROVE_AGENT_ID but override via GROVE_BASH_GUARD config,
  // so they still get guarded by the loadConfig() path below.
  if (process.env.GROVE_AGENT_ID) {
    allow();
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
      allow();
      return;
    }
    input = JSON.parse(raw) as HookInput;
  } catch {
    allow();
    return;
  }

  // Only guard Bash commands
  if (input.tool_name !== "Bash") {
    allow();
    return;
  }

  const rawCommand =
    typeof input.tool_input === "string"
      ? input.tool_input
      : input.tool_input.command ?? "";

  const command = stripEnvPrefix(rawCommand).trim();

  if (!command) {
    allow();
    return;
  }

  const sessionId =
    input.session_id ?? process.env.CLAUDE_SESSION_ID ?? "unknown";

  // Handle chained commands: split on && ; || and check each part
  const parts = command.split(/\s*(?:&&|\|\||;)\s*/);
  const config = loadConfig();

  // G-300: Guard disabled (operator DM) — allow everything
  if (config === null) {
    allow();
    return;
  }

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
                  `[Grove Bash Guard] Blocked "${trimmed.slice(0, 80)}": ` +
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
        `[Grove Bash Guard] Blocked "${trimmed.slice(0, 80)}": ` +
        `command does not match any rule in the bash allowlist. ` +
        `Ask the operator to widen the allowlist if this command is needed.`;
      // Write the security decision FIRST — telemetry I/O
      // (a filesystem appendFileSync) must never delay a deny.
      deny(reason);
      await emitBlockEvent(sessionId, reason, command);
      return;
    }
  }

  // All parts matched — allow
  allow();
}

main().catch(() => {
  allow();
});
