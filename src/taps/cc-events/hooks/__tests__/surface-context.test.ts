import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const HOOK_PATH = join(import.meta.dir, "..", "SurfaceContext.hook.ts");

/** Helper: run the hook with SessionStart JSON on stdin */
function runHook(env: Record<string, string>, prompt = "Hello") {
  const input = JSON.stringify({
    hook_event_name: "SessionStart",
    prompt,
  });
  return spawnSync("bun", [HOOK_PATH], {
    encoding: "utf-8",
    input,
    env: { ...process.env, ...env },
  });
}

describe("SurfaceContext.hook", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GROVE_CHANNEL;
    delete process.env.GROVE_AGENT_NAME;
    delete process.env.GROVE_AGENT_ID;
    delete process.env.GROVE_NETWORK;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("should exit silently when GROVE_CHANNEL is not set", () => {
    const result = spawnSync("bun", [HOOK_PATH], {
      encoding: "utf-8",
      env: { ...process.env },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("should pass through non-SessionStart events unchanged", () => {
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      prompt: "Hello",
    });
    const result = spawnSync("bun", [HOOK_PATH], {
      encoding: "utf-8",
      input,
      env: { ...process.env, GROVE_CHANNEL: "test-channel" },
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.hook_event_name).toBe("PostToolUse");
    // Prompt should be unchanged
    expect(output.prompt).toBe("Hello");
  });

  test("should inject Cortex context on SessionStart when GROVE_CHANNEL is set", () => {
    const result = runHook({ GROVE_CHANNEL: "test-channel" });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.prompt).toContain("<system-reminder>");
    expect(output.prompt).toContain("Cortex Context:");
    expect(output.prompt).toContain("Channel: test-channel");
    expect(output.prompt).toContain("</system-reminder>");
  });

  test("should include agent identity when provided", () => {
    const result = runHook({
      GROVE_CHANNEL: "test-channel",
      GROVE_AGENT_NAME: "Test Agent",
      GROVE_AGENT_ID: "test-001",
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.prompt).toContain("Agent Name: Test Agent");
    expect(output.prompt).toContain("Agent ID: test-001");
  });

  test("should include network when provided", () => {
    const result = runHook({
      GROVE_CHANNEL: "test-channel",
      GROVE_NETWORK: "metafactory",
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.prompt).toContain("Network: metafactory");
  });

  // G-2a/G-3a (cortex#774) — CORTEX_*-native read path with GROVE_* fallback.
  describe("CORTEX_* env path (cortex#774)", () => {
    test("injects context when CORTEX_CHANNEL is set", () => {
      const result = runHook({
        CORTEX_CHANNEL: "cortex-channel",
        CORTEX_NETWORK: "metafactory",
        CORTEX_AGENT_NAME: "Ivy",
        CORTEX_AGENT_ID: "ivy-001",
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.prompt).toContain("Channel: cortex-channel");
      expect(output.prompt).toContain("Network: metafactory");
      expect(output.prompt).toContain("Agent Name: Ivy");
      expect(output.prompt).toContain("Agent ID: ivy-001");
    });

    test("CORTEX_CHANNEL wins over GROVE_CHANNEL", () => {
      const result = runHook({
        CORTEX_CHANNEL: "cortex-channel",
        GROVE_CHANNEL: "grove-channel",
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.prompt).toContain("Channel: cortex-channel");
      expect(output.prompt).not.toContain("Channel: grove-channel");
    });

    test("still resolves with only GROVE_* set (fallback intact)", () => {
      const result = runHook({
        GROVE_CHANNEL: "grove-only",
        GROVE_NETWORK: "metafactory",
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.prompt).toContain("Channel: grove-only");
      expect(output.prompt).toContain("Network: metafactory");
    });
  });
});
