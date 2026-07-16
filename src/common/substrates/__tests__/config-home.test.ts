import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  SUBSTRATE_CONFIG_HOME_ENV,
  SUBSTRATE_IDS,
  SubstratesSchema,
  resolveConfigHomeEnv,
  setActiveSubstrates,
  activeConfigHomeEnv,
  configHomeSpawnEnv,
} from "../config-home";
import { AgentRuntimeSchema } from "../../types/cortex-config";

describe("SUBSTRATE_CONFIG_HOME_ENV — translation table", () => {
  test("maps known substrates to their config-home env var", () => {
    expect(SUBSTRATE_CONFIG_HOME_ENV["claude-code"]).toBe("CLAUDE_CONFIG_DIR");
    expect(SUBSTRATE_CONFIG_HOME_ENV.codex).toBe("CODEX_HOME");
  });

  test("has no entry for substrates without a config-home var", () => {
    expect(SUBSTRATE_CONFIG_HOME_ENV["pi-dev"]).toBeUndefined();
  });
});

describe("SubstratesSchema — validation", () => {
  test("accepts a per-substrate configHome map", () => {
    const parsed = SubstratesSchema.parse({
      "claude-code": { configHome: "/Users/x/.claude-soma" },
      codex: { configHome: "/Users/x/.codex" },
    });
    expect(parsed["claude-code"]?.configHome).toBe("/Users/x/.claude-soma");
  });

  test("rejects an unknown key inside a substrate block (strict)", () => {
    expect(() =>
      SubstratesSchema.parse({ "claude-code": { configHome: "/x", bogus: 1 } }),
    ).toThrow();
  });

  test("accepts an empty substrate block (no configHome)", () => {
    expect(() => SubstratesSchema.parse({ "claude-code": {} })).not.toThrow();
  });
});

describe("resolveConfigHomeEnv", () => {
  const savedHome = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = "/Users/tester";
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  test("resolves claude-code to CLAUDE_CONFIG_DIR + absolute value", () => {
    const got = resolveConfigHomeEnv("claude-code", {
      "claude-code": { configHome: "/Users/x/.claude-soma" },
    });
    expect(got).toEqual({ name: "CLAUDE_CONFIG_DIR", value: "/Users/x/.claude-soma" });
  });

  test("resolves codex to CODEX_HOME", () => {
    const got = resolveConfigHomeEnv("codex", { codex: { configHome: "/Users/x/.codex" } });
    expect(got).toEqual({ name: "CODEX_HOME", value: "/Users/x/.codex" });
  });

  test("expands a leading ~/", () => {
    const got = resolveConfigHomeEnv("claude-code", {
      "claude-code": { configHome: "~/.claude-soma" },
    });
    expect(got?.value).toBe("/Users/tester/.claude-soma");
  });

  test("expands ${HOME}", () => {
    const got = resolveConfigHomeEnv("claude-code", {
      "claude-code": { configHome: "${HOME}/.claude-soma" },
    });
    expect(got?.value).toBe("/Users/tester/.claude-soma");
  });

  test("returns undefined when the substrate has no declared configHome", () => {
    expect(resolveConfigHomeEnv("claude-code", { codex: { configHome: "/x" } })).toBeUndefined();
    expect(resolveConfigHomeEnv("claude-code", {})).toBeUndefined();
    expect(resolveConfigHomeEnv("claude-code", undefined)).toBeUndefined();
  });

  test("returns undefined for a substrate with no config-home env var", () => {
    // pi-dev has a configHome declared but no known env var → nothing to set.
    expect(
      resolveConfigHomeEnv("pi-dev", { "pi-dev": { configHome: "/x" } }),
    ).toBeUndefined();
  });
});

describe("SUBSTRATE_IDS ↔ AgentRuntimeSchema.substrate (drift guard)", () => {
  test("the local id tuple matches the config substrate enum exactly", () => {
    // config-home.ts keeps a local copy (leaf module, no schema-import cycle);
    // this fails CI if the two ever drift — e.g. a substrate added to the schema
    // but not here (which would silently reject a valid `substrates:` key).
    const enumOptions = AgentRuntimeSchema.shape.substrate.unwrap().options;
    expect([...SUBSTRATE_IDS].sort()).toEqual([...enumOptions].sort());
  });
});

describe("active substrates chokepoint (setActiveSubstrates / activeConfigHomeEnv)", () => {
  afterEach(() => setActiveSubstrates(undefined));

  test("activeConfigHomeEnv reads the process-wide substrates set at boot", () => {
    setActiveSubstrates({ "claude-code": { configHome: "/Users/x/.claude-soma" } });
    expect(activeConfigHomeEnv("claude-code")).toEqual({
      name: "CLAUDE_CONFIG_DIR",
      value: "/Users/x/.claude-soma",
    });
  });

  test("returns undefined when nothing is set", () => {
    setActiveSubstrates(undefined);
    expect(activeConfigHomeEnv("claude-code")).toBeUndefined();
  });

  test("returns undefined for a substrate absent from the active set", () => {
    setActiveSubstrates({ codex: { configHome: "/x" } });
    expect(activeConfigHomeEnv("claude-code")).toBeUndefined();
  });
});

// These guard the two spawn wrappers (mc endpoint-resolver, sage-runner) whose
// own bodies are injection-seam defaults tests never execute — the logic lives
// here precisely so it CAN be asserted.
describe("configHomeSpawnEnv — spawn env for a substrate's binary", () => {
  afterEach(() => setActiveSubstrates(undefined));

  test("returns undefined when no config home is declared (caller omits env → inherit)", () => {
    setActiveSubstrates(undefined);
    expect(configHomeSpawnEnv("claude-code", { PATH: "/usr/bin" })).toBeUndefined();
  });

  test("layers the config home on top of the base env, preserving it", () => {
    setActiveSubstrates({ "claude-code": { configHome: "/Users/x/.claude-soma" } });
    const env = configHomeSpawnEnv("claude-code", { PATH: "/usr/bin", GITHUB_TOKEN: "t" });
    expect(env?.CLAUDE_CONFIG_DIR).toBe("/Users/x/.claude-soma");
    // sage relies on inherited gh auth — the base env must survive.
    expect(env?.PATH).toBe("/usr/bin");
    expect(env?.GITHUB_TOKEN).toBe("t");
  });

  test("drops undefined base-env values rather than stringifying them", () => {
    setActiveSubstrates({ "claude-code": { configHome: "/home" } });
    const env = configHomeSpawnEnv("claude-code", { PATH: "/usr/bin", NOPE: undefined });
    expect("NOPE" in (env ?? {})).toBe(false);
  });

  // The codex regression: a site that hardcodes "claude-code" leaves a codex
  // deployment on its vendor default — the exact bug class this module exists
  // to kill. Resolution must follow the substrate actually being run.
  test("resolves per-substrate: codex gets CODEX_HOME, not CLAUDE_CONFIG_DIR", () => {
    setActiveSubstrates({
      "claude-code": { configHome: "/claude/home" },
      codex: { configHome: "/codex/home" },
    });
    const env = configHomeSpawnEnv("codex", { PATH: "/usr/bin" });
    expect(env?.CODEX_HOME).toBe("/codex/home");
    expect(env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("returns undefined for a substrate with no config-home env var (pi-dev)", () => {
    setActiveSubstrates({ "pi-dev": { configHome: "/x" } });
    expect(configHomeSpawnEnv("pi-dev", { PATH: "/usr/bin" })).toBeUndefined();
  });
});

describe("expandHome edge cases (via resolveConfigHomeEnv)", () => {
  const savedHome = process.env.HOME;
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  test("leaves an absolute path unchanged", () => {
    process.env.HOME = "/Users/tester";
    expect(
      resolveConfigHomeEnv("claude-code", { "claude-code": { configHome: "/abs/.claude" } })?.value,
    ).toBe("/abs/.claude");
  });

  test("does NOT expand $HOMEDIR (word boundary)", () => {
    process.env.HOME = "/Users/tester";
    expect(
      resolveConfigHomeEnv("claude-code", { "claude-code": { configHome: "$HOMEDIR/x" } })?.value,
    ).toBe("$HOMEDIR/x");
  });

  test("returns the tilde path unchanged when HOME is empty (no root-relative rewrite)", () => {
    process.env.HOME = "";
    expect(
      resolveConfigHomeEnv("claude-code", { "claude-code": { configHome: "~/.claude-soma" } })?.value,
    ).toBe("~/.claude-soma");
  });
});
