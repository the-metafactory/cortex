/**
 * cortex#2498 §0e / #2482 (R1-F1-A) — the file-tool gate, END TO END through
 * the settings an isolated session actually loads.
 *
 * ## Why this file exists alongside the two tests that already touch this
 *
 * Three assertions are needed to know the file-tool boundary is live, and
 * until now only two were made — by different tests, neither of which met
 * the other:
 *
 *   1. `hook-registration-parity.test.ts` (cortex#2482) asserts the guard is
 *      REGISTERED — it compares `arc-manifest.yaml`'s `provides.hooks`
 *      against `buildCuratedSettings`' return value as STRINGS. It never
 *      runs a hook, so it cannot tell a registration that gates a `Write`
 *      from one that gates nothing (a matcher of `"Wriet"` passes it, so
 *      long as the manifest has the same typo).
 *   2. `hooks/__tests__/path-guard.hook.test.ts` (cortex#2343) asserts the
 *      guard DECIDES correctly — it spawns the hook directly with a
 *      hand-built payload. It never reads the curated settings, so it
 *      passed for the entire period the guard was registered NOWHERE a
 *      dispatched session could load it.
 *
 * Both were green throughout the R1-F1-A defect window. The missing
 * assertion is the JOIN: that the settings file `createIsolatedSettings`
 * WRITES routes a `Write` to the guard, and that the guard then decides it.
 * That is what this file asserts, by resolving the matcher out of the
 * written file and executing whatever it names.
 *
 * ## Why the matcher is re-implemented here
 *
 * Claude Code resolves a PreToolUse matcher as a regex, full-matched against
 * the tool name. Cortex does not own that engine, so this file models it
 * ({@link hooksMatching}) and treats the RESULT as the thing under test. A
 * matcher that stops covering `Write` — by edit, by typo, by a future
 * refactor that drops the entry — resolves to zero hooks here and the
 * behavioural assertions below fail, which is the point.
 *
 * ## What fails without the fix
 *
 * On the pre-#2482 code every test in this file fails: `buildCuratedSettings`
 * registers no file-tool matcher, `hooksMatching("Write")` returns `[]`, and
 * a `Write` — in bounds or out — reaches no cortex hook at all. In bounds
 * that means the CLI's own permission prompt, unanswerable under `--print`
 * (the cortex#2498 incident, attempt 2→3). Out of bounds, once `Write` is in
 * `--allowedTools`, it means the write simply lands.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createIsolatedSettings } from "../session-settings";
import { resolvePathGuardEnv } from "../cc-session";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * The installed-hook symlinks arc lays down under the cortex-owned `.claude`
 * dir (`arc-manifest.yaml`'s `provides.files`). `buildCuratedSettings` emits
 * `${claudeDir}/hooks/<Name>` paths, so the curated file is only executable
 * if these exist — building them here keeps the test self-contained and
 * independent of whether arc has run on the machine.
 */
const INSTALLED_HOOKS: Record<string, string> = {
  "CortexBashGuard.hook.ts": "src/runner/hooks/bash-guard.hook.ts",
  "CortexPathGuard.hook.ts": "src/runner/hooks/path-guard.hook.ts",
  "CortexSkillGuard.hook.ts": "src/runner/hooks/skill-guard.hook.ts",
  "CortexMcpGuard.hook.ts": "src/runner/hooks/mcp-guard.hook.ts",
  "CortexContext.hook.ts": "src/taps/cc-events/hooks/surface-context.hook.ts",
  "CortexEventLogger.hook.ts": "src/taps/cc-events/hooks/event-logger.hook.ts",
};

/**
 * Surface env keys the hook reads. The test process may itself be running
 * inside a cortex agent session, so every spawn starts from a slate with
 * these stripped and applies only what the case sets — the same defence
 * `path-guard.hook.test.ts`'s `SURFACE_ENV_KEYS` makes.
 */
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

interface CuratedEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

let claudeDir: string;
let inBoundsDir: string;
let outOfBoundsDir: string;
let pathGuardEnv: string;
let curatedPreToolUse: CuratedEntry[];
let cleanupSettings: () => void;

beforeAll(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "cortex-curatedgate-claude-"));
  mkdirSync(join(claudeDir, "hooks"));
  for (const [installed, source] of Object.entries(INSTALLED_HOOKS)) {
    symlinkSync(join(REPO_ROOT, source), join(claudeDir, "hooks", installed));
  }

  // realpath: on macOS `/var/folders/...` is a symlink to `/private/var/...`,
  // and the guard realpath's every candidate before the containment check —
  // so the POLICY must be stated in realpath'd form too, or an in-bounds
  // path would spuriously read as out-of-bounds and this test would pass for
  // the wrong reason.
  inBoundsDir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-curatedgate-in-")));
  outOfBoundsDir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-curatedgate-out-")));

  // Produced by the SAME function cc-session.ts:631 uses to write
  // CORTEX_PATH_GUARD onto every spawned session — not a hand-built literal,
  // so a change to the policy projection is caught here too.
  pathGuardEnv = resolvePathGuardEnv({ allowedDirs: [inBoundsDir], readOnlyDirs: [] });

  // The settings an isolated session actually loads: read back off DISK from
  // the file createIsolatedSettings wrote, not from buildCuratedSettings'
  // in-memory return value. `mcpGrants: []` mirrors a policy-resolved
  // dispatch (the common case); skill grants are irrelevant to the file-tool
  // gate and left undefined.
  const isolated = createIsolatedSettings(claudeDir, undefined, []);
  cleanupSettings = isolated.cleanup;
  const written = JSON.parse(readFileSync(isolated.settingsPath, "utf-8")) as {
    hooks: { PreToolUse?: CuratedEntry[] };
  };
  curatedPreToolUse = written.hooks.PreToolUse ?? [];
});

afterAll(() => {
  cleanupSettings?.();
  for (const dir of [claudeDir, inBoundsDir, outOfBoundsDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Model Claude Code's PreToolUse matcher resolution: the matcher is a regex,
 * full-matched against the tool name; an absent/empty/`*` matcher matches
 * every tool. Returns the hook commands that would run for `toolName`.
 */
function hooksMatching(toolName: string): string[] {
  const commands: string[] = [];
  for (const entry of curatedPreToolUse) {
    const matcher = entry.matcher;
    if (matcher === undefined || matcher === "" || matcher === "*") {
      commands.push(...entry.hooks.map((h) => h.command));
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${matcher})$`);
    } catch (err) {
      throw new Error(
        `curated PreToolUse matcher ${JSON.stringify(matcher)} is not a valid regex ` +
          `(${err instanceof Error ? err.message : String(err)}) — Claude Code compiles ` +
          `matchers as regexes, so an uncompilable one silently gates nothing.`,
        { cause: err },
      );
    }
    if (re.test(toolName)) commands.push(...entry.hooks.map((h) => h.command));
  }
  return commands;
}

interface Decision {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  passedThrough: boolean;
}

/** Execute one curated hook command with the real PreToolUse stdin contract. */
function runCuratedHook(
  command: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Decision {
  const stripped = new Set(SURFACE_ENV_KEYS);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !stripped.has(k)) env[k] = v;
  }
  env.CORTEX_CHANNEL = "curated-gate-test";
  env.CORTEX_PATH_GUARD = pathGuardEnv;
  // Point telemetry at a closed port: the guard's block event is best-effort
  // and must never reach a real ingest endpoint from a test.
  env.CORTEX_INGEST_URL = "http://127.0.0.1:1/none";

  const result = spawnSync("bun", [command], {
    encoding: "utf-8",
    input: JSON.stringify({
      session_id: "curated-gate-test",
      tool_name: toolName,
      tool_input: toolInput,
    }),
    env,
    cwd: inBoundsDir,
  });

  const stdout = result.stdout.trim();
  if (stdout === "") {
    throw new Error(
      `curated hook ${command} produced no stdout for ${toolName} — a PreToolUse hook ` +
        `must always emit a decision object. stderr: ${result.stderr}`,
    );
  }
  const parsed = JSON.parse(stdout.split("\n").at(-1) ?? "{}") as {
    continue?: boolean;
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return {
    permissionDecision: parsed.hookSpecificOutput?.permissionDecision,
    permissionDecisionReason: parsed.hookSpecificOutput?.permissionDecisionReason,
    passedThrough: parsed.continue === true,
  };
}

/**
 * Resolve the single hook that gates `toolName` in the curated settings and
 * run it. Fails loudly (rather than skipping) when nothing matches — "no
 * hook is registered for this tool" IS the R1-F1-A defect, so it must read
 * as a failure, never as a vacuous pass.
 */
function decideVia(toolName: string, toolInput: Record<string, unknown>): Decision {
  const commands = hooksMatching(toolName);
  if (commands.length === 0) {
    throw new Error(
      `the settings an isolated session loads register NO PreToolUse hook matching ` +
        `"${toolName}" — matchers present: ` +
        `[${curatedPreToolUse.map((e) => JSON.stringify(e.matcher)).join(", ")}]. ` +
        `A file tool that reaches no cortex hook is decided entirely by the Claude CLI: ` +
        `in bounds it dies at an unanswerable permission prompt under --print, and out of ` +
        `bounds — once the tool is in --allowedTools — it is auto-approved with no cortex ` +
        `containment at all (cortex#2498 §0e / #2482 R1-F1-A).`,
    );
  }
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("CortexPathGuard.hook.ts");
  return runCuratedHook(commands[0]!, toolName, toolInput);
}

describe("curated settings — the file-tool gate is bound (cortex#2498 §0e / #2482)", () => {
  test("the path guard IS present in the settings an isolated session loads", () => {
    const commands = curatedPreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands.some((c) => c.endsWith("/hooks/CortexPathGuard.hook.ts"))).toBe(true);
  });

  test("every governed file tool resolves to the path guard through the written matcher", () => {
    // Executable coverage of the matcher, tool by tool — the string-equality
    // parity test cannot distinguish a matcher that covers these from one
    // that covers nothing.
    for (const tool of ["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"]) {
      const commands = hooksMatching(tool);
      expect(
        commands.some((c) => c.endsWith("/hooks/CortexPathGuard.hook.ts")),
      ).toBe(true);
    }
  });

  test("a Write INSIDE bounds is auto-approved BY THE GUARD — no permission prompt", () => {
    // The `allow` decision is what spares a dispatched session the CLI's
    // permission prompt. Under `--print` that prompt cannot be answered, so
    // an unguarded in-bounds Write does not merely warn — it kills the turn.
    // This is the exact mechanism of the cortex#2498 incident's attempt 2→3.
    const decision = decideVia("Write", {
      file_path: join(inBoundsDir, "note.md"),
      content: "hello",
    });
    expect(decision.passedThrough).toBe(false);
    expect(decision.permissionDecision).toBe("allow");
    expect(decision.permissionDecisionReason).toContain("Cortex Path Guard");
  });

  test("a Write OUTSIDE bounds is refused BY THE GUARD — not merely by the CLI", () => {
    // The assertion that matters for containment is the AUTHOR of the
    // refusal. Once `Write` is in `--allowedTools` the CLI refuses nothing,
    // so only a cortex-authored deny keeps the boundary. Asserting the
    // `[Cortex Path Guard]` prefix pins that authorship: a refusal that
    // merely happens is indistinguishable from the CLI's own, and the CLI's
    // own is exactly what is absent here.
    const decision = decideVia("Write", {
      file_path: join(outOfBoundsDir, "escaped.md"),
      content: "owned",
    });
    expect(decision.passedThrough).toBe(false);
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.permissionDecisionReason).toContain("[Cortex Path Guard]");
    expect(decision.permissionDecisionReason).toContain(outOfBoundsDir);
  });

  test("an Edit OUTSIDE bounds is refused too — Write is not the only mutating file tool", () => {
    // Write/Edit/NotebookEdit all bypass Bash, so bash-guard's containment
    // (which imports the same path checks) never sees them. Edit is pinned
    // separately so a matcher narrowed to `Write` alone still fails.
    const decision = decideVia("Edit", {
      file_path: join(outOfBoundsDir, "escaped.md"),
      old_string: "a",
      new_string: "b",
    });
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.permissionDecisionReason).toContain("[Cortex Path Guard]");
  });
});
