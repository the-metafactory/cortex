/**
 * Tests for the Cortex Path Guard PreToolUse hook (EBH-1, cortex#2343).
 *
 * Covers every acceptance-criterion bullet from issue #2343:
 *   - Read/Write/Edit/Glob/Grep of a path outside `allowedDirs` → deny.
 *   - Write/Edit/NotebookEdit targeting a `readOnlyDir` → deny (the
 *     read-only-write MECHANISM this hook enforces; F6 goes fully live once
 *     dispatch-handler.ts threads a distinct readOnlyDirs through to
 *     CORTEX_PATH_GUARD on live sessions — EBH-1b, a separate slice); Read →
 *     allow.
 *   - A symlink INSIDE an allowed dir pointing OUTSIDE it → deny (realpath'd
 *     before the containment check).
 *   - Non-cortex session (no CORTEX_CHANNEL) → pass through, no behavior change.
 *   - Fail-closed on malformed CORTEX_PATH_GUARD / unreadable stdin.
 *   - Pure-function unit coverage for parsePathGuardConfig / extractCandidatePaths
 *     / decidePath, mirroring bash-guard.hook.test.ts's style.
 *
 * Plus the cortex#2343 adversarial-review fixes (B1/B2/B4):
 *   - B1: `~`/`$VAR` in a file_path/path token must expand to the REAL path
 *     before containment (a naive isAbsolute/resolve on the raw token treats
 *     `~/.ssh/id_rsa` as a literal relative path under cwd — the "guard
 *     checks a different path than the shell runs" bypass).
 *   - B2: Glob's `pattern` argument is itself a path (unlike Grep's, which
 *     is a content regex) — its literal directory prefix must be
 *     containment-checked too, closing an unchecked absolute-pattern /
 *     `../` traversal-via-pattern hole.
 *   - B4: `NotebookEdit` is a grantable, mutating file tool
 *     (tool-inventory.ts) that the matcher/GOVERNED_TOOLS previously
 *     omitted entirely — any stack granting it got unchecked file access.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir, homedir } from "os";
import {
  parsePathGuardConfig,
  extractCandidatePaths,
  decidePath,
  expandBraceAlternatives,
  isRiskyGlobPatternRoot,
} from "../path-guard.hook";
import { expandUserPath, isUnresolvedShellToken } from "../../../common/path-containment";

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
  cwd?: string,
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
    ...(cwd !== undefined && { cwd }),
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

  test("Write inside readOnlyDir ⇒ deny (read-only-write mechanism)", () => {
    const d = decidePath("Write", join(readOnlyDir, "f.txt"), { allowedDirs: [], readOnlyDirs: [readOnlyDir] });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("READ-ONLY");
  });

  test("Edit inside readOnlyDir ⇒ deny (read-only-write mechanism)", () => {
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

  test("Write into readOnlyDir ⇒ deny (read-only-write mechanism)", () => {
    const r = runHook("Write", { file_path: join(readOnlyDir, "secret.yaml") }, policyEnv());
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("READ-ONLY");
  });

  test("Edit into readOnlyDir ⇒ deny (read-only-write mechanism)", () => {
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

// =============================================================================
// B1 (CRITICAL) — `~`/`$VAR` must expand to the REAL path before containment.
// =============================================================================

describe("expandUserPath (B1 fix)", () => {
  test("bare ~ expands to HOME", () => {
    expect(expandUserPath("~")).toBe(process.env.HOME ?? homedir());
  });

  test("~/ prefix expands to HOME", () => {
    expect(expandUserPath("~/.ssh/id_rsa")).toBe((process.env.HOME ?? homedir()) + "/.ssh/id_rsa");
  });

  test("$HOME expands via process.env", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/fake/home";
    try {
      expect(expandUserPath("$HOME/.ssh/id_rsa")).toBe("/fake/home/.ssh/id_rsa");
    } finally {
      process.env.HOME = prev;
    }
  });

  test("${VAR} braced form expands", () => {
    const prev = process.env.EBH1_TEST_VAR;
    process.env.EBH1_TEST_VAR = "/somewhere";
    try {
      expect(expandUserPath("${EBH1_TEST_VAR}/leak")).toBe("/somewhere/leak");
    } finally {
      if (prev === undefined) delete process.env.EBH1_TEST_VAR;
      else process.env.EBH1_TEST_VAR = prev;
    }
  });

  test("unset $VAR expands to empty string (matches real shell)", () => {
    delete process.env.EBH1_DEFINITELY_UNSET;
    expect(expandUserPath("$EBH1_DEFINITELY_UNSET/leak")).toBe("/leak");
  });

  test("a plain path with no ~ or $ is unchanged", () => {
    expect(expandUserPath("/a/b/c.txt")).toBe("/a/b/c.txt");
    expect(expandUserPath("relative/file.ts")).toBe("relative/file.ts");
  });
});

// =============================================================================
// R1 (cortex#2343 adversarial review ROUND 2) — table-driven matrix covering
// the CLASS of shell-expansion tokens, not just the two repros the review
// gave. Every row exercises expandUserPath() + isUnresolvedShellToken()
// together — this is the exact pair both hooks call before isAbsolute/resolve.
// =============================================================================
describe("expandUserPath + isUnresolvedShellToken — R1 class matrix", () => {
  const FAKE_HOME = "/tmp/ebh1-r1-matrix-fakehome";

  interface Row {
    label: string;
    token: string;
    expectAmbiguous: boolean; // true ⇒ the hook must fail-closed DENY
  }

  const rows: Row[] = [
    { label: "~root/x (other user's home)", token: "~root/x", expectAmbiguous: true },
    { label: "~someuser/x (other user's home)", token: "~someuser/x", expectAmbiguous: true },
    { label: "~/x (bare-slash form — resolves via HOME, not ambiguous)", token: "~/x", expectAmbiguous: false },
    { label: "~ (bare tilde alone — resolves via HOME, not ambiguous)", token: "~", expectAmbiguous: false },
    { label: "${HOME}/x (braced var — resolves, not ambiguous)", token: "${HOME}/x", expectAmbiguous: false },
    { label: "$HOME/x (bare var — resolves, not ambiguous)", token: "$HOME/x", expectAmbiguous: false },
    { label: "$UNSET_EBH1_VAR/x (unset var ⇒ empty string, not ambiguous)", token: "$UNSET_EBH1_VAR/x", expectAmbiguous: false },
    { label: "a/$5/mid-path (unresolvable — $5 isn't a valid var name)", token: "a/$5/mid-path", expectAmbiguous: true },
    { label: "plain/relative/path.txt (no shell syntax at all)", token: "plain/relative/path.txt", expectAmbiguous: false },
    { label: "/already/absolute/path.txt (no shell syntax at all)", token: "/already/absolute/path.txt", expectAmbiguous: false },
  ];

  for (const { label, token, expectAmbiguous } of rows) {
    test(`${label} → ${expectAmbiguous ? "AMBIGUOUS (must deny)" : "resolves cleanly"}`, () => {
      const prevHome = process.env.HOME;
      process.env.HOME = FAKE_HOME;
      delete process.env.UNSET_EBH1_VAR;
      try {
        const expanded = expandUserPath(token);
        expect(isUnresolvedShellToken(expanded)).toBe(expectAmbiguous);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    });
  }
});

describe("path-guard.hook — B1: ~/$VAR expansion before containment (spawned)", () => {
  let root: string;
  let allowedDir: string;
  let fakeHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "path-guard-b1-"));
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
      CORTEX_CHANNEL: "test",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
      HOME: fakeHome,
    };
  }

  test("Read with file_path '~/.ssh/id_rsa' (HOME outside allowedDirs) ⇒ deny, cwd inside allowedDir", () => {
    const r = runHook("Read", { file_path: "~/.ssh/id_rsa" }, policyEnv(), "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });

  test("Read with file_path '$HOME/.ssh/id_rsa' (HOME outside allowedDirs) ⇒ deny, cwd inside allowedDir", () => {
    const r = runHook("Read", { file_path: "$HOME/.ssh/id_rsa" }, policyEnv(), "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });

  test("control: Read with file_path '/etc/hosts' still denies (sanity)", () => {
    const r = runHook("Read", { file_path: "/etc/hosts" }, policyEnv(), "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });

  test("legitimate '~/...' path that DOES resolve inside allowedDirs still allows", () => {
    // allowedDirs itself is configured as an absolute path here (not under
    // HOME), so exercise the positive case with HOME pointed AT allowedDir's
    // parent so `~/allowed/...` resolves into policy scope.
    const homeAsRoot = root; // HOME = root, allowedDir = root/allowed
    const r = runHook(
      "Read",
      { file_path: "~/allowed/ok.txt" },
      {
        CORTEX_CHANNEL: "test",
        CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
        HOME: homeAsRoot,
      },
      "test-session",
      allowedDir,
    );
    // File doesn't need to exist for Read to be judged in-policy by the
    // guard (existence is the tool's concern, not the guard's) — only
    // containment matters here.
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });
});

describe("path-guard.hook — R1: shell-expansion CLASS matrix (spawned)", () => {
  let root: string;
  let allowedDir: string;
  let fakeHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "path-guard-r1-matrix-"));
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
      CORTEX_CHANNEL: "test",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
      HOME: fakeHome, // outside allowedDir — any HOME-based resolution must deny
    };
  }

  interface Row {
    label: string;
    file_path: string;
    expectDeny: boolean;
  }

  const rows: Row[] = [
    { label: "~root/x (other user's home)", file_path: "~root/x", expectDeny: true },
    { label: "~someuser/x (other user's home)", file_path: "~someuser/x", expectDeny: true },
    { label: "~/x (HOME outside allowedDirs)", file_path: "~/x", expectDeny: true },
    { label: "~ bare (HOME outside allowedDirs)", file_path: "~", expectDeny: true },
    { label: "${HOME}/x (HOME outside allowedDirs)", file_path: "${HOME}/x", expectDeny: true },
    { label: "$HOME/x (HOME outside allowedDirs)", file_path: "$HOME/x", expectDeny: true },
    { label: "$UNSET_EBH1_VAR/x (unset ⇒ empty string ⇒ /x ⇒ outside)", file_path: "$UNSET_EBH1_VAR/x", expectDeny: true },
    { label: "a/$5/mid-path ($5 unresolvable — not a valid var name)", file_path: "a/$5/mid-path", expectDeny: true },
    { label: "/etc/hosts (plain absolute, no shell syntax — sanity control)", file_path: "/etc/hosts", expectDeny: true },
  ];

  for (const { label, file_path, expectDeny } of rows) {
    test(`${label} → ${expectDeny ? "DENY" : "ALLOW"}`, () => {
      delete process.env.UNSET_EBH1_VAR;
      const r = runHook("Read", { file_path }, policyEnv(), "test-session", allowedDir);
      expect(r.status).toBe(0);
      if (expectDeny) {
        expectDenyDecision(r.stdout);
      } else {
        expectGrantDecision(r.stdout);
      }
    });
  }

  test("positive control: a plain relative path resolving INSIDE allowedDirs allows", () => {
    const r = runHook("Read", { file_path: "ok.txt" }, policyEnv(), "test-session", allowedDir);
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });
});

// =============================================================================
// B2 — Glob's `pattern` argument is itself a path (unlike Grep's).
// =============================================================================

describe("path-guard.hook — B2: Glob pattern path-traversal (spawned)", () => {
  let root: string;
  let allowedDir: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "path-guard-b2-"));
    allowedDir = join(root, "allowed");
    secretDir = join(root, "secret");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "leak.txt"), "nope\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  test("Glob with an ABSOLUTE pattern outside allowedDirs (no `path` field) ⇒ deny", () => {
    const r = runHook("Glob", { pattern: `${secretDir}/*` }, policyEnv());
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });

  test("Glob with path=allowedDir and a `../` traversal pattern ⇒ deny", () => {
    const r = runHook("Glob", { path: allowedDir, pattern: "../secret/*" }, policyEnv());
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });

  test("Glob with a harmless relative pattern (no path prefix) still allows", () => {
    const r = runHook("Glob", { pattern: "*.ts" }, policyEnv());
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("Glob with a relative directory-prefixed pattern resolving INSIDE allowedDirs allows", () => {
    mkdirSync(join(allowedDir, "src"), { recursive: true });
    const r = runHook("Glob", { path: allowedDir, pattern: "src/**/*.ts" }, policyEnv());
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("Grep's `pattern` (content regex) is still NEVER treated as a path even after the B2 fix", () => {
    const r = runHook("Grep", { pattern: secretDir }, policyEnv());
    expect(r.status).toBe(0);
    // No `path` field given ⇒ nothing to containment-check for Grep ⇒ allow
    // (relies on session cwd scope, unaffected by the B2 Glob-only fix).
    expectGrantDecision(r.stdout);
  });
});

// =============================================================================
// R2 (cortex#2343 adversarial review ROUND 2) — pure-function unit coverage
// for the brace-expansion + risky-root primitives, plus a table-driven
// SPAWNED matrix covering the CLASS of Glob pattern shapes, not just the
// one repro the review gave.
// =============================================================================

describe("expandBraceAlternatives (R2 fix)", () => {
  test("no braces at all ⇒ kind:none", () => {
    expect(expandBraceAlternatives("src/**/*.ts")).toEqual({ kind: "none" });
  });

  test("one clean brace group ⇒ expanded alternatives", () => {
    expect(expandBraceAlternatives("{../secret,x}/*")).toEqual({
      kind: "expanded",
      alternatives: ["../secret/*", "x/*"],
    });
  });

  test("brace group with 3 alternatives", () => {
    expect(expandBraceAlternatives("{/etc,x,../y}/passwd")).toEqual({
      kind: "expanded",
      alternatives: ["/etc/passwd", "x/passwd", "../y/passwd"],
    });
  });

  test("unbalanced brace ⇒ ambiguous", () => {
    expect(expandBraceAlternatives("{a,b/*").kind).toBe("ambiguous");
  });

  test("nested brace ⇒ ambiguous", () => {
    expect(expandBraceAlternatives("{a,{b,c}}/*").kind).toBe("ambiguous");
  });

  test("two top-level brace groups ⇒ ambiguous", () => {
    expect(expandBraceAlternatives("{a,b}/{c,d}").kind).toBe("ambiguous");
  });
});

describe("isRiskyGlobPatternRoot (R2 fix)", () => {
  test("empty root ⇒ not risky", () => {
    expect(isRiskyGlobPatternRoot("")).toBe(false);
  });

  test("absolute root ⇒ risky", () => {
    expect(isRiskyGlobPatternRoot("/etc/")).toBe(true);
  });

  test("relative root with a .. segment ⇒ risky", () => {
    expect(isRiskyGlobPatternRoot("../secret/")).toBe(true);
  });

  test("relative root with no .. segment ⇒ not risky", () => {
    expect(isRiskyGlobPatternRoot("src/")).toBe(false);
  });
});

describe("path-guard.hook — R2: Glob pattern CLASS matrix (spawned)", () => {
  let root: string;
  let allowedDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "path-guard-r2-matrix-"));
    allowedDir = join(root, "allowed");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(join(allowedDir, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  interface Row {
    label: string;
    pattern: string;
    expectDeny: boolean;
  }

  const rows: Row[] = [
    { label: "../x (plain traversal, no brace)", pattern: "../x", expectDeny: true },
    { label: "{../x,y}/* (traversal HIDDEN inside a brace alternative)", pattern: "{../x,y}/*", expectDeny: true },
    { label: "{/etc,x}/passwd (absolute HIDDEN inside a brace alternative)", pattern: "{/etc,x}/passwd", expectDeny: true },
    { label: "**/x (legit — no directory prefix at all)", pattern: "**/x", expectDeny: false },
    { label: "*.ts (legit — no directory prefix at all)", pattern: "*.ts", expectDeny: false },
    { label: "src/** (legit — relative prefix resolving inside allowedDirs)", pattern: "src/**", expectDeny: false },
  ];

  for (const { label, pattern, expectDeny } of rows) {
    test(`${label} → ${expectDeny ? "DENY" : "ALLOW"}`, () => {
      const r = runHook("Glob", { path: allowedDir, pattern }, policyEnv());
      expect(r.status).toBe(0);
      if (expectDeny) {
        expectDenyDecision(r.stdout);
      } else {
        expectGrantDecision(r.stdout);
      }
    });
  }
});

// =============================================================================
// B4 — NotebookEdit must be governed (was a complete bypass before the fix).
// =============================================================================

describe("path-guard.hook — B4: NotebookEdit coverage (spawned)", () => {
  let root: string;
  let allowedDir: string;
  let outsideDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "path-guard-b4-"));
    allowedDir = join(root, "allowed");
    outsideDir = join(root, "outside");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "secret.ipynb"), "{}\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function policyEnv(): Record<string, string> {
    return {
      CORTEX_CHANNEL: "test",
      CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [allowedDir], readOnlyDirs: [] }),
    };
  }

  test("NotebookEdit outside allowedDirs ⇒ deny (was pass-through before the fix)", () => {
    const r = runHook("NotebookEdit", { notebook_path: join(outsideDir, "secret.ipynb") }, policyEnv());
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });

  test("NotebookEdit inside allowedDirs ⇒ allow", () => {
    const r = runHook("NotebookEdit", { notebook_path: join(allowedDir, "nb.ipynb") }, policyEnv());
    expect(r.status).toBe(0);
    expectGrantDecision(r.stdout);
  });

  test("NotebookEdit into a readOnlyDir ⇒ deny (mutating tool, same as Write/Edit)", () => {
    const readOnlyDir = join(root, "readonly");
    mkdirSync(readOnlyDir, { recursive: true });
    const r = runHook(
      "NotebookEdit",
      { notebook_path: join(readOnlyDir, "nb.ipynb") },
      {
        CORTEX_CHANNEL: "test",
        CORTEX_PATH_GUARD: JSON.stringify({ allowedDirs: [], readOnlyDirs: [readOnlyDir] }),
      },
    );
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });

  test("NotebookEdit with no notebook_path (malformed) under an active policy ⇒ deny", () => {
    const r = runHook("NotebookEdit", {}, policyEnv());
    expect(r.status).toBe(0);
    expectDenyDecision(r.stdout);
  });
});
