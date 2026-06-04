/**
 * cortex#701 (Part A) — session settings isolation tests.
 *
 * AC: "Bot CC sessions do NOT inherit the principal's global ~/.claude
 * hooks/skills/plugins" — verified here at the unit level by asserting:
 *   - the spawn excludes the principal's `user` setting source,
 *   - the curated settings file references ONLY cortex's own hooks,
 *   - the child env drops principal-personal CLAUDE_* vars.
 *
 * The end-to-end "no principal hooks fired" assertion is covered at the
 * CCSession arg level (cc-session-isolation.test.ts).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import {
  CORTEX_SETTING_SOURCES,
  CORTEX_PRESERVED_CLAUDE_ENV,
  buildCuratedSettings,
  createIsolatedSettings,
  scopeSessionEnv,
} from "../session-settings";

describe("CORTEX_SETTING_SOURCES — no ambient source loaded", () => {
  test("never loads the principal's `user` source", () => {
    // The principal's global ~/.claude/settings.json is the `user` source.
    // Excluding it is the whole point of the isolation.
    expect(CORTEX_SETTING_SOURCES).not.toContain("user");
  });

  test("loads NO ambient source (not project/local either)", () => {
    // cortex#701 self-check: `--settings` is additive, so loading `project`
    // or `local` would let the cwd repo's `.claude/` (repo content +
    // principal-personal local config) fire hooks inside the bot session.
    // The only sound default is an empty source list — rely solely on the
    // curated --settings file.
    expect([...CORTEX_SETTING_SOURCES]).toEqual([]);
    expect(CORTEX_SETTING_SOURCES).not.toContain("project");
    expect(CORTEX_SETTING_SOURCES).not.toContain("local");
  });
});

describe("buildCuratedSettings — cortex's own hooks only", () => {
  const settings = buildCuratedSettings("/fake/.claude") as {
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  };

  test("registers ONLY Cortex* hooks (no principal hooks)", () => {
    const commands = Object.values(settings.hooks)
      .flat()
      .flatMap((entry) => entry.hooks.map((h) => h.command));
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      // Every hook must be a cortex-owned hook under the curated .claude dir.
      expect(cmd).toMatch(/\/hooks\/Cortex[A-Za-z]+\.hook\.ts$/);
    }
  });

  test("includes EventLogger + bash-guard (cortex's load-bearing hooks)", () => {
    const commands = JSON.stringify(settings.hooks);
    expect(commands).toContain("CortexEventLogger.hook.ts");
    expect(commands).toContain("CortexBashGuard.hook.ts");
    expect(commands).toContain("CortexContext.hook.ts");
  });

  test("bash-guard is gated to the Bash matcher", () => {
    const pre = settings.hooks.PreToolUse!;
    expect(pre[0]!.matcher).toBe("Bash");
  });
});

describe("createIsolatedSettings — materialised file + args", () => {
  test("writes a settings file and emits the isolation args", () => {
    const iso = createIsolatedSettings("/fake/.claude");
    try {
      expect(existsSync(iso.settingsPath)).toBe(true);
      // Args MUST load NO ambient source (empty value) and load our
      // curated file. The empty string is the "no source" sentinel.
      const srcIdx = iso.args.indexOf("--setting-sources");
      expect(srcIdx).toBeGreaterThan(-1);
      expect(iso.args[srcIdx + 1]).toBe("");
      expect(iso.args).not.toContain("project,local");
      expect(iso.args).not.toContain("user");
      expect(iso.args).toContain("--settings");
      expect(iso.args).toContain(iso.settingsPath);

      const written = JSON.parse(readFileSync(iso.settingsPath, "utf8"));
      expect(written.hooks).toBeDefined();
      expect(JSON.stringify(written.hooks)).toContain("CortexEventLogger.hook.ts");
    } finally {
      iso.cleanup();
    }
  });

  test("cleanup removes the temp dir and is idempotent", () => {
    const iso = createIsolatedSettings("/fake/.claude");
    expect(existsSync(iso.settingsPath)).toBe(true);
    iso.cleanup();
    expect(existsSync(iso.settingsPath)).toBe(false);
    // Second call must not throw.
    expect(() => iso.cleanup()).not.toThrow();
  });
});

describe("scopeSessionEnv — principal CLAUDE_* vars dropped", () => {
  test("drops un-allowlisted CLAUDE_* vars (default-deny)", () => {
    const scoped = scopeSessionEnv({
      PATH: "/usr/bin",
      HOME: "/Users/op",
      CLAUDE_CODE_EXTRA_SETTINGS: "/Users/op/.claude/evil.json",
      CLAUDE_HOOKS_PATH: "/Users/op/hooks",
      CLAUDE_PLUGINS: "x",
    });
    expect(scoped.PATH).toBe("/usr/bin");
    expect(scoped.HOME).toBe("/Users/op");
    // Anything CLAUDE_* not on the allowlist must be gone.
    expect(scoped.CLAUDE_CODE_EXTRA_SETTINGS).toBeUndefined();
    expect(scoped.CLAUDE_HOOKS_PATH).toBeUndefined();
    expect(scoped.CLAUDE_PLUGINS).toBeUndefined();
  });

  test("preserves allowlisted auth CLAUDE_* vars", () => {
    const scoped = scopeSessionEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    });
    expect(scoped.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    // Sanity: the allowlist actually contains it.
    expect(CORTEX_PRESERVED_CLAUDE_ENV.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
  });

  test("preserves cortex's own pipeline + non-Claude vars", () => {
    const scoped = scopeSessionEnv({
      CORTEX_CHANNEL: "andreas",
      GROVE_BASH_GUARD: "{}",
      SOME_OTHER_VAR: "v",
    });
    expect(scoped.CORTEX_CHANNEL).toBe("andreas");
    expect(scoped.GROVE_BASH_GUARD).toBe("{}");
    expect(scoped.SOME_OTHER_VAR).toBe("v");
  });

  test("drops undefined values", () => {
    const scoped = scopeSessionEnv({ A: undefined, B: "b" });
    expect("A" in scoped).toBe(false);
    expect(scoped.B).toBe("b");
  });
});
