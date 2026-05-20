/**
 * Tests for the Grove Bash Guard PreToolUse hook.
 *
 * Covers the cortex#bash-guard-observability changes:
 *   - structured PreToolUse deny output (replaces exit(2) + stderr)
 *   - unchanged pass-through ({"continue": true})
 *   - preserved GROVE_CHANNEL gate / GROVE_AGENT_ID bypass /
 *     GROVE_BASH_GUARD disabled behaviour
 *   - block telemetry event written to the JSONL fallback
 *   - block telemetry event POSTed to the HTTP ingest endpoint
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

// Grove env vars the hook reads. The test process itself may run inside a
// Cortex agent session (which sets these), so the helper strips ALL of them
// from the child env first, then re-applies only what each test specifies.
// Without this, an inherited GROVE_BASH_GUARD / GROVE_AGENT_ID silently
// bypasses the guard and tests pass for the wrong reason.
const GROVE_ENV_KEYS = [
  "GROVE_CHANNEL",
  "GROVE_AGENT_ID",
  "GROVE_AGENT_NAME",
  "GROVE_NETWORK",
  "GROVE_BASH_GUARD",
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

describe("bash-guard.hook — pass-through behaviour", () => {
  test("passes through when GROVE_CHANNEL is not set", () => {
    const r = runHook("rm -rf /", { GROVE_CHANNEL: undefined });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("bypasses guard when GROVE_AGENT_ID is set (CLI operator session)", () => {
    const r = runHook("rm -rf /tmp/whatever", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: "cldyo-live",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("disabled config (operator DM) allows everything", () => {
    const r = runHook("rm -rf /tmp/x", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      GROVE_BASH_GUARD: JSON.stringify({ disabled: true }),
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("allowed command passes with {continue:true}", () => {
    const r = runHook("ls -la", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("non-Bash tool passes through unchanged", () => {
    const r = runHook("ignored", { GROVE_CHANNEL: "test-channel" }, "Read");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("custom allowlist permits a widened command (e.g. bun)", () => {
    const r = runHook("bun test", {
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_ID: undefined,
      GROVE_BASH_GUARD: JSON.stringify({ rules: [{ pattern: "^bun\\s+" }] }),
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
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
      GROVE_BASH_GUARD: JSON.stringify({
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
    // The hook POSTs to a hardcoded http://localhost:8766/api/events/ingest
    // before falling back to JSONL. Stand up a real listener on that port so
    // the POST "succeeds", and capture the request body to assert its shape.
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
      port: 8766,
      async fetch(req) {
        seen.path = new URL(req.url).pathname;
        seen.contentType = req.headers.get("content-type");
        seen.body = (await req.json()) as Record<string, unknown>;
        return new Response("ok", { status: 200 });
      },
    });

    try {
      const groveOverrides = new Set(GROVE_ENV_KEYS);
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !groveOverrides.has(k)) merged[k] = v;
      }
      Object.assign(merged, {
        GROVE_CHANNEL: "test-channel",
        HOME: homeDir,
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
