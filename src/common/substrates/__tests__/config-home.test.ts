import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  SUBSTRATE_CONFIG_HOME_ENV,
  SubstratesSchema,
  resolveConfigHomeEnv,
} from "../config-home";

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
