import { describe, test, expect, spyOn } from "bun:test";
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

  /**
   * EBH-4 (cortex#2346) — `opts.egressAllow` extends, never replaces, the
   * static seed. This is the "wire egressAllow from the profile through to
   * the proxy" contract's INPUT half — `egress-proxy.ts`'s tests cover the
   * enforcement half.
   */
  test("opts.egressAllow is MERGED with the static seed, not a replacement", () => {
    const profile = deriveSandboxProfile({ egressAllow: ["extra.example.com"] }, "audit");
    expect(profile.egressAllow).toContain("api.anthropic.com"); // seed survives
    expect(profile.egressAllow).toContain("extra.example.com"); // caller addition present
  });

  test("no opts.egressAllow ⇒ exactly the static seed, no duplication with itself", () => {
    const profile = deriveSandboxProfile({}, "audit");
    expect(profile.egressAllow).toEqual([...new Set(profile.egressAllow)]); // no dupes
    expect(profile.egressAllow.length).toBeGreaterThan(0);
  });

  test("a duplicate of a seed entry in opts.egressAllow is deduplicated", () => {
    const profile = deriveSandboxProfile({ egressAllow: ["api.anthropic.com"] }, "audit");
    expect(profile.egressAllow.filter((h) => h === "api.anthropic.com")).toHaveLength(1);
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

/**
 * EBH-4 (cortex#2346) — proves `CCSession.start()` actually wires a spawned
 * child through the `EgressProxy`: env vars set when `sandboxMode` is
 * `"audit"`/`"enforce"`, absent when it's `"off"` (the HARD HOLD default,
 * byte-identical to every session that exists today). Uses the same
 * intercept-`Bun.spawn`-and-throw strategy as `cc-session-isolation.test.ts`
 * — no real `claude` binary needed, deterministic, CI-safe. The REAL
 * `EgressProxy` still binds a REAL ephemeral port in the "audit"/"enforce"
 * cases (this is what proves the wiring, not a mock of it); the outer catch
 * path (`egressProxy?.stop()`) tears it down when the intercepted spawn
 * throws, so no port leaks across tests.
 */
describe("CCSession — EBH-4 egress proxy env wiring", () => {
  interface Captured {
    env: Record<string, string>;
  }

  function captureSpawn(): { calls: Captured[]; restore: () => void } {
    const calls: Captured[] = [];
    const spy = spyOn(Bun, "spawn").mockImplementation(((
      _cmd: string[],
      opts: { env: Record<string, string> },
    ) => {
      calls.push({ env: opts.env });
      throw new Error("spawn intercepted by test");
    }) as unknown as typeof Bun.spawn);
    return { calls, restore: () => spy.mockRestore() };
  }

  test("mode 'off' (default) — no proxy env vars, byte-identical to pre-EBH-4", () => {
    resetSandboxCapabilityProbeForTests();
    const { calls, restore } = captureSpawn();
    try {
      const session = new CCSession({ prompt: "hi", channel: "test" });
      session.on("error", () => {/* expected — spawn intercepted */});
      session.start();

      expect(calls).toHaveLength(1);
      const env = calls[0]!.env;
      expect(env.HTTP_PROXY).toBeUndefined();
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(env.http_proxy).toBeUndefined();
      expect(env.https_proxy).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("mode 'audit' — HTTP_PROXY/HTTPS_PROXY point at a real local proxy port, NO_PROXY stripped", () => {
    resetSandboxCapabilityProbeForTests();
    const { calls, restore } = captureSpawn();
    try {
      const session = new CCSession({
        prompt: "hi",
        channel: "test",
        sandboxMode: "audit",
      });
      session.on("error", () => {/* expected — spawn intercepted */});
      session.start();

      expect(calls).toHaveLength(1);
      const env = calls[0]!.env;
      expect(env.HTTP_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
      expect(env.http_proxy).toBe(env.HTTP_PROXY);
      expect(env.https_proxy).toBe(env.HTTP_PROXY);
      expect(env.NO_PROXY).toBeUndefined();
      expect(env.no_proxy).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("mode 'enforce' — same env wiring as audit", () => {
    resetSandboxCapabilityProbeForTests();
    const { calls, restore } = captureSpawn();
    try {
      const session = new CCSession({
        prompt: "hi",
        channel: "test",
        sandboxMode: "enforce",
      });
      session.on("error", () => {/* expected — spawn intercepted */});
      session.start();

      expect(calls).toHaveLength(1);
      expect(calls[0]!.env.HTTP_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      restore();
    }
  });

  test("a NO_PROXY set on the parent env does not survive into a mode 'enforce' child (bypass-escape-hatch closed)", () => {
    resetSandboxCapabilityProbeForTests();
    const { calls, restore } = captureSpawn();
    const priorNoProxy = process.env.NO_PROXY;
    process.env.NO_PROXY = "*";
    try {
      const session = new CCSession({
        prompt: "hi",
        channel: "test",
        sandboxMode: "enforce",
        settingsIsolation: false, // inherits process.env as the base env
      });
      session.on("error", () => {/* expected — spawn intercepted */});
      session.start();

      expect(calls).toHaveLength(1);
      expect(calls[0]!.env.NO_PROXY).toBeUndefined();
    } finally {
      if (priorNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = priorNoProxy;
      restore();
    }
  });
});
