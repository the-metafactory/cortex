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

  test("a plain (metacharacter-free) env-prefix is still allowed", () => {
    // The whole point of PR #770: `AWS_PROFILE=halden-dev <allowed> …` must
    // pass. Use `ls` (in DEFAULT_CONFIG) so this case is independent of the
    // aws rule — it proves the raw-command metacharacter scan does not
    // over-reject a benign `NAME=value` prefix.
    const r = runHook("AWS_PROFILE=halden-dev ls", env);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("a chain of ALL-allowed commands still passes (&& preserved)", () => {
    const r = runHook("ls && pwd", env);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
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
      GROVE_BASH_GUARD: haldenConfig,
    });
  }

  function expectAllow(cmd: string): void {
    const r = run(cmd);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
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
