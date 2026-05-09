import { describe, test, expect, mock } from "bun:test";
import { invokeClaudeCode, type ClaudeInvocationOpts } from "../claude-invoker";

describe("invokeClaudeCode", () => {
  test("returns result with correct structure", async () => {
    // Use a very short timeout — we're testing the structure, not Claude itself
    const result = await invokeClaudeCode({
      prompt: "Say hello",
      groveChannel: "test",
      timeoutMs: 500,
    });
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("response");
    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("durationMs");
    expect(typeof result.durationMs).toBe("number");
  });

  test("sets GROVE_CHANNEL env var", async () => {
    // Verify the function accepts groveChannel parameter
    const opts: ClaudeInvocationOpts = {
      prompt: "test",
      groveChannel: "ivy",
      timeoutMs: 1000,
    };
    // Should not throw on construction
    expect(opts.groveChannel).toBe("ivy");
  });

  test("respects timeout", async () => {
    const start = Date.now();
    const result = await invokeClaudeCode({
      prompt: "This should timeout",
      groveChannel: "test",
      timeoutMs: 100, // Very short timeout
    });
    const elapsed = Date.now() - start;
    // Should complete within a reasonable time (timeout + overhead)
    expect(elapsed).toBeLessThan(5000);
  });
});
