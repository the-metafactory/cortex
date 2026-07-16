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

describe("buildCuratedSettings — per-skill grant hook (cortex#710)", () => {
  interface Curated {
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  }

  const skillHook = (s: Curated) =>
    s.hooks.PreToolUse!.find((e) => e.matcher === "Skill");

  test("NO grants → no Skill hook registered (default-deny lives in disallowedTools)", () => {
    expect(skillHook(buildCuratedSettings("/fake/.claude") as unknown as Curated)).toBeUndefined();
    expect(
      skillHook(buildCuratedSettings("/fake/.claude", []) as unknown as Curated),
    ).toBeUndefined();
  });

  test("WITH grants → Skill Guard hook registered under the Skill matcher", () => {
    const s = buildCuratedSettings("/fake/.claude", ["code-review"]) as unknown as Curated;
    const entry = skillHook(s);
    expect(entry).toBeDefined();
    expect(entry!.hooks[0]!.command).toMatch(/\/hooks\/CortexSkillGuard\.hook\.ts$/);
  });

  test("the Bash guard is ALWAYS present, with or without grants", () => {
    for (const grants of [undefined, [], ["code-review"]]) {
      const s = buildCuratedSettings("/fake/.claude", grants) as unknown as Curated;
      const bash = s.hooks.PreToolUse!.find((e) => e.matcher === "Bash");
      expect(bash).toBeDefined();
      expect(bash!.hooks[0]!.command).toContain("CortexBashGuard.hook.ts");
    }
  });

  test("grant list is NOT baked into the settings file (it rides the env var)", () => {
    // The grant names travel via CORTEX_SKILL_GRANTS, not the curated file —
    // the file only registers the gate hook. Asserting the skill NAME is
    // absent keeps the two channels separate (the hook reads the env).
    const s = buildCuratedSettings("/fake/.claude", ["code-review"]);
    expect(JSON.stringify(s)).not.toContain("code-review");
  });

  test("createIsolatedSettings threads grants into the written file", () => {
    const iso = createIsolatedSettings("/fake/.claude", ["code-review"]);
    try {
      const written = JSON.parse(readFileSync(iso.settingsPath, "utf8"));
      const skill = written.hooks.PreToolUse.find(
        (e: { matcher?: string }) => e.matcher === "Skill",
      );
      expect(skill).toBeDefined();
      expect(skill.hooks[0].command).toContain("CortexSkillGuard.hook.ts");
    } finally {
      iso.cleanup();
    }
  });
});

describe("buildCuratedSettings — per-principal MCP guard hook (cortex#2111)", () => {
  interface Curated {
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  }

  const mcpHook = (s: Curated) =>
    s.hooks.PreToolUse!.find((e) => e.matcher === "mcp__.*");

  test("UNDEFINED mcpGrants → no MCP hook (non-policy path, behaviour unchanged)", () => {
    const s = buildCuratedSettings("/fake/.claude", undefined, undefined) as unknown as Curated;
    expect(mcpHook(s)).toBeUndefined();
  });

  test("EMPTY mcpGrants ([]) STILL registers the hook — deny-all is a decision", () => {
    // Asymmetry with skills is deliberate: an empty skill list is covered by
    // the `Skill` deny rule, but NO deny rule can reach un-enumerable mcp__*
    // names — the hook IS the deny (cortex#2111).
    const s = buildCuratedSettings("/fake/.claude", undefined, []) as unknown as Curated;
    const entry = mcpHook(s);
    expect(entry).toBeDefined();
    expect(entry!.hooks[0]!.command).toMatch(/\/hooks\/CortexMcpGuard\.hook\.ts$/);
  });

  test("WITH grants → MCP Guard hook registered under the mcp__.* matcher", () => {
    const s = buildCuratedSettings("/fake/.claude", undefined, ["gdrive"]) as unknown as Curated;
    expect(mcpHook(s)).toBeDefined();
  });

  test("grant patterns are NOT baked into the settings file (they ride the env var)", () => {
    const s = buildCuratedSettings("/fake/.claude", undefined, ["gdrive", "jira.search"]);
    expect(JSON.stringify(s)).not.toContain("gdrive");
  });

  test("skill + mcp hooks coexist independently", () => {
    const s = buildCuratedSettings("/fake/.claude", ["code-review"], []) as unknown as Curated;
    expect(s.hooks.PreToolUse!.find((e) => e.matcher === "Skill")).toBeDefined();
    expect(mcpHook(s)).toBeDefined();
    expect(s.hooks.PreToolUse!.find((e) => e.matcher === "Bash")).toBeDefined();
  });

  test("createIsolatedSettings threads mcpGrants into the written file", () => {
    const iso = createIsolatedSettings("/fake/.claude", undefined, []);
    try {
      const written = JSON.parse(readFileSync(iso.settingsPath, "utf8"));
      const mcp = written.hooks.PreToolUse.find(
        (e: { matcher?: string }) => e.matcher === "mcp__.*",
      );
      expect(mcp).toBeDefined();
      expect(mcp.hooks[0].command).toContain("CortexMcpGuard.hook.ts");
    } finally {
      iso.cleanup();
    }
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
      CORTEX_BASH_GUARD: "{}",
      SOME_OTHER_VAR: "v",
    });
    expect(scoped.CORTEX_CHANNEL).toBe("andreas");
    expect(scoped.CORTEX_BASH_GUARD).toBe("{}");
    expect(scoped.SOME_OTHER_VAR).toBe("v");
  });

  test("drops undefined values", () => {
    const scoped = scopeSessionEnv({ A: undefined, B: "b" });
    expect("A" in scoped).toBe(false);
    expect(scoped.B).toBe("b");
  });
});
