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
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync, readdirSync } from "fs";
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
  cwd?: string,
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
    ...(cwd !== undefined && { cwd }),
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

// =============================================================================
// cortex#2331 (7a) review F1 — the gh repo-pin bypass close.
//
// extractGhRepo previously matched only the WHITESPACE flag form
// (`--repo owner/name` / `-R owner/name`). gh ALSO accepts the `=` form
// (`--repo=owner/name` / `-R=owner/name`), so an agent on a repo-pinned rule
// could reach any repo via `gh pr view --repo=other/repo`. And a pinned rule
// with NO repo flag at all (cwd-inferred) fell through to a grant — the pin was
// silently skippable. Both are now closed: the `=` form is extracted, and a
// pinned rule with no extractable repo FAILS CLOSED (deny). Rules WITHOUT a
// `repos` restriction are unchanged (the read-only floor keeps its behaviour).
// =============================================================================
describe("bash-guard.hook — gh repo-pin bypass close (F1)", () => {
  // A repo-pinned gh rule: only the-metafactory/cortex is reachable.
  const pinnedConfig = JSON.stringify({
    rules: [{ pattern: "^gh\\s+(pr|issue)\\s", repos: ["the-metafactory/cortex"] }],
  });
  // An UNRESTRICTED gh rule (no repos on the rule, no top-level repos) — the
  // floor behaviour that must stay unchanged by the fail-closed direction.
  const floorConfig = JSON.stringify({
    rules: [{ pattern: "^gh\\s+(pr|issue)\\s" }],
  });

  function runPinned(cmd: string) {
    return runHook(cmd, {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: pinnedConfig,
    });
  }

  test("`--repo=evil/other` (= form) on a pinned rule is DENIED (bypass closed)", () => {
    const r = runPinned("gh pr view --repo=the-metafactory/some-other-repo 1");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "the-metafactory/some-other-repo",
    );
  });

  test("`--repo=granted/repo` (= form) on a pinned rule is GRANTED", () => {
    const r = runPinned("gh pr view --repo=the-metafactory/cortex 1");
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("`-R=granted/repo` (short = form) on a pinned rule is GRANTED", () => {
    const r = runPinned("gh pr view -R=the-metafactory/cortex 1");
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("pinned rule with NO repo flag FAILS CLOSED (deny, pass --repo reason)", () => {
    const r = runPinned("gh pr create --title x --body y");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("--repo owner/name");
  });

  test("unrestricted floor rule with NO repo flag is still ALLOWED (unchanged)", () => {
    const r = runHook("gh pr list", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: floorConfig,
    });
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });
});

// =============================================================================
// cortex#2335 — the DEFAULT floor's gh rule drops `api` and `run`.
//
// The floor runs with `repos: []`, so the repo-pin block (F1) never engages for
// it. While `api`/`run` were on the floor gh rule, ANY bash-guarded agent on the
// default floor (channel set, no custom CORTEX_BASH_GUARD) could auto-approve
// `gh api -X PUT repos/<o>/<r>/pulls/<n>/merge` (merge a PR), `gh api -X DELETE`,
// `gh api graphql`, `gh api user`, and `gh run` workflow dispatch — a raw REST
// surface STRONGER than the deliberately-narrowed code capability (whose
// allowlist omits exactly these; stack-lib.ts). The floor now exposes the
// porcelain verbs (pr/issue/repo) only; a stack needing `api`/`run` declares an
// explicit (ideally repos-pinned) rule. These tests drive the DEFAULT floor
// itself — CORTEX_CHANNEL set, NO agent-id, NO CORTEX_BASH_GUARD → loadConfig()
// returns DEFAULT_CONFIG (not the F1 floorConfig mirror, which is a stand-in).
// =============================================================================
describe("bash-guard.hook — floor drops gh api/run (cortex#2335)", () => {
  // A real DEFAULT-floor session: channel present (passes gate-1), no agent-id
  // (no gate-2 CLI bypass), no CORTEX_BASH_GUARD (loadConfig → DEFAULT_CONFIG).
  function runFloor(cmd: string) {
    return runHook(cmd, {
      CORTEX_CHANNEL: "community",
      CORTEX_AGENT_ID: undefined,
      GROVE_AGENT_ID: undefined,
      CORTEX_BASH_GUARD: undefined,
    });
  }

  function expectFloorDeny(stdout: string): void {
    const out = JSON.parse(stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe("allow");
    expect(out.continue).toBeUndefined();
  }

  test("`gh api -X PUT .../pulls/N/merge` is DENIED on the floor (the hole)", () => {
    const r = runFloor(
      "gh api -X PUT repos/the-metafactory/cortex/pulls/1/merge",
    );
    expect(r.status).toBe(0);
    expectFloorDeny(r.stdout);
  });

  test("`gh api user` (raw endpoint, no repo to pin) is DENIED on the floor", () => {
    const r = runFloor("gh api user");
    expect(r.status).toBe(0);
    expectFloorDeny(r.stdout);
  });

  test("`gh api graphql` is DENIED on the floor", () => {
    const r = runFloor("gh api graphql -f query='{viewer{login}}'");
    expect(r.status).toBe(0);
    expectFloorDeny(r.stdout);
  });

  test("`gh run list` (workflow dispatch surface) is DENIED on the floor", () => {
    const r = runFloor("gh run list");
    expect(r.status).toBe(0);
    expectFloorDeny(r.stdout);
  });

  test("`gh pr list` is still GRANTED on the floor (porcelain unchanged)", () => {
    const r = runFloor("gh pr list");
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("`gh issue view 1` is still GRANTED on the floor (porcelain unchanged)", () => {
    const r = runFloor("gh issue view 1");
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("`gh repo view` is still GRANTED on the floor (porcelain unchanged)", () => {
    const r = runFloor("gh repo view the-metafactory/cortex");
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  // --- cortex#2335 review (mellanon): porcelain SUBCOMMAND restriction. The
  // verb-open floor allowed destructive porcelain — mutating ops the code
  // capability forbids. The floor must be <= the code capability. These assert
  // the mutating porcelain is DENIED (this is what "went unnoticed"). ---
  test("`gh pr merge` is DENIED on the floor (floor must not out-power the code agent)", () => {
    const r = runFloor("gh pr merge 1 --repo the-metafactory/cortex");
    expect(r.status).toBe(0);
    expectFloorDeny(r.stdout);
  });

  test("`gh pr merge --admin` (branch-protection bypass) is DENIED on the floor", () => {
    const r = runFloor("gh pr merge 1 --admin");
    expect(r.status).toBe(0);
    expectFloorDeny(r.stdout);
  });

  test("`gh pr review --approve` (self-approve) is DENIED on the floor", () => {
    const r = runFloor("gh pr review 1 --approve");
    expect(r.status).toBe(0);
    expectFloorDeny(r.stdout);
  });

  test("`gh pr close` is DENIED on the floor", () => {
    const r = runFloor("gh pr close 1");
    expect(r.status).toBe(0);
    expectFloorDeny(r.stdout);
  });

  test("`gh issue delete` is DENIED on the floor", () => {
    const r = runFloor("gh issue delete 1 --yes");
    expect(r.status).toBe(0);
    expectFloorDeny(r.stdout);
  });

  test("`gh repo delete` is DENIED on the floor (prompt-injection blast radius)", () => {
    const r = runFloor("gh repo " + "delete the-metafactory/cortex --yes");
    expect(r.status).toBe(0);
    expectFloorDeny(r.stdout);
  });

  test("`gh pr comment` (non-mutating collab) is still GRANTED on the floor", () => {
    const r = runFloor("gh pr comment 1 --body hi");
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("a stack that EXPLICITLY grants `gh api` (own rule) still works — floor removal is not a global ban", () => {
    // The escape hatch Andreas's proposal preserves: an agent genuinely needing
    // gh api declares its own rule. Proves we closed the FLOOR, not gh api itself.
    const r = runHook("gh api repos/the-metafactory/cortex/contents/README.md", {
      CORTEX_CHANNEL: "recon",
      CORTEX_AGENT_ID: "recon-agent",
      CORTEX_BASH_GUARD: JSON.stringify({ rules: [{ pattern: "^gh\\s+api\\s" }] }),
    });
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
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

// =============================================================================
// EBH-1 (cortex#2343 step 3) — path containment for the read-command rules
// (cat/head/tail/ls/wc/file). Command-shape allow alone is no longer
// sufficient: these tests prove the SAME CORTEX_PATH_GUARD policy
// path-guard.hook.ts enforces for the file tools also gates these Bash
// read commands' path argument(s).
// =============================================================================
describe("bash-guard.hook — path containment for read commands (EBH-1, cortex#2343)", () => {
  let root: string;
  let allowedDir: string;
  let readOnlyDir: string;
  let outsideDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-path-"));
    allowedDir = join(root, "allowed");
    readOnlyDir = join(root, "readonly");
    outsideDir = join(root, "outside");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(readOnlyDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(allowedDir, "ok.txt"), "fine\n");
    writeFileSync(join(readOnlyDir, "system.yaml"), "secret: true\n");
    writeFileSync(join(outsideDir, "secret.txt"), "nope\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [readOnlyDir] }),
    };
  }

  for (const cmd of ["cat", "head", "tail", "ls", "wc", "file"]) {
    test(`DENY "${cmd} <path outside allowedDirs/readOnlyDirs>"`, () => {
      const r = runHook(`${cmd} ${join(outsideDir, "secret.txt")}`, policyEnv());
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout.trim());
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("EBH-1");
    });

    test(`ALLOW "${cmd} <path inside allowedDirs>"`, () => {
      const target = cmd === "ls" || cmd === "wc" ? join(allowedDir, "ok.txt") : join(allowedDir, "ok.txt");
      const r = runHook(`${cmd} ${target}`, policyEnv());
      expect(r.status).toBe(0);
      expectGrantDecision(r.stdout);
    });

    test(`ALLOW "${cmd} <path inside readOnlyDir>" (read command, read-only dir is fine)`, () => {
      const r = runHook(`${cmd} ${join(readOnlyDir, "system.yaml")}`, policyEnv());
      expect(r.status).toBe(0);
      expectGrantDecision(r.stdout);
    });
  }

  test("DENY cat of the cortex-config-shaped path outside allowedDirs (repro from issue #2343)", () => {
    const configLikeDir = join(root, "config-like", "metafactory", "cortex", "system");
    mkdirSync(configLikeDir, { recursive: true });
    writeFileSync(join(configLikeDir, "system.yaml"), "token: abc\n");
    const r = runHook(`cat ${join(configLikeDir, "system.yaml")}`, policyEnv());
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("DENY via a symlink inside allowedDir pointing outside it (realpath'd before check)", () => {
    const linkPath = join(allowedDir, "escape-link");
    symlinkSync(outsideDir, linkPath);
    const r = runHook(`cat ${join(linkPath, "secret.txt")}`, policyEnv());
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("no CORTEX_PATH_GUARD configured (no restriction) ⇒ command-shape allow alone still GRANTS", () => {
    // Preserves EXISTING behaviour for sessions that haven't configured
    // allowedDirs — matches security-preamble.ts's "no dirs ⇒ no restriction"
    // contract. Uses `ls` (no args) which is always allowlisted.
    const r = runHook("ls", { CORTEX_CHANNEL: "test-channel", CORTEX_PATH_GUARD: undefined });
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("malformed CORTEX_PATH_GUARD ⇒ DENY even for an otherwise-allowlisted read command", () => {
    const r = runHook("ls", { CORTEX_CHANNEL: "test-channel", CORTEX_PATH_GUARD: "{not json" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("`gh` IS now path-checked (round 9, cortex#2370) — ordinary usage from an in-scope cwd still ALLOWS", () => {
    // Superseded assumption from before round 9: `gh` used to be silently
    // exempt from containment (the exact bug cortex#2370 closes). It is now
    // in PATH_CHECKED_COMMANDS like every other floor command — this proves
    // that alone doesn't over-deny ordinary positional-argument usage when
    // cwd is inside allowedDirs. See the dedicated "round 9" describe block
    // below for the full gh acceptance matrix (including the --body-file
    // exfil vector this round closes).
    const r = runHook(
      "gh pr view 1 --repo the-metafactory/cortex",
      {
        CORTEX_CHANNEL: "test-channel",
        CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
      },
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("existing #2337 gh-floor rules are untouched: gh pr merge still DENIES", () => {
    const r = runHook("gh pr merge 1 --admin", {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

// =============================================================================
// B1 (CRITICAL, cortex#2343 adversarial review) — `~`/`$VAR` must expand to
// the REAL path before the containment check, or the guard checks a
// DIFFERENT path than the shell actually runs (a token like
// `~/.ssh/id_rsa` / `$HOME/.ssh/id_rsa` is not absolute, so a naive
// resolve(cwd, token) treats it as a literal relative path under an
// already-allowed cwd — silently ALLOWING an escape into the real home dir).
// =============================================================================
describe("bash-guard.hook — B1: ~/$VAR expansion before path containment", () => {
  let root: string;
  let allowedDir: string;
  let fakeHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-b1-"));
    allowedDir = join(root, "allowed");
    fakeHome = join(root, "fakehome");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    writeFileSync(join(fakeHome, ".ssh", "id_rsa"), "fake-key\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
      HOME: fakeHome,
    };
  }

  test("DENY 'cat $HOME/.ssh/id_rsa' when HOME is outside allowedDirs, cwd inside allowedDir", () => {
    const r = runHook("cat $HOME/.ssh/id_rsa", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("DENY 'cat ~/.ssh/id_rsa' when HOME is outside allowedDirs, cwd inside allowedDir", () => {
    const r = runHook("cat ~/.ssh/id_rsa", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("control: 'cat /etc/hosts' still denies (sanity — proves the policy IS active)", () => {
    const r = runHook("cat /etc/hosts", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("legitimate 'cat ~/allowed/ok.txt' resolving INSIDE allowedDirs still grants", () => {
    const r = runHook(
      `cat ~/allowed/ok.txt`,
      {
        CORTEX_CHANNEL: "test-channel",
        CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
        HOME: root, // ~/allowed resolves to <root>/allowed === allowedDir
      },
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });
});

// =============================================================================
// R1 (cortex#2343 adversarial review ROUND 2) — table-driven matrix covering
// the CLASS of shell-expansion tokens for the Bash read-command path, not
// just the two repros the review gave.
// =============================================================================
describe("bash-guard.hook — R1: shell-expansion CLASS matrix", () => {
  let root: string;
  let allowedDir: string;
  let fakeHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-r1-matrix-"));
    allowedDir = join(root, "allowed");
    fakeHome = join(root, "fakehome");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
      HOME: fakeHome, // outside allowedDir — any HOME-based resolution must deny
    };
  }

  interface Row {
    label: string;
    arg: string;
    expectDeny: boolean;
  }

  const rows: Row[] = [
    { label: "~root/x (other user's home)", arg: "~root/x", expectDeny: true },
    { label: "~someuser/x (other user's home)", arg: "~someuser/x", expectDeny: true },
    { label: "~/x (HOME outside allowedDirs)", arg: "~/x", expectDeny: true },
    { label: "~ bare (HOME outside allowedDirs)", arg: "~", expectDeny: true },
    { label: "${HOME}/x (HOME outside allowedDirs)", arg: "${HOME}/x", expectDeny: true },
    { label: "$HOME/x (HOME outside allowedDirs)", arg: "$HOME/x", expectDeny: true },
    { label: "$UNSET_EBH1_VAR/x (unset ⇒ empty string ⇒ /x ⇒ outside)", arg: "$UNSET_EBH1_VAR/x", expectDeny: true },
    { label: "a/$5/mid-path ($5 unresolvable — not a valid var name)", arg: "a/$5/mid-path", expectDeny: true },
    { label: "/etc/hosts (plain absolute, no shell syntax — sanity control)", arg: "/etc/hosts", expectDeny: true },
  ];

  for (const { label, arg, expectDeny } of rows) {
    test(`cat ${label} → ${expectDeny ? "DENY" : "ALLOW"}`, () => {
      delete process.env.UNSET_EBH1_VAR;
      const r = runHook(`cat ${arg}`, policyEnv(), "Bash", "test-session", allowedDir);
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout.trim());
      if (expectDeny) {
        expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      } else {
        expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
      }
    });
  }

  test("positive control: 'cat ok.txt' (plain relative, resolves inside allowedDir) allows", () => {
    const r = runHook("cat ok.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });
});

// =============================================================================
// "Still-open bypass" (cortex#2343 adversarial review round 3) — bash brace
// expansion. `rejectsChaining` does not (and should not) block `{` — brace
// expansion is not a chaining primitive — but the R2 brace-awareness fix
// only ever landed in path-guard's Glob branch, never in bash-guard's own
// command-path check, so `cat {/tmp/secret,x}/f` (a REAL bash brace
// expansion — bash genuinely reads BOTH `/tmp/secret/f` and `x/f`) sailed
// through unrecognised. Root-caused + fixed by routing BOTH hooks through
// the ONE shared `reduceTokenToRealPathOrReject` (path-containment.ts) —
// this matrix proves bash-guard now shares the exact same brace/wildcard
// treatment path-guard's Glob branch does.
// =============================================================================
describe("bash-guard.hook — round 3: brace expansion + wildcard CLASS matrix", () => {
  let root: string;
  let allowedDir: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-r3-matrix-"));
    allowedDir = join(root, "allowed");
    secretDir = join(root, "secret");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "canary.txt"), "canary\n");
    writeFileSync(join(allowedDir, "ok.log"), "fine\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  test("cat {/abs,x}/f — absolute alternative HIDDEN inside a brace ⇒ DENY", () => {
    const r = runHook(`cat {${secretDir},x}/canary.txt`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat {../rel,x}/f — .. traversal alternative HIDDEN inside a brace ⇒ DENY", () => {
    const r = runHook("cat {../secret,x}/canary.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("control: cat /tmp/.../secret/canary.txt (plain absolute, no braces) still denies", () => {
    // Proves the two brace repros above are specifically about braces, not
    // about the absolute path being denied for some unrelated reason.
    const r = runHook(`cat ${join(secretDir, "canary.txt")}`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat *.log — bare cwd-relative wildcard with no directory component ⇒ ALLOW", () => {
    const r = runHook("cat *.log", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("cat /etc/pa* — absolute pathname glob (shell pathname expansion) ⇒ DENY", () => {
    const r = runHook("cat /etc/pa*", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat {a,b}/ok.log — two SAFE relative brace alternatives, both resolving inside allowedDir ⇒ ALLOW", () => {
    mkdirSync(join(allowedDir, "a"), { recursive: true });
    mkdirSync(join(allowedDir, "b"), { recursive: true });
    writeFileSync(join(allowedDir, "a", "ok.log"), "a\n");
    writeFileSync(join(allowedDir, "b", "ok.log"), "b\n");
    const r = runHook("cat {a,b}/ok.log", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("cat {a,../secret}/ok.log — ONE safe + ONE escaping alternative ⇒ DENY (any risky alternative vetoes the whole token)", () => {
    const r = runHook("cat {a,../secret}/canary.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

// =============================================================================
// Bypass #4 (cortex#2343 adversarial review round 4) — bash quote-removal.
// `extractCommandPaths` only stripped a quote pair that wraps a WHOLE
// token; an EMBEDDED quote pair (including bash's `""`/`''`
// empty-string-concatenation form, which real bash quote-REMOVES —
// `/a/""/../b` reads as `/a/../b`) survived verbatim, so the guard resolved
// a DIFFERENT string than the shell actually runs. Fixed by refusing to
// predict shell quote-removal at all: any candidate path token that STILL
// contains a `"`/`'` after the whole-token strip DENIES THE WHOLE COMMAND.
// Each deny case below is verified against REAL bash (`bash -c`) to
// confirmed it reads outside allowedDirs (or fails to parse at all) — the
// guard's deny is not over-cautious, it is the ONLY safe answer.
// =============================================================================
describe("bash-guard.hook — round 4: bash quote-removal CLASS matrix", () => {
  let root: string;
  let allowedDir: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-r4-matrix-"));
    allowedDir = join(root, "allowed");
    secretDir = join(root, "secret");
    mkdirSync(join(allowedDir, "sub"), { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "canary.txt"), "canary\n");
    writeFileSync(join(allowedDir, "sub", "b"), "inside\n");
    writeFileSync(join(allowedDir, "my file.txt"), "spacefile\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  test('cat /a/""/../secret/x — embedded EMPTY double-quote segment ⇒ DENY (real bash reads OUTSIDE allowedDirs)', () => {
    // Ground truth: `bash -c` on this exact command reads secretDir/canary.txt
    // — the "" segment vanishes via bash quote-removal, so the ".." cancels
    // "sub" instead of a phantom empty segment. Confirmed live.
    const realBash = spawnSync("bash", ["-c", `cat ${allowedDir}/sub/""/../../secret/canary.txt`], {
      encoding: "utf-8",
    });
    expect(realBash.stdout.trim()).toBe("canary");

    const r = runHook(`cat ${allowedDir}/sub/""/../../secret/canary.txt`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat /a/''/../secret/x — embedded EMPTY single-quote segment ⇒ DENY (real bash reads OUTSIDE allowedDirs)", () => {
    const realBash = spawnSync("bash", ["-c", `cat ${allowedDir}/sub/''/../../secret/canary.txt`], {
      encoding: "utf-8",
    });
    expect(realBash.stdout.trim()).toBe("canary");

    const r = runHook(`cat ${allowedDir}/sub/''/../../secret/canary.txt`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test('cat /a/"b"/c — embedded double-quote wrapping mid-token text ⇒ DENY', () => {
    // Real bash resolves this to the SAME file (quote-removal of "sub" just
    // unquotes it back to `sub`), so it stays inside allowedDirs — but the
    // guard denies anyway per the fail-closed-on-ambiguity policy: it must
    // not GUESS that an embedded quote is harmless just because it happens
    // to resolve safely in one case. Confirmed real bash still reads it
    // (proving the command IS a live, parseable bash invocation, not a
    // syntax error the guard could safely ignore).
    const realBash = spawnSync("bash", ["-c", `cat ${allowedDir}/"sub"/b`], { encoding: "utf-8" });
    expect(realBash.stdout.trim()).toBe("inside");

    const r = runHook(`cat ${allowedDir}/"sub"/b`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat /a/'b'c — embedded single-quote NOT wrapping the whole token ⇒ DENY", () => {
    const realBash = spawnSync("bash", ["-c", `cat ${allowedDir}/sub/'b'`], { encoding: "utf-8" });
    expect(realBash.stdout.trim()).toBe("inside");

    const r = runHook(`cat ${allowedDir}/sub/'b'`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test('cat "my file.txt" — WHOLE-TOKEN quoted space-in-path ⇒ DENY (round 5 supersedes round 4 here)', () => {
    // Round 4 allowed this (a cleanly whole-token-quoted path with a space
    // is unambiguous — bash really does read exactly "my file.txt"). Round
    // 5's character WHITELIST deliberately excludes whitespace (the
    // adversarial review's own explicit character list + required-ALLOW
    // list did NOT carve out an exception for it), so this is now denied —
    // an intentional, documented over-denial of a legitimate-but-rare case
    // via these six read-only bash commands, traded for closing the whole
    // unenumerated char-trick class by construction. A space-containing
    // path is still reachable through the Read tool (path-guard.hook.ts,
    // which is NOT whitelisted — file_path is taken literally, no shell
    // involved) or by widening allowedDirs.
    const realBash = spawnSync("bash", ["-c", `cd ${allowedDir} && cat "my file.txt"`], { encoding: "utf-8" });
    expect(realBash.stdout.trim()).toBe("spacefile"); // real bash CAN read it — the guard still refuses, deliberately

    const r = runHook('cat "my file.txt"', policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat ok.txt (no space, whitelisted chars only) inside allowedDirs ⇒ ALLOW — proves round 5 didn't break the common case", () => {
    writeFileSync(join(allowedDir, "ok.txt"), "fine\n");
    const r = runHook("cat ok.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test('cat "/abs/outside" — WHOLE-TOKEN quoted, outside allowedDirs ⇒ DENY (by normal containment, not quote-ambiguity)', () => {
    const realBash = spawnSync("bash", ["-c", `cat "${join(secretDir, "canary.txt")}"`], { encoding: "utf-8" });
    expect(realBash.stdout.trim()).toBe("canary");

    const r = runHook(`cat "${join(secretDir, "canary.txt")}"`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    // Distinguish from the quote-ambiguity deny reason — this one denies via
    // ordinary containment (the reducer produced a clean real path, and it
    // just wasn't inside allowedDirs).
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain(
      "resolves outside every configured allowedDirs",
    );
  });

  test('cat "/a/b (dangling/unbalanced quote) ⇒ DENY (real bash fails to even PARSE the command)', () => {
    const realBash = spawnSync("bash", ["-c", `cat "${join(allowedDir, "sub", "b")}`], { encoding: "utf-8" });
    expect(realBash.status).not.toBe(0); // bash: unexpected EOF while looking for matching `"'

    const r = runHook(`cat "${join(allowedDir, "sub", "b")}`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("bash-guard.hook — round 4: malformed CORTEX_BASH_GUARD fails closed", () => {
  test("present-but-unparseable CORTEX_BASH_GUARD ⇒ DENY (was DEFAULT_CONFIG fallback — fail OPEN — before this fix)", () => {
    const r = runHook("ls", {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_BASH_GUARD: "{not valid json",
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("present-but-non-object CORTEX_BASH_GUARD (a JSON array) ⇒ DENY", () => {
    const r = runHook("ls", {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_BASH_GUARD: "[1,2,3]",
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("absent CORTEX_BASH_GUARD still behaves as DEFAULT_CONFIG (unaffected by this fix)", () => {
    const r = runHook("ls", { CORTEX_CHANNEL: "test-channel", CORTEX_BASH_GUARD: undefined });
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test('{"disabled":true} still passes through (unaffected by this fix — a well-formed instruction, not malformed)', () => {
    const r = runHook("rm -rf /tmp/x", {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_BASH_GUARD: JSON.stringify({ disabled: true }),
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });
});

// =============================================================================
// Bypass #5 (cortex#2343 adversarial review round 5) — bash backslash
// escaping, the signal to stop blacklisting individual shell tricks and
// flip to a character WHITELIST. `\.` → `.` under bash's escape removal,
// so `cat /a/\../secret/x` reads `/a/../secret/x` — a DIFFERENT path than
// the guard's literal-token resolution saw. Every DENY case below is
// cross-checked against REAL bash (`bash -c`) to confirm the guard's
// refusal matches what the shell would actually do (or, for the safe
// ALLOW cases, that the whitelist does NOT over-deny ordinary paths).
// =============================================================================
describe("bash-guard.hook — round 5: character whitelist matrix", () => {
  let root: string;
  let allowedDir: string;
  let secretDir: string;
  let fakeHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-r5-matrix-"));
    allowedDir = join(root, "allowed");
    secretDir = join(root, "secret");
    fakeHome = join(root, "fakehome");
    mkdirSync(join(allowedDir, "src"), { recursive: true });
    mkdirSync(join(allowedDir, "sub", "dir"), { recursive: true });
    mkdirSync(join(allowedDir, "repo"), { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(secretDir, "canary.txt"), "canary\n");
    writeFileSync(join(allowedDir, "src", "foo.ts"), "ts\n");
    writeFileSync(join(allowedDir, "sub", "dir", "file.txt"), "nested\n");
    writeFileSync(join(allowedDir, "repo", "file"), "repofile\n");
    writeFileSync(join(allowedDir, "ok.log"), "log\n");
    writeFileSync(join(allowedDir, "file-name_v2.txt"), "v2\n");
    writeFileSync(join(allowedDir, "file.txt"), "plain\n");
    writeFileSync(join(allowedDir, "b.c@1"), "at1\n");
    writeFileSync(join(allowedDir, "x y"), "spacefile\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  function denyEnv(): Record<string, string> {
    // HOME deliberately OUTSIDE allowedDirs — matches round 1/2's fixture
    // convention so a `~`-based escape denies via containment as expected.
    return { ...policyEnv(), HOME: fakeHome };
  }

  // ---- DENY: backslash + unenumerated character tricks ----

  test("cat /a/\\../secret/x — backslash-escaped dot-dot ⇒ DENY (real bash reads OUTSIDE allowedDirs)", () => {
    const realBash = spawnSync("bash", ["-c", `cat ${allowedDir}/\\../secret/canary.txt`], { encoding: "utf-8" });
    // The backslash is a no-op escape (`\.` → `.`), so bash resolves this
    // relative to allowedDir's PARENT — it escapes allowedDir entirely.
    expect(realBash.stdout.trim()).toBe("canary");

    const r = runHook(`cat ${allowedDir}/\\../secret/canary.txt`, denyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat /a/\\secret/x — backslash before a plain char (no-op escape) ⇒ DENY (real bash reads the secret)", () => {
    const realBash = spawnSync("bash", ["-c", `cat ${root}/\\secret/canary.txt`], { encoding: "utf-8" });
    expect(realBash.stdout.trim()).toBe("canary");

    const r = runHook(`cat ${root}/\\secret/canary.txt`, denyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat /a/x\\ y — backslash-escaped space ⇒ DENY (real bash reads the space-named file inside allowedDirs; denied anyway — backslash is never whitelisted)", () => {
    const realBash = spawnSync("bash", ["-c", `cat ${allowedDir}/x\\ y`], { encoding: "utf-8" });
    expect(realBash.stdout.trim()).toBe("spacefile");

    const r = runHook(`cat ${allowedDir}/x\\ y`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat /a/$(echo x) — command substitution ⇒ DENY (already via rejectsChaining — round 5 keeps this intact)", () => {
    const r = runHook(`cat ${allowedDir}/$(echo x)`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat /a/foo^bar — caret (bash quick-substitution char) ⇒ DENY", () => {
    const r = runHook(`cat ${allowedDir}/foo^bar`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat /a/foo!bar — bang (bash history-expansion char) ⇒ DENY", () => {
    const r = runHook(`cat ${allowedDir}/foo!bar`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // ---- ALLOW: ordinary paths must not be over-denied ----

  test("cat /src/foo.ts (absolute, whitelisted chars, inside allowedDirs) ⇒ ALLOW", () => {
    const r = runHook(`cat ${allowedDir}/src/foo.ts`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("cat ~/repo/file (tilde, HOME resolves INSIDE allowedDirs) ⇒ ALLOW", () => {
    // HOME points AT allowedDir itself so `~/repo/file` resolves inside
    // scope — proves the whitelist lets `~` through to the reducer rather
    // than blocking it itself (unlike round 1/2's fixtures, which
    // deliberately point HOME OUTSIDE to prove the opposite: a DENY).
    const r = runHook("cat ~/repo/file", { ...policyEnv(), HOME: allowedDir }, "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("cat sub/dir/file.txt (relative, nested, whitelisted chars) ⇒ ALLOW", () => {
    const r = runHook("cat sub/dir/file.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("cat *.log (bare wildcard, no directory component) ⇒ ALLOW", () => {
    const r = runHook("cat *.log", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("cat file-name_v2.txt (hyphen + underscore + digit, all whitelisted) ⇒ ALLOW", () => {
    const r = runHook("cat file-name_v2.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("head -n 20 file.txt (flag + numeric value + plain filename) ⇒ ALLOW", () => {
    const r = runHook("head -n 20 file.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("cat a/b.c@1 (@ is whitelisted) ⇒ ALLOW", () => {
    const r = runHook("cat b.c@1", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("cat $HOME/x style (reducer-expanded $VAR, resolves INSIDE allowedDirs) ⇒ ALLOW", () => {
    writeFileSync(join(allowedDir, "x"), "homefile\n");
    const r = runHook("cat $HOME/x", { ...policyEnv(), HOME: allowedDir }, "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });
});

// =============================================================================
// Bypass #6 (cortex#2343 adversarial review round 6, FINAL L1 round) —
// flag-value classification / arbitrary file-content exfil. A `-`-prefixed
// token was unconditionally skipped as "just a flag" — never classified as
// a path, so never whitelisted or containment-checked. `file -f<path>` /
// `file --files-from=<path>` read the path GLUED to the flag and echo that
// file's CONTENTS back on error (a real, live exfil primitive, confirmed
// against the actual `file` binary below) — a different class from the
// character-based bypasses rounds 1-5 closed.
// =============================================================================
describe("bash-guard.hook — round 6: flag-value classification matrix", () => {
  let root: string;
  let allowedDir: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-r6-matrix-"));
    allowedDir = join(root, "allowed");
    secretDir = join(root, "secret");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "canary.txt"), "SECRET_CANARY_LINE\n");
    writeFileSync(join(allowedDir, "file.txt"), "plain\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  test("file -f/x — path glued to a short flag ⇒ DENY (real `file` echoes the secret line on error)", () => {
    const canaryPath = join(secretDir, "canary.txt");
    // Ground truth: the real `file` binary reads canaryPath as a LIST of
    // filenames-to-check (one per line) and, since "SECRET_CANARY_LINE" is
    // not a real file, echoes it back verbatim in its error output — an
    // exfil primitive, not a hypothetical.
    const realFile = spawnSync("file", [`-f${canaryPath}`], { encoding: "utf-8" });
    expect(realFile.stdout + realFile.stderr).toContain("SECRET_CANARY_LINE");

    const r = runHook(`file -f${canaryPath}`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("path-shaped value glued to a flag");
  });

  test("file --files-from=/x — path glued via = ⇒ DENY (real `file` echoes the secret line on error)", () => {
    const canaryPath = join(secretDir, "canary.txt");
    const realFile = spawnSync("file", [`--files-from=${canaryPath}`], { encoding: "utf-8" });
    expect(realFile.stdout + realFile.stderr).toContain("SECRET_CANARY_LINE");

    const r = runHook(`file --files-from=${canaryPath}`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("wc --files0-from=/x — path glued via = on a different path-checked command ⇒ DENY", () => {
    const r = runHook(
      `wc --files0-from=${join(secretDir, "canary.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("ls -l — boolean flag, no path-shaped content ⇒ ALLOW (no over-deny regression)", () => {
    const r = runHook("ls -l", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("head -n 20 file.txt — value-taking flag with a NUMERIC (non-path) value ⇒ ALLOW", () => {
    const r = runHook("head -n 20 file.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("file --color=auto file.txt — = flag with a non-path value ⇒ ALLOW", () => {
    const r = runHook("file --color=auto file.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("file --mime-type file.txt — bare boolean-ish flag with no value at all ⇒ ALLOW", () => {
    const r = runHook("file --mime-type file.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });
});

// =============================================================================
// Bypass #7 (cortex#2359, EBH-1c finding 1, round 7 — the coverage-drift
// finding) — a BARE RELATIVE flag value. Round 6's `isPathShapedFlagValue`
// only denies a `-`-prefixed token that itself contains `/`/`~`, or is a
// `.`-leading `=`-value. `file -flist` / `file --files-from=list` / `wc
// --files0-from=list` match NONE of those shapes (no `/`, no `~`, and the
// value doesn't start with `.`) — verified LIVE on `main` @ c25a7c3d as an
// actual bypass: the guard allowed all three, and the real `file` binary
// (cross-checked below) reads the OUT-OF-SCOPE path named inside `list`.
// Fixed by the per-command flag-name WHITELIST (`COMMAND_FLAG_POLICIES` +
// `classifyFlagToken`): a flag not on the calling command's explicit safe
// list denies the WHOLE command, regardless of what shape its value takes.
// =============================================================================
describe("bash-guard.hook — round 7: bare-relative flag-value coverage (cortex#2359 finding 1)", () => {
  let root: string;
  let allowedDir: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-r7-matrix-"));
    allowedDir = join(root, "allowed");
    secretDir = join(root, "secret");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "canary.txt"), "SECRET_CANARY_LINE\n");
    // The "list" file itself lives INSIDE allowedDir (so referencing it by a
    // bare relative name is otherwise unremarkable) but its CONTENTS name an
    // OUT-OF-SCOPE path — the exact cortex#2359 repro shape.
    writeFileSync(join(allowedDir, "list"), `${join(secretDir, "canary.txt")}\n`);
    writeFileSync(join(allowedDir, "file.txt"), "plain\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  // ---- DENY: the live bypasses from the issue repro ----

  test("file -flist — bare relative value glued to a short flag ⇒ DENY (real `file` reads the out-of-scope path)", () => {
    // Ground truth: the real `file` binary, run from allowedDir exactly like
    // the guard's cwd, follows the relative "list" argument, reads the
    // out-of-scope canary path named inside it, and reports on THAT file —
    // proving out-of-scope file access, not a hypothetical.
    const realFile = spawnSync("file", ["-flist"], { encoding: "utf-8", cwd: allowedDir });
    expect(realFile.stdout + realFile.stderr).toContain(join(secretDir, "canary.txt"));

    const r = runHook("file -flist", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unrecognised flag");
  });

  test("file --files-from=list — bare relative value via `=` ⇒ DENY (real `file` reads the out-of-scope path)", () => {
    const realFile = spawnSync("file", ["--files-from=list"], { encoding: "utf-8", cwd: allowedDir });
    expect(realFile.stdout + realFile.stderr).toContain(join(secretDir, "canary.txt"));

    const r = runHook("file --files-from=list", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unrecognised flag");
  });

  test("wc --files0-from=list — bare relative value on a different path-checked command ⇒ DENY", () => {
    // No real-tool cross-check here: this dev box's default `wc` is the BSD
    // build, which doesn't implement --files0-from at all (GNU coreutils —
    // the production Linux target — does; see the issue). The guard decision
    // does not depend on which `wc` build is installed, only on the command
    // shape, so the assertion below is meaningful regardless.
    const r = runHook("wc --files0-from=list", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unrecognised flag");
  });

  test("wc --files0-from=list — value file names an out-of-scope path ⇒ DENY (denied by flag-name alone, contents never inspected)", () => {
    // Same fixture as the DENY case above, restated to make explicit that
    // the deny does not depend on reading `list`'s contents at all — the
    // whole command is refused before the guard would ever open it.
    const r = runHook("wc --files0-from=list", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // ---- ALLOW: no over-deny regression on ordinary safe-flag usage ----

  test("ls -l ⇒ ALLOW", () => {
    const r = runHook("ls -l", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("head -n 20 f.txt ⇒ ALLOW", () => {
    writeFileSync(join(allowedDir, "f.txt"), "x\n");
    const r = runHook("head -n 20 f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("wc -l f.txt ⇒ ALLOW", () => {
    writeFileSync(join(allowedDir, "f.txt"), "x\n");
    const r = runHook("wc -l f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("file --mime-type f.txt ⇒ ALLOW", () => {
    writeFileSync(join(allowedDir, "f.txt"), "x\n");
    const r = runHook("file --mime-type f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("cat -n f.txt ⇒ ALLOW", () => {
    writeFileSync(join(allowedDir, "f.txt"), "x\n");
    const r = runHook("cat -n f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  // ---- ALLOW: bundled / glued safe-flag forms ----

  test("ls -la ⇒ ALLOW (bundled boolean short flags)", () => {
    const r = runHook("ls -la", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("head -n20 f.txt ⇒ ALLOW (glued numeric short-flag value)", () => {
    writeFileSync(join(allowedDir, "f.txt"), "x\n");
    const r = runHook("head -n20 f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  // ---- DENY: unrecognised flags on each path-checked command (no silent skip) ----

  test("tail --retry f.txt ⇒ DENY (long flag not on tail's whitelist)", () => {
    writeFileSync(join(allowedDir, "f.txt"), "x\n");
    const r = runHook("tail --retry f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unrecognised flag");
  });

  test("ls --hide=list ⇒ DENY (long flag not on ls's whitelist, `=list` value never reached)", () => {
    const r = runHook("ls --hide=list", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unrecognised flag");
  });

  test("cat --references f.txt ⇒ DENY (long flag not on cat's whitelist)", () => {
    writeFileSync(join(allowedDir, "f.txt"), "x\n");
    const r = runHook("cat --references f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

// =============================================================================
// Round 8 (cortex#2365, EBH-1d) — Finding 1: `git` was allowlisted by
// DEFAULT_CONFIG's shape rule but absent from PATH_CHECKED_COMMANDS, so
// `git diff --no-index` (a standalone diff utility needing no repository,
// NOT subject to git's own repo-boundary checks) could read and print the
// full contents of any two readable paths. Finding 2: `--` (POSIX
// end-of-options) regressed to a deny at round 7.
// =============================================================================
describe("bash-guard.hook — round 8: git path-check coverage + `--` end-of-options (cortex#2365)", () => {
  let root: string;
  let allowedDir: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-r8-matrix-"));
    allowedDir = join(root, "allowed");
    secretDir = join(root, "secret");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "canary.txt"), "GIT-EXFIL-CANARY-MARKER\n");
    writeFileSync(join(allowedDir, "ok.txt"), "fine\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  // ---- DENY: the live bypass from the issue repro (Finding 1) ----

  test("git diff --no-index /dev/null <out-of-scope> ⇒ DENY (real git leaks full file contents)", () => {
    // Ground truth: the real `git diff --no-index` prints the out-of-scope
    // file's contents verbatim — proving live exfiltration, not a
    // hypothetical (matches the issue's verified repro).
    const realGit = spawnSync(
      "git",
      ["diff", "--no-index", "/dev/null", join(secretDir, "canary.txt")],
      { encoding: "utf-8", cwd: allowedDir },
    );
    expect(realGit.stdout).toContain("GIT-EXFIL-CANARY-MARKER");

    const r = runHook(
      `git diff --no-index /dev/null ${join(secretDir, "canary.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unrecognised flag");
  });

  test("git diff --no-index <in-scope> <out-of-scope> ⇒ DENY (two-file form)", () => {
    const realGit = spawnSync(
      "git",
      ["diff", "--no-index", join(allowedDir, "ok.txt"), join(secretDir, "canary.txt")],
      { encoding: "utf-8", cwd: allowedDir },
    );
    expect(realGit.stdout).toContain("GIT-EXFIL-CANARY-MARKER");

    const r = runHook(
      `git diff --no-index ${join(allowedDir, "ok.txt")} ${join(secretDir, "canary.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("git -C /outside status ⇒ DENY (repo-redirect flag)", () => {
    const r = runHook(`git -C ${secretDir} status`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("git --git-dir=/outside log ⇒ DENY (repo-redirect flag)", () => {
    const r = runHook(`git --git-dir=${secretDir} log`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("git --work-tree=/outside status ⇒ DENY (repo-redirect flag)", () => {
    const r = runHook(`git --work-tree=${secretDir} status`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // ---- DENY: repo-redirect flags placed AFTER the subcommand, which is
  // the shape the guard's own COMMAND_FLAG_POLICIES.git containment
  // routing actually processes (a redirect flag BEFORE the subcommand
  // already fails DEFAULT_CONFIG's `^git\s+(log|diff|...)\b` shape rule on
  // its own, regardless of this round's fix — these prove the new git
  // flag policy itself, not just the pre-existing shape rule). ----

  test("git diff -C <out-of-scope dir> ⇒ DENY (shortValue containment routing)", () => {
    const r = runHook(`git diff -C ${secretDir}`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("EBH-1");
  });

  test("git status --work-tree <out-of-scope dir> ⇒ DENY (bare longValue form, containment routing)", () => {
    const r = runHook(`git status --work-tree ${secretDir}`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("EBH-1");
  });

  test("git log --git-dir=<out-of-scope dir> ⇒ DENY (`=`-glued longValue, denied by path-shaped-value gate)", () => {
    const r = runHook(`git log --git-dir=${secretDir}`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("git diff -C <in-scope dir> ⇒ ALLOW (no over-deny: an in-scope -C target still passes containment)", () => {
    const r = runHook(`git diff -C ${allowedDir}`, policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  // ---- ALLOW: no over-deny regression on ordinary safe git usage ----

  test("git status ⇒ ALLOW", () => {
    const r = runHook("git status", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("git log --oneline ⇒ ALLOW", () => {
    const r = runHook("git log --oneline", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("git diff ⇒ ALLOW", () => {
    const r = runHook("git diff", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("git diff HEAD~1 ⇒ ALLOW (rev is a positional non-flag, not misclassified as a path)", () => {
    const r = runHook("git diff HEAD~1", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("git show ⇒ ALLOW", () => {
    const r = runHook("git show", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("git rev-parse HEAD ⇒ ALLOW", () => {
    const r = runHook("git rev-parse HEAD", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("git branch ⇒ ALLOW", () => {
    const r = runHook("git branch", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("git diff -- <in-scope path> ⇒ ALLOW (`--` end-of-options, path containment-checked)", () => {
    const r = runHook(
      `git diff -- ${join(allowedDir, "ok.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("git diff -- <out-of-scope path> ⇒ DENY (`--` doesn't bypass containment)", () => {
    const r = runHook(
      `git diff -- ${join(secretDir, "canary.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // ---- Finding 2: `--` end-of-options no longer denies the whole command ----

  test("cat -- f.txt (in-scope) ⇒ ALLOW", () => {
    writeFileSync(join(allowedDir, "f.txt"), "x\n");
    const r = runHook("cat -- f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("cat -- /etc/passwd ⇒ DENY (out-of-scope absolute path, containment-checked not skipped)", () => {
    const r = runHook("cat -- /etc/passwd", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("EBH-1");
  });

  test("ls -- ⇒ ALLOW (bare end-of-options marker, no trailing args)", () => {
    const r = runHook("ls --", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("file -- -flist ⇒ DENY (a dash-led token after `--` is a LITERAL filename, containment-checked against a cwd outside allowedDirs — not reinterpreted as the `-f`/`--files-from` flag)", () => {
    // cwd is secretDir (outside allowedDirs) — proves "-flist" is resolved
    // as a real positional path relative to cwd and containment-checked,
    // rather than either (a) being denied outright as "unrecognised flag"
    // (the pre-fix, round-7-only behaviour for ANY leading "-" token) or
    // (b) being silently skipped.
    const r = runHook("file -- -flist", policyEnv(), "Bash", "test-session", secretDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("EBH-1");
  });

  test("file -- -flist ⇒ ALLOW when cwd IS inside allowedDirs (same literal-path resolution, now in-scope)", () => {
    const r = runHook("file -- -flist", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });
});

// =============================================================================
// Round 9 (cortex#2370, EBH-1e) — Finding: `gh` was allowlisted by
// DEFAULT_CONFIG's floor (`^gh\s+pr\s+(view|list|diff|checks|status|
// comment)\b`, `^gh\s+issue\s+(view|list|status|comment)\b`, `^gh\s+repo\s+
// view\b`) but absent from the (then opt-in) PATH_CHECKED_COMMANDS, so its
// arguments were never containment-checked. `gh pr comment 1 --body-file
// <out-of-scope>` reads an arbitrary local file and POSTS IT TO GITHUB — a
// live, verified REMOTE-exfiltration primitive, worse than the round 7/8
// local-read findings.
//
// This is also the round that INVERTS the coverage model itself
// (PATH_CHECKED_COMMANDS: opt-in → opt-out) — see `deriveFloorCommandHeadWords`
// / `FLOOR_COMMAND_HEAD_WORDS` / `PATH_CHECK_OPT_OUT_COMMANDS` /
// `COMMAND_FLAG_POLICIES` in bash-guard.hook.ts. The "floor coverage"
// describe block below is the regression test that makes a round 10 of this
// exact class impossible.
// =============================================================================
import {
  checkCommandPaths,
  COMMAND_FLAG_POLICIES,
  DEFAULT_CONFIG,
  deriveFloorCommandHeadWords,
  FLOOR_COMMAND_HEAD_WORDS,
  PATH_CHECK_OPT_OUT_COMMANDS,
} from "../bash-guard.hook";

describe("bash-guard.hook — round 9: gh path-check coverage (cortex#2370)", () => {
  let root: string;
  let allowedDir: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-r9-matrix-"));
    allowedDir = join(root, "allowed");
    secretDir = join(root, "secret");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "canary.txt"), "GH-EXFIL-CANARY-MARKER\n");
    writeFileSync(join(allowedDir, "body.md"), "an ordinary in-scope PR comment body\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  // ---- DENY: the live bypass from the issue repro ----

  test("gh pr comment 1 --body-file <out-of-scope> ⇒ DENY (the live remote-exfil bypass)", () => {
    const r = runHook(
      `gh pr comment 1 --body-file ${join(secretDir, "canary.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("EBH-1");
  });

  test("gh issue comment 1 --body-file <out-of-scope> ⇒ DENY (the live remote-exfil bypass)", () => {
    const r = runHook(
      `gh issue comment 1 --body-file ${join(secretDir, "canary.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("EBH-1");
  });

  // ---- ALLOW: no blanket ban on the flag — an in-scope body file still works ----

  test("gh pr comment 1 --body-file <in-scope> ⇒ ALLOW (containment-checked, not blanket-denied)", () => {
    const r = runHook(
      `gh pr comment 1 --body-file ${join(allowedDir, "body.md")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  // ---- ALLOW: no over-deny of ordinary read-only gh floor usage ----

  test("gh pr view 1 ⇒ ALLOW", () => {
    const r = runHook("gh pr view 1", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("gh pr list ⇒ ALLOW", () => {
    const r = runHook("gh pr list", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("gh pr diff ⇒ ALLOW", () => {
    const r = runHook("gh pr diff", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("gh pr checks ⇒ ALLOW", () => {
    const r = runHook("gh pr checks", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("gh issue view 1 ⇒ ALLOW", () => {
    const r = runHook("gh issue view 1", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("gh repo view ⇒ ALLOW", () => {
    const r = runHook("gh repo view", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  // ---- ALLOW: the round-9 opt-out set (pwd/echo/which) — unchanged behaviour ----

  test("pwd ⇒ ALLOW (opt-out: takes no operand)", () => {
    const r = runHook("pwd", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("echo hi ⇒ ALLOW (opt-out: prints argv verbatim, never reads a path)", () => {
    const r = runHook("echo hi", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("which bun ⇒ ALLOW (opt-out: searches $PATH for a command name)", () => {
    const r = runHook("which bun", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });
});

// =============================================================================
// Round 9 (cortex#2370, EBH-1e) — the regression test that makes a round 10
// of this class impossible. Rounds 7 (`file`), 8 (`git`), and 9 (`gh`) each
// found a DIFFERENT command silently missing from the (then opt-in)
// PATH_CHECKED_COMMANDS. Coverage is now derived PROGRAMMATICALLY from
// DEFAULT_CONFIG's live floor rules (`FLOOR_COMMAND_HEAD_WORDS`) — this test
// asserts every one of those command head words is EITHER on the explicit
// `PATH_CHECK_OPT_OUT_COMMANDS` allow-list OR carries a
// `COMMAND_FLAG_POLICIES` entry. It deliberately does NOT hard-code its own
// copy of the floor's command list (that duplicate list is exactly what drifted
// three times) — it reads `FLOOR_COMMAND_HEAD_WORDS`, which is itself derived
// from `DEFAULT_CONFIG.rules`, so widening the floor with a brand-new command
// and forgetting to declare its path posture fails THIS test immediately.
// =============================================================================
describe("bash-guard.hook — round 9: floor coverage (cortex#2370 regression guard)", () => {
  test("every DEFAULT_CONFIG floor command is opted out OR has a COMMAND_FLAG_POLICIES entry", () => {
    // Sanity: the floor must not have silently shrunk to nothing (a vacuous
    // pass here would defeat the whole point of this test).
    expect(FLOOR_COMMAND_HEAD_WORDS.size).toBeGreaterThan(0);
    // Ground truth: the specific commands this and prior rounds fixed must
    // actually be present in the derived set — proves the derivation itself
    // is wired to the real DEFAULT_CONFIG, not an empty/stale stand-in.
    for (const expected of ["gh", "git", "cat", "head", "tail", "ls", "wc", "file", "pwd", "echo", "which"]) {
      expect(FLOOR_COMMAND_HEAD_WORDS.has(expected)).toBe(true);
    }

    const undeclared: string[] = [];
    for (const word of FLOOR_COMMAND_HEAD_WORDS) {
      const optedOut = PATH_CHECK_OPT_OUT_COMMANDS.has(word);
      const hasPolicy = Object.prototype.hasOwnProperty.call(COMMAND_FLAG_POLICIES, word);
      if (!optedOut && !hasPolicy) undeclared.push(word);
    }
    expect(undeclared).toEqual([]);
  });

  test("a floor command with no policy and no opt-out ⇒ DENY (fail-closed default, direct unit check)", () => {
    // Direct unit exercise of checkCommandPaths' fail-closed branch: "grep"
    // is not on the floor, not opted out, and carries no COMMAND_FLAG_POLICIES
    // entry — proving the runtime mechanism itself denies-by-default rather
    // than silently skipping, independent of whatever DEFAULT_CONFIG happens
    // to allow today.
    expect(PATH_CHECK_OPT_OUT_COMMANDS.has("grep")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(COMMAND_FLAG_POLICIES, "grep")).toBe(false);

    const root = mkdtempSync(join(tmpdir(), "bash-guard-r9-unit-"));
    const allowedDir = join(root, "allowed");
    mkdirSync(allowedDir, { recursive: true });
    try {
      const prevGuard = process.env.CORTEX_PATH_GUARD;
      process.env.CORTEX_PATH_GUARD = JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] });
      try {
        const result = checkCommandPaths("grep foo bar.txt");
        expect(result.allow).toBe(false);
        expect(result.reason).toContain("COMMAND_FLAG_POLICIES");
      } finally {
        process.env.CORTEX_PATH_GUARD = prevGuard;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// EBH-1f (cortex#2374) — adversarial review of round 9 (#2371) found that
// `deriveFloorCommandHeadWords` only ever understood ONE regex shape
// (`^plainword`). Every other legal floor-rule shape either derived NOTHING
// (silently exempting that command from path-checking — the exact bypass
// class rounds 7/8/9 each closed) or, for `^cats?\b`, derived the WRONG word
// ("cats") while the real runtime head word ("cat") stayed unchecked.
//
// The round-9 "floor coverage" test above CANNOT catch this: it derives its
// own ground truth via `FLOOR_COMMAND_HEAD_WORDS`, i.e. the very function
// with the blind spot. This describe block covers the gap two ways:
//   1. Feeds each problem shape through the REAL exported
//      `deriveFloorCommandHeadWords` and asserts it now throws LOUDLY
//      (naming the offending pattern) instead of silently returning nothing
//      or the wrong word.
//   2. An INDEPENDENT shape assertion against the live `DEFAULT_CONFIG.rules`
//      that hard-codes the expected head word per pattern and does NOT call
//      `deriveFloorCommandHeadWords` at all — so it cannot share that
//      function's blind spot, and fails if a pattern's shape (not just its
//      command) changes unexpectedly.
// =============================================================================
describe("bash-guard.hook — EBH-1f: floor rule shape hardening (cortex#2374 regression guard)", () => {
  describe("deriveFloorCommandHeadWords — unsupported shapes throw loudly (no silent empty/wrong derivation)", () => {
    test("alternation ^(curl|wget)\\s+ throws naming the pattern (the issue's own example)", () => {
      const pattern = "^(curl|wget)\\s+";
      expect(() => deriveFloorCommandHeadWords([{ pattern }])).toThrow(
        expect.objectContaining({
          message: expect.stringContaining(pattern),
        }),
      );
    });

    test("alternation ^(cat|less)\\b throws — previously derived NOTHING, silently exempting both commands", () => {
      const pattern = "^(cat|less)\\b";
      expect(() => deriveFloorCommandHeadWords([{ pattern }])).toThrow(
        expect.objectContaining({ message: expect.stringContaining(pattern) }),
      );
    });

    test("character class ^[Cc]at\\b throws — previously derived NOTHING, silently exempting the command", () => {
      const pattern = "^[Cc]at\\b";
      expect(() => deriveFloorCommandHeadWords([{ pattern }])).toThrow(
        expect.objectContaining({ message: expect.stringContaining(pattern) }),
      );
    });

    test("leading whitespace ^\\s*cat\\b throws — previously derived NOTHING, silently exempting the command", () => {
      const pattern = "^\\s*cat\\b";
      expect(() => deriveFloorCommandHeadWords([{ pattern }])).toThrow(
        expect.objectContaining({ message: expect.stringContaining(pattern) }),
      );
    });

    test("optional-suffix ^cats?\\b throws — previously derived the WRONG word (\"cats\" instead of \"cat\")", () => {
      const pattern = "^cats?\\b";
      // Guard the OLD behaviour didn't sneak back in: the buggy derivation
      // used to silently succeed with "cats". Assert throw, not a wrong word.
      expect(() => deriveFloorCommandHeadWords([{ pattern }])).toThrow(
        expect.objectContaining({ message: expect.stringContaining(pattern) }),
      );
    });

    test("a single bad rule throws even when mixed with otherwise-good rules", () => {
      const rules = [{ pattern: "^cat\\b" }, { pattern: "^(curl|wget)\\s+" }];
      expect(() => deriveFloorCommandHeadWords(rules)).toThrow();
    });
  });

  describe("deriveFloorCommandHeadWords — supported shapes still derive correctly (no regression)", () => {
    test("^cat\\b derives \"cat\"", () => {
      expect(deriveFloorCommandHeadWords([{ pattern: "^cat\\b" }])).toEqual(new Set(["cat"]));
    });

    test("^pwd$ derives \"pwd\"", () => {
      expect(deriveFloorCommandHeadWords([{ pattern: "^pwd$" }])).toEqual(new Set(["pwd"]));
    });

    test("^gh\\s+pr\\s+(view|list)\\b derives \"gh\" (alternation LATER in the pattern is fine — only the HEAD word must be a plain identifier)", () => {
      expect(
        deriveFloorCommandHeadWords([{ pattern: "^gh\\s+pr\\s+(view|list)\\b" }]),
      ).toEqual(new Set(["gh"]));
    });
  });

  test("FLOOR_COMMAND_HEAD_WORDS itself loaded without throwing — proves every live DEFAULT_CONFIG rule is currently the supported shape", () => {
    // This is really just re-asserting module load succeeded (if a live rule
    // had an unsupported shape, importing this module at the top of this
    // test file would already have thrown and no test here would run) — but
    // spelled out explicitly so a future reader doesn't have to infer it.
    expect(FLOOR_COMMAND_HEAD_WORDS.size).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Independent, non-re-derived shape assertion. Deliberately does NOT call
  // deriveFloorCommandHeadWords — it hard-codes the expected head word for
  // every CURRENT DEFAULT_CONFIG pattern and checks the live rule list
  // against that fixed map. A future edit that changes a pattern's TEXT
  // (e.g. `^cat\b` → `^cats?\b`) has no matching entry in this map and fails
  // this test, independent of whatever deriveFloorCommandHeadWords does with
  // it.
  // ---------------------------------------------------------------------------
  test("independent shape assertion: every DEFAULT_CONFIG pattern matches its hard-coded expected head word (does not call deriveFloorCommandHeadWords)", () => {
    const EXPECTED_PATTERN_TO_HEAD_WORD: Readonly<Record<string, string>> = {
      "^gh\\s+pr\\s+(view|list|diff|checks|status|comment)\\b": "gh",
      "^gh\\s+issue\\s+(view|list|status|comment)\\b": "gh",
      "^gh\\s+repo\\s+view\\b": "gh",
      "^git\\s+(log|diff|show|status|branch|fetch|remote|rev-parse)\\b": "git",
      "^ls\\b": "ls",
      "^pwd$": "pwd",
      "^echo\\b": "echo",
      "^cat\\b": "cat",
      "^head\\b": "head",
      "^tail\\b": "tail",
      "^wc\\b": "wc",
      "^which\\b": "which",
      "^file\\b": "file",
    };

    // Same length, in EITHER direction: catches a rule ADDED to DEFAULT_CONFIG
    // without a matching hard-coded entry above, and an entry above that no
    // longer corresponds to a live rule.
    expect(DEFAULT_CONFIG.rules.length).toBe(Object.keys(EXPECTED_PATTERN_TO_HEAD_WORD).length);

    for (const rule of DEFAULT_CONFIG.rules) {
      const expectedWord = EXPECTED_PATTERN_TO_HEAD_WORD[rule.pattern];
      // Pattern TEXT must be a key in the hard-coded map at all — if a
      // pattern's shape (or command) silently changed, it won't match any
      // key here and this fails, without ever calling the derivation.
      expect(expectedWord).toBeDefined();

      // Independent (non-regex-parser) check that the pattern's head word is
      // what we expect: the pattern string, minus its leading "^", must
      // start with the expected word, and the character immediately after
      // the word must be a boundary character/sequence — checked with plain
      // string operations, not the SUPPORTED_FLOOR_RULE_SHAPE regex, so this
      // assertion cannot share that regex's own blind spot either.
      const word = expectedWord!;
      const afterCaret = rule.pattern.slice(1);
      expect(afterCaret.startsWith(word)).toBe(true);
      const boundary = afterCaret.slice(word.length, word.length + 2);
      const isBoundary = boundary.startsWith("\\b") || boundary.startsWith("\\s") || boundary.startsWith("$");
      expect(isBoundary).toBe(true);
    }
  });
});

// =============================================================================
// EBH-1g (cortex#2377, principal-decided option (b)) — guard-off (G-300,
// CORTEX_BASH_GUARD={"disabled":true}) sessions still run path containment.
//
// Before this fix, `config === null` (disabled) returned pass() immediately —
// Bash had ZERO cortex-owned protection in a principal-DM session, even
// though the file tools (Read/Write/Edit/Glob/Grep/NotebookEdit, via the
// separate path-guard.hook.ts) were already containment-checked in the very
// same sessions (EBH-1). The fix: the disabled branch SKIPS the command-shape
// allowlist (config.rules) entirely — any command may still run, preserving
// the whole point of G-300 — but now runs the SAME reduceTokenToRealPathOrReject
// + containment machinery rounds 7-9 built, in a LENIENT mode: a command with
// no COMMAND_FLAG_POLICIES entry doesn't hard-fail on an unrecognised flag
// (that would defeat "any command must be runnable"); it just treats a
// non-path-shaped flag as safe and skips it, while a KNOWN command (one that
// DOES have a COMMAND_FLAG_POLICIES entry — cat/head/tail/wc/ls/file/git/gh)
// keeps the EXACT round 7-9 strict flag classification, so the specific
// findings those rounds closed (file -flist, git diff --no-index, gh
// --body-file) stay closed even in a guard-off session.
// =============================================================================
describe("bash-guard.hook — EBH-1g: guard-off (G-300) path containment (cortex#2377)", () => {
  let root: string;
  let allowedDir: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-ebh1g-matrix-"));
    allowedDir = join(root, "allowed");
    secretDir = join(root, "secret");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "canary.txt"), "EBH-1G-EXFIL-CANARY-MARKER\n");
    writeFileSync(join(allowedDir, "body.md"), "an ordinary in-scope file\n");
    writeFileSync(join(allowedDir, "other.md"), "a second ordinary in-scope file\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function guardOffEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_BASH_GUARD: JSON.stringify({ disabled: true }),
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  // ---- DENY: the F4 gap this closes — a known, path-checked command ----

  test("cat <out-of-scope> in a guard-off session ⇒ DENY (the F4 gap: Bash had zero containment)", () => {
    const r = runHook(
      `cat ${join(secretDir, "canary.txt")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("outside every configured");
  });

  // ---- ALLOW: in-scope reads on a known command still work, deferring to CC's gate (pass, not grant) ----

  test("cat <in-scope> in a guard-off session ⇒ ALLOW via pass-through (not an auto-approve grant)", () => {
    const r = runHook(
      `cat ${join(allowedDir, "body.md")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    // Guard-off never grant()s — it defers to Claude Code's own permission
    // gate either way (cortex#777 posture, unchanged by EBH-1g).
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  // ---- ALLOW: a non-allowlisted (unknown) command with in-scope paths — G-300 preserved ----

  test("sort <in-scope> — a command with NO COMMAND_FLAG_POLICIES entry and no DEFAULT_CONFIG rule ⇒ ALLOW (G-300: any command runs)", () => {
    const r = runHook(
      `sort ${join(allowedDir, "body.md")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("sort -u <in-scope> — an unmodeled but non-path-shaped flag on an unknown command ⇒ ALLOW (lenient: skipped, not denied)", () => {
    const r = runHook(
      `sort -u ${join(allowedDir, "body.md")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  // ---- DENY: the same unknown command with an out-of-scope path ----

  test("sort <out-of-scope> — an unknown command with an out-of-scope positional path ⇒ DENY (lenient containment still applies)", () => {
    const r = runHook(
      `sort ${join(secretDir, "canary.txt")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // ---- DENY preserved for the exact round 7 finding — a KNOWN command's unmodeled path-glued flag ----

  test("file -flist in a guard-off session ⇒ still DENY (round 7 defense-in-depth preserved for known commands)", () => {
    writeFileSync(join(allowedDir, "list"), `${join(secretDir, "canary.txt")}\n`);
    const r = runHook("file -flist", guardOffEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unrecognised flag");
  });

  // ---- DENY preserved for the exact round 8 finding — git diff --no-index ----

  test("git diff --no-index <out-of-scope> <in-scope> in a guard-off session ⇒ still DENY (round 8 finding preserved)", () => {
    const r = runHook(
      `git diff --no-index ${join(secretDir, "canary.txt")} ${join(allowedDir, "body.md")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("gh pr comment 1 --body-file=<out-of-scope> in a guard-off session ⇒ still DENY (round 9 finding preserved, `=` glued form)", () => {
    const r = runHook(
      `gh pr comment 1 --body-file=${join(secretDir, "canary.txt")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("gh pr comment 1 --body-file <out-of-scope> in a guard-off session ⇒ still DENY (round 9 finding preserved, space-separated form)", () => {
    const r = runHook(
      `gh pr comment 1 --body-file ${join(secretDir, "canary.txt")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // ---- ALLOW: git/gh subcommands OUTSIDE the floor's narrow read-only set —
  // the SUBCOMMAND_SCOPED_FLAG_POLICIES exemption. Without it, EVERY ordinary
  // git write / gh mutate flag denies outright (COMMAND_FLAG_POLICIES.git/.gh
  // was only ever calibrated for the floor's log|diff|show|status|branch|
  // fetch|remote|rev-parse / pr-view-list-diff-checks-status-comment set), a
  // crippling false-positive regression for the exact git/gh write workflows
  // G-300 exists to allow (docs/design-dm-operator-channel.md names "git
  // write ops" explicitly). Verified as a real regression before this fix
  // landed (an earlier draft of EBH-1g denied every one of these). ----

  test("git commit -m \"msg\" in a guard-off session ⇒ ALLOW (not a floor subcommand, not a real path-read risk)", () => {
    const r = runHook('git commit -m "msg"', guardOffEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("git push -u origin main in a guard-off session ⇒ ALLOW", () => {
    const r = runHook("git push -u origin main", guardOffEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("git checkout -b feat/x in a guard-off session ⇒ ALLOW", () => {
    const r = runHook("git checkout -b feat/x", guardOffEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test('gh pr create -t "title" -b "body" in a guard-off session ⇒ ALLOW', () => {
    const r = runHook('gh pr create -t "title" -b "body"', guardOffEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("gh pr merge --squash in a guard-off session ⇒ ALLOW", () => {
    const r = runHook("gh pr merge --squash", guardOffEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  // ---- ALLOW: the opt-out set (pwd/echo/which) is never containment-checked, even in guard-off mode ----

  test("echo <out-of-scope-looking string> in a guard-off session ⇒ ALLOW (echo never reads a path)", () => {
    const r = runHook(
      `echo ${join(secretDir, "canary.txt")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  // ---- Pipes: ALLOWED in guard-off mode, containment-checked per segment
  // (coordinator follow-up, same issue #2377). A pipeline is just more
  // segments — no shape-allowlist exists in guard-off mode for a pipe to
  // smuggle a command past, so once each side is independently
  // containment-checked, denying the bare `|` bought nothing but friction
  // on everyday principal-DM commands. ----

  test("cat <in-scope> | wc -l in a guard-off session ⇒ ALLOW (pipe decomposes into containment-checked segments)", () => {
    const r = runHook(
      `cat ${join(allowedDir, "body.md")} | wc -l`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  // NOTE: `git log --oneline | head -5` (the coordinator's literal example)
  // is substituted with `| wc -l` here — `head -5` (bare numeric shorthand,
  // no space before the digit) hits a PRE-EXISTING, unrelated round-7 gap:
  // COMMAND_FLAG_POLICIES.head never modeled a bare `-N` short flag, so
  // `head -5` already denies in NORMAL (guard-on) sessions too, verified
  // unchanged by this fix. Out of scope here (touching head's policy would
  // change guard-ON behaviour, which this fix must not do) — tracked as a
  // separate, pre-existing limitation, not a regression from EBH-1g.
  test("git log --oneline | wc -l in a guard-off session ⇒ ALLOW (everyday git pipe)", () => {
    const r = runHook("git log --oneline | wc -l", guardOffEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("cat <out-of-scope> | wc -l in a guard-off session ⇒ DENY (LHS segment fails containment)", () => {
    const r = runHook(
      `cat ${join(secretDir, "canary.txt")} | wc -l`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("echo hi | cat <out-of-scope> in a guard-off session ⇒ DENY (RHS segment fails containment)", () => {
    const r = runHook(
      `echo hi | cat ${join(secretDir, "canary.txt")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat <in-scope1> | cat <in-scope2> | wc -l in a guard-off session ⇒ ALLOW (3-stage pipeline, every segment checked)", () => {
    const r = runHook(
      `cat ${join(allowedDir, "body.md")} | cat ${join(allowedDir, "other.md")} | wc -l`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  // ---- Command substitution / backticks / redirects: STILL denied in
  // guard-off mode — these genuinely defeat static path analysis (a
  // substituted path is computed at run time; a redirect target is never
  // extracted as a "path argument" at all), unlike a bare pipe. ----

  test("echo $(date) in a guard-off session ⇒ DENY (command substitution still denied)", () => {
    const r = runHook("echo $(date)", guardOffEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("echo `date` in a guard-off session ⇒ DENY (backtick substitution still denied)", () => {
    const r = runHook("echo `date`", guardOffEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("wc -l < <out-of-scope> in a guard-off session ⇒ DENY (input redirect still denied)", () => {
    const r = runHook(
      `wc -l < ${join(secretDir, "canary.txt")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("cat <in-scope> > /tmp/somewhere in a guard-off session ⇒ DENY (output redirect still denied)", () => {
    const r = runHook(
      `cat ${join(allowedDir, "body.md")} > /tmp/ebh1g-redirect-test`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // ---- &&/||/; chaining: unaffected by the pipe change ----

  test("cat <in-scope1> && cat <in-scope2> in a guard-off session ⇒ ALLOW (both segments containment-checked)", () => {
    const r = runHook(
      `cat ${join(allowedDir, "body.md")} && cat ${join(allowedDir, "other.md")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("cat <in-scope> && cat <out-of-scope> in a guard-off session ⇒ DENY (second segment fails containment)", () => {
    const r = runHook(
      `cat ${join(allowedDir, "body.md")} && cat ${join(secretDir, "canary.txt")}`,
      guardOffEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // ---- No CORTEX_PATH_GUARD configured ⇒ unaffected (matches pre-fix behaviour) ----

  test("no CORTEX_PATH_GUARD configured in a guard-off session ⇒ still allows everything (no restriction configured)", () => {
    const r = runHook(`cat ${join(secretDir, "canary.txt")}`, {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_BASH_GUARD: JSON.stringify({ disabled: true }),
      CORTEX_PATH_GUARD: undefined,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });
});

// =============================================================================
// EBH-1h (cortex#2384) — bare numeric short flags (`head -5`, `tail -3`).
//
// `head`/`tail` accept a bare numeric count as shorthand for `-n <count>`
// (`head -5` == `head -n 5`). COMMAND_FLAG_POLICIES never modeled this shape,
// and since round 9 an unrecognised flag on a path-checked command denies the
// WHOLE command — so this ordinary, everyday form was wrongly denied. Fixed
// by `CommandFlagPolicy.bareNumericCount`, set ONLY on `head`/`tail`.
// =============================================================================
describe("bash-guard.hook — EBH-1h: bare numeric short flags (cortex#2384)", () => {
  let root: string;
  let allowedDir: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-ebh1h-matrix-"));
    allowedDir = join(root, "allowed");
    secretDir = join(root, "secret");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "canary.txt"), "EBH-1H-CANARY-MARKER\n");
    writeFileSync(join(allowedDir, "f.txt"), "one\ntwo\nthree\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  // ---- ALLOW: bare numeric short flag, in-scope path ----

  test("head -5 f.txt ⇒ ALLOW", () => {
    const r = runHook("head -5 f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("tail -3 f.txt ⇒ ALLOW", () => {
    const r = runHook("tail -3 f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("head -20 f.txt ⇒ ALLOW", () => {
    const r = runHook("head -20 f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  // ---- DENY: bare numeric short flag, out-of-scope path (path still containment-checked) ----

  test("head -5 <out-of-scope> ⇒ DENY (the path argument is still containment-checked)", () => {
    const r = runHook(
      `head -5 ${join(secretDir, "canary.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("tail -3 <out-of-scope> ⇒ DENY (the path argument is still containment-checked)", () => {
    const r = runHook(
      `tail -3 ${join(secretDir, "canary.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // ---- DENY: unknown, non-numeric flags on head/tail still deny (round-9 behaviour preserved) ----

  test("head -x f.txt ⇒ DENY (unrecognised non-numeric short flag)", () => {
    const r = runHook("head -x f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unrecognised flag");
  });

  test("tail --bogus f.txt ⇒ DENY (unrecognised long flag)", () => {
    const r = runHook("tail --bogus f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unrecognised flag");
  });

  // ---- DENY: NOT generalised beyond head/tail — same bare-numeric shape on
  // an unrelated path-checked command still denies exactly as before. ----

  test("ls -5 ⇒ DENY (bare numeric short flag NOT modeled for ls)", () => {
    const r = runHook("ls -5", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unrecognised flag");
  });

  test("cat -5 f.txt ⇒ DENY (bare numeric short flag NOT modeled for cat)", () => {
    const r = runHook("cat -5 f.txt", policyEnv(), "Bash", "test-session", allowedDir);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unrecognised flag");
  });
});

// =============================================================================
// Round 10 (cortex#2493) — `gh --title`/`--body` free-text values were
// misclassified as path candidates. Round 9 modeled `-t`/`--title`,
// `-b`/`--body`, `-F`/`--body-file` all as ordinary path-pipeline value
// flags; the space-separated form's value fell through to the generic
// bareword-argument handler (a candidate path that never resolves — titles
// aren't filenames) and the `=`-glued form routed the same free text through
// `reduceTokenToRealPathOrReject` for the same fate. Fixed by
// `CommandFlagPolicy.longTextValue`/`shortTextValue`: `title`/`body` (both
// flag forms) never enter the candidate-path pipeline at all. `-F`/
// `--body-file` is UNCHANGED — it stays on `shortValue`/`longValue`, still
// containment-checked, because it genuinely reads a local file (the round-9
// remote-exfil finding).
// =============================================================================

import { classifyFlagToken as classifyFlagTokenR10, extractCommandPaths as extractCommandPathsR10 } from "../bash-guard.hook";

describe("bash-guard.hook — round 10: classifyFlagToken unit coverage for text-value flags (cortex#2493)", () => {
  const ghPolicy = COMMAND_FLAG_POLICIES.gh;
  if (!ghPolicy) throw new Error("gh policy missing from COMMAND_FLAG_POLICIES — test setup invariant broken");

  test('--title (no "=") classifies as "text" — caller must skip the next token', () => {
    expect(classifyFlagTokenR10("--title", ghPolicy)).toEqual({ kind: "text" });
  });

  test('--body (no "=") classifies as "text"', () => {
    expect(classifyFlagTokenR10("--body", ghPolicy)).toEqual({ kind: "text" });
  });

  test("--title=value (glued) classifies as \"safe\" — never routed through the path pipeline", () => {
    expect(classifyFlagTokenR10("--title=Regression-in-bash-guard", ghPolicy)).toEqual({ kind: "safe" });
  });

  test("--body=value (glued) classifies as \"safe\"", () => {
    expect(classifyFlagTokenR10("--body=Ordinary-prose-body", ghPolicy)).toEqual({ kind: "safe" });
  });

  test('-t (short, no value attached) classifies as "text"', () => {
    expect(classifyFlagTokenR10("-t", ghPolicy)).toEqual({ kind: "text" });
  });

  test('-b (short, no value attached) classifies as "text"', () => {
    expect(classifyFlagTokenR10("-b", ghPolicy)).toEqual({ kind: "text" });
  });

  test("-tGluedTitle (short, glued value) classifies as \"safe\"", () => {
    expect(classifyFlagTokenR10("-tGluedTitle", ghPolicy)).toEqual({ kind: "safe" });
  });

  test("-F/--body-file are UNCHANGED — still route through the path pipeline, never \"text\"", () => {
    expect(classifyFlagTokenR10("-F", ghPolicy)).toEqual({ kind: "safe" });
    expect(classifyFlagTokenR10("--body-file", ghPolicy)).toEqual({ kind: "safe" });
    expect(classifyFlagTokenR10("--body-file=./out.md", ghPolicy)).toEqual({
      kind: "value",
      value: "./out.md",
    });
  });

  test("extractCommandPaths: --title's space-separated value never appears in the extracted candidate paths", () => {
    const extracted = extractCommandPathsR10(
      'gh issue create --title "A title with spaces" --body-file ./body.md',
    );
    expect(extracted.paths).not.toBeNull();
    // The bareword subcommand tokens ("issue", "create") are harmless
    // pre-existing candidate paths (they resolve relative to cwd, same as
    // git's REV/ref positionals — see COMMAND_FLAG_POLICIES.git's own
    // comment) and are NOT what this fix changes. What matters here: the
    // quoted title text — however many words — must be fully ABSENT from
    // the list, and --body-file's value must be the only flag-sourced path.
    expect(extracted.paths).toEqual(["issue", "create", "./body.md"]);
  });

  test("extractCommandPaths: --title=value (glued) never appears in the extracted candidate paths either", () => {
    const extracted = extractCommandPathsR10(
      "gh issue create --title=Regression-in-bash-guard --body-file ./body.md",
    );
    expect(extracted.paths).not.toBeNull();
    expect(extracted.paths).toEqual(["issue", "create", "./body.md"]);
  });
});

describe("bash-guard.hook — round 10: gh free-text value flags, end to end (cortex#2493)", () => {
  let root: string;
  let allowedDir: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bash-guard-r10-matrix-"));
    allowedDir = join(root, "allowed");
    secretDir = join(root, "secret");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "canary.txt"), "GH-R10-CANARY-MARKER\n");
    writeFileSync(join(allowedDir, "body.md"), "an ordinary in-scope PR comment body\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // `create` is not in DEFAULT_CONFIG's floor (only view|list|diff|checks|
  // status|comment) — a real deployment widens its own CORTEX_BASH_GUARD for
  // write subcommands (see DEFAULT_CONFIG's own module comment, and halden's
  // allowlist at bash-guard.hook.test.ts:317). Mirror that shape here so the
  // command reaches checkCommandPaths at all, exactly like a real stack's
  // config would let the issue's own repro reach it.
  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test-channel",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
      CORTEX_BASH_GUARD: JSON.stringify({
        rules: [{ pattern: "^gh\\s+(pr|issue)\\s+(create|comment)\\b" }],
      }),
    };
  }

  // ---- ALLOW: the exact issue repro, space-separated --title form ----

  test('gh issue create --title "A title with spaces" --body-file <in-scope> ⇒ ALLOW (space-separated form)', () => {
    const r = runHook(
      `gh issue create --title "A title with spaces" --body-file ${join(allowedDir, "body.md")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  // ---- ALLOW: the same repro, `--title=value` glued form ----

  test("gh issue create --title=Regression-in-bash-guard --body-file <in-scope> ⇒ ALLOW (`=` glued form)", () => {
    const r = runHook(
      `gh issue create --title=Regression-in-bash-guard --body-file ${join(allowedDir, "body.md")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  // ---- ALLOW: short-flag equivalents -t/-b, space-separated form ----

  test('gh pr create -t "A title with spaces" -b "An ordinary prose body, with punctuation!" ⇒ ALLOW', () => {
    const r = runHook(
      'gh pr create -t "A title with spaces" -b "An ordinary prose body, with punctuation!"',
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  // ---- ALLOW: --body long form on a floor-permitted comment subcommand ----

  test('gh pr comment 1 --body "A prose comment, with punctuation!" ⇒ ALLOW', () => {
    const r = runHook(
      'gh pr comment 1 --body "A prose comment, with punctuation!"',
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  // ---- DENY: the round-9 property MUST survive — --body-file containment
  // is unaffected by fixing --title, even in the SAME command. ----

  test("gh issue create --title \"A title with spaces\" --body-file <out-of-scope> ⇒ DENY (title fix does not weaken body-file containment)", () => {
    const r = runHook(
      `gh issue create --title "A title with spaces" --body-file ${join(secretDir, "canary.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("gh issue create --title=Regression-in-bash-guard --body-file <out-of-scope> ⇒ DENY (`=` form title fix does not weaken body-file containment)", () => {
    const r = runHook(
      `gh issue create --title=Regression-in-bash-guard --body-file ${join(secretDir, "canary.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // ---- DENY: the round-9 findings themselves, restated, still close ----

  test("gh pr comment 1 --body-file <out-of-scope> ⇒ DENY (round-9 finding, restated for round 10)", () => {
    const r = runHook(
      `gh pr comment 1 --body-file ${join(secretDir, "canary.txt")}`,
      policyEnv(),
      "Bash",
      "test-session",
      allowedDir,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

