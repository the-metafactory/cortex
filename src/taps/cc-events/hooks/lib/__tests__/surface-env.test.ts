import { test, expect, describe } from "bun:test";
import { resolveSurfaceEnv } from "../surface-env";

describe("resolveSurfaceEnv — G-2a/G-3a (cortex#774) CORTEX_* with GROVE_* read-fallback", () => {
  test("returns the canonical CORTEX_* value when set", () => {
    const env = { CORTEX_CHANNEL: "ivy" };
    expect(resolveSurfaceEnv("CHANNEL", env)).toBe("ivy");
  });

  test("canonical CORTEX_* name wins over the legacy GROVE_* name", () => {
    const env = { CORTEX_CHANNEL: "ivy", GROVE_CHANNEL: "legacy" };
    expect(resolveSurfaceEnv("CHANNEL", env)).toBe("ivy");
  });

  test("falls back to the legacy GROVE_* name when only GROVE_* is set", () => {
    const env = { GROVE_CHANNEL: "legacy" };
    expect(resolveSurfaceEnv("CHANNEL", env)).toBe("legacy");
  });

  test("returns undefined when neither tier is set", () => {
    expect(resolveSurfaceEnv("CHANNEL", {})).toBeUndefined();
  });

  test("resolves each instrumentation field from CORTEX_* first", () => {
    const env = {
      CORTEX_CHANNEL: "ivy",
      CORTEX_NETWORK: "metafactory",
      CORTEX_AGENT_NAME: "Ivy",
      CORTEX_AGENT_ID: "ivy-001",
      CORTEX_PROJECT: "cortex",
      CORTEX_ENTITY: "issue/774",
    };
    expect(resolveSurfaceEnv("CHANNEL", env)).toBe("ivy");
    expect(resolveSurfaceEnv("NETWORK", env)).toBe("metafactory");
    expect(resolveSurfaceEnv("AGENT_NAME", env)).toBe("Ivy");
    expect(resolveSurfaceEnv("AGENT_ID", env)).toBe("ivy-001");
    expect(resolveSurfaceEnv("PROJECT", env)).toBe("cortex");
    expect(resolveSurfaceEnv("ENTITY", env)).toBe("issue/774");
  });

  test("falls back per-field to GROVE_* when only GROVE_* is set", () => {
    const env = {
      GROVE_CHANNEL: "ivy",
      GROVE_NETWORK: "metafactory",
      GROVE_AGENT_NAME: "Ivy",
      GROVE_AGENT_ID: "ivy-001",
      GROVE_PROJECT: "cortex",
      GROVE_ENTITY: "issue/774",
    };
    expect(resolveSurfaceEnv("CHANNEL", env)).toBe("ivy");
    expect(resolveSurfaceEnv("NETWORK", env)).toBe("metafactory");
    expect(resolveSurfaceEnv("AGENT_NAME", env)).toBe("Ivy");
    expect(resolveSurfaceEnv("AGENT_ID", env)).toBe("ivy-001");
    expect(resolveSurfaceEnv("PROJECT", env)).toBe("cortex");
    expect(resolveSurfaceEnv("ENTITY", env)).toBe("issue/774");
  });

  test("preserves an explicit empty string from CORTEX_* (defined wins)", () => {
    const env = { CORTEX_CHANNEL: "", GROVE_CHANNEL: "legacy" };
    expect(resolveSurfaceEnv("CHANNEL", env)).toBe("");
  });
});
