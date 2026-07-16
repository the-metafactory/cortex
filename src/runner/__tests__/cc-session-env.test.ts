import { describe, test, expect, afterEach } from "bun:test";
import { buildSessionEnv } from "../cc-session";
import { scopeSessionEnv } from "../session-settings";
import { setActiveSubstrates } from "../../common/substrates/config-home";

describe("buildSessionEnv — G-2a/G-3a (cortex#774) sets CORTEX_* instrumentation names", () => {
  const baseEnv = { PATH: "/usr/bin" } as Record<string, string>;

  test("sets the CORTEX_* names from the session opts", () => {
    const env = buildSessionEnv(baseEnv, {
      channel: "ivy",
      network: "metafactory",
      agentName: "Ivy",
      agentId: "ivy-001",
      project: "cortex",
      entity: "issue/774",
      principal: "andreas",
    });

    expect(env.CORTEX_CHANNEL).toBe("ivy");
    expect(env.CORTEX_NETWORK).toBe("metafactory");
    expect(env.CORTEX_AGENT_NAME).toBe("Ivy");
    expect(env.CORTEX_AGENT_ID).toBe("ivy-001");
    expect(env.CORTEX_PROJECT).toBe("cortex");
    expect(env.CORTEX_ENTITY).toBe("issue/774");
    expect(env.CORTEX_PRINCIPAL).toBe("andreas");
  });

  test("does NOT set the legacy GROVE_* instrumentation names", () => {
    const env = buildSessionEnv(baseEnv, {
      channel: "ivy",
      network: "metafactory",
      agentName: "Ivy",
      agentId: "ivy-001",
      project: "cortex",
      entity: "issue/774",
      principal: "andreas",
    });

    expect(env.GROVE_CHANNEL).toBeUndefined();
    expect(env.GROVE_NETWORK).toBeUndefined();
    expect(env.GROVE_AGENT_NAME).toBeUndefined();
    expect(env.GROVE_AGENT_ID).toBeUndefined();
    expect(env.GROVE_PROJECT).toBeUndefined();
    expect(env.GROVE_ENTITY).toBeUndefined();
    expect(env.GROVE_OPERATOR).toBeUndefined();
  });

  test("omits unset optional fields", () => {
    const env = buildSessionEnv(baseEnv, {
      channel: "ivy",
    });
    expect(env.CORTEX_CHANNEL).toBe("ivy");
    expect(env.CORTEX_NETWORK).toBeUndefined();
    expect(env.CORTEX_AGENT_NAME).toBeUndefined();
    expect(env.CORTEX_PRINCIPAL).toBeUndefined();
  });

  test("preserves the inherited base env", () => {
    const env = buildSessionEnv(baseEnv, { channel: "ivy" });
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("buildSessionEnv — substrate config-home (CLAUDE_CONFIG_DIR)", () => {
  const baseEnv = { PATH: "/usr/bin" } as Record<string, string>;
  afterEach(() => setActiveSubstrates(undefined));

  test("exports the explicit opts.configHomeEnv override", () => {
    const env = buildSessionEnv(baseEnv, {
      configHomeEnv: { name: "CLAUDE_CONFIG_DIR", value: "/explicit/home" },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/explicit/home");
  });

  test("falls back to the process-wide substrates published at daemon boot", () => {
    setActiveSubstrates({ "claude-code": { configHome: "/Users/x/.claude-soma" } });
    const env = buildSessionEnv(baseEnv, { channel: "ivy" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/x/.claude-soma");
  });

  test("an explicit opts override beats the process-wide value", () => {
    setActiveSubstrates({ "claude-code": { configHome: "/boot/home" } });
    const env = buildSessionEnv(baseEnv, {
      configHomeEnv: { name: "CLAUDE_CONFIG_DIR", value: "/explicit/home" },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/explicit/home");
  });

  test("sets nothing when no config home is declared (vendor default)", () => {
    setActiveSubstrates(undefined);
    const env = buildSessionEnv(baseEnv, { channel: "ivy" });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  // The thesis of the whole mechanism, in one test: isolation strips the
  // principal's ambient CLAUDE_CONFIG_DIR, and the DECLARED home is re-applied
  // on top — so an isolated session lands on the configured home, never the
  // principal's ambient one and never the silently-expiring vendor default.
  test("survives isolation: the scoped-away principal value is replaced by the declared home", () => {
    setActiveSubstrates({ "claude-code": { configHome: "/Users/x/.claude-soma" } });
    const scoped = scopeSessionEnv({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/principal/.claude",
    });
    expect(scoped.CLAUDE_CONFIG_DIR).toBeUndefined(); // stripped by cortex#701
    const env = buildSessionEnv(scoped, { channel: "ivy" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/x/.claude-soma");
  });
});
