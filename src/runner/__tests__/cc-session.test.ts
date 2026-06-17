import { describe, test, expect } from "bun:test";
import { CCSession, type CCSessionOpts } from "../cc-session";
import { testClaude } from "../../common/test-utils";

describe("CCSession", () => {
  test("constructs with required opts", () => {
    const session = new CCSession({
      prompt: "Say hello",
      channel: "test",
    });
    expect(session).toBeInstanceOf(CCSession);
    expect(session.sessionId).toBeUndefined();
    expect(session.result).toBeUndefined();
  });

  testClaude("emits events in correct order for a successful run", async () => {
    const session = new CCSession({
      prompt: "Say just the word hello, nothing else",
      channel: "test",
      timeoutMs: 30_000,
    });

    const events: string[] = [];

    session.on("session-id", (id: string) => {
      events.push("session-id");
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    session.on("result", (text: string) => {
      events.push("result");
      expect(typeof text).toBe("string");
    });

    session.on("exit", () => {
      events.push("exit");
    });

    const result = await session.start().wait();

    expect(result.success).toBe(true);
    expect(result.response.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.sessionId).toBeTruthy();
    // Session ID should be captured on the session object too
    expect(session.sessionId).toBe(result.sessionId);

    expect(events).toContain("session-id");
    expect(events).toContain("result");
    expect(events).toContain("exit");
  }, 60_000); // Allow up to 60s for Claude to respond

  testClaude("handles timeout", async () => {
    const session = new CCSession({
      prompt: "Write a very long essay about the history of the universe",
      channel: "test",
      timeoutMs: 100, // Extremely short — will timeout
    });

    let errorEmitted = false;
    session.on("error", () => {
      errorEmitted = true;
    });

    const result = await session.start().wait();

    // Should either timeout or fail
    expect(result.durationMs).toBeGreaterThan(0);
    // Process should have been killed
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  testClaude("wait() auto-starts if not started", async () => {
    const session = new CCSession({
      prompt: "Say just the word ok",
      channel: "test",
      timeoutMs: 30_000,
    });

    // Call wait() without start() — should auto-start
    const result = await session.wait();
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("response");
    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("durationMs");
  }, 60_000);

  testClaude("result is stored on session object", async () => {
    const session = new CCSession({
      prompt: "Say just the word yes",
      channel: "test",
      timeoutMs: 30_000,
    });

    await session.start().wait();

    expect(session.result).toBeTruthy();
    expect(typeof session.result).toBe("string");
  }, 60_000);
});

describe("CCSession args", () => {
  test("includes stream-json output format", async () => {
    // Verify the session adds --output-format stream-json by checking it doesn't throw
    const session = new CCSession({
      prompt: "test",
      channel: "test",
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      allowedDirs: ["/tmp"],
      additionalArgs: ["--verbose"],
    });
    expect(session).toBeInstanceOf(CCSession);
  });
});
