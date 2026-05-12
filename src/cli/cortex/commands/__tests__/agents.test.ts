// F-3 — cortex agents reload/list CLI tests.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  parseAgentsArgs,
  runAgentsReload,
  runAgentsList,
  dispatchAgents,
  AgentsArgsError,
} from "../agents";

const FIXTURES = join(import.meta.dir, "fixtures");
const VALID_DIR = join(FIXTURES, "agents.d-valid");
const BROKEN_DIR = join(FIXTURES, "agents.d-broken");
const PERSONA_PATH = join(FIXTURES, "personas", "echo.md");

// =============================================================================
// parseAgentsArgs
// =============================================================================

describe("parseAgentsArgs", () => {
  test("parses 'reload' subcommand", () => {
    const args = parseAgentsArgs(["reload"]);
    expect(args.subcommand).toBe("reload");
    expect(args.help).toBe(false);
  });

  test("parses 'list' subcommand", () => {
    const args = parseAgentsArgs(["list"]);
    expect(args.subcommand).toBe("list");
  });

  test("--help yields subcommand=help", () => {
    expect(parseAgentsArgs(["--help"]).subcommand).toBe("help");
    expect(parseAgentsArgs(["-h"]).subcommand).toBe("help");
  });

  test("unknown subcommand marked as 'unknown'", () => {
    expect(parseAgentsArgs(["status"]).subcommand).toBe("unknown");
  });

  test("no args → unknown (caller decides what to do)", () => {
    expect(parseAgentsArgs([]).subcommand).toBe("unknown");
  });

  test("parses --config flag", () => {
    const args = parseAgentsArgs(["reload", "--config", "/tmp/foo.yaml"]);
    expect(args.config).toBe("/tmp/foo.yaml");
  });

  test("parses --fragment flag", () => {
    const args = parseAgentsArgs(["reload", "--fragment", "/tmp/foo.yaml"]);
    expect(args.fragment).toBe("/tmp/foo.yaml");
  });

  test("parses --json flag", () => {
    expect(parseAgentsArgs(["list", "--json"]).json).toBe(true);
    expect(parseAgentsArgs(["list"]).json).toBe(false);
  });

  test("--help inside subcommand sets help and preserves subcommand", () => {
    const args = parseAgentsArgs(["reload", "--help"]);
    expect(args.subcommand).toBe("reload");
    expect(args.help).toBe(true);
  });

  test("multiple flags in any order", () => {
    const args = parseAgentsArgs([
      "reload",
      "--json",
      "--config",
      "/tmp/c.yaml",
      "--fragment",
      "/tmp/f.yaml",
    ]);
    expect(args.subcommand).toBe("reload");
    expect(args.json).toBe(true);
    expect(args.config).toBe("/tmp/c.yaml");
    expect(args.fragment).toBe("/tmp/f.yaml");
  });

  // Echo M1 on cortex#63 — parser now throws on bad-flag cases (matches
  // migrate-config convention).
  describe("AgentsArgsError on usage failures", () => {
    test("throws when --config is missing its value", () => {
      expect(() => parseAgentsArgs(["reload", "--config"])).toThrow(AgentsArgsError);
    });

    test("throws when --config is followed by another flag", () => {
      expect(() => parseAgentsArgs(["reload", "--config", "--json"])).toThrow(AgentsArgsError);
    });

    test("throws when --fragment is missing its value", () => {
      expect(() => parseAgentsArgs(["reload", "--fragment"])).toThrow(AgentsArgsError);
    });

    test("throws on unknown flag", () => {
      expect(() => parseAgentsArgs(["reload", "--verbose"])).toThrow(AgentsArgsError);
    });

    test("throws on extra positional argument", () => {
      expect(() => parseAgentsArgs(["reload", "extra-arg"])).toThrow(AgentsArgsError);
    });
  });
});

// =============================================================================
// runAgentsReload
// =============================================================================

describe("runAgentsReload", () => {
  test("exit 0 on valid agents.d/ via --config", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-cfg-"));
    seedConfigDir(cfg, VALID_DIR);
    const r = runAgentsReload(parseAgentsArgs(["reload", "--config", join(cfg, "cortex.yaml")]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo");
    expect(r.stdout).toMatch(/1 fragment.*OK/);
  });

  test("exit 1 on broken fragment, error in stderr names the file", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-cfg-broken-"));
    seedConfigDir(cfg, BROKEN_DIR);
    const r = runAgentsReload(parseAgentsArgs(["reload", "--config", join(cfg, "cortex.yaml")]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("broken.yaml");
  });

  test("exit 2 when config path's directory does not exist", () => {
    const r = runAgentsReload(
      parseAgentsArgs([
        "reload",
        "--config",
        "/tmp/nonexistent-path-xyz/cortex.yaml",
      ]),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/config directory.*does not exist/);
  });

  test("--json on success emits parseable JSON", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-cfg-json-"));
    seedConfigDir(cfg, VALID_DIR);
    const r = runAgentsReload(
      parseAgentsArgs(["reload", "--config", join(cfg, "cortex.yaml"), "--json"]),
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.agents).toBeInstanceOf(Array);
    expect(parsed.agents.length).toBeGreaterThan(0);
    expect(parsed.agents[0].id).toBe("echo");
  });

  test("--json on failure emits envelope with agents:[] + error (M4 round-1)", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-cfg-json-err-"));
    seedConfigDir(cfg, BROKEN_DIR);
    const r = runAgentsReload(
      parseAgentsArgs(["reload", "--config", join(cfg, "cortex.yaml"), "--json"]),
    );
    expect(r.exitCode).toBe(1);
    // JSON goes to stdout even on failure so scripts can parse it.
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("error");
    // Echo M4 round 1: `agents` MUST be present (empty array) so consumers
    // can iterate without status-checking.
    expect(parsed.agents).toEqual([]);
    expect(parsed.error.file).toContain("broken.yaml");
    expect(parsed.error.reason).toBeTruthy();
  });

  test("--fragment <dir> exits 2 with usage error, not 1 (Echo round-1 nit)", () => {
    const dir = mkdtempSync(join(tmpdir(), "f3-frag-dir-"));
    const r = runAgentsReload(parseAgentsArgs(["reload", "--fragment", dir]));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/expects a file, got a directory/);
  });

  test("--fragment validates a single file", () => {
    const validFragment = join(VALID_DIR, "echo.yaml");
    const r = runAgentsReload(parseAgentsArgs(["reload", "--fragment", validFragment]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo");
  });

  test("--fragment exit 1 when file is malformed", () => {
    const brokenFragment = join(BROKEN_DIR, "broken.yaml");
    const r = runAgentsReload(parseAgentsArgs(["reload", "--fragment", brokenFragment]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("broken.yaml");
  });

  test("--fragment exit 2 when file does not exist", () => {
    const r = runAgentsReload(
      parseAgentsArgs(["reload", "--fragment", "/tmp/nonexistent-fragment.yaml"]),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/fragment file.*does not exist/);
  });

  test("--fragment with `~`-prefixed persona path resolves via $HOME (Echo B1)", () => {
    // Persona file under $HOME — fragment refers to it as `~/path/file.md`.
    const home = process.env.HOME;
    if (!home) return; // skip if HOME unset (CI rarity)
    const personaHomeRel = `f3-b1-persona-${Date.now()}`;
    const personaAbs = join(home, personaHomeRel, "echo.md");
    mkdirSync(join(home, personaHomeRel), { recursive: true });
    writeFileSync(personaAbs, `---\ndisplayName: Echo\n---\n`);

    const fragmentDir = mkdtempSync(join(tmpdir(), "f3-b1-frag-"));
    writeFileSync(
      join(fragmentDir, "echo.yaml"),
      `id: echo
displayName: Echo
persona: "~/${personaHomeRel}/echo.md"
roles: [agent-restricted]
presence:
  discord:
    enabled: false
    token: "t"
    guildId: "0"
    agentChannelId: "1"
    logChannelId: "2"
`,
    );

    const r = runAgentsReload(
      parseAgentsArgs(["reload", "--fragment", join(fragmentDir, "echo.yaml")]),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo");
  });

  test("--fragment routes a schema-validation failure (not just YAML-parse) — m3 nit", () => {
    // Echo m3 — fixture that parses as YAML but fails AgentSchema.
    const dir = mkdtempSync(join(tmpdir(), "f3-schema-fail-"));
    writeFileSync(
      join(dir, "broken.yaml"),
      // Missing displayName (required) — parses fine, fails schema.
      `id: broken
roles: [agent-restricted]
persona: ./missing.md
presence:
  discord:
    enabled: false
    token: t
    guildId: "0"
    agentChannelId: "1"
    logChannelId: "2"
`,
    );
    const r = runAgentsReload(
      parseAgentsArgs(["reload", "--fragment", join(dir, "broken.yaml")]),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("schema validation failed");
    expect(r.stderr).toMatch(/displayName/i);
  });

  test("success text includes the validation-only caveat (Echo M3)", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-validation-note-"));
    seedConfigDir(cfg, VALID_DIR);
    const r = runAgentsReload(
      parseAgentsArgs(["reload", "--config", join(cfg, "cortex.yaml")]),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("validation-only");
  });

  test("--fragment 1 MiB cap applies (Echo M2 hardening parity)", () => {
    const dir = mkdtempSync(join(tmpdir(), "f3-frag-toobig-"));
    const padding = "#" + " padding ".repeat(140_000);
    writeFileSync(join(dir, "huge.yaml"), `id: huge\n${padding}\n`);
    const r = runAgentsReload(
      parseAgentsArgs(["reload", "--fragment", join(dir, "huge.yaml")]),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("exceeds");
  });
});

// =============================================================================
// runAgentsList
// =============================================================================

describe("runAgentsList", () => {
  test("lists agents in alphabetical order", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-list-"));
    seedConfigDir(cfg, VALID_DIR);
    const r = runAgentsList(parseAgentsArgs(["list", "--config", join(cfg, "cortex.yaml")]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo");
    expect(r.stdout).toContain("claude-code");
    expect(r.stdout).toContain("in-process");
  });

  test("empty agents.d/ → exit 0, empty agent list", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-empty-"));
    writeFileSync(join(cfg, "cortex.yaml"), "agents: []\n");
    mkdirSync(join(cfg, "agents.d"));
    const r = runAgentsList(parseAgentsArgs(["list", "--config", join(cfg, "cortex.yaml")]));
    expect(r.exitCode).toBe(0);
    // Should be no error and either empty or just headers
    expect(r.stderr).toBe("");
  });

  test("--json emits unified envelope with agents sorted by id (Echo M4)", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-list-json-"));
    seedConfigDir(cfg, VALID_DIR);
    const r = runAgentsList(
      parseAgentsArgs(["list", "--config", join(cfg, "cortex.yaml"), "--json"]),
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("ok");
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(parsed.agents[0].id).toBe("echo");
    expect(parsed.agents[0]).toHaveProperty("substrate");
    expect(parsed.agents[0]).toHaveProperty("mode");
    expect(parsed.agents[0]).toHaveProperty("capabilities");
  });

  test("empty agents.d/ prints message (Echo m2 consistency)", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-list-empty-message-"));
    writeFileSync(join(cfg, "cortex.yaml"), "agents: []\n");
    mkdirSync(join(cfg, "agents.d"));
    const r = runAgentsList(parseAgentsArgs(["list", "--config", join(cfg, "cortex.yaml")]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("0 agents");
  });
});

// =============================================================================
// dispatchAgents
// =============================================================================

describe("dispatchAgents", () => {
  test("routes 'reload' to runAgentsReload", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-dispatch-reload-"));
    seedConfigDir(cfg, VALID_DIR);
    const r = dispatchAgents(["reload", "--config", join(cfg, "cortex.yaml")]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo");
  });

  test("routes 'list' to runAgentsList", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-dispatch-list-"));
    seedConfigDir(cfg, VALID_DIR);
    const r = dispatchAgents(["list", "--config", join(cfg, "cortex.yaml")]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo");
  });

  test("--help prints help and exits 0", () => {
    const r = dispatchAgents(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("cortex agents");
    expect(r.stdout).toContain("reload");
    expect(r.stdout).toContain("list");
  });

  test("unknown subcommand prints help and exits 2", () => {
    const r = dispatchAgents(["status"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown");
    expect(r.stderr).toContain("status");
  });

  test("no subcommand prints help and exits 2", () => {
    const r = dispatchAgents([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("usage");
  });

  test("subcommand --help routes through dispatcher", () => {
    const r = dispatchAgents(["reload", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("reload");
  });
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Seed a config dir at `cfg` whose `agents.d/` mirrors `srcAgentsDir`. The
 * `cortex.yaml` is a minimal placeholder; runAgentsReload looks for
 * `<cfgDir>/agents.d/` derived from the config path.
 */
function seedConfigDir(cfg: string, srcAgentsDir: string): void {
  writeFileSync(join(cfg, "cortex.yaml"), "agents: []\n");
  const agentsD = join(cfg, "agents.d");
  mkdirSync(agentsD, { recursive: true });
  const personasD = join(cfg, "personas");
  mkdirSync(personasD, { recursive: true });
  // Copy the fixture's persona.
  copyFileSync(PERSONA_PATH, join(personasD, "echo.md"));
  // Copy the fixture's fragments — but rewrite the persona path so it
  // resolves correctly against the new agents.d/ directory.
  const fs = require("fs") as typeof import("fs");
  for (const filename of fs.readdirSync(srcAgentsDir)) {
    if (!filename.endsWith(".yaml")) continue;
    const content = fs.readFileSync(join(srcAgentsDir, filename), "utf-8");
    fs.writeFileSync(join(agentsD, filename), content);
  }
}
