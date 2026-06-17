// F-3 — cortex agents reload/list CLI tests.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, type ChildProcess } from "child_process";

import {
  parseAgentsArgs,
  runAgentsReload,
  runAgentsList,
  dispatchAgents,
  AgentsArgsError,
} from "../agents";
import { pidFileFor } from "../../../../common/pidfile";

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
    expect(parsed.items).toBeInstanceOf(Array);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items[0].id).toBe("echo");
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
    expect(parsed.items).toEqual([]);
    expect(parsed.error.context.file).toContain("broken.yaml");
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
    const personaHomeAbs = join(home, personaHomeRel);
    const personaAbs = join(personaHomeAbs, "echo.md");
    mkdirSync(personaHomeAbs, { recursive: true });
    try {
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
    } finally {
      rmSync(personaHomeAbs, { recursive: true, force: true });
    }
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

  test("B-0: --validate-only keeps the validation-only caveat (no daemon signal)", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-validation-note-"));
    seedConfigDir(cfg, VALID_DIR);
    const r = runAgentsReload(
      parseAgentsArgs([
        "reload",
        "--validate-only",
        "--config",
        join(cfg, "cortex.yaml"),
      ]),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("validation-only");
    // No signal language on the validate-only path.
    expect(r.stdout).not.toContain("reload signal delivered");
  });

  test("B-0: default reload reports no signal sent when no runtime is running", () => {
    const cfg = mkdtempSync(join(tmpdir(), "f3-no-runtime-"));
    seedConfigDir(cfg, VALID_DIR);
    const r = runAgentsReload(
      parseAgentsArgs(["reload", "--config", join(cfg, "cortex.yaml")]),
    );
    // Validation passed; with no PID file there's no runtime to signal — benign,
    // so the command still exits 0 (validation is the failure surface).
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no reload signal sent");
    expect(r.stdout).toContain("no running cortex runtime");
  });

  // Sage cortex#1027 — honesty: a delivered SIGHUP is reported as "signal
  // delivered", NOT "reload applied". Drive a real signalable PID (this test
  // process) through a config whose PID file we write ourselves.
  test("Sage cortex#1027: delivered signal is reported as 'signal delivered', not 'reload applied'", () => {
    const target = spawnSignalTarget();
    const { configPath, restore } = seedConfigWithPidFile(target.pid);
    try {
      const r = runAgentsReload(
        parseAgentsArgs(["reload", "--config", configPath]),
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("reload signal delivered");
      // Honest scope: never claims the async reload finished.
      expect(r.stdout).not.toMatch(/reload live|reload applied/);
      // Tells the principal where to confirm.
      expect(r.stdout).toContain("runtime logs");
    } finally {
      target.kill();
      restore();
    }
  });

  test("round-2: partial-numeric PID file is malformed — never signals PID prefix", () => {
    // parseInt("123abc") === 123 would SIGHUP an unintended process; the
    // full-string check must classify the file as malformed instead.
    const { configPath, restore } = seedConfigWithPidFile(1);
    try {
      writeFileSync(pidFileFor(configPath), "123abc\n");
      const r = runAgentsReload(
        parseAgentsArgs(["reload", "--config", configPath]),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("malformed");
    } finally {
      restore();
    }
  });

  test("Sage cortex#1027: a FAILED signal (stale PID) exits non-zero and reports the failure", () => {
    // A PID that is (almost certainly) not a live process → process.kill throws
    // ESRCH → attempted-but-failed → non-zero exit.
    const { configPath, restore } = seedConfigWithPidFile(2_147_483_646);
    try {
      const r = runAgentsReload(
        parseAgentsArgs(["reload", "--config", configPath]),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("reload signal FAILED");
    } finally {
      restore();
    }
  });

  test("Sage cortex#1027: --json carries a FAILED signal as an error + non-zero exit", () => {
    const { configPath, restore } = seedConfigWithPidFile(2_147_483_646);
    try {
      const r = runAgentsReload(
        parseAgentsArgs(["reload", "--config", configPath, "--json"]),
      );
      expect(r.exitCode).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.status).toBe("error");
      expect(parsed.error.reason).toContain("reload signal failed");
      // Validation itself passed — the error context records that distinction.
      expect(parsed.error.context.validation).toBe("ok");
    } finally {
      restore();
    }
  });

  test("Sage cortex#1027: --json on a delivered signal records signalled=true in data (success)", () => {
    const target = spawnSignalTarget();
    const { configPath, restore } = seedConfigWithPidFile(target.pid);
    try {
      const r = runAgentsReload(
        parseAgentsArgs(["reload", "--config", configPath, "--json"]),
      );
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.status).toBe("ok");
      expect(parsed.data.signalled).toBe("true");
      expect(parsed.data.pid).toBe(String(target.pid));
    } finally {
      target.kill();
      restore();
    }
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
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items[0].id).toBe("echo");
    expect(parsed.items[0]).toHaveProperty("substrate");
    expect(parsed.items[0]).toHaveProperty("mode");
    expect(parsed.items[0]).toHaveProperty("capabilities");
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
  for (const filename of readdirSync(srcAgentsDir)) {
    if (!filename.endsWith(".yaml")) continue;
    const content = readFileSync(join(srcAgentsDir, filename), "utf-8");
    writeFileSync(join(agentsD, filename), content);
  }
}

/**
 * Sage cortex#1027 — seed a valid config dir AND write a PID file (containing
 * `pid`) at the exact location `signalDaemonReload` resolves it to, so a `reload`
 * actually attempts `process.kill(pid, SIGHUP)`. Each test gets a UNIQUE config
 * basename (so its PID file path is unique) and `restore()` removes the PID file.
 *
 * The config basename must be unique per test because `pidFileFor` keys on the
 * (canonicalized) config basename — two tests sharing a basename would collide on
 * the same PID file under `~/.config/grove/state/`.
 */
/**
 * Spawn a harmless long-lived child (`sleep 300`) and return its PID + a killer.
 * Used as a REAL, signalable target so the "delivered signal" path runs
 * `process.kill(childPid, SIGHUP)` against a live process that is NOT the test
 * runner (signalling `process.pid` would SIGHUP-kill the test process itself).
 * The child's default SIGHUP action terminates it — fine; `process.kill` still
 * returns success because the process existed at signal time.
 */
function spawnSignalTarget(): { pid: number; kill: () => void } {
  const child: ChildProcess = spawn("sleep", ["300"], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("failed to spawn signal target");
  return {
    pid,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone (e.g. our SIGHUP terminated it) — nothing to clean up.
      }
    },
  };
}

let pidConfigCounter = 0;
function seedConfigWithPidFile(pid: number): {
  cfg: string;
  configPath: string;
  restore: () => void;
} {
  const cfg = mkdtempSync(join(tmpdir(), "f3-pid-"));
  // UNIQUE config basename per call — `pidFileFor` keys on the (canonicalized)
  // basename, so a shared name would collide on one PID file across tests AND
  // could clash with a real daemon's `cortex-cortex.pid`. The agents.d/ dir is
  // resolved from the config DIRECTORY, so the filename is free to vary.
  const base = `cortex-pidtest-${process.pid}-${pidConfigCounter++}`;
  const configPath = join(cfg, `${base}.yaml`);
  // seedConfigDir writes its own cortex.yaml placeholder + agents.d/; we only
  // need the agents.d/ tree (resolved from the config dir), so reuse it then
  // point --config at our uniquely-named file (same dir).
  seedConfigDir(cfg, VALID_DIR);
  writeFileSync(configPath, "agents: []\n");
  const pidFile = pidFileFor(configPath);
  mkdirSync(join(pidFile, ".."), { recursive: true });
  writeFileSync(pidFile, String(pid));
  return {
    cfg,
    configPath,
    restore: () => {
      if (existsSync(pidFile)) unlinkSync(pidFile);
      rmSync(cfg, { recursive: true, force: true });
    },
  };
}

// sage round 3 — tilde spelling converges for on-disk configs
describe("round-3: pidFileFor tilde expansion", () => {
  test("~ and absolute spellings of the same existing config derive one PID file", () => {
    const home = process.env.HOME!;
    const dir = mkdtempSync(join(home, ".pidfile-tilde-test-"));
    try {
      const abs = join(dir, "stack.yaml");
      writeFileSync(abs, "x: 1\n");
      const viaTilde = `~/${abs.slice(home.length + 1)}`;
      expect(pidFileFor(viaTilde)).toBe(pidFileFor(abs));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
