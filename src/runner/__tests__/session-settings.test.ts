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
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  lstatSync,
  chmodSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CORTEX_SETTING_SOURCES,
  CORTEX_PRESERVED_CLAUDE_ENV,
  CORTEX_GRANTED_PLUGIN_NAME,
  buildCuratedSettings,
  createIsolatedSettings,
  scopeSessionEnv,
} from "../session-settings";

/**
 * Build a throwaway skills-source dir with one sub-dir per named skill, each
 * carrying a `SKILL.md`. Returns the dir; caller cleans it up. `refs` maps a
 * skill name → text appended to its SKILL.md (used to plant a sibling-relative
 * reference like `../other/SKILL.md`).
 */
function makeSkillSource(
  skills: string[],
  refs: Record<string, string> = {},
): string {
  const src = mkdtempSync(join(tmpdir(), "cortex-skillsrc-"));
  for (const name of skills) {
    mkdirSync(join(src, name), { recursive: true });
    writeFileSync(join(src, name, "SKILL.md"), `# ${name}\n${refs[name] ?? ""}`);
  }
  return src;
}

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

describe("createIsolatedSettings — granted-skills plugin (cortex#990 A1)", () => {
  test("empty/undefined grants → NO plugin dir, args unchanged from current main", () => {
    for (const grants of [undefined, []] as const) {
      const iso = createIsolatedSettings("/fake/.claude", grants);
      try {
        expect(iso.pluginDir).toBeUndefined();
        expect(iso.args).not.toContain("--plugin-dir");
        // Byte-identical arg shape to the pre-#990 isolation args.
        expect(iso.args).toEqual([
          "--setting-sources",
          "",
          "--settings",
          iso.settingsPath,
        ]);
        expect(existsSync(join(iso.settingsPath, "..", "plugin"))).toBe(false);
      } finally {
        iso.cleanup();
      }
    }
  });

  test("non-empty grants → validating plugin layout with EXACTLY the granted skills COPIED (not symlinked) + --plugin-dir arg", () => {
    const src = makeSkillSource(["alpha", "beta"]);
    const iso = createIsolatedSettings("/fake/.claude", ["alpha", "beta"], undefined, src);
    try {
      // --plugin-dir points at the materialised plugin, inside the temp dir.
      const pdIdx = iso.args.indexOf("--plugin-dir");
      expect(pdIdx).toBeGreaterThan(-1);
      expect(iso.args[pdIdx + 1]).toBe(iso.pluginDir);
      expect(iso.pluginDir).toBeDefined();

      // plugin.json is present and shaped as the spike requires.
      const manifest = JSON.parse(
        readFileSync(join(iso.pluginDir!, ".claude-plugin", "plugin.json"), "utf8"),
      );
      expect(manifest.name).toBe(CORTEX_GRANTED_PLUGIN_NAME);
      expect(typeof manifest.version).toBe("string");
      expect(manifest.version.length).toBeGreaterThan(0);
      expect(manifest.description).toBe("cortex per-session granted skills");

      // EXACTLY the granted skills are present, and each is a real COPY dir —
      // NOT a symlink (review MAJOR 1: symlinks let a session write through to
      // the shared source).
      const skillsDir = join(iso.pluginDir!, "skills");
      for (const name of ["alpha", "beta"]) {
        const st = lstatSync(join(skillsDir, name));
        expect(st.isSymbolicLink()).toBe(false);
        expect(st.isDirectory()).toBe(true);
        expect(existsSync(join(skillsDir, name, "SKILL.md"))).toBe(true);
      }
      expect(existsSync(join(skillsDir, "gamma"))).toBe(false);
    } finally {
      iso.cleanup();
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("MAJOR 1 — writing through a materialised skill CANNOT poison the shared source", () => {
    const src = makeSkillSource(["poison-me"]);
    const sourceSkill = join(src, "poison-me", "SKILL.md");
    const original = readFileSync(sourceSkill, "utf8");

    const iso = createIsolatedSettings("/fake/.claude", ["poison-me"], undefined, src);
    try {
      const copied = join(iso.pluginDir!, "skills", "poison-me", "SKILL.md");
      // Defence-in-depth: the copy is read-only (0444) — the last 3 mode bits.
      expect(lstatSync(copied).mode & 0o777).toBe(0o444);
      // Even if a same-uid session chmods its own copy back and writes to it…
      chmodSync(copied, 0o644);
      writeFileSync(copied, "# PWNED");
      // …the SHARED source is untouched, because the copy severed the link.
      expect(readFileSync(sourceSkill, "utf8")).toBe(original);
      expect(readFileSync(sourceSkill, "utf8")).not.toContain("PWNED");
    } finally {
      iso.cleanup();
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("MAJOR 1 (regression) — SYMLINKED skill source is dereferenced, not re-linked", () => {
    // Production reality: an installed skill dir is itself a symlink
    // (~/.claude/skills/gws-drive → ~/.soma/skills/gws-drive). A non-
    // dereferencing copy would recreate that symlink and the write-through
    // hole would stay open. Reproduce that layout exactly.
    const parent = mkdtempSync(join(tmpdir(), "cortex-symlinksrc-"));
    const realDir = join(parent, "real-store", "linked");
    mkdirSync(realDir, { recursive: true });
    const realSkill = join(realDir, "SKILL.md");
    writeFileSync(realSkill, "# real content");
    // The skills SOURCE dir holds a SYMLINK to the real store, mirroring
    // ~/.claude/skills/<name> → <config-home>/skills/<name>.
    const skillsSrc = join(parent, "skills");
    mkdirSync(skillsSrc, { recursive: true });
    symlinkSync(realDir, join(skillsSrc, "linked"));

    const original = readFileSync(realSkill, "utf8");
    const iso = createIsolatedSettings("/fake/.claude", ["linked"], undefined, skillsSrc);
    try {
      const copiedDir = join(iso.pluginDir!, "skills", "linked");
      // The materialised dir must be a REAL dir, not a recreated symlink.
      expect(lstatSync(copiedDir).isSymbolicLink()).toBe(false);
      expect(lstatSync(copiedDir).isDirectory()).toBe(true);
      // Write through the copy → the real underlying source stays clean.
      const copiedSkill = join(copiedDir, "SKILL.md");
      chmodSync(copiedSkill, 0o644);
      writeFileSync(copiedSkill, "# PWNED");
      expect(readFileSync(realSkill, "utf8")).toBe(original);
      expect(readFileSync(realSkill, "utf8")).not.toContain("PWNED");
    } finally {
      iso.cleanup();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("missing-skill grant → loud log line + skipped, session still constructs", () => {
    const src = makeSkillSource(["present"]); // 'absent' has no source dir
    const logged: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    });
    let iso: ReturnType<typeof createIsolatedSettings>;
    try {
      iso = createIsolatedSettings("/fake/.claude", ["present", "absent"], undefined, src);
    } finally {
      process.stderr.write = original;
    }
    try {
      // Session still built with a plugin; present skill copied, absent skipped.
      expect(iso.pluginDir).toBeDefined();
      expect(existsSync(join(iso.pluginDir!, "skills", "present"))).toBe(true);
      expect(existsSync(join(iso.pluginDir!, "skills", "absent"))).toBe(false);
      // Loud log line naming the missing grant + the searched dir.
      const line = logged.join("");
      expect(line).toContain("skill grant 'absent' not found");
      expect(line).toContain(src);
    } finally {
      iso!.cleanup();
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("MAJOR 2 — traversal / dot grant names are rejected before any path use", () => {
    // Self-contained layout: parent/{skills/ok, secrets}. A '../secrets' grant
    // resolved from parent/skills would reach parent/secrets — it must NOT.
    const parent = mkdtempSync(join(tmpdir(), "cortex-trav-"));
    const skillsSrc = join(parent, "skills");
    mkdirSync(join(skillsSrc, "ok"), { recursive: true });
    writeFileSync(join(skillsSrc, "ok", "SKILL.md"), "# ok");
    const secretsDir = join(parent, "secrets");
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, "SKILL.md"), "# top secret");

    const logged: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    });
    let iso: ReturnType<typeof createIsolatedSettings>;
    try {
      iso = createIsolatedSettings(
        "/fake/.claude",
        ["../secrets", "..", ".", "", "ok"],
        undefined,
        skillsSrc,
      );
    } finally {
      process.stderr.write = originalWrite;
    }
    try {
      // Session constructs; only the single valid grant materialised.
      const skillsDir = join(iso.pluginDir!, "skills");
      expect(existsSync(join(skillsDir, "ok"))).toBe(true);
      // No entry escaped skills/ — the traversal grant never reached 'secrets'.
      expect(existsSync(join(skillsDir, "secrets"))).toBe(false);
      // And the real out-of-tree secrets dir was never copied/removed.
      expect(existsSync(join(secretsDir, "SKILL.md"))).toBe(true);
      // Each invalid name was logged and skipped. The empty string is called
      // out explicitly: basename("") === "" passes the basename check, so only
      // the `grant.length === 0` sub-clause rejects it — without this assertion
      // deleting that sub-clause stays green while "" resolves to the skills
      // ROOT and cpSync merges the entire source into the plugin.
      const log = logged.join("");
      expect(log).toContain("skill grant '../secrets' invalid — skipped");
      expect(log).toContain("skill grant '..' invalid — skipped");
      expect(log).toContain("skill grant '.' invalid — skipped");
      expect(log).toContain("skill grant '' invalid — skipped");
    } finally {
      iso!.cleanup();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("MINOR — every grant invalid/missing → NO plugin dir, no --plugin-dir arg", () => {
    const src = makeSkillSource([]); // empty source: valid names, but nothing present
    const iso = createIsolatedSettings(
      "/fake/.claude",
      ["nope", "also-nope", ".."],
      undefined,
      src,
    );
    try {
      expect(iso.pluginDir).toBeUndefined();
      expect(iso.args).not.toContain("--plugin-dir");
      // The empty plugin dir was removed, not left on disk.
      expect(existsSync(join(iso.settingsPath, "..", "plugin"))).toBe(false);
    } finally {
      iso.cleanup();
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("sibling-relative reference between two granted skills resolves through the copies", () => {
    // gws-drive references ../gws-shared/SKILL.md — the canonical case (#990 §3).
    const src = makeSkillSource(["gws-drive", "gws-shared"], {
      "gws-drive": "See ../gws-shared/SKILL.md",
    });
    const iso = createIsolatedSettings(
      "/fake/.claude",
      ["gws-drive", "gws-shared"],
      undefined,
      src,
    );
    try {
      const skillsDir = join(iso.pluginDir!, "skills");
      // Both copies land in the same skills/ dir, so the sibling path resolves.
      const sibling = join(skillsDir, "gws-drive", "..", "gws-shared", "SKILL.md");
      expect(existsSync(sibling)).toBe(true);
    } finally {
      iso.cleanup();
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("cleanup removes the read-only plugin tree but NOT the copied-from sources", () => {
    const src = makeSkillSource(["keeper"]);
    const iso = createIsolatedSettings("/fake/.claude", ["keeper"], undefined, src);
    const pluginDir = iso.pluginDir!;
    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(pluginDir, "skills", "keeper"))).toBe(true);

    // cleanup must succeed even though the copies are read-only (0444/0555).
    expect(() => iso.cleanup()).not.toThrow();

    // The whole temp tree (settings + plugin + copies) is gone…
    expect(existsSync(pluginDir)).toBe(false);
    expect(existsSync(iso.settingsPath)).toBe(false);
    // …but the SOURCE skill (what we copied FROM) is untouched.
    expect(existsSync(join(src, "keeper", "SKILL.md"))).toBe(true);
    rmSync(src, { recursive: true, force: true });
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

  test("does NOT allowlist a substrate config-home var (set post-scope instead)", () => {
    // Isolation stays strict default-deny for CLAUDE_CONFIG_DIR; the config
    // home is exported explicitly AFTER scoping (config-home.ts / cc-session
    // configHomeEnv), never inherited through this allowlist.
    const scoped = scopeSessionEnv({ CLAUDE_CONFIG_DIR: "/Users/andreas/.claude-soma" });
    expect(scoped.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(CORTEX_PRESERVED_CLAUDE_ENV.has("CLAUDE_CONFIG_DIR")).toBe(false);
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
