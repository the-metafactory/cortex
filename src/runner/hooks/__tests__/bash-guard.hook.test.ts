/**
 * Tests for the Cortex Bash Guard PreToolUse hook.
 *
 * Covers the cortex#bash-guard-observability changes:
 *   - structured PreToolUse deny output (replaces exit(2) + stderr)
 *   - unchanged pass-through ({"continue": true})
 *   - preserved channel gate / agent-id bypass / CORTEX_BASH_GUARD disabled
 *     behaviour
 *   - block telemetry event written to the JSONL fallback
 *   - block telemetry event POSTed to the HTTP ingest endpoint
 *
 * Plus the cortex#777 grant changes:
 *   - the allowlist-MATCH terminal now emits Claude Code's auto-approve
 *     PreToolUse decision (permissionDecision:"allow") so allowlisted
 *     commands run in async dispatch WITHOUT a "requires approval" prompt.
 *   - genuine pass-through paths (non-cortex / CLI principal / disabled-guard /
 *     non-Bash / empty command) keep the {"continue": true} contract.
 *   - every deny path still gates BEFORE the grant; no deny-worthy or
 *     unvalidated command ever reaches the grant terminal.
 *
 * Plus the cortex#401/#779 grove→cortex env-name fix:
 *   - the channel gate + agent-id bypass + block telemetry read the canonical
 *     CORTEX_* env names (cc-session sets these), with a legacy GROVE_* read-
 *     fallback for the transition window.
 *   - REGRESSION (the live blocker): a real bot session — CORTEX_CHANNEL +
 *     CORTEX_AGENT_ID + a non-disabled CORTEX_BASH_GUARD allowlist — must reach
 *     grant() for an allowlisted command, NOT bypass via the agent-id short-
 *     circuit and NOT pass-through into Claude Code's approval prompt.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";

const HOOK_PATH = join(import.meta.dir, "..", "bash-guard.hook.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Surface env vars the hook reads. The test process itself may run inside a
// cortex agent session (which sets these), so the helper strips ALL of them
// from the child env first, then re-applies only what each test specifies.
// Without this, an inherited CORTEX_BASH_GUARD / CORTEX_AGENT_ID (or a legacy
// GROVE_AGENT_ID) silently bypasses the guard and tests pass for the wrong
// reason. Strips BOTH the canonical CORTEX_* names and the legacy GROVE_*
// read-fallbacks the hook resolves through (surface-env.ts / principal-env.ts).
const GROVE_ENV_KEYS = [
  // canonical cortex names (cc-session sets these)
  "CORTEX_CHANNEL",
  "CORTEX_AGENT_ID",
  "CORTEX_AGENT_NAME",
  "CORTEX_NETWORK",
  "CORTEX_PROJECT",
  "CORTEX_ENTITY",
  "CORTEX_PRINCIPAL",
  "CORTEX_BASH_GUARD",
  // legacy grove read-fallbacks (transition window)
  "GROVE_CHANNEL",
  "GROVE_AGENT_ID",
  "GROVE_AGENT_NAME",
  "GROVE_NETWORK",
  "GROVE_PROJECT",
  "GROVE_ENTITY",
  "GROVE_OPERATOR",
];

/** Run the hook with a Bash tool-call payload on stdin. */
function runHook(
  command: string,
  env: Record<string, string | undefined>,
  toolName = "Bash",
  sessionId = "test-session",
): RunResult {
  const input = JSON.stringify({
    session_id: sessionId,
    tool_name: toolName,
    tool_input: { command },
  });
  // Build a clean env: start from process.env, drop every GROVE_* var, then
  // apply this test's overrides. `undefined` values keep the key unset.
  const groveOverrides = new Set(GROVE_ENV_KEYS);
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !groveOverrides.has(k)) merged[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) merged[k] = v;
  }
  const result = spawnSync("bun", [HOOK_PATH], {
    encoding: "utf-8",
    input,
    env: merged,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Assert the hook emitted Claude Code's auto-approve PreToolUse decision —
 * the cortex#777 grant terminal. The harness reads
 * `hookSpecificOutput.permissionDecision`, so we assert that exact shape (NOT
 * `{continue:true}`, which would leave Claude Code's normal gate in place and
 * stall async `--print` dispatch on "requires approval").
 */
function expectGrantDecision(stdout: string): void {
  const out = JSON.parse(stdout.trim());
  expect(out.hookSpecificOutput).toBeDefined();
  expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  expect(typeof out.hookSpecificOutput.permissionDecisionReason).toBe("string");
  // A grant is NOT a pass-through — `continue` must be absent.
  expect(out.continue).toBeUndefined();
}

describe("bash-guard.hook — pass-through behaviour", () => {
  test("passes through when GROVE_CHANNEL is not set", () => {
    const r = runHook("rm -rf /", { GROVE_CHANNEL: undefined });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("bypasses guard when GROVE_AGENT_ID is set (CLI principal session)", () => {
    const r = runHook("rm -rf /tmp/whatever", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: "cldyo-live",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("disabled config (principal DM) allows everything", () => {
    const r = runHook("rm -rf /tmp/x", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: JSON.stringify({ disabled: true }),
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("non-Bash tool passes through unchanged", () => {
    const r = runHook("ignored", { GROVE_CHANNEL: "test-channel" }, "Read");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });
});

// =============================================================================
// cortex#401/#779 — grove→cortex env-name fix.
//
// THE LIVE BLOCKER: cc-session now sets the canonical CORTEX_* names
// (CORTEX_CHANNEL / CORTEX_AGENT_ID / CORTEX_BASH_GUARD), NOT the legacy GROVE_*
// names. Before this fix the hook's gate-1 (channel) and gate-2 (agent-id
// bypass) read process.env.GROVE_* directly, so a real bot session:
//   - failed gate-1 (no GROVE_CHANNEL) → pass() → every allowlisted command
//     (gh / aws read / git read) fell through to Claude Code's approval prompt
//     → "This command requires approval" → community-stack Luna couldn't run gh.
// And gate-2 wrongly bypassed ALL agent-id sessions (cortex#401), so when the
// channel WAS set the bot got allow-all bash instead of the allowlist.
//
// The fix:
//   gate-1: resolveSurfaceEnv("CHANNEL")  → CORTEX_CHANNEL ?? GROVE_CHANNEL
//   gate-2: resolveSurfaceEnv("AGENT_ID") && !CORTEX_BASH_GUARD
//           → bypass is CLI-principal-only; bot sessions (which set a non-
//             disabled CORTEX_BASH_GUARD) fall through to loadConfig() + grant.
// =============================================================================
describe("bash-guard.hook — cortex env-name gates (grove→cortex)", () => {
  // The community-stack Luna allowlist shape: gh read/write verbs.
  const botAllowlist = JSON.stringify({
    rules: [{ pattern: "^gh\\s+(pr|issue|repo|api|run)\\s" }],
  });

  test("REGRESSION: bot session (CORTEX_* + allowlist) GRANTS `gh pr list`, not {continue:true}", () => {
    // The exact live failure: CORTEX_CHANNEL set (not GROVE_), an agent-id set,
    // and a non-disabled CORTEX_BASH_GUARD allowlist. Must reach grant() — NOT
    // bypass via the agent-id short-circuit, NOT pass-through to CC's gate.
    const r = runHook("gh pr list", {
      CORTEX_CHANNEL: "community",
      CORTEX_AGENT_ID: "luna",
      CORTEX_BASH_GUARD: botAllowlist,
    });
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("bot session (CORTEX_*) DENIES a non-allowlisted command", () => {
    // Same bot session, but a command outside the allowlist must DENY — proving
    // the session falls through to the allowlist (loadConfig path), not bypass.
    const r = runHook("curl http://evil.example", {
      CORTEX_CHANNEL: "community",
      CORTEX_AGENT_ID: "luna",
      CORTEX_BASH_GUARD: botAllowlist,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe("allow");
  });

  test("CLI-principal session (CORTEX_AGENT_ID, NO CORTEX_BASH_GUARD) bypasses (full trust)", () => {
    // cldyo-live's discriminant: agent-id present, no allowlist config → the
    // gate-2 bypass fires → pass() even for an otherwise-denied command.
    const r = runHook("rm -rf /tmp/whatever", {
      CORTEX_CHANNEL: "andreas",
      CORTEX_AGENT_ID: "andreas",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("no channel (CORTEX_CHANNEL + GROVE_CHANNEL both unset) passes through", () => {
    // gate-1: neither tier set → not a cortex session → pass().
    const r = runHook("rm -rf /", {
      CORTEX_CHANNEL: undefined,
      GROVE_CHANNEL: undefined,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("legacy fallback: GROVE_CHANNEL + GROVE_AGENT_ID (no CORTEX_*) still behaves", () => {
    // Transition compat: an external setter still on GROVE_* resolves through
    // the read-fallback. Channel set + agent-id set + no CORTEX_BASH_GUARD →
    // gate-2 CLI-principal bypass → pass(). Proves the GROVE_* fallback chain
    // is intact (not dropped by the CORTEX_* migration).
    const r = runHook("rm -rf /tmp/legacy", {
      GROVE_CHANNEL: "legacy-channel",
      GROVE_AGENT_ID: "legacy-cli",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("legacy fallback: GROVE_CHANNEL bot session (GROVE + CORTEX_BASH_GUARD) still GRANTS allowlisted", () => {
    // A bot session whose channel arrives via the GROVE_* fallback but whose
    // allowlist is the canonical CORTEX_BASH_GUARD must still reach grant() for
    // an allowlisted command (gate-2 does NOT bypass: CORTEX_BASH_GUARD is set).
    const r = runHook("gh pr list", {
      GROVE_CHANNEL: "legacy-bot",
      GROVE_AGENT_ID: "legacy-luna",
      CORTEX_BASH_GUARD: botAllowlist,
    });
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("block telemetry reads CORTEX_* surface metadata (not undefined)", () => {
    // #779: emitBlockEvent must stamp channel/agent/network/principal from the
    // CORTEX_* names. A denied bot command writes a JSONL event whose
    // grove_channel/agent_id/etc. carry the CORTEX_* values, not undefined.
    const homeDir = mkdtempSync(join(tmpdir(), "bash-guard-cortex-meta-"));
    try {
      const sessionId = "cortex-meta-session";
      const r = runHook(
        "curl http://evil.example",
        {
          CORTEX_CHANNEL: "community",
          CORTEX_AGENT_ID: "luna",
          CORTEX_AGENT_NAME: "Luna",
          CORTEX_NETWORK: "metafactory",
          CORTEX_PROJECT: "cortex",
          CORTEX_ENTITY: "cortex/pr/1",
          CORTEX_PRINCIPAL: "Andreas",
          CORTEX_BASH_GUARD: botAllowlist,
          HOME: homeDir,
        },
        "Bash",
        sessionId,
      );
      expect(r.status).toBe(0);
      const rawFile = join(homeDir, ".claude", "events", "raw", `${sessionId}.jsonl`);
      expect(existsSync(rawFile)).toBe(true);
      const firstLine = readFileSync(rawFile, "utf-8")
        .trim()
        .split("\n")
        .find((l) => l.length > 0);
      const event = JSON.parse(firstLine ?? "{}");
      expect(event.grove_channel).toBe("community");
      expect(event.agent_id).toBe("luna");
      expect(event.agent_name).toBe("Luna");
      expect(event.network_id).toBe("metafactory");
      expect(event.payload.project).toBe("cortex");
      expect(event.payload.entity).toBe("cortex/pr/1");
      expect(event.payload.principal).toBe("Andreas");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// cortex#777 — allowlist MATCH now GRANTS (auto-approve), not pass-through.
//
// In a restricted (non-principal-DM) async `--print` session, a pass-through
// ({continue:true}) leaves Claude Code's normal permission gate in place, so an
// allowlisted command still returns "requires approval" — which async dispatch
// can't surface, so the command never runs. The match terminal must instead
// emit the auto-approve decision so the allowlisted+safe command runs without a
// prompt.
// =============================================================================
describe("bash-guard.hook — allowlist match grants (auto-approve)", () => {
  test("an allowlisted command GRANTS with permissionDecision:allow (not continue)", () => {
    const r = runHook("ls -la", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
    });
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("gh issue create (halden's case) is GRANTED, not gated", () => {
    // halden's allowlist matches `^gh\s+(pr|issue|repo|api|run)\s`. Before #777
    // this was a pass-through → "requires approval" → async stall. Now: grant.
    const r = runHook("gh issue create --repo the-metafactory/cortex --title x", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: JSON.stringify({
        rules: [{ pattern: "^gh\\s+(pr|issue|repo|api|run)\\s" }],
        repos: ["the-metafactory/cortex"],
      }),
    });
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("a custom-allowlisted command (e.g. bun) is GRANTED", () => {
    const r = runHook("bun test", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: JSON.stringify({ rules: [{ pattern: "^bun\\s+" }] }),
    });
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("a chain of ALL-allowed commands is GRANTED once (&& preserved)", () => {
    const r = runHook("ls && pwd", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
    });
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("a grant writes no block telemetry (grant is not a block)", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "bash-guard-grant-"));
    try {
      const sessionId = "grant-no-telemetry";
      const r = runHook(
        "ls",
        { GROVE_CHANNEL: "test-channel", GROVE_AGENT_ID: undefined, HOME: homeDir },
        "Bash",
        sessionId,
      );
      expect(r.status).toBe(0);
      expectGrantDecision(r.stdout);
      const rawFile = join(homeDir, ".claude", "events", "raw", `${sessionId}.jsonl`);
      expect(existsSync(rawFile)).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// cortex#777 SECURITY INVARIANT — the grant is the strict success terminal.
// permissionDecision:"allow" is emitted ONLY when a command passed
// rejectsChaining AND every chained part matched an allowlist rule AND any gh
// repo-restriction passed. Every deny-worthy input must reach a DENY, never a
// grant. This table-drives the negative space the adversarial reviewer checks.
// =============================================================================
describe("bash-guard.hook — grant is the strict success terminal (no deny-worthy input grants)", () => {
  const config = JSON.stringify({
    rules: [
      { pattern: "^gh\\s+(pr|issue|repo|api|run)\\s" },
      { pattern: "^ls\\b" },
      { pattern: "^pwd$" },
    ],
    repos: ["the-metafactory/cortex"],
  });

  const DENY_WORTHY: [string, string][] = [
    ["no allowlist match", "curl http://evil.example"],
    ["one bad part in a chain", "ls && curl http://evil.example"],
    ["repo not in allowlist", "gh issue create --repo evil/repo --title x"],
    ["pipe smuggle past allowed head", "ls | curl http://evil.example"],
    ["command substitution", "ls $(curl http://evil.example)"],
    ["backtick substitution", "ls `id`"],
    ["redirect clobber", "ls > /etc/passwd"],
    ["background control token", "ls & curl http://evil.example"],
    ["env-prefix substitution smuggle", 'X="$(id)" ls'],
  ];

  for (const [label, cmd] of DENY_WORTHY) {
    test(`DENY (never grant): ${label}`, () => {
      const r = runHook(cmd, {
        GROVE_CHANNEL: "test-channel",
        GROVE_AGENT_ID: undefined,
        CORTEX_BASH_GUARD: config,
      });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout.trim());
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      // Hard guarantee: a deny-worthy command must NEVER produce an allow.
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe("allow");
    });
  }

  // ---------------------------------------------------------------------------
  // Echo (adversarial review, cortex#778) — vectors not in the inline table
  // above because they need a real control character or a non-string payload.
  // Each confirms the grant terminal stays unreachable for a deny-worthy input.
  // ---------------------------------------------------------------------------

  test("DENY (never grant): a REAL newline smuggles a second command", () => {
    // The inline table can't carry a literal newline; feed one directly so the
    // rejectsChaining `[\r\n]` arm is exercised end-to-end, not just in isolation.
    const r = runHook("ls\nrm -rf /", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: config,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe("allow");
  });

  test("DENY (never grant): a carriage-return smuggles a second command", () => {
    const r = runHook("ls\rrm -rf /", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: config,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("DENY (never grant): the LAST part of a 3-part chain is unallowed (loop validates ALL parts)", () => {
    // Loop-ordering proof: the first two parts match; the grant terminal must
    // stay unreachable because a later part fails. Guards against a per-part
    // `grant` slipping in before the loop finishes.
    const r = runHook("ls && pwd && curl http://evil.example", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: config,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe("allow");
  });

  test("DENY (never grant): a MIDDLE part of a chain is unallowed", () => {
    const r = runHook("ls && curl http://evil.example && pwd", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: config,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("DENY (never grant): TAB-delimited chaining is split and validated (\\s split robustness)", () => {
    // `\t` is whitespace, so the `\s*(?:&&|…)\s*` splitter must isolate the
    // unallowed tail rather than fold it into an allowed head.
    const r = runHook("ls\t&&\tcurl http://evil.example", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: config,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("FAIL-SAFE: unparseable hook stdin passes through, NEVER grants", () => {
    // The fail-open path must defer to Claude Code's normal gate ({continue:true}),
    // not auto-approve. An error must never silently widen to an allow. Feed raw
    // malformed JSON directly (runHook always wraps in valid JSON, so bypass it).
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !GROVE_ENV_KEYS.includes(k)) merged[k] = v;
    }
    merged.GROVE_CHANNEL = "test-channel";
    merged.CORTEX_BASH_GUARD = config;
    const r = spawnSync("bun", [HOOK_PATH], {
      encoding: "utf-8",
      input: "this is not valid json {{{",
      env: merged,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse((r.stdout ?? "").trim());
    expect(out).toEqual({ continue: true });
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe("allow");
  });
});

describe("bash-guard.hook — structured deny output", () => {
  test("blocked command emits a PreToolUse deny decision on stdout", () => {
    const r = runHook("curl http://evil.example", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
    });
    // No longer exit(2): structured deny is exit 0 with JSON on stdout.
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput).toBeDefined();
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(typeof out.hookSpecificOutput.permissionDecisionReason).toBe("string");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("curl");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("allowlist");
  });

  test("deny reason names the offending command part", () => {
    const r = runHook("ls && curl http://evil.example", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("curl");
  });

  test("gh command for a repo outside the allowlist is denied with the repo name", () => {
    const r = runHook("gh pr view --repo evil/repo 1", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: JSON.stringify({
        rules: [{ pattern: "^gh\\s+" }],
        repos: ["the-metafactory/cortex"],
      }),
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("evil/repo");
  });
});

describe("bash-guard.hook — block telemetry", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "bash-guard-test-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  test("a block writes a tool.bash.blocked event to the JSONL fallback", () => {
    const sessionId = "telemetry-session";
    const r = runHook(
      "curl http://evil.example",
      {
        GROVE_CHANNEL: "test-channel",
        GROVE_AGENT_ID: undefined,
        HOME: homeDir,
      },
      "Bash",
      sessionId,
    );
    expect(r.status).toBe(0);

    const rawDir = join(homeDir, ".claude", "events", "raw");
    expect(existsSync(rawDir)).toBe(true);
    const files = readdirSync(rawDir);
    expect(files).toContain(`${sessionId}.jsonl`);

    const lines = readFileSync(join(rawDir, `${sessionId}.jsonl`), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const event = JSON.parse(lines[0] ?? "{}");
    expect(event.event_type).toBe("tool.bash.blocked");
    expect(event.session_id).toBe(sessionId);
    expect(event.source.hook).toBe("PreToolUse");
    expect(event.source.tool_name).toBe("Bash");
    expect(event.payload.reason).toContain("curl");
    expect(event.payload.command_preview).toContain("curl");
    expect(typeof event.event_id).toBe("string");
  });

  test("an allowed command writes no telemetry", () => {
    const sessionId = "no-telemetry-session";
    const r = runHook(
      "ls",
      {
        GROVE_CHANNEL: "test-channel",
        GROVE_AGENT_ID: undefined,
        HOME: homeDir,
      },
      "Bash",
      sessionId,
    );
    expect(r.status).toBe(0);
    const rawFile = join(homeDir, ".claude", "events", "raw", `${sessionId}.jsonl`);
    expect(existsSync(rawFile)).toBe(false);
  });

  test("a block POSTs the event to the HTTP ingest endpoint", async () => {
    // The hook POSTs to its ingest endpoint before falling back to JSONL. Stand
    // up a real listener on an EPHEMERAL port (port: 0) and point the hook at it
    // via CORTEX_INGEST_URL, so the POST "succeeds" and we can capture the body
    // to assert its shape. Using port 0 (not the hardcoded 8766) avoids the
    // EADDRINUSE flake when sibling Bun.serve suites hold 8766 under the full run.
    //
    // NOTE: the hook must be spawned *asynchronously* here. spawnSync would
    // block the test's event loop, starving the in-process Bun.serve so the
    // hook's fetch would time out and fall through to JSONL — never hitting
    // the HTTP path this test exists to cover.
    const sessionId = "http-ingest-session";
    const seen: {
      body: Record<string, unknown> | null;
      path: string | null;
      contentType: string | null;
    } = { body: null, path: null, contentType: null };

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.path = new URL(req.url).pathname;
        seen.contentType = req.headers.get("content-type");
        seen.body = (await req.json()) as Record<string, unknown>;
        return new Response("ok", { status: 200 });
      },
    });
    const ingestUrl = `http://localhost:${server.port}/api/events/ingest`;

    try {
      const groveOverrides = new Set(GROVE_ENV_KEYS);
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !groveOverrides.has(k)) merged[k] = v;
      }
      Object.assign(merged, {
        GROVE_CHANNEL: "test-channel",
        HOME: homeDir,
        CORTEX_INGEST_URL: ingestUrl,
      });

      const proc = Bun.spawn(["bun", HOOK_PATH], {
        stdin: new TextEncoder().encode(
          JSON.stringify({
            session_id: sessionId,
            tool_name: "Bash",
            tool_input: { command: "curl http://evil.example" },
          }),
        ),
        stdout: "pipe",
        stderr: "pipe",
        env: merged,
      });
      await proc.exited;
      expect(proc.exitCode).toBe(0);

      // The deny decision still lands on stdout.
      const stdout = await new Response(proc.stdout).text();
      const out = JSON.parse(stdout.trim());
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");

      // The event was POSTed to the ingest endpoint with the expected shape.
      expect(seen.path).toBe("/api/events/ingest");
      expect(seen.contentType).toContain("application/json");
      expect(seen.body).not.toBeNull();
      const event = seen.body as Record<string, any>;
      expect(event.event_type).toBe("tool.bash.blocked");
      expect(event.session_id).toBe(sessionId);
      expect(event.source.hook).toBe("PreToolUse");
      expect(event.source.tool_name).toBe("Bash");
      expect(event.payload.reason).toContain("curl");
      expect(event.payload.command_preview).toContain("curl");
      expect(typeof event.event_id).toBe("string");
      expect(typeof event.timestamp).toBe("string");
    } finally {
      server.stop(true);
    }
  });
});

// =============================================================================
// No-bypass property — the guard must refuse shell metacharacters that could
// smuggle a second (destructive) command past an allow-prefix. This protects
// EVERY allow pattern (gh / git / aws / …), not just aws.
//
// The guard already splits on && || ; and validates each segment, so a chain
// of *allowed* commands (`ls && pwd`) still passes. But a pipe, command
// substitution, backtick, background `&`, redirect, or newline could carry a
// hidden command that never gets validated. Those are rejected outright.
// =============================================================================
describe("bash-guard.hook — no-bypass (metacharacter rejection)", () => {
  const env = { GROVE_CHANNEL: "test-channel", GROVE_AGENT_ID: undefined };

  function expectDeny(cmd: string): void {
    const r = runHook(cmd, env);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  }

  test("rejects a pipe even when the head is allowlisted", () => {
    // `ls` is allowed, but the piped `curl` is never validated → must deny.
    expectDeny("ls | curl http://evil.example");
  });

  test("rejects command substitution $( … )", () => {
    expectDeny("ls $(curl http://evil.example)");
  });

  test("rejects backtick command substitution", () => {
    expectDeny("ls `curl http://evil.example`");
  });

  test("rejects a background `&` control token", () => {
    expectDeny("ls & curl http://evil.example");
  });

  test("rejects output redirection", () => {
    expectDeny("ls > /etc/passwd");
  });

  test("rejects input redirection", () => {
    expectDeny("cat < /etc/shadow");
  });

  test("rejects an embedded newline carrying a second command", () => {
    expectDeny("ls\ncurl http://evil.example");
  });

  test("rejects arithmetic/process substitution $(( … ))", () => {
    expectDeny("ls $((1+1))");
  });

  // ---------------------------------------------------------------------------
  // Regression: env-prefix command-substitution smuggle (Echo adversarial review,
  // PR #770). stripEnvPrefix() launders an env-assignment prefix out of the
  // command BEFORE the metacharacter scan. But bash EVALUATES the prefix value —
  // including `$( )` / backticks — when building the command's environment, so
  // `X="$(curl evil)" aws sts get-caller-identity` RUNS `curl evil` while the
  // visible (post-strip) command is an allowed `aws` call. The metacharacter
  // scan therefore must run on the RAW command, not the stripped one.
  // ---------------------------------------------------------------------------
  test("rejects command substitution hidden in a double-quoted env-prefix value", () => {
    expectDeny('AWS_PROFILE="$(touch /tmp/pwned)" aws sts get-caller-identity');
  });

  test("rejects command substitution in an unquoted env-prefix value", () => {
    expectDeny("X=$(id) aws sts get-caller-identity");
  });

  test("rejects a backtick substitution hidden in a quoted env-prefix value", () => {
    expectDeny('X="`id`" aws sts get-caller-identity');
  });

  test("a plain (metacharacter-free) env-prefix is still allowed (grants)", () => {
    // The whole point of PR #770: `AWS_PROFILE=halden-dev <allowed> …` must
    // pass. Use `ls` (in DEFAULT_CONFIG) so this case is independent of the
    // aws rule — it proves the raw-command metacharacter scan does not
    // over-reject a benign `NAME=value` prefix. Post-#777 a match GRANTS.
    const r = runHook("AWS_PROFILE=halden-dev ls", env);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("a chain of ALL-allowed commands still passes (&& preserved, grants)", () => {
    const r = runHook("ls && pwd", env);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("a chain with one disallowed command is denied (existing contract)", () => {
    expectDeny("ls && curl http://evil.example");
  });
});

// =============================================================================
// Read-only aws allowlist — the regex used by halden's bashAllowlist. Proven
// here so the live config inherits a tested pattern, NOT a hand-rolled one.
//
//   ALLOW: sts get-caller-identity, <svc> describe-* / get-* / list-*,
//          tolerating env prefix + global flags (--profile/--region/
//          --output/--no-cli-pager) in any position.
//   DENY:  any write/exec verb (send-command, start-session, run-instances,
//          terminate-*, stop-*, start-*, *-create-*, delete-*, put-*,
//          modify-*, update-*), and any chained-destructive form.
// =============================================================================
import { READONLY_AWS_PATTERN } from "../bash-guard.hook";

describe("bash-guard.hook — read-only aws pattern (unit)", () => {
  const re = new RegExp(READONLY_AWS_PATTERN, "i");

  // The hook strips a leading env prefix before matching, so the regex itself
  // is tested against the post-strip form. Env-prefix tolerance is covered by
  // the integration cases below (which go through the real hook).
  const ALLOW = [
    "aws sts get-caller-identity",
    "aws --profile halden-dev sts get-caller-identity",
    "aws --region us-east-1 sts get-caller-identity",
    "aws --output json sts get-caller-identity",
    "aws --no-cli-pager sts get-caller-identity",
    "aws --profile halden-dev --region us-east-1 sts get-caller-identity",
    "aws ec2 describe-instances",
    "aws --profile halden-dev ec2 describe-instances",
    "aws --region us-east-1 ec2 describe-instances",
    "aws ssm describe-instance-information",
    "aws ssm list-commands",
    "aws ssm get-command-invocation --command-id abc --instance-id i-1",
    "aws sso list-accounts",
    "aws s3api list-buckets",
    "aws iam list-users",
    "aws --profile p --region r --output json ec2 describe-instances --instance-ids i-0",
  ];

  const DENY = [
    "aws ssm send-command --instance-ids i-1 --document-name AWS-RunShellScript",
    "aws ssm start-session --target i-1",
    "aws ec2 run-instances --image-id ami-1",
    "aws ec2 terminate-instances --instance-ids i-1",
    "aws ec2 stop-instances --instance-ids i-1",
    "aws ec2 start-instances --instance-ids i-1",
    "aws ec2 create-tags --resources i-1",
    "aws s3api delete-bucket --bucket x",
    "aws ssm put-parameter --name x --value y",
    "aws ec2 modify-instance-attribute --instance-id i-1",
    "aws iam update-user --user-name x",
    "aws ec2 reboot-instances --instance-ids i-1",
    // verb that merely CONTAINS describe/get/list mid-token must not match
    "aws ec2 run-describe-hack",
    // bare aws with no verb
    "aws",
    "aws help",
    // a flag value must not be mistaken for a read verb
    "aws --profile describe-instances ec2 terminate-instances --instance-ids i-1",
  ];

  for (const cmd of ALLOW) {
    test(`ALLOW: ${cmd}`, () => {
      expect(re.test(cmd)).toBe(true);
    });
  }

  for (const cmd of DENY) {
    test(`DENY: ${cmd}`, () => {
      expect(re.test(cmd)).toBe(false);
    });
  }
});

describe("bash-guard.hook — read-only aws (integration via hook + halden config)", () => {
  // Mirror the halden bashAllowlist: gh/git/etc. read-only rules + the aws rule.
  const haldenConfig = JSON.stringify({
    rules: [
      { pattern: "^gh\\s+(pr|issue|repo|api|run)\\s" },
      { pattern: "^git\\s+(log|diff|show|status|branch|fetch|remote|rev-parse)\\b" },
      { pattern: "^ls\\b" },
      { pattern: "^pwd$" },
      { pattern: READONLY_AWS_PATTERN },
    ],
    repos: [],
  });

  function run(cmd: string) {
    return runHook(cmd, {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: haldenConfig,
    });
  }

  function expectAllow(cmd: string): void {
    // Post-#777: an allowlist MATCH GRANTS (auto-approve), not a pass-through.
    const r = run(cmd);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  }

  function expectDeny(cmd: string): void {
    const r = run(cmd);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).hookSpecificOutput?.permissionDecision).toBe(
      "deny",
    );
  }

  test("ALLOW bare sts get-caller-identity", () => {
    expectAllow("aws sts get-caller-identity");
  });

  test("ALLOW --profile sts get-caller-identity (the halden Luna case)", () => {
    expectAllow("aws --profile halden-dev sts get-caller-identity");
  });

  test("ALLOW env-prefix form (AWS_PROFILE=… AWS_REGION=… aws …)", () => {
    expectAllow(
      "AWS_PROFILE=halden-dev AWS_REGION=us-east-1 aws sts get-caller-identity",
    );
  });

  test("ALLOW --region ec2 describe-instances", () => {
    expectAllow("aws --region us-east-1 ec2 describe-instances");
  });

  test("ALLOW ssm describe / list / get read verbs", () => {
    expectAllow("aws ssm describe-instance-information");
    expectAllow("aws ssm list-commands");
    expectAllow("aws ssm get-command-invocation --command-id abc --instance-id i-1");
  });

  test("DENY ssm send-command", () => {
    expectDeny("aws ssm send-command --instance-ids i-1 --document-name X");
  });

  test("DENY ssm start-session", () => {
    expectDeny("aws ssm start-session --target i-1");
  });

  test("DENY ec2 terminate-instances", () => {
    expectDeny("aws ec2 terminate-instances --instance-ids i-1");
  });

  test("DENY ec2 run-instances", () => {
    expectDeny("aws ec2 run-instances --image-id ami-1");
  });

  test("DENY chained describe && terminate (no-bypass)", () => {
    expectDeny(
      "aws ec2 describe-instances && aws ec2 terminate-instances --instance-ids i-1",
    );
  });

  test("DENY describe piped into a destructive command (no-bypass)", () => {
    expectDeny("aws ec2 describe-instances | aws ec2 terminate-instances");
  });
});
