/**
 * cortex#701 (Part A) — CCSession spawn isolation tests.
 *
 * AC #1: "Bot CC sessions do NOT inherit the principal's global ~/.claude
 * hooks/skills/plugins — verified by [the spawn using] the isolated
 * --settings."
 *
 * Strategy: spy on `Bun.spawn` so no real `claude` launches. The spy
 * captures the argv + env, then throws to short-circuit CCSession.start()
 * (the catch path emits error/exit cleanly). We assert on the captured
 * spawn call rather than on process behaviour — deterministic and CI-safe
 * (no `claude` binary needed).
 */

import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { CCSession } from "../cc-session";

interface Captured {
  cmd: string[];
  env: Record<string, string>;
}

function captureSpawn(): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts: { env: Record<string, string> }) => {
    calls.push({ cmd, env: opts.env });
    // Short-circuit: throw so start() takes the catch path without ever
    // launching a process. We only care about the spawn arguments.
    throw new Error("spawn intercepted by test");
  }) as unknown as typeof Bun.spawn);
  return { calls, restore: () => spy.mockRestore() };
}

afterEach(() => {
  // Belt-and-braces — each test restores its own spy, but guard against leaks.
});

describe("CCSession — settings isolation (default ON)", () => {
  test("spawn loads NO ambient source and loads a curated --settings file", () => {
    const { calls, restore } = captureSpawn();
    try {
      const session = new CCSession({
        prompt: "hi",
        groveChannel: "test",
        claudeDir: "/fake/.claude",
      });
      // start() will hit the spy, throw internally, and take the catch path.
      session.on("error", () => {/* expected — spawn was intercepted */});
      session.start();

      expect(calls.length).toBe(1);
      const argv = calls[0]!.cmd;
      // Argv[0] is the binary; the rest are the claude args.
      expect(argv[0]).toBe("claude");
      const sourcesIdx = argv.indexOf("--setting-sources");
      expect(sourcesIdx).toBeGreaterThan(-1);
      // Empty value ⇒ load NO ambient source. `--settings` is additive, so
      // loading project/local would let the cwd repo's `.claude/` fire
      // hooks inside the bot session (cortex#701 self-check / regression).
      expect(argv[sourcesIdx + 1]).toBe("");
      // MUST NOT load the principal's user source NOR the repo-scoped
      // project/local sources.
      expect(argv[sourcesIdx + 1]).not.toContain("user");
      expect(argv[sourcesIdx + 1]).not.toContain("project");
      expect(argv[sourcesIdx + 1]).not.toContain("local");

      const settingsIdx = argv.indexOf("--settings");
      expect(settingsIdx).toBeGreaterThan(-1);
      const settingsPath = argv[settingsIdx + 1];
      expect(settingsPath).toMatch(/cortex-session-.*\/settings\.json$/);
    } finally {
      restore();
    }
  });

  test("child env drops principal-personal CLAUDE_* vars", () => {
    const prev = {
      CLAUDE_CODE_EXTRA_SETTINGS: process.env.CLAUDE_CODE_EXTRA_SETTINGS,
      CLAUDE_HOOKS_PATH: process.env.CLAUDE_HOOKS_PATH,
    };
    process.env.CLAUDE_CODE_EXTRA_SETTINGS = "/Users/op/.claude/evil.json";
    process.env.CLAUDE_HOOKS_PATH = "/Users/op/hooks";

    const { calls, restore } = captureSpawn();
    try {
      const session = new CCSession({
        prompt: "hi",
        groveChannel: "test",
        claudeDir: "/fake/.claude",
      });
      session.on("error", () => {/* expected */});
      session.start();

      expect(calls.length).toBe(1);
      const env = calls[0]!.env;
      // Principal-personal CLAUDE_* config must be stripped so it can't
      // re-introduce hooks/plugins/settings into the isolated session.
      expect(env.CLAUDE_CODE_EXTRA_SETTINGS).toBeUndefined();
      expect(env.CLAUDE_HOOKS_PATH).toBeUndefined();
      // Cortex's own pipeline var (set from groveChannel) survives.
      expect(env.GROVE_CHANNEL).toBe("test");
    } finally {
      restore();
      process.env.CLAUDE_CODE_EXTRA_SETTINGS = prev.CLAUDE_CODE_EXTRA_SETTINGS;
      process.env.CLAUDE_HOOKS_PATH = prev.CLAUDE_HOOKS_PATH;
      if (prev.CLAUDE_CODE_EXTRA_SETTINGS === undefined) delete process.env.CLAUDE_CODE_EXTRA_SETTINGS;
      if (prev.CLAUDE_HOOKS_PATH === undefined) delete process.env.CLAUDE_HOOKS_PATH;
    }
  });
});

describe("CCSession — isolation opt-out (principal-as-self)", () => {
  test("settingsIsolation:false omits isolation args and inherits full env", () => {
    const prev = process.env.CLAUDE_HOOKS_PATH;
    process.env.CLAUDE_HOOKS_PATH = "/Users/op/hooks";
    const { calls, restore } = captureSpawn();
    try {
      const session = new CCSession({
        prompt: "hi",
        groveChannel: "test",
        settingsIsolation: false,
      });
      session.on("error", () => {/* expected */});
      session.start();

      expect(calls.length).toBe(1);
      const argv = calls[0]!.cmd;
      expect(argv).not.toContain("--setting-sources");
      // Full env inherited when opted out.
      expect(calls[0]!.env.CLAUDE_HOOKS_PATH).toBe("/Users/op/hooks");
    } finally {
      restore();
      if (prev === undefined) delete process.env.CLAUDE_HOOKS_PATH;
      else process.env.CLAUDE_HOOKS_PATH = prev;
    }
  });
});
