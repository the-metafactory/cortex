import { describe, test, expect } from "bun:test";
import { CCSession, type CCSessionOpts, resolvePathGuardEnv, deriveSandboxProfile } from "../cc-session";
import { resetSandboxCapabilityProbeForTests } from "../session-sandbox";
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

/**
 * EBH-2 (cortex#2344) — `deriveSandboxProfile` projects the SAME resolved
 * `CCSessionOpts.{allowedDirs,readOnlyDirs}` `resolvePathGuardEnv` reads
 * into a `SandboxProfile` (DD-1: one policy, N projections). These tests
 * prove the projection stays byte-consistent with the L1 path guard's
 * split — in particular that the EBH-1b overlap rule (a dir in BOTH
 * `allowedDirs` and `readOnlyDirs` resolves to read-only) holds for the
 * kernel-level profile too, not just for `CORTEX_PATH_GUARD`.
 */
describe("deriveSandboxProfile — EBH-2 policy → SandboxProfile projection (cortex#2344)", () => {
  test("no opts ⇒ empty readWrite/readOnly, mode passed through", () => {
    const profile = deriveSandboxProfile({}, "off");
    expect(profile.readWrite).toEqual([]);
    expect(profile.readOnly).toEqual([]);
    expect(profile.mode).toBe("off");
  });

  test("disjoint allowedDirs/readOnlyDirs project straight across", () => {
    const profile = deriveSandboxProfile(
      { allowedDirs: ["/work"], readOnlyDirs: ["/ro"] },
      "audit",
    );
    expect(profile.readWrite).toEqual(["/work"]);
    expect(profile.readOnly).toEqual(["/ro"]);
    expect(profile.mode).toBe("audit");
  });

  test("a dir in BOTH lists resolves to readOnly, never readWrite (EBH-1b overlap rule, honoured at the kernel-profile layer too)", () => {
    const profile = deriveSandboxProfile(
      { allowedDirs: ["/work", "/ro"], readOnlyDirs: ["/ro"] },
      "enforce",
    );
    expect(profile.readWrite).toEqual(["/work"]);
    expect(profile.readOnly).toEqual(["/ro"]);
    expect(profile.readWrite).not.toContain("/ro");
  });

  test("execAllow/egressAllow are populated from the compatibility-contract seed, not opts", () => {
    const profile = deriveSandboxProfile({ allowedDirs: ["/work"] }, "off");
    expect(profile.execAllow.length).toBeGreaterThan(0);
    expect(profile.execAllow).toContain("claude");
    expect(profile.egressAllow).toContain("api.anthropic.com");
  });

  test("mode threads through unchanged for every SandboxMode value", () => {
    expect(deriveSandboxProfile({}, "off").mode).toBe("off");
    expect(deriveSandboxProfile({}, "audit").mode).toBe("audit");
    expect(deriveSandboxProfile({}, "enforce").mode).toBe("enforce");
  });
});

/**
 * EBH-2 (cortex#2344) — `start()` now routes every spawn through
 * `SessionSandbox.spawn` instead of a direct `Bun.spawn`. This is a
 * behaviour-preservation test for the `none` backend: a real session still
 * runs end-to-end (gated on a local `claude` binary, like the rest of this
 * file's live-invocation tests) and the new `"security-event"` fires
 * exactly once, carrying `backend: "none"`.
 */
describe("CCSession — EBH-2 SessionSandbox routing", () => {
  testClaude("emits exactly one security-event (none backend) per session", async () => {
    // EBH-3a (cortex#2345) — `createSessionSandbox` now resolves a REAL
    // `macos-sbpl` backend when the boot capability probe has been warmed
    // AND resolves it (session-sandbox.ts). In the full test-suite run
    // (one process, `bun test` default), an EARLIER file's `startCortex()`
    // call can warm that MODULE-LEVEL sync cache before this test runs —
    // this test's whole point is the `none` backend's OWN observable
    // contract (fires `sandbox-unavailable`), so it resets the cache first
    // to deterministically get `NoneSandbox`, regardless of suite ordering
    // or what ran before it. Mirrors `session-sandbox.test.ts`'s own
    // `afterEach(resetSandboxCapabilityProbeForTests)` discipline.
    resetSandboxCapabilityProbeForTests();
    const session = new CCSession({
      prompt: "Say just the word hi",
      channel: "test",
      timeoutMs: 30_000,
    });

    const securityEvents: unknown[] = [];
    session.on("security-event", (event: unknown) => {
      securityEvents.push(event);
    });

    await session.start().wait();

    expect(securityEvents).toHaveLength(1);
    expect(securityEvents[0]).toMatchObject({
      type: "system.security.sandbox-unavailable",
      backend: "none",
    });
  }, 60_000);
});
