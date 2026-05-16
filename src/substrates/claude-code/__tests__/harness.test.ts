/**
 * IAW Phase A.1 — `ClaudeCodeHarness` happy-path + terminal-state tests.
 *
 * **Coverage axes:**
 *   1. Instantiation — minimum/full opts both compile and produce a
 *      harness with the expected `id` and `capabilities`.
 *   2. Happy path — dispatch yields started → completed in order, with
 *      the same `correlation_id` and a result summary derived from
 *      `CCSessionResult.response`.
 *   3. Failure path — non-zero exit yields started → failed with the
 *      exit code in the error summary.
 *   4. Abort path — `result.aborted === true` yields started → aborted
 *      with `reason = result.abortReason` (Echo round-1 W1 fix carried
 *      through from dispatch-listener).
 *   5. Factory throw — constructor-thrown exception yields started →
 *      failed with the thrown message.
 *   6. CCSessionOpts mapping — `tools.allow`/`tools.deny` become
 *      `allowedTools`/`disallowedTools`; env-kind context populates
 *      operator/entity/project; both timeout fields collapse to the
 *      minimum on cc-session's existing timer.
 *   7. Shutdown — `graceful: false` calls kill on active sessions;
 *      post-shutdown `dispatch()` yields started → failed (refused).
 *
 * NO real CC processes are spawned. Every test injects a fake
 * `ccSessionFactory` per the protocol contract.
 */

import { describe, expect, test } from "bun:test";

import {
  __resetWarnedNonUuidRequestId,
  ClaudeCodeHarness,
  type CCSessionFactory,
} from "../harness";
import type { CCSessionOpts, CCSessionResult } from "../../../runner/cc-session";
import type { DispatchEventSource } from "../../../bus/dispatch-events";
import type {
  DispatchRequest,
  MyelinEnvelope,
} from "../../../common/substrates/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE: DispatchEventSource = {
  org: "metafactory",
  agent: "cortex",
  instance: "local",
};

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    persona: { path: "/agents/cortex.md", content: "# Cortex" },
    prompt: "say hello",
    tools: { allow: ["Bash", "Read"] },
    context: [],
    agent: { id: "cortex", displayName: "Cortex" },
    requestId: REQUEST_ID,
    ...overrides,
  };
}

function makeResult(overrides: Partial<CCSessionResult> = {}): CCSessionResult {
  return {
    success: true,
    response: "Hello, world!\nMore details below.",
    exitCode: 0,
    durationMs: 100,
    sessionId: "session-abc",
    ...overrides,
  };
}

/**
 * Capturing factory. Records every opts seen and returns a session whose
 * `wait()` resolves to the provided result.
 */
function captureFactory(result: CCSessionResult): {
  factory: CCSessionFactory;
  opts: CCSessionOpts[];
  killCalls: number;
} {
  const seen: CCSessionOpts[] = [];
  let killCalls = 0;
  const factory: CCSessionFactory = (opts) => {
    seen.push(opts);
    const session = {
      start() { return session; },
      async wait() { return result; },
      kill() { killCalls += 1; },
    };
    return session;
  };
  return {
    factory,
    opts: seen,
    get killCalls() { return killCalls; },
  };
}

async function drain(it: AsyncIterable<MyelinEnvelope>): Promise<MyelinEnvelope[]> {
  const out: MyelinEnvelope[] = [];
  for await (const env of it) out.push(env);
  return out;
}

// ---------------------------------------------------------------------------
// Instantiation
// ---------------------------------------------------------------------------

describe("ClaudeCodeHarness — instantiation", () => {
  test("id is 'claude-code'", () => {
    const h = new ClaudeCodeHarness({ source: SOURCE });
    expect(h.id).toBe("claude-code");
  });

  test("capabilities defaults to empty array", () => {
    const h = new ClaudeCodeHarness({ source: SOURCE });
    expect(h.capabilities).toEqual([]);
  });

  test("capabilities passthrough when provided", () => {
    const h = new ClaudeCodeHarness({
      source: SOURCE,
      capabilities: [
        { id: "code-review", description: "Reviews PRs" },
        { id: "research", description: "Web research", tags: ["search"] },
      ],
    });
    expect(h.capabilities).toHaveLength(2);
    expect(h.capabilities[0]?.id).toBe("code-review");
    expect(h.capabilities[1]?.tags).toEqual(["search"]);
  });

  test("shutdown method is defined (optional in protocol but provided here)", () => {
    const h = new ClaudeCodeHarness({ source: SOURCE });
    expect(typeof h.shutdown).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("ClaudeCodeHarness — happy path", () => {
  test("yields started then completed for a successful session", async () => {
    const result = makeResult();
    const cap = captureFactory(result);
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });

    const envelopes = await drain(h.dispatch(makeRequest()));

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]?.type).toBe("dispatch.task.started");
    expect(envelopes[1]?.type).toBe("dispatch.task.completed");
  });

  test("started + completed share the same correlation_id (= requestId)", async () => {
    const result = makeResult();
    const cap = captureFactory(result);
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });

    const envelopes = await drain(h.dispatch(makeRequest()));

    expect(envelopes[0]?.correlation_id).toBe(REQUEST_ID);
    expect(envelopes[1]?.correlation_id).toBe(REQUEST_ID);
  });

  test("completed envelope carries the result summary (first line only)", async () => {
    const result = makeResult({ response: "Hello, world!\nDetails follow." });
    const cap = captureFactory(result);
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });

    const envelopes = await drain(h.dispatch(makeRequest()));
    const completed = envelopes[1];

    expect(completed?.payload.result_summary).toBe("Hello, world!");
  });

  test("envelope source matches the harness source triple", async () => {
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });

    const envelopes = await drain(h.dispatch(makeRequest()));
    expect(envelopes[0]?.source).toBe("metafactory.cortex.local");
    expect(envelopes[1]?.source).toBe("metafactory.cortex.local");
  });

  test("non-uuid requestId still produces a uuid correlation_id", async () => {
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });
    const req = makeRequest({ requestId: "not-a-uuid" });

    const envelopes = await drain(h.dispatch(req));

    // Two envelopes, both with the same generated correlation_id
    // (a real UUID, not the input string).
    const c0 = envelopes[0]?.correlation_id;
    const c1 = envelopes[1]?.correlation_id;
    expect(c0).toBeDefined();
    expect(c0).not.toBe("not-a-uuid");
    expect(c0).toMatch(/^[0-9a-f-]{36}$/);
    expect(c1).toBe(c0);
  });
});

// ---------------------------------------------------------------------------
// CCSessionOpts mapping
// ---------------------------------------------------------------------------

describe("ClaudeCodeHarness — DispatchRequest → CCSessionOpts mapping", () => {
  test("tools.allow/deny pass through as substrate-native strings (Q1-α)", async () => {
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });
    const req = makeRequest({
      tools: { allow: ["Bash", "Edit"], deny: ["WebFetch"] },
    });

    await drain(h.dispatch(req));

    expect(cap.opts[0]?.allowedTools).toEqual(["Bash", "Edit"]);
    expect(cap.opts[0]?.disallowedTools).toEqual(["WebFetch"]);
  });

  test("empty tools.allow drops the field rather than passing an empty array", async () => {
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });

    await drain(h.dispatch(makeRequest({ tools: { allow: [] } })));

    expect(cap.opts[0]?.allowedTools).toBeUndefined();
  });

  test("Q6: both timeouts collapse to the minimum on cc-session timer", async () => {
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });
    const req = makeRequest({ timeoutMs: 300_000, inactivityMs: 60_000 });

    await drain(h.dispatch(req));

    // Until A.1b splits the timers, the more conservative cap wins.
    expect(cap.opts[0]?.timeoutMs).toBe(60_000);
  });

  test("Q6: single timeout maps through directly", async () => {
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });

    await drain(h.dispatch(makeRequest({ timeoutMs: 30_000 })));
    expect(cap.opts[0]?.timeoutMs).toBe(30_000);

    await drain(h.dispatch(makeRequest({ inactivityMs: 45_000 })));
    expect(cap.opts[1]?.timeoutMs).toBe(45_000);
  });

  test("env-kind context populates operator/entity/project", async () => {
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });
    const req = makeRequest({
      context: [
        { kind: "env", data: { operator: "andreas", entity: "pr/45", project: "cortex" } },
        { kind: "discord-history", data: [{ author: "andreas", text: "hi" }] },
      ],
    });

    await drain(h.dispatch(req));

    expect(cap.opts[0]?.operator).toBe("andreas");
    expect(cap.opts[0]?.entity).toBe("pr/45");
    expect(cap.opts[0]?.project).toBe("cortex");
  });

  test("unknown context kinds are silently ignored", async () => {
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });
    const req = makeRequest({
      context: [
        { kind: "unknown-kind", data: { random: "stuff" } },
        { kind: "another-unknown", data: 42 },
      ],
    });

    // Should NOT throw — protocol contract says unknown kinds are dropped.
    const envelopes = await drain(h.dispatch(req));
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]?.type).toBe("dispatch.task.completed");
  });

  test("A.1b: req.runtime fields plumb onto CCSessionOpts", async () => {
    // A.1b extends DispatchRequest with an optional `runtime` block
    // carrying CC-specific knobs (cwd, allowedDirs, bashAllowlist, etc.).
    // The harness reads them onto CCSessionOpts; future non-CC harnesses
    // ignore them.
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });
    const req = makeRequest({
      runtime: {
        cwd: "/work",
        allowedDirs: ["/work", "/tmp"],
        additionalArgs: ["--verbose"],
        groveChannel: "grove",
        groveNetwork: "metafactory",
        resumeSessionId: "sess-123",
        bashAllowlist: { rules: [{ pattern: "ls" }], repos: ["grove"] },
        bashGuardDisabled: false,
      },
    });

    await drain(h.dispatch(req));

    expect(cap.opts[0]?.cwd).toBe("/work");
    expect(cap.opts[0]?.allowedDirs).toEqual(["/work", "/tmp"]);
    expect(cap.opts[0]?.additionalArgs).toEqual(["--verbose"]);
    expect(cap.opts[0]?.groveChannel).toBe("grove");
    expect(cap.opts[0]?.groveNetwork).toBe("metafactory");
    expect(cap.opts[0]?.resumeSessionId).toBe("sess-123");
    expect(cap.opts[0]?.bashAllowlist).toEqual({
      rules: [{ pattern: "ls" }],
      repos: ["grove"],
    });
    expect(cap.opts[0]?.bashGuardDisabled).toBe(false);
  });

  test("A.1b: req.runtime and env-kind context coexist (no overlapping fields today)", async () => {
    // If a payload happens to populate BOTH `req.runtime` AND a
    // `context[kind=env]` block (defence in depth — different upstream
    // adapters might use either path), `req.runtime` wins. This is the
    // explicit-over-implicit principle: the new typed surface beats the
    // legacy `context.data` route.
    //
    // Note: operator/entity/project don't live on `req.runtime` today —
    // they only live in env context. The conflict is only resolvable for
    // fields that overlap; for now nothing overlaps directly. This test
    // asserts the *combination* path: both blocks supplied, harness reads
    // both without throwing, env context still surfaces operator/etc.
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });
    const req = makeRequest({
      runtime: { cwd: "/work", groveChannel: "grove" },
      context: [
        { kind: "env", data: { operator: "andreas", entity: "pr/45", project: "cortex" } },
      ],
    });

    await drain(h.dispatch(req));

    expect(cap.opts[0]?.cwd).toBe("/work");
    expect(cap.opts[0]?.groveChannel).toBe("grove");
    expect(cap.opts[0]?.operator).toBe("andreas");
    expect(cap.opts[0]?.entity).toBe("pr/45");
    expect(cap.opts[0]?.project).toBe("cortex");
  });

  test("A.1b: persona is optional on DispatchRequest", async () => {
    // Echo cortex#125: `req.persona` dropped to optional. A request with
    // no persona block must still dispatch successfully (the harness
    // doesn't inject persona — the prompt is already persona-injected
    // upstream by dispatch-handler's prompt-builder path).
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });
    const req: DispatchRequest = {
      // NB: no `persona` field at all
      prompt: "do it",
      tools: { allow: [] },
      context: [],
      agent: { id: "cortex", displayName: "Cortex" },
      requestId: REQUEST_ID,
    };

    const envelopes = await drain(h.dispatch(req));
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]?.type).toBe("dispatch.task.completed");
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe("ClaudeCodeHarness — failure paths", () => {
  test("non-zero exit yields started → failed with exit code summary", async () => {
    const cap = captureFactory(makeResult({ success: false, exitCode: 1 }));
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });

    const envelopes = await drain(h.dispatch(makeRequest()));

    expect(envelopes[1]?.type).toBe("dispatch.task.failed");
    expect(envelopes[1]?.payload.error_summary).toBe("claude exited 1");
  });

  test("factory throw yields started → failed with the thrown message", async () => {
    const factory: CCSessionFactory = () => {
      throw new Error("spawn ENOENT: claude not in path");
    };
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: factory });

    const envelopes = await drain(h.dispatch(makeRequest()));

    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]?.type).toBe("dispatch.task.failed");
    expect(envelopes[1]?.payload.error_summary).toBe("spawn ENOENT: claude not in path");
  });

  test("aborted=true yields started → aborted with reason from result", async () => {
    const cap = captureFactory(makeResult({
      success: false,
      exitCode: 1,
      aborted: true,
      abortReason: "timeout",
    }));
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });

    const envelopes = await drain(h.dispatch(makeRequest()));

    expect(envelopes[1]?.type).toBe("dispatch.task.aborted");
    expect(envelopes[1]?.payload.reason).toBe("timeout");
  });

  test("exitCode=143 without aborted flag still yields aborted (defense-in-depth)", async () => {
    const cap = captureFactory(makeResult({
      success: false,
      exitCode: 143,
    }));
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });

    const envelopes = await drain(h.dispatch(makeRequest()));

    expect(envelopes[1]?.type).toBe("dispatch.task.aborted");
    expect(envelopes[1]?.payload.reason).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("ClaudeCodeHarness — shutdown", () => {
  test("graceful=true flips flag; in-flight dispatches finish naturally", async () => {
    const cap = captureFactory(makeResult());
    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: cap.factory });

    await h.shutdown({ graceful: true });

    // Post-shutdown dispatch refuses cleanly (still yields the protocol-
    // required started + terminal pair, but the terminal is `failed`).
    const envelopes = await drain(h.dispatch(makeRequest()));
    expect(envelopes[0]?.type).toBe("dispatch.task.started");
    expect(envelopes[1]?.type).toBe("dispatch.task.failed");
    expect(envelopes[1]?.payload.error_summary).toBe("harness shutting down");
    expect(cap.killCalls).toBe(0);
  });

  test("graceful=false kills any active session in the tracker", async () => {
    // Build a session whose wait() never resolves so we can observe kill().
    const killOrder: string[] = [];
    let resolveWait: ((r: CCSessionResult) => void) | null = null;
    const factory: CCSessionFactory = () => {
      const session = {
        start() { return session; },
        wait() {
          return new Promise<CCSessionResult>((resolve) => {
            resolveWait = resolve;
          });
        },
        kill() {
          killOrder.push("killed");
          // Settle wait so the dispatch generator completes.
          resolveWait?.({
            success: false,
            response: "",
            exitCode: 143,
            durationMs: 0,
            aborted: true,
            abortReason: "timeout",
          });
        },
      };
      return session;
    };

    const h = new ClaudeCodeHarness({ source: SOURCE, ccSessionFactory: factory });
    const dispatchPromise = drain(h.dispatch(makeRequest()));

    // Yield to let the dispatch generator add the session to activeSessions
    // before we call shutdown.
    await new Promise((r) => setTimeout(r, 0));

    await h.shutdown({ graceful: false });

    const envelopes = await dispatchPromise;
    expect(killOrder).toEqual(["killed"]);
    expect(envelopes[1]?.type).toBe("dispatch.task.aborted");
  });

  test("cortex#127 item 4: non-UUID requestId warn-once latch is module-scoped (survives across harness instances)", async () => {
    __resetWarnedNonUuidRequestId();
    const warnCalls: string[] = [];
    const originalWarn = console.warn.bind(console);
    console.warn = (msg: string) => {
      warnCalls.push(msg);
    };

    try {
      const cap = captureFactory(makeResult());
      // Two fresh harness instances dispatched with non-UUID requestIds —
      // production wires a new ClaudeCodeHarness per dispatch in
      // dispatch-listener.ts. Pre-fix, each instance's `warnedNonUuidRequestId`
      // field started false, so every dispatch warned. Post-fix, the latch
      // is module-scope and the warning fires exactly once across both.
      const h1 = new ClaudeCodeHarness({
        source: SOURCE,
        ccSessionFactory: cap.factory,
      });
      const h2 = new ClaudeCodeHarness({
        source: SOURCE,
        ccSessionFactory: cap.factory,
      });

      await drain(h1.dispatch(makeRequest({ requestId: "not-a-uuid" })));
      await drain(h2.dispatch(makeRequest({ requestId: "also-not-uuid" })));

      const nonUuidWarnings = warnCalls.filter((m) =>
        m.includes("is not UUID-shaped"),
      );
      expect(nonUuidWarnings).toHaveLength(1);
      // The single warning must be for the FIRST non-UUID id (latch fired
      // on h1's dispatch); h2's bad id is silently substituted.
      expect(nonUuidWarnings[0]).toContain("not-a-uuid");
    } finally {
      console.warn = originalWarn;
      __resetWarnedNonUuidRequestId();
    }
  });
});
