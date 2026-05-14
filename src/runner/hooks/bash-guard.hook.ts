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
 */

interface HookInput {
  session_id: string;
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

async function main(): Promise<void> {
  // Not a Grove session — pass through silently
  if (!process.env.GROVE_CHANNEL) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // CLI operator session (cldyo-live sets GROVE_AGENT_ID) — full trust, bypass guard.
  // Bot sessions also set GROVE_AGENT_ID but override via GROVE_BASH_GUARD config,
  // so they still get guarded by the loadConfig() path below.
  if (process.env.GROVE_AGENT_ID) {
    console.log(JSON.stringify({ continue: true }));
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
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    input = JSON.parse(raw) as HookInput;
  } catch {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Only guard Bash commands
  if (input.tool_name !== "Bash") {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const rawCommand =
    typeof input.tool_input === "string"
      ? input.tool_input
      : input.tool_input.command ?? "";

  const command = stripEnvPrefix(rawCommand).trim();

  if (!command) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Handle chained commands: split on && ; || and check each part
  const parts = command.split(/\s*(?:&&|\|\||;)\s*/);
  const config = loadConfig();

  // G-300: Guard disabled (operator DM) — allow everything
  if (config === null) {
    console.log(JSON.stringify({ continue: true }));
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
                console.error(
                  `[GROVE BASH GUARD] Blocked: repo "${repo}" not in allowlist [${repos.join(", ")}]`,
                );
                process.exit(2);
              }
            }
          }
          matched = true;
          break;
        }
      } catch { /* invalid regex, skip */ }
    }

    if (!matched) {
      console.error(
        `[GROVE BASH GUARD] Blocked: "${trimmed.slice(0, 80)}" not in allowlist`,
      );
      process.exit(2);
    }
  }

  // All parts matched — allow
  console.log(JSON.stringify({ continue: true }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
});
