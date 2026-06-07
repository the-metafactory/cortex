import { describe, test, expect } from "bun:test";
import { buildSessionEnv } from "../cc-session";

describe("buildSessionEnv — G-2a/G-3a (cortex#774) sets CORTEX_* instrumentation names", () => {
  const baseEnv = { PATH: "/usr/bin" } as Record<string, string>;

  test("sets the CORTEX_* names from the session opts", () => {
    const env = buildSessionEnv(baseEnv, {
      groveChannel: "ivy",
      groveNetwork: "metafactory",
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
      groveChannel: "ivy",
      groveNetwork: "metafactory",
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
      groveChannel: "ivy",
    });
    expect(env.CORTEX_CHANNEL).toBe("ivy");
    expect(env.CORTEX_NETWORK).toBeUndefined();
    expect(env.CORTEX_AGENT_NAME).toBeUndefined();
    expect(env.CORTEX_PRINCIPAL).toBeUndefined();
  });

  test("preserves the inherited base env", () => {
    const env = buildSessionEnv(baseEnv, { groveChannel: "ivy" });
    expect(env.PATH).toBe("/usr/bin");
  });
});
