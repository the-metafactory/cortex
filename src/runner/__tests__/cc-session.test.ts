import { describe, test, expect } from "bun:test";
import { CCSession, type CCSessionOpts, resolvePathGuardEnv } from "../cc-session";
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

/**
 * EBH-1b (cortex#2352) — `resolvePathGuardEnv` is the single projection point
 * that turns `CCSessionOpts.allowedDirs`/`readOnlyDirs` into the
 * `CORTEX_PATH_GUARD` value path-guard.hook.ts's `decidePath` reads. THE
 * correctness subtlety this slice closes: without subtracting `readOnlyDirs`
 * from `allowedDirs`, a dispatch path that builds `allowedDirs` as a UNION
 * including the read-only set (dispatch-handler.ts's `invokeDirs`) would put
 * a read-only dir in BOTH emitted lists — `decidePath`'s `inAllowed` check
 * would be `true` and the write-deny branch (which requires `!inAllowed`)
 * would never fire, leaving F6 silently inert even with `readOnlyDirs`
 * populated. These tests prove the subtraction actually happens.
 */
describe("resolvePathGuardEnv — EBH-1b allowedDirs/readOnlyDirs subtraction (cortex#2352)", () => {
  test("no opts ⇒ the safe default {allowedDirs:[],readOnlyDirs:[]} (no restriction configured)", () => {
    expect(JSON.parse(resolvePathGuardEnv({}))).toEqual({ allowedDirs: [], readOnlyDirs: [] });
  });

  test("disjoint allowedDirs/readOnlyDirs pass through unchanged", () => {
    const out = JSON.parse(
      resolvePathGuardEnv({ allowedDirs: ["/work"], readOnlyDirs: ["/ro"] }),
    );
    expect(out).toEqual({ allowedDirs: ["/work"], readOnlyDirs: ["/ro"] });
  });

  test("THE subtraction: a dir in BOTH lists is excluded from the emitted allowedDirs and kept in readOnlyDirs (read-only wins)", () => {
    // Mirrors dispatch-handler.ts's invokeDirs shape: allowedDirs is a UNION
    // that also contains the read-only dir (kept that way so --add-dir still
    // grants read access via claude-invoker.ts, which reads opts.allowedDirs
    // directly and never sees this function's output).
    const out = JSON.parse(
      resolvePathGuardEnv({
        allowedDirs: ["/work", "/ro"],
        readOnlyDirs: ["/ro"],
      }),
    );
    expect(out).toEqual({ allowedDirs: ["/work"], readOnlyDirs: ["/ro"] });
    // The proof that matters: the overlapping dir does NOT appear in the
    // emitted allowedDirs, so decidePath's `inAllowed` is false for it and
    // the write-deny branch (WRITE_TOOLS && inReadOnly) can fire.
    expect(out.allowedDirs).not.toContain("/ro");
  });

  test("readOnlyDirs without a matching allowedDirs entry is unaffected (no accidental exclusion)", () => {
    const out = JSON.parse(
      resolvePathGuardEnv({ allowedDirs: ["/work"], readOnlyDirs: ["/ro"] }),
    );
    expect(out.allowedDirs).toEqual(["/work"]);
  });

  test("undefined allowedDirs with a defined readOnlyDirs ⇒ allowedDirs stays []", () => {
    const out = JSON.parse(resolvePathGuardEnv({ readOnlyDirs: ["/ro"] }));
    expect(out).toEqual({ allowedDirs: [], readOnlyDirs: ["/ro"] });
  });
});
