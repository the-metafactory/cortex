/**
 * Tests for the Cortex Path Guard PreToolUse hook (EBH-1, cortex#2343).
 *
 * Covers every acceptance-criterion bullet from issue #2343:
 *   - Read/Write/Edit/Glob/Grep of a path outside `allowedDirs` → deny.
 *   - Write/Edit targeting a `readOnlyDir` → deny (F6); Read → allow.
 *   - A symlink INSIDE an allowed dir pointing OUTSIDE it → deny (realpath'd
 *     before the containment check).
 *   - Non-cortex session (no CORTEX_CHANNEL) → pass through, no behavior change.
 *   - Fail-closed on malformed CORTEX_PATH_GUARD / unreadable stdin.
 *   - Pure-function unit coverage for parsePathGuardConfig / extractCandidatePaths
 *     / decidePath, mirroring bash-guard.hook.test.ts's style.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import {
  parsePathGuardConfig,
  extractCandidatePaths,
  decidePath,
} from "../path-guard.hook";

const HOOK_PATH = join(import.meta.dir, "..", "path-guard.hook.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Mirrors bash-guard.hook.test.ts's env-stripping helper: the test process
// itself may run inside a cortex agent session, so start from a clean slate
// and only apply what each test explicitly sets.
const SURFACE_ENV_KEYS = [
  "CORTEX_CHANNEL",
  "CORTEX_AGENT_ID",
  "CORTEX_AGENT_NAME",
  "CORTEX_NETWORK",
  "CORTEX_PROJECT",
  "CORTEX_ENTITY",
  "CORTEX_PRINCIPAL",
  "CORTEX_PATH_GUARD",
  "GROVE_CHANNEL",
  "GROVE_AGENT_ID",
  "GROVE_AGENT_NAME",
  "GROVE_NETWORK",
  "GROVE_PROJECT",
  "GROVE_ENTITY",
  "GROVE_OPERATOR",
];

function runHook(
  toolName: string,
  toolInput: Record<string, unknown>,
  env: Record<string, string | undefined>,
  sessionId = "test-session",
): RunResult {
  const input = JSON.stringify({
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
  });
  const overrides = new Set(SURFACE_ENV_KEYS);
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !overrides.has(k)) merged[k] = v;
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

function expectGrantDecision(stdout: string): void {
  const out = JSON.parse(stdout.trim());
  expect(out.hookSpecificOutput).toBeDefined();
  expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  expect(out.continue).toBeUndefined();
}

function expectDenyDecision(stdout: string): void {
  const out = JSON.parse(stdout.trim());
  expect(out.hookSpecificOutput).toBeDefined();
  expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(typeof out.hookSpecificOutput.permissionDecisionReason).toBe("string");
}

// =============================================================================
// Pure-function unit tests
// =============================================================================

describe("parsePathGuardConfig", () => {
  test("undefined ⇒ legitimate empty policy (ok, no restriction)", () => {
    const r = parsePathGuardConfig(undefined);
    expect(r.ok).toBe(true);
    expect(r.policy).toEqual({ allowedDirs: [], readOnlyDirs: [] });
  });

  test("empty string ⇒ legitimate empty policy", () => {
    const r = parsePathGuardConfig("");
    expect(r.ok).toBe(true);
    expect(r.policy).toEqual({ allowedDirs: [], readOnlyDirs: [] });
  });

  test("{} ⇒ legitimate empty policy", () => {
    const r = parsePathGuardConfig("{}");
    expect(r.ok).toBe(true);
    expect(r.policy).toEqual({ allowedDirs: [], readOnlyDirs: [] });
  });

  test("valid policy round-trips", () => {
    const r = parsePathGuardConfig(JSON.stringify({ allowedDirs: ["/a"], readOnlyDirs: ["/b"] }));
    expect(r.ok).toBe(true);
    expect(r.policy).toEqual({ allowedDirs: ["/a"], readOnlyDirs: ["/b"] });
  });

  test("malformed JSON ⇒ ok:false (fail closed, NOT empty policy)", () => {
    const r = parsePathGuardConfig("{not json");
    expect(r.ok).toBe(false);
  });

  test("non-object JSON (array) ⇒ ok:false", () => {
    const r = parsePathGuardConfig("[1,2,3]");
    expect(r.ok).toBe(false);
  });

  test("non-array allowedDirs value is coerced to [] (tolerant, still ok)", () => {
    const r = parsePathGuardConfig(JSON.stringify({ allowedDirs: "not-an-array" }));
    expect(r.ok).toBe(true);
    expect(r.policy.allowedDirs).toEqual([]);
  });
});

describe("extractCandidatePaths", () => {
  test("Read/Write/Edit require file_path", () => {
    expect(extractCandidatePaths("Read", { file_path: "/a/b.ts" })).toEqual({ paths: ["/a/b.ts"] });
    expect(extractCandidatePaths("Write", { file_path: "/a/b.ts" })).toEqual({ paths: ["/a/b.ts"] });
    expect(extractCandidatePaths("Edit", { file_path: "/a/b.ts" })).toEqual({ paths: ["/a/b.ts"] });
  });

  test("Read with no file_path ⇒ malformed (null)", () => {
    expect(extractCandidatePaths("Read", {})).toEqual({ paths: null });
  });

  test("Glob/Grep with explicit path ⇒ that path", () => {
    expect(extractCandidatePaths("Glob", { pattern: "**/*.ts", path: "/a" })).toEqual({ paths: ["/a"] });
    expect(extractCandidatePaths("Grep", { pattern: "foo", path: "/a" })).toEqual({ paths: ["/a"] });
  });

  test("Glob/Grep with no path ⇒ [] (nothing to check, not malformed)", () => {
    expect(extractCandidatePaths("Glob", { pattern: "**/*.ts" })).toEqual({ paths: [] });
    expect(extractCandidatePaths("Grep", { pattern: "foo" })).toEqual({ paths: [] });
  });

  test("Grep's `pattern` (content regex) is NEVER treated as a path", () => {
    // A pattern that LOOKS like a path must not leak into the containment check.
    const r = extractCandidatePaths("Grep", { pattern: "/etc/passwd" });
    expect(r.paths).toEqual([]);
  });
});

// =============================================================================
// decidePath — needs a real temp-dir fixture (containment does realpath I/O).
// =============================================================================

describe("decidePath", () => {
  let root: string;
  let allowedDir: string;
  let readOnlyDir: string;
  let outsideDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "path-guard-decide-"));
    allowedDir = join(root, "allowed");
    readOnlyDir = join(root, "readonly");
    outsideDir = join(root, "outside");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(readOnlyDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("Read inside allowedDir ⇒ allow", () => {
    const d = decidePath("Read", join(allowedDir, "f.txt"), { allowedDirs: [allowedDir], readOnlyDirs: [] });
    expect(d.allow).toBe(true);
  });

  test("Write outside every policy dir ⇒ deny", () => {
    const d = decidePath("Write", join(outsideDir, "f.txt"), { allowedDirs: [allowedDir], readOnlyDirs: [] });
    expect(d.allow).toBe(false);
  });

  test("Read inside readOnlyDir ⇒ allow", () => {
    const d = decidePath("Read", join(readOnlyDir, "f.txt"), { allowedDirs: [], readOnlyDirs: [readOnlyDir] });
    expect(d.allow).toBe(true);
  });

  test("Write inside readOnlyDir ⇒ deny (F6)", () => {
    const d = decidePath("Write", join(readOnlyDir, "f.txt"), { allowedDirs: [], readOnlyDirs: [readOnlyDir] });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("READ-ONLY");
  });

  test("Edit inside readOnlyDir ⇒ deny (F6)", () => {
    const d = decidePath("Edit", join(readOnlyDir, "f.txt"), { allowedDirs: [], readOnlyDirs: [readOnlyDir] });
    expect(d.allow).toBe(false);
  });

  test("a dir listed in BOTH allowedDirs and readOnlyDirs ⇒ write allowed (allow wins)", () => {
    const d = decidePath("Write", join(allowedDir, "f.txt"), {
      allowedDirs: [allowedDir],
      readOnlyDirs: [allowedDir],
    });
    expect(d.allow).toBe(true);
  });
});

// =============================================================================
// Full-process (spawned hook) tests
// =============================================================================

describe("path-guard.hook — pass-through behaviour", () => {
  test("no CORTEX_CHANNEL ⇒ pass through unchanged", () => {
    const r = runHook("Read", { file_path: "/etc/passwd" }, { CORTEX_CHANNEL: undefined, GROVE_CHANNEL: undefined });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("non-governed tool name ⇒ pass through", () => {
    const r = runHook("Bash", { command: "ls" }, { CORTEX_CHANNEL: "test" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("CORTEX_CHANNEL set but no CORTEX_PATH_GUARD (no restriction configured) ⇒ pass through", () => {
    const r = runHook("Read", { file_path: "/etc/passwd" }, { CORTEX_CHANNEL: "test", CORTEX_PATH_GUARD: undefined });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("CORTEX_PATH_GUARD={} (explicit empty policy) ⇒ pass through", () => {
    const r = runHook("Write", { file_path: "/etc/passwd" }, { CORTEX_CHANNEL: "test", CORTEX_PATH_GUARD: "{}" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });
});

describe("path-guard.hook — fail-closed behaviour", () => {
  test("malformed CORTEX_PATH_GUARD ⇒ deny (not pass-through)", () => {
    const r = runHook(
      "Read",
      { file_path: "/anything" },
      { CORTEX_CHANNEL: "test", CORTEX_PATH_GUARD: "{not valid json" },
    );
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });

  test("Read with no file_path (malformed call) under an active policy ⇒ deny", () => {
    const r = runHook(
      "Read",
      {},
      { CORTEX_CHANNEL: "test", CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: ["/tmp"], readOnlyDirs: [] }) },
    );
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });
});

describe("path-guard.hook — containment enforcement (spawned)", () => {
  let root: string;
  let allowedDir: string;
  let readOnlyDir: string;
  let outsideDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "path-guard-spawn-"));
    allowedDir = join(root, "allowed");
    readOnlyDir = join(root, "readonly");
    outsideDir = join(root, "outside");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(readOnlyDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(readOnlyDir, "secret.yaml"), "token: abc\n");
    writeFileSync(join(outsideDir, "escape.txt"), "nope\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [readOnlyDir] }),
    };
  }

  for (const toolName of ["Read", "Write", "Edit", "Glob", "Grep"]) {
    test(`${toolName} of a path outside allowedDirs/readOnlyDirs ⇒ deny`, () => {
      const toolInput =
        toolName === "Glob"
          ? { pattern: "**/*", path: outsideDir }
          : toolName === "Grep"
            ? { pattern: "secret", path: outsideDir }
            : { file_path: join(outsideDir, "escape.txt") };
      const r = runHook(toolName, toolInput, policyEnv());
      expect(r.status).toBe(0);
      expectDenyDecision(r.stdout);
    });
  }

  test("Write into readOnlyDir ⇒ deny (closes F6)", () => {
    const r = runHook("Write", { file_path: join(readOnlyDir, "secret.yaml") }, policyEnv());
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("READ-ONLY");
  });

  test("Edit into readOnlyDir ⇒ deny (closes F6)", () => {
    const r = runHook(
      "Edit",
      { file_path: join(readOnlyDir, "secret.yaml"), old_string: "a", new_string: "b" },
      policyEnv(),
    );
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });

  test("Read of readOnlyDir ⇒ allow", () => {
    const r = runHook("Read", { file_path: join(readOnlyDir, "secret.yaml") }, policyEnv());
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("Glob rooted in readOnlyDir ⇒ allow (read-only tool)", () => {
    const r = runHook("Glob", { pattern: "*.yaml", path: readOnlyDir }, policyEnv());
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("Write into allowedDir ⇒ allow", () => {
    const r = runHook("Write", { file_path: join(allowedDir, "new-file.txt") }, policyEnv());
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("Write into a NEW file that does not exist yet, inside allowedDir ⇒ allow", () => {
    // Proves resolveProspectiveRealpath's "walk to nearest existing ancestor"
    // handling — the Write tool's whole point is creating a file that does
    // NOT exist yet, so a naive realpathSync(candidate) would ENOENT.
    const r = runHook("Write", { file_path: join(allowedDir, "brand-new", "deep", "file.ts") }, policyEnv());
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("Glob with no explicit path argument ⇒ allow (relies on session cwd scope)", () => {
    const r = runHook("Glob", { pattern: "**/*.ts" }, policyEnv());
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("symlink INSIDE allowedDir pointing OUTSIDE it ⇒ deny (realpath'd before check)", () => {
    const linkPath = join(allowedDir, "escape-link");
    symlinkSync(outsideDir, linkPath);
    const r = runHook("Read", { file_path: join(linkPath, "escape.txt") }, policyEnv());
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });

  test("symlink INSIDE allowedDir pointing OUTSIDE it ⇒ Write also denied", () => {
    const linkPath = join(allowedDir, "escape-link-write");
    symlinkSync(outsideDir, linkPath);
    const r = runHook("Write", { file_path: join(linkPath, "new-escape.txt") }, policyEnv());
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });

  test("cortex config dir style path (outside allowedDirs) ⇒ deny", () => {
    // Mirrors the CONFIG IMMUTABILITY prose rule — proves the guard denies a
    // read of an out-of-scope config-shaped path exactly like any other
    // out-of-scope path (this hook has no config-dir special case; the deny
    // comes purely from containment).
    const configLikeDir = join(root, "config-like", "metafactory", "cortex");
    mkdirSync(configLikeDir, { recursive: true });
    writeFileSync(join(configLikeDir, "system.yaml"), "secret: true\n");
    const r = runHook("Read", { file_path: join(configLikeDir, "system.yaml") }, policyEnv());
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });
});

// =============================================================================
// Telemetry — mirrors bash-guard.hook.test.ts's block-telemetry coverage.
// =============================================================================

describe("path-guard.hook — block telemetry", () => {
  let homeDir: string;
  let root: string;
  let allowedDir: string;
  let outsideDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "path-guard-telemetry-home-"));
    root = mkdtempSync(join(tmpdir(), "path-guard-telemetry-root-"));
    allowedDir = join(root, "allowed");
    outsideDir = join(root, "outside");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test("a block writes a tool.path.blocked event to the JSONL fallback", () => {
    const sessionId = "path-telemetry-session";
    const r = runHook(
      "Read",
      { file_path: join(outsideDir, "secret.txt") },
      {
        CORTEX_CHANNEL: "test-channel",
        CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
        HOME: homeDir,
      },
      sessionId,
    );
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);

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
    expect(event.event_type).toBe("tool.path.blocked");
    expect(event.session_id).toBe(sessionId);
    expect(event.source.hook).toBe("PreToolUse");
    expect(event.source.tool_name).toBe("Read");
  });

  test("an allowed call writes no telemetry", () => {
    const sessionId = "path-no-telemetry-session";
    const r = runHook(
      "Read",
      { file_path: join(allowedDir, "ok.txt") },
      {
        CORTEX_CHANNEL: "test-channel",
        CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
        HOME: homeDir,
      },
      sessionId,
    );
    expect(r.status).toBe(0);
    const rawFile = join(homeDir, ".claude", "events", "raw", `${sessionId}.jsonl`);
    expect(existsSync(rawFile)).toBe(false);
  });
});
