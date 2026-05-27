/**
 * Tests for `src/bus/surface-router.ts` — G-1111.A.
 *
 * Cover:
 *   - subjectMatches: > terminal, * single segment, literals, edge cases
 *   - register / unregister
 *   - dispatch by subject and by filter (positive + negative)
 *   - adapter isolation: failing adapter doesn't block siblings
 *   - timeout: hanging render is cancelled at renderTimeoutMs
 *   - onAdapterError hook receives errors and timeouts
 *   - start/stop lifecycle
 *
 * MyelinRuntime is mocked as a plain stub — we never touch real NATS.
 */

import { describe, expect, test } from "bun:test";
import type {
  PolicyFederated,
  PolicyFederatedNetwork,
  RendererVisibility,
} from "../../common/types/cortex-config";
import type { Envelope, SignedBy } from "../myelin/envelope-validator";
import type { MyelinRuntime } from "../myelin/runtime";
import { validateEnvelope } from "../myelin/envelope-validator";
import {
  createSurfaceRouter,
  evaluateFederationGate,
  evaluateVisibility,
  subjectMatches,
  type SurfaceAdapter,
} from "../surface-router";
import type { SystemEventSource } from "../system-events";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRuntime(): MyelinRuntime {
  const handlers = new Set<Parameters<MyelinRuntime["onEnvelope"]>[0]>();
  return {
    enabled: true,
    onEnvelope: (handler) => {
      handlers.add(handler);
      return { unregister: () => { handlers.delete(handler); } };
    },
    publish: async () => {},
    stop: async () => {},
  };
}

/**
 * IAW Phase A.4 — fakeRuntime variant that records `publish()` calls so
 * tests can assert on the `system.access.filtered` envelopes the router
 * emits on visibility drops.
 */
function fakeRuntimeWithPublishLog(): {
  runtime: MyelinRuntime;
  published: Envelope[];
} {
  const handlers = new Set<Parameters<MyelinRuntime["onEnvelope"]>[0]>();
  const published: Envelope[] = [];
  return {
    runtime: {
      enabled: true,
      onEnvelope: (handler) => {
        handlers.add(handler);
        return { unregister: () => { handlers.delete(handler); } };
      },
      publish: async (env) => { published.push(env); },
      stop: async () => {},
    },
    published,
  };
}

const TEST_SYSTEM_EVENT_SOURCE: SystemEventSource = {
  org: "metafactory",
  agent: "cortex",
  instance: "local",
};

/**
 * `fakeRuntime` plus a `trigger()` helper for end-to-end wiring tests.
 * Use when the test needs to simulate an envelope arriving on the bus
 * (i.e. the runtime side of the surface-router contract).
 */
function fakeRuntimeWithTrigger(): {
  runtime: MyelinRuntime;
  trigger: (env: Envelope, subject: string) => void;
  registrationCount: () => number;
} {
  const handlers = new Set<Parameters<MyelinRuntime["onEnvelope"]>[0]>();
  return {
    runtime: {
      enabled: true,
      onEnvelope: (handler) => {
        handlers.add(handler);
        return { unregister: () => { handlers.delete(handler); } };
      },
      publish: async () => {},
      stop: async () => {},
    },
    trigger: (env, subject) => {
      for (const h of handlers) h(env, subject);
    },
    registrationCount: () => handlers.size,
  };
}

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    source: "metafactory.pilot.local",
    type: "review.cycle.completed",
    timestamp: "2026-05-09T12:00:00Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: true,
      model_class: "any",
    },
    payload: { repo: "grove", urgency: "normal" },
    ...overrides,
  };
}

interface RecordingAdapter {
  adapter: SurfaceAdapter;
  calls: Envelope[];
}

function recordingAdapter(opts: {
  id: string;
  subjects: string[];
  filter?: SurfaceAdapter["filter"];
  visibility?: RendererVisibility;
  behaviour?: "ok" | "throw" | "hang";
  hangMs?: number;
}): RecordingAdapter {
  const calls: Envelope[] = [];
  return {
    calls,
    adapter: {
      id: opts.id,
      subjects: opts.subjects,
      ...(opts.filter ? { filter: opts.filter } : {}),
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
      render: async (env) => {
        calls.push(env);
        if (opts.behaviour === "throw") {
          throw new Error(`adapter "${opts.id}" intentional failure`);
        }
        if (opts.behaviour === "hang") {
          await new Promise((r) => setTimeout(r, opts.hangMs ?? 60_000));
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// subjectMatches
// ---------------------------------------------------------------------------

describe("subjectMatches — literal", () => {
  test("identical literal subject matches", () => {
    expect(subjectMatches("local.metafactory.review.cycle.completed", "local.metafactory.review.cycle.completed")).toBe(true);
  });

  test("non-matching literal does not match", () => {
    expect(subjectMatches("local.metafactory.review.cycle.completed", "local.metafactory.review.cycle.requested")).toBe(false);
  });

  test("longer pattern than subject does not match", () => {
    expect(subjectMatches("local.metafactory.review.cycle.completed", "local.metafactory.review")).toBe(false);
  });

  test("longer subject than literal pattern does not match", () => {
    expect(subjectMatches("local.metafactory.review", "local.metafactory.review.cycle.completed")).toBe(false);
  });

  test("empty pattern never matches", () => {
    expect(subjectMatches("", "local.x")).toBe(false);
  });

  test("empty subject never matches", () => {
    expect(subjectMatches("local.x", "")).toBe(false);
  });
});

describe("subjectMatches — `*` single segment", () => {
  test("`*` matches any single segment", () => {
    expect(subjectMatches("local.metafactory.review.*.completed", "local.metafactory.review.cycle.completed")).toBe(true);
    expect(subjectMatches("local.metafactory.review.*.completed", "local.metafactory.review.errand.completed")).toBe(true);
  });

  test("`*` does NOT span multiple segments", () => {
    expect(subjectMatches("local.metafactory.review.*.completed", "local.metafactory.review.cycle.foo.completed")).toBe(false);
  });

  test("`*` requires exactly one segment present", () => {
    expect(subjectMatches("local.metafactory.review.*", "local.metafactory.review")).toBe(false);
    expect(subjectMatches("local.metafactory.review.*", "local.metafactory.review.cycle")).toBe(true);
  });

  test("multiple `*` segments compose", () => {
    expect(subjectMatches("local.*.review.*.completed", "local.metafactory.review.cycle.completed")).toBe(true);
    expect(subjectMatches("local.*.review.*.completed", "local.metafactory.review.cycle.requested")).toBe(false);
  });
});

describe("subjectMatches — `>` terminal wildcard", () => {
  test("`>` matches any number of trailing segments (≥1)", () => {
    expect(subjectMatches("local.metafactory.review.>", "local.metafactory.review.cycle.completed")).toBe(true);
    expect(subjectMatches("local.metafactory.review.>", "local.metafactory.review.errand")).toBe(true);
    expect(subjectMatches("local.metafactory.review.>", "local.metafactory.review.cycle.foo.bar.baz")).toBe(true);
  });

  test("`>` requires at least one trailing segment", () => {
    expect(subjectMatches("local.metafactory.review.>", "local.metafactory.review")).toBe(false);
  });

  test("`>` alone matches any non-empty subject (≥1 segment)", () => {
    expect(subjectMatches(">", "local")).toBe(true);
    expect(subjectMatches(">", "local.x.y")).toBe(true);
  });

  test("`>` non-terminal is treated as no-match (defensive)", () => {
    expect(subjectMatches("local.>.completed", "local.x.completed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// register / unregister
// ---------------------------------------------------------------------------

describe("createSurfaceRouter — register / unregister", () => {
  test("registered adapter receives matching envelopes", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({ id: "a", subjects: ["review.>"] });
    router.register(a.adapter);

    const env = makeEnvelope();
    await router.dispatch(env);

    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]?.id).toBe(env.id);
  });

  test("unregister removes adapter from dispatch", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({ id: "a", subjects: ["review.>"] });
    const handle = router.register(a.adapter);

    handle.unregister();
    await router.dispatch(makeEnvelope());

    expect(a.calls).toHaveLength(0);
  });

  test("unregister is idempotent (calling twice is safe)", () => {
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({ id: "a", subjects: ["review.>"] });
    const handle = router.register(a.adapter);

    expect(() => {
      handle.unregister();
      handle.unregister();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Subject matching in dispatch
// ---------------------------------------------------------------------------

describe("createSurfaceRouter — subject match dispatch", () => {
  test("subject match → render called", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({ id: "a", subjects: ["local.metafactory.review.>"] });
    router.register(a.adapter);

    await router.dispatch(makeEnvelope(), "local.metafactory.review.cycle.completed");
    expect(a.calls).toHaveLength(1);
  });

  test("subject no-match → render NOT called", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({ id: "a", subjects: ["local.metafactory.review.>"] });
    router.register(a.adapter);

    await router.dispatch(makeEnvelope(), "local.metafactory.attention.item.enqueued");
    expect(a.calls).toHaveLength(0);
  });

  test("union semantics: any of the adapter's subjects can match", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({
      id: "a",
      subjects: ["local.metafactory.review.>", "local.metafactory.attention.>"],
    });
    router.register(a.adapter);

    await router.dispatch(makeEnvelope(), "local.metafactory.attention.item.enqueued");
    expect(a.calls).toHaveLength(1);
  });

  test("default subject (envelope.type) is used when subject omitted", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({ id: "a", subjects: ["review.cycle.completed"] });
    router.register(a.adapter);

    await router.dispatch(makeEnvelope({ type: "review.cycle.completed" }));
    expect(a.calls).toHaveLength(1);
  });

  test("two adapters subscribing to different subjects each get their own", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const review = recordingAdapter({ id: "review", subjects: ["local.metafactory.review.>"] });
    const attention = recordingAdapter({ id: "att", subjects: ["local.metafactory.attention.>"] });
    router.register(review.adapter);
    router.register(attention.adapter);

    await router.dispatch(makeEnvelope(), "local.metafactory.review.cycle.completed");
    expect(review.calls).toHaveLength(1);
    expect(attention.calls).toHaveLength(0);

    await router.dispatch(makeEnvelope(), "local.metafactory.attention.item.enqueued");
    expect(review.calls).toHaveLength(1);
    expect(attention.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Filter matching in dispatch
// ---------------------------------------------------------------------------

describe("createSurfaceRouter — filter dispatch", () => {
  test("filter match → render called", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({
      id: "a",
      subjects: ["local.metafactory.review.>"],
      filter: { payload: { repo: ["grove"] } },
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope({ payload: { repo: "grove" } }),
      "local.metafactory.review.cycle.completed",
    );
    expect(a.calls).toHaveLength(1);
  });

  test("filter no-match → render NOT called", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({
      id: "a",
      subjects: ["local.metafactory.review.>"],
      filter: { payload: { repo: ["myelin"] } },
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope({ payload: { repo: "grove" } }),
      "local.metafactory.review.cycle.completed",
    );
    expect(a.calls).toHaveLength(0);
  });

  test("subject matches but filter blocks → no render", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const pager = recordingAdapter({
      id: "pagerduty",
      subjects: ["local.metafactory.>"],
      filter: { payload: { urgency: ["high"] } },
    });
    router.register(pager.adapter);

    await router.dispatch(
      makeEnvelope({ payload: { urgency: "low" } }),
      "local.metafactory.review.cycle.completed",
    );
    expect(pager.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Adapter isolation
// ---------------------------------------------------------------------------

describe("createSurfaceRouter — adapter isolation (§5.3)", () => {
  test("failing adapter does not block siblings", async () => {
    const errors: { id: string; err: Error }[] = [];
    const router = createSurfaceRouter(fakeRuntime(), {
      onAdapterError: (id, err) => errors.push({ id, err }),
    });

    const broken = recordingAdapter({ id: "broken", subjects: ["review.>"], behaviour: "throw" });
    const ok1 = recordingAdapter({ id: "ok1", subjects: ["review.>"] });
    const ok2 = recordingAdapter({ id: "ok2", subjects: ["review.>"] });
    router.register(broken.adapter);
    router.register(ok1.adapter);
    router.register(ok2.adapter);

    await router.dispatch(makeEnvelope(), "review.cycle.completed");

    expect(broken.calls).toHaveLength(1);
    expect(ok1.calls).toHaveLength(1);
    expect(ok2.calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe("broken");
    expect(errors[0]?.err.message).toContain("intentional failure");
  });

  test("dispatch never throws — even if every adapter fails", async () => {
    const router = createSurfaceRouter(fakeRuntime(), { onAdapterError: () => {} });
    router.register(recordingAdapter({ id: "a", subjects: [">"], behaviour: "throw" }).adapter);
    router.register(recordingAdapter({ id: "b", subjects: [">"], behaviour: "throw" }).adapter);

    await expect(router.dispatch(makeEnvelope())).resolves.toBeUndefined();
  });

  test("synchronous throw before render returns a promise is captured", async () => {
    const errors: { id: string; err: Error }[] = [];
    const router = createSurfaceRouter(fakeRuntime(), {
      onAdapterError: (id, err) => errors.push({ id, err }),
    });

    const sync: SurfaceAdapter = {
      id: "sync-throw",
      subjects: [">"],
      render: () => {
        throw new Error("sync boom");
      },
    };
    const ok = recordingAdapter({ id: "ok", subjects: [">"] });
    router.register(sync);
    router.register(ok.adapter);

    await router.dispatch(makeEnvelope());

    expect(ok.calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe("sync-throw");
    expect(errors[0]?.err.message).toBe("sync boom");
  });

  test("a throwing onAdapterError hook does not poison dispatch", async () => {
    const router = createSurfaceRouter(fakeRuntime(), {
      onAdapterError: () => {
        throw new Error("hook is buggy");
      },
    });
    const broken = recordingAdapter({ id: "broken", subjects: [">"], behaviour: "throw" });
    const ok = recordingAdapter({ id: "ok", subjects: [">"] });
    router.register(broken.adapter);
    router.register(ok.adapter);

    await expect(router.dispatch(makeEnvelope())).resolves.toBeUndefined();
    expect(ok.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("createSurfaceRouter — render timeout", () => {
  test("hanging render is cancelled at renderTimeoutMs", async () => {
    const errors: { id: string; err: Error }[] = [];
    const router = createSurfaceRouter(fakeRuntime(), {
      renderTimeoutMs: 30,
      onAdapterError: (id, err) => errors.push({ id, err }),
    });

    const hanging = recordingAdapter({
      id: "hanging",
      subjects: [">"],
      behaviour: "hang",
      hangMs: 5000,
    });
    const fast = recordingAdapter({ id: "fast", subjects: [">"] });
    router.register(hanging.adapter);
    router.register(fast.adapter);

    const start = Date.now();
    await router.dispatch(makeEnvelope());
    const elapsed = Date.now() - start;

    // Should resolve well before the 5s hang — give a generous ceiling for
    // CI flakiness.
    expect(elapsed).toBeLessThan(2000);
    expect(fast.calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe("hanging");
    expect(errors[0]?.err.message).toContain("timeout");
  });

  test("default timeout (5s) is applied when not overridden", async () => {
    // Just check the default exists and dispatch works under it without
    // hanging. We don't actually wait 5s — register a fast adapter and
    // verify default-config dispatch works.
    const router = createSurfaceRouter(fakeRuntime());
    const fast = recordingAdapter({ id: "fast", subjects: [">"] });
    router.register(fast.adapter);
    await router.dispatch(makeEnvelope());
    expect(fast.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal contract
// ---------------------------------------------------------------------------

describe("createSurfaceRouter — render(envelope, signal)", () => {
  test("render() receives an AbortSignal that is not aborted on the happy path", async () => {
    const router = createSurfaceRouter(fakeRuntime(), { renderTimeoutMs: 1000 });
    let receivedSignal: AbortSignal | undefined;
    const adapter: SurfaceAdapter = {
      id: "signal-observer",
      subjects: [">"],
      render: async (_env, signal) => {
        receivedSignal = signal;
      },
    };
    router.register(adapter);

    await router.dispatch(makeEnvelope());

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
  });

  test("render() signal aborts when the render times out", async () => {
    const router = createSurfaceRouter(fakeRuntime(), { renderTimeoutMs: 30 });
    let observedSignal: AbortSignal | undefined;
    let abortedAt: number | null = null;
    const adapter: SurfaceAdapter = {
      id: "signal-aborter",
      subjects: [">"],
      render: (_env, signal) => {
        observedSignal = signal;
        return new Promise((resolve) => {
          // Don't resolve — let the timeout fire. Subscribe to abort so we
          // can record the cancellation moment.
          signal?.addEventListener("abort", () => {
            abortedAt = Date.now();
            resolve();
          });
        });
      },
    };
    router.register(adapter);

    const start = Date.now();
    await router.dispatch(makeEnvelope());
    const elapsed = Date.now() - start;

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(abortedAt).not.toBeNull();
    // Abort fires within the timeout window (with generous CI margin).
    expect(elapsed).toBeLessThan(500);
  });

  test("adapter that ignores the signal still gets timed out (race wins)", async () => {
    const errors: { id: string; err: Error }[] = [];
    const router = createSurfaceRouter(fakeRuntime(), {
      renderTimeoutMs: 30,
      onAdapterError: (id, err) => errors.push({ id, err }),
    });
    // Adapter does NOT subscribe to the signal — render hangs indefinitely.
    // Promise.race must still resolve via the timeout branch.
    const adapter: SurfaceAdapter = {
      id: "signal-ignorer",
      subjects: [">"],
      render: () => new Promise(() => {}),
    };
    router.register(adapter);

    const start = Date.now();
    await router.dispatch(makeEnvelope());
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe("signal-ignorer");
    expect(errors[0]?.err.message).toContain("timeout");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("createSurfaceRouter — lifecycle", () => {
  test("start() is idempotent", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    await router.start();
    await router.start();
    await router.start();
    // No assertion beyond "doesn't throw"
  });

  test("stop() is idempotent", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    await router.stop();
    await router.stop();
  });

  test("dispatch after stop is a no-op (resolves, no render)", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({ id: "a", subjects: [">"] });
    router.register(a.adapter);

    await router.start();
    await router.stop();
    await router.dispatch(makeEnvelope());

    expect(a.calls).toHaveLength(0);
  });

  test("dispatch before start works (start() is a state marker, not a gate)", async () => {
    // The current contract: start() is informational; dispatch is always
    // available pre-start. Pin this behaviour so a future refactor that
    // wants to gate dispatch behind start() must update this test
    // explicitly.
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({ id: "a", subjects: [">"] });
    router.register(a.adapter);

    await router.dispatch(makeEnvelope());
    expect(a.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration shape — fake MyelinRuntime path (the future wiring)
// ---------------------------------------------------------------------------

describe("createSurfaceRouter — runtime integration shape", () => {
  test("router accepts a MyelinRuntime stub and dispatches when called externally", async () => {
    // The legacy direct-dispatch path — verifies dispatch() works even
    // when the runtime hasn't fired the handler. Useful for unit tests
    // and for callers that want to push synthetic envelopes through.
    const runtime = fakeRuntime();
    const router = createSurfaceRouter(runtime);

    const a = recordingAdapter({ id: "a", subjects: ["local.metafactory.review.>"] });
    router.register(a.adapter);
    await router.start();

    const envs = [
      makeEnvelope({ id: "11111111-1111-4111-8111-111111111111" }),
      makeEnvelope({ id: "22222222-2222-4222-8222-222222222222" }),
      makeEnvelope({ id: "33333333-3333-4333-8333-333333333333" }),
    ];
    for (const e of envs) {
      await router.dispatch(e, "local.metafactory.review.cycle.completed");
    }

    expect(a.calls).toHaveLength(3);
    expect(a.calls.map((c) => c.id)).toEqual(envs.map((e) => e.id));

    await router.stop();
  });

  test("start() registers an onEnvelope handler on the runtime", async () => {
    const fake = fakeRuntimeWithTrigger();
    const router = createSurfaceRouter(fake.runtime);

    expect(fake.registrationCount()).toBe(0);
    await router.start();
    expect(fake.registrationCount()).toBe(1);
    await router.start(); // idempotent — must not double-register
    expect(fake.registrationCount()).toBe(1);
    await router.stop();
  });

  test("stop() unregisters the runtime onEnvelope handler", async () => {
    const fake = fakeRuntimeWithTrigger();
    const router = createSurfaceRouter(fake.runtime);

    await router.start();
    expect(fake.registrationCount()).toBe(1);
    await router.stop();
    expect(fake.registrationCount()).toBe(0);
    await router.stop(); // idempotent
    expect(fake.registrationCount()).toBe(0);
  });

  test("end-to-end: runtime envelope reaches registered adapter via wired handler", async () => {
    // The §4.355 integration acceptance shape: register a fake adapter,
    // simulate an envelope arriving from the runtime, assert the
    // adapter received it.
    const fake = fakeRuntimeWithTrigger();
    const router = createSurfaceRouter(fake.runtime);

    const a = recordingAdapter({ id: "a", subjects: ["local.metafactory.review.>"] });
    router.register(a.adapter);
    await router.start();

    fake.trigger(
      makeEnvelope({ id: "12121212-1212-4121-8121-121212121212" }),
      "local.metafactory.review.cycle.completed",
    );

    // Dispatch is fire-and-forget from the handler's perspective. Yield
    // to the microtask queue so allSettled completes before we assert.
    await new Promise((r) => setTimeout(r, 0));

    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]!.id).toBe("12121212-1212-4121-8121-121212121212");

    await router.stop();
  });

  test("after stop(), runtime envelopes do not reach adapters (handler unregistered)", async () => {
    const fake = fakeRuntimeWithTrigger();
    const router = createSurfaceRouter(fake.runtime);
    const a = recordingAdapter({ id: "a", subjects: ["local.metafactory.>"] });
    router.register(a.adapter);

    await router.start();
    fake.trigger(makeEnvelope(), "local.metafactory.review.cycle.completed");
    await new Promise((r) => setTimeout(r, 0));
    expect(a.calls).toHaveLength(1);

    await router.stop();
    fake.trigger(makeEnvelope(), "local.metafactory.review.cycle.completed");
    await new Promise((r) => setTimeout(r, 0));
    expect(a.calls).toHaveLength(1); // unchanged — stop unregistered the handler
  });
});

// ---------------------------------------------------------------------------
// IAW Phase A.4 — visibility filter (cortex#113, cortex#109 §B)
// ---------------------------------------------------------------------------

describe("evaluateVisibility — pure rule predicate", () => {
  function envWith(sov: Partial<Envelope["sovereignty"]>): Envelope {
    return makeEnvelope({
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: true,
        model_class: "any",
        ...sov,
      },
    });
  }

  test("undefined visibility passes through (no constraint = no filter)", () => {
    expect(evaluateVisibility(undefined, makeEnvelope())).toBeUndefined();
  });

  test("empty visibility object passes through (every field unset)", () => {
    expect(evaluateVisibility({}, makeEnvelope())).toBeUndefined();
  });

  describe("hide_residency_outside", () => {
    test("envelope residency in the allowlist passes", () => {
      expect(
        evaluateVisibility(
          { hide_residency_outside: ["CH", "DE"] },
          envWith({ data_residency: "CH" }),
        ),
      ).toBeUndefined();
    });

    test("envelope residency outside the allowlist returns residency_blocked", () => {
      expect(
        evaluateVisibility(
          { hide_residency_outside: ["CH", "DE"] },
          envWith({ data_residency: "US" }),
        ),
      ).toBe("residency_blocked");
    });

    test("single-entry allowlist still works", () => {
      expect(
        evaluateVisibility(
          { hide_residency_outside: ["NZ"] },
          envWith({ data_residency: "AU" }),
        ),
      ).toBe("residency_blocked");
    });
  });

  describe("require_model_class", () => {
    test("envelope model_class in the allowlist passes", () => {
      expect(
        evaluateVisibility(
          { require_model_class: ["local-only", "any"] },
          envWith({ model_class: "local-only" }),
        ),
      ).toBeUndefined();
    });

    test("envelope model_class outside the allowlist returns model_class_blocked", () => {
      expect(
        evaluateVisibility(
          { require_model_class: ["local-only"] },
          envWith({ model_class: "frontier" }),
        ),
      ).toBe("model_class_blocked");
    });

    test("`any` in the allowlist matches `any`-tagged envelopes", () => {
      expect(
        evaluateVisibility(
          { require_model_class: ["any"] },
          envWith({ model_class: "any" }),
        ),
      ).toBeUndefined();
    });
  });

  describe("max_classification", () => {
    test("cap `local` passes local envelopes", () => {
      expect(
        evaluateVisibility(
          { max_classification: "local" },
          envWith({ classification: "local" }),
        ),
      ).toBeUndefined();
    });

    test("cap `local` blocks federated envelopes", () => {
      expect(
        evaluateVisibility(
          { max_classification: "local" },
          envWith({ classification: "federated" }),
        ),
      ).toBe("classification_exceeds_max");
    });

    test("cap `local` blocks public envelopes", () => {
      expect(
        evaluateVisibility(
          { max_classification: "local" },
          envWith({ classification: "public" }),
        ),
      ).toBe("classification_exceeds_max");
    });

    test("cap `federated` allows local + federated, blocks public", () => {
      expect(
        evaluateVisibility(
          { max_classification: "federated" },
          envWith({ classification: "local" }),
        ),
      ).toBeUndefined();
      expect(
        evaluateVisibility(
          { max_classification: "federated" },
          envWith({ classification: "federated" }),
        ),
      ).toBeUndefined();
      expect(
        evaluateVisibility(
          { max_classification: "federated" },
          envWith({ classification: "public" }),
        ),
      ).toBe("classification_exceeds_max");
    });

    test("cap `public` allows everything (no cap)", () => {
      for (const c of ["local", "federated", "public"] as const) {
        expect(
          evaluateVisibility(
            { max_classification: "public" },
            envWith({ classification: c }),
          ),
        ).toBeUndefined();
      }
    });
  });

  describe("composition (AND semantics)", () => {
    const fullPolicy: RendererVisibility = {
      hide_residency_outside: ["CH", "DE"],
      require_model_class: ["local-only", "any"],
      max_classification: "federated",
    };

    test("envelope satisfying every rule passes", () => {
      expect(
        evaluateVisibility(
          fullPolicy,
          envWith({
            classification: "federated",
            data_residency: "CH",
            model_class: "local-only",
          }),
        ),
      ).toBeUndefined();
    });

    test("any single violation drops (residency)", () => {
      expect(
        evaluateVisibility(
          fullPolicy,
          envWith({
            classification: "federated",
            data_residency: "US",
            model_class: "local-only",
          }),
        ),
      ).toBe("residency_blocked");
    });

    test("any single violation drops (model_class)", () => {
      expect(
        evaluateVisibility(
          fullPolicy,
          envWith({
            classification: "federated",
            data_residency: "CH",
            model_class: "frontier",
          }),
        ),
      ).toBe("model_class_blocked");
    });

    test("any single violation drops (classification)", () => {
      expect(
        evaluateVisibility(
          fullPolicy,
          envWith({
            classification: "public",
            data_residency: "CH",
            model_class: "any",
          }),
        ),
      ).toBe("classification_exceeds_max");
    });

    test("residency reported first when multiple rules violated (deterministic order)", () => {
      // All three rules violated. The evaluator walks rules in declaration
      // order — residency first. Pin the order so a future refactor that
      // reshuffles can't silently change observable behaviour.
      expect(
        evaluateVisibility(
          fullPolicy,
          envWith({
            classification: "public",
            data_residency: "US",
            model_class: "frontier",
          }),
        ),
      ).toBe("residency_blocked");
    });
  });
});

describe("createSurfaceRouter — visibility filter wiring", () => {
  test("adapter with no visibility config receives every envelope (back-compat)", async () => {
    const router = createSurfaceRouter(fakeRuntime());
    const a = recordingAdapter({ id: "a", subjects: [">"] });
    router.register(a.adapter);

    // Three envelopes with progressively wider classification — all must
    // reach the adapter when no visibility config is set.
    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "local", data_residency: "NZ", max_hop: 0,
          frontier_ok: true, model_class: "any",
        },
      }),
      "local.metafactory.x.y.z",
    );
    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "federated", data_residency: "DE", max_hop: 1,
          frontier_ok: true, model_class: "frontier",
        },
      }),
      "federated.metafactory.x.y.z",
    );
    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "public", data_residency: "US", max_hop: 10,
          frontier_ok: true, model_class: "any",
        },
      }),
      "public.x.y.z",
    );

    expect(a.calls).toHaveLength(3);
  });

  test("residency drop: envelope outside allowlist is filtered", async () => {
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
    });
    const a = recordingAdapter({
      id: "dashboard",
      subjects: [">"],
      visibility: { hide_residency_outside: ["CH", "DE"] },
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "federated", data_residency: "US", max_hop: 1,
          frontier_ok: true, model_class: "any",
        },
      }),
      "federated.metafactory.x.y.z",
    );

    expect(a.calls).toHaveLength(0);
    // Yield so the fire-and-forget publish lands.
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0]?.type).toBe("system.access.filtered");
    expect(fake.published[0]?.payload).toEqual({
      renderer_id: "dashboard",
      envelope_subject: "federated.metafactory.x.y.z",
      reason: "residency_blocked",
    });
    expect(validateEnvelope(fake.published[0]!).ok).toBe(true);
  });

  test("residency pass: envelope inside allowlist is rendered", async () => {
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
    });
    const a = recordingAdapter({
      id: "dashboard",
      subjects: [">"],
      visibility: { hide_residency_outside: ["CH", "DE"] },
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "federated", data_residency: "CH", max_hop: 1,
          frontier_ok: true, model_class: "any",
        },
      }),
      "federated.metafactory.x.y.z",
    );

    expect(a.calls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.published).toHaveLength(0);
  });

  test("model_class drop: envelope outside allowlist is filtered", async () => {
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
    });
    const a = recordingAdapter({
      id: "local-only-surface",
      subjects: [">"],
      visibility: { require_model_class: ["local-only", "any"] },
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "local", data_residency: "NZ", max_hop: 0,
          frontier_ok: true, model_class: "frontier",
        },
      }),
      "local.metafactory.x.y.z",
    );

    expect(a.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0]?.payload.reason).toBe("model_class_blocked");
    expect(fake.published[0]?.payload.renderer_id).toBe("local-only-surface");
  });

  test("model_class pass: envelope in allowlist is rendered", async () => {
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
    });
    const a = recordingAdapter({
      id: "local-only-surface",
      subjects: [">"],
      visibility: { require_model_class: ["local-only", "any"] },
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "local", data_residency: "NZ", max_hop: 0,
          frontier_ok: true, model_class: "local-only",
        },
      }),
      "local.metafactory.x.y.z",
    );

    expect(a.calls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.published).toHaveLength(0);
  });

  test("max_classification drop: federated envelope on local-only surface filtered", async () => {
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
    });
    const a = recordingAdapter({
      id: "operator-dashboard",
      subjects: [">"],
      visibility: { max_classification: "local" },
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "federated", data_residency: "NZ", max_hop: 1,
          frontier_ok: true, model_class: "any",
        },
      }),
      "federated.metafactory.x.y.z",
    );

    expect(a.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0]?.payload.reason).toBe("classification_exceeds_max");
  });

  test("max_classification pass: federated cap admits local + federated, blocks public", async () => {
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
    });
    const a = recordingAdapter({
      id: "federation-surface",
      subjects: [">"],
      visibility: { max_classification: "federated" },
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "local", data_residency: "NZ", max_hop: 0,
          frontier_ok: true, model_class: "any",
        },
      }),
      "local.metafactory.x.y.z",
    );
    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "federated", data_residency: "NZ", max_hop: 1,
          frontier_ok: true, model_class: "any",
        },
      }),
      "federated.metafactory.x.y.z",
    );
    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "public", data_residency: "NZ", max_hop: 10,
          frontier_ok: true, model_class: "any",
        },
      }),
      "public.x.y.z",
    );

    expect(a.calls).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 0));
    // Public envelope dropped → one access-filtered emit.
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0]?.payload.reason).toBe("classification_exceeds_max");
  });

  test("combined visibility rules compose with AND semantics (pass)", async () => {
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
    });
    const a = recordingAdapter({
      id: "strict-dashboard",
      subjects: [">"],
      visibility: {
        hide_residency_outside: ["CH", "DE"],
        require_model_class: ["local-only", "any"],
        max_classification: "federated",
      },
    });
    router.register(a.adapter);

    // Satisfies every rule.
    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "federated", data_residency: "CH", max_hop: 1,
          frontier_ok: false, model_class: "local-only",
        },
      }),
      "federated.metafactory.x.y.z",
    );

    expect(a.calls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.published).toHaveLength(0);
  });

  test("combined visibility rules compose with AND semantics (each rule drops in isolation)", async () => {
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
    });
    const a = recordingAdapter({
      id: "strict-dashboard",
      subjects: [">"],
      visibility: {
        hide_residency_outside: ["CH", "DE"],
        require_model_class: ["local-only", "any"],
        max_classification: "federated",
      },
    });
    router.register(a.adapter);

    // 1. Residency violation
    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "federated", data_residency: "US", max_hop: 1,
          frontier_ok: false, model_class: "local-only",
        },
      }),
      "federated.metafactory.a.b.c",
    );
    // 2. Model-class violation
    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "federated", data_residency: "CH", max_hop: 1,
          frontier_ok: true, model_class: "frontier",
        },
      }),
      "federated.metafactory.d.e.f",
    );
    // 3. Classification violation
    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "public", data_residency: "CH", max_hop: 10,
          frontier_ok: false, model_class: "local-only",
        },
      }),
      "public.g.h.i",
    );

    expect(a.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.published).toHaveLength(3);
    expect(fake.published.map((e) => e.payload.reason)).toEqual([
      "residency_blocked",
      "model_class_blocked",
      "classification_exceeds_max",
    ]);
  });

  test("subject non-match → no access-filtered emit (silent)", async () => {
    // Visibility-drop emits an audit signal; subject non-match should not
    // — the adapter never subscribed to the topic in the first place.
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
    });
    const a = recordingAdapter({
      id: "dashboard",
      subjects: ["local.metafactory.review.>"],
      // Visibility set, but irrelevant since subject won't match.
      visibility: { max_classification: "local" },
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "public", data_residency: "NZ", max_hop: 10,
          frontier_ok: true, model_class: "any",
        },
      }),
      "public.something.else",
    );

    expect(a.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.published).toHaveLength(0);
  });

  test("payload filter blocks before visibility → no access-filtered emit (silent)", async () => {
    // The router evaluates payload filter BEFORE visibility; a payload
    // miss is treated as "not subscribed to this content" — silent. Pins
    // the layering decision so reordering would surface as a failing test.
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
    });
    const a = recordingAdapter({
      id: "dashboard",
      subjects: [">"],
      filter: { payload: { repo: ["myelin"] } }, // won't match
      visibility: { max_classification: "local" }, // would block too
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope({
        payload: { repo: "grove" },
        sovereignty: {
          classification: "public", data_residency: "NZ", max_hop: 10,
          frontier_ok: true, model_class: "any",
        },
      }),
      "public.x.y.z",
    );

    expect(a.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.published).toHaveLength(0);
  });

  test("multiple adapters: visibility filters per adapter independently", async () => {
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
    });
    const strict = recordingAdapter({
      id: "strict",
      subjects: [">"],
      visibility: { max_classification: "local" },
    });
    const permissive = recordingAdapter({
      id: "permissive",
      subjects: [">"],
      // no visibility — accepts everything
    });
    router.register(strict.adapter);
    router.register(permissive.adapter);

    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "federated", data_residency: "NZ", max_hop: 1,
          frontier_ok: true, model_class: "any",
        },
      }),
      "federated.metafactory.x.y.z",
    );

    expect(strict.calls).toHaveLength(0);
    expect(permissive.calls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0]?.payload.renderer_id).toBe("strict");
  });

  test("router without systemEventSource: visibility still drops, no emit", async () => {
    // Pre-MIG-7.2 callers (and unit tests) may construct the router
    // without a SystemEventSource. Visibility filtering MUST still work
    // — but the emit is skipped (logged only) because we can't build a
    // schema-valid envelope without `source`.
    const fake = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(fake.runtime); // no systemEventSource
    const a = recordingAdapter({
      id: "dashboard",
      subjects: [">"],
      visibility: { max_classification: "local" },
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope({
        sovereignty: {
          classification: "public", data_residency: "NZ", max_hop: 10,
          frontier_ok: true, model_class: "any",
        },
      }),
      "public.x.y.z",
    );

    expect(a.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.published).toHaveLength(0); // no emit (no source)
  });
});

// ---------------------------------------------------------------------------
// IAW Phase D.2 — federation accept/deny gate
// ---------------------------------------------------------------------------

function makeFederatedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return makeEnvelope({
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 1,
      frontier_ok: true,
      model_class: "any",
    },
    ...overrides,
  });
}

function makeSignedByChain(principals: string[]): SignedBy[] {
  return principals.map((principal, i) => ({
    method: "ed25519" as const,
    principal,
    signature: `sig-${i}`,
    at: "2026-05-09T12:00:00Z",
  }));
}

function makeNetwork(overrides: Partial<PolicyFederatedNetwork> = {}): PolicyFederatedNetwork {
  return {
    id: "research-collab",
    leaf_node: "leaf-research",
    peers: [],
    accept_subjects: ["federated.research-collab.tasks.code-review.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 1,
    ...overrides,
  };
}

function networksMap(networks: PolicyFederatedNetwork[]): Map<string, PolicyFederatedNetwork> {
  return new Map(networks.map((n) => [n.id, n]));
}

describe("evaluateFederationGate — accept-list", () => {
  test("accept-list match → allow", () => {
    const decision = evaluateFederationGate(
      "federated.research-collab.tasks.code-review.typescript",
      makeFederatedEnvelope(),
      networksMap([makeNetwork()]),
    );
    expect(decision).toBe("allow");
  });

  test("accept-list miss → peer_not_in_accept_list (network known)", () => {
    const decision = evaluateFederationGate(
      "federated.research-collab.tasks.other.thing",
      makeFederatedEnvelope(),
      networksMap([makeNetwork()]),
    );
    expect(decision).toEqual({
      kind: "peer_not_in_accept_list",
      networkId: "research-collab",
    });
  });

  test("empty accept_subjects[] denies everything for that network", () => {
    const decision = evaluateFederationGate(
      "federated.research-collab.tasks.code-review.ts",
      makeFederatedEnvelope(),
      networksMap([makeNetwork({ accept_subjects: [] })]),
    );
    expect(decision).toMatchObject({ kind: "peer_not_in_accept_list", networkId: "research-collab" });
  });
});

describe("evaluateFederationGate — deny-list precedence", () => {
  test("deny-list match overrides accept-list → peer_deny_list", () => {
    const decision = evaluateFederationGate(
      "federated.research-collab.tasks.code-review.private.secret",
      makeFederatedEnvelope(),
      networksMap([
        makeNetwork({
          accept_subjects: ["federated.research-collab.tasks.code-review.>"],
          deny_subjects: ["federated.research-collab.tasks.*.private.>"],
        }),
      ]),
    );
    expect(decision).toEqual({
      kind: "peer_deny_list",
      networkId: "research-collab",
      matched_pattern: "federated.research-collab.tasks.*.private.>",
    });
  });

  test("deny-list reports the first matching pattern", () => {
    const decision = evaluateFederationGate(
      "federated.research-collab.tasks.x",
      makeFederatedEnvelope(),
      networksMap([
        makeNetwork({
          accept_subjects: ["federated.research-collab.>"],
          deny_subjects: [
            "federated.research-collab.tasks.>",
            "federated.research-collab.tasks.x",
          ],
        }),
      ]),
    );
    expect(decision).toMatchObject({
      kind: "peer_deny_list",
      matched_pattern: "federated.research-collab.tasks.>",
    });
  });
});

describe("evaluateFederationGate — unknown network", () => {
  test("no network entry → peer_not_in_accept_list with unknown_network: true", () => {
    const decision = evaluateFederationGate(
      "federated.unknown-net.tasks.x",
      makeFederatedEnvelope(),
      networksMap([makeNetwork()]),
    );
    expect(decision).toEqual({
      kind: "peer_not_in_accept_list",
      networkId: "unknown-net",
      unknown_network: true,
    });
  });

  test("empty networks map → unknown_network for every federated subject", () => {
    const decision = evaluateFederationGate(
      "federated.research-collab.tasks.code-review.ts",
      makeFederatedEnvelope(),
      new Map(),
    );
    expect(decision).toEqual({
      kind: "peer_not_in_accept_list",
      networkId: "research-collab",
      unknown_network: true,
    });
  });

  test("malformed subject (no network id segment) → unknown_network with <malformed> sentinel", () => {
    const decision = evaluateFederationGate(
      "federated.",
      makeFederatedEnvelope(),
      networksMap([makeNetwork()]),
    );
    expect(decision).toEqual({
      kind: "peer_not_in_accept_list",
      networkId: "<malformed>",
      unknown_network: true,
    });
  });

  test("non-federated subject passes through (defensive fail-open)", () => {
    // Out-of-scope subjects shouldn't be denied by this helper — the
    // caller is supposed to pre-filter on `startsWith("federated.")`.
    const decision = evaluateFederationGate(
      "local.metafactory.review.cycle.completed",
      makeFederatedEnvelope(),
      networksMap([makeNetwork()]),
    );
    expect(decision).toBe("allow");
  });
});

describe("evaluateFederationGate — max_hop", () => {
  test("signed_by.length > max_hop → max_hop_exceeded", () => {
    const decision = evaluateFederationGate(
      "federated.research-collab.tasks.code-review.ts",
      makeFederatedEnvelope({
        signed_by: makeSignedByChain(["did:mf:alpha", "did:mf:beta"]),
      }),
      networksMap([makeNetwork({ max_hop: 1 })]),
    );
    expect(decision).toEqual({
      kind: "max_hop_exceeded",
      networkId: "research-collab",
      observed_hops: 2,
      max_hop: 1,
    });
  });

  test("signed_by.length == max_hop → allow (cap is inclusive)", () => {
    const decision = evaluateFederationGate(
      "federated.research-collab.tasks.code-review.ts",
      makeFederatedEnvelope({
        signed_by: makeSignedByChain(["did:mf:alpha"]),
      }),
      networksMap([makeNetwork({ max_hop: 1 })]),
    );
    expect(decision).toBe("allow");
  });

  test("max_hop=0 + unsigned envelope → allow (no relay required)", () => {
    const decision = evaluateFederationGate(
      "federated.research-collab.tasks.code-review.ts",
      makeFederatedEnvelope(),
      networksMap([makeNetwork({ max_hop: 0 })]),
    );
    expect(decision).toBe("allow");
  });

  test("max_hop=0 + 1 stamp → max_hop_exceeded", () => {
    const decision = evaluateFederationGate(
      "federated.research-collab.tasks.code-review.ts",
      makeFederatedEnvelope({
        signed_by: makeSignedByChain(["did:mf:alpha"]),
      }),
      networksMap([makeNetwork({ max_hop: 0 })]),
    );
    expect(decision).toMatchObject({ kind: "max_hop_exceeded", observed_hops: 1, max_hop: 0 });
  });

  test("deny-list precedence: hop overage on a deny-listed subject reports peer_deny_list", () => {
    // Deny-list runs before hop counting; the deny reason is what
    // the principal sees, not the hop fact.
    const decision = evaluateFederationGate(
      "federated.research-collab.tasks.private.secret",
      makeFederatedEnvelope({
        signed_by: makeSignedByChain(["a", "b", "c"]),
      }),
      networksMap([
        makeNetwork({
          accept_subjects: ["federated.research-collab.>"],
          deny_subjects: ["federated.research-collab.tasks.private.>"],
          max_hop: 0,
        }),
      ]),
    );
    expect(decision).toMatchObject({ kind: "peer_deny_list" });
  });
});

describe("createSurfaceRouter — D.2 federation gating end-to-end", () => {
  function withFederation(networks: PolicyFederatedNetwork[]): PolicyFederated {
    return { networks };
  }

  test("accepted federated.* envelope fans out to matching adapter", async () => {
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      federated: withFederation([makeNetwork()]),
    });
    const a = recordingAdapter({
      id: "fed-adapter",
      subjects: ["federated.research-collab.>"],
    });
    router.register(a.adapter);

    await router.dispatch(
      makeFederatedEnvelope({ type: "tasks.code-review.typescript" }),
      "federated.research-collab.tasks.code-review.typescript",
    );

    expect(a.calls).toHaveLength(1);
    // No deny envelope emitted on allow.
    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(0);
  });

  test("accept-list miss drops fan-out AND emits system.access.denied", async () => {
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      federated: withFederation([makeNetwork()]),
    });
    const a = recordingAdapter({
      id: "fed-adapter",
      subjects: ["federated.research-collab.>"],
    });
    router.register(a.adapter);

    await router.dispatch(
      makeFederatedEnvelope({ type: "tasks.other.thing" }),
      "federated.research-collab.tasks.other.thing",
    );

    expect(a.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(1);
    const denied = published[0]!;
    expect(denied.type).toBe("system.access.denied");
    expect(denied.payload).toMatchObject({
      capability: "federated.subject_dispatch",
      network_id: "research-collab",
      envelope_subject: "federated.research-collab.tasks.other.thing",
      reason: { kind: "peer_not_in_accept_list" },
    });
  });

  test("deny-list match drops fan-out AND emits peer_deny_list", async () => {
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      federated: withFederation([
        makeNetwork({
          accept_subjects: ["federated.research-collab.tasks.>"],
          deny_subjects: ["federated.research-collab.tasks.*.private.>"],
        }),
      ]),
    });
    const a = recordingAdapter({
      id: "fed-adapter",
      subjects: ["federated.research-collab.>"],
    });
    router.register(a.adapter);

    await router.dispatch(
      makeFederatedEnvelope({ type: "tasks.code-review.private.secret" }),
      "federated.research-collab.tasks.code-review.private.secret",
    );

    expect(a.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toMatchObject({
      reason: {
        kind: "peer_deny_list",
        matched_pattern: "federated.research-collab.tasks.*.private.>",
      },
      network_id: "research-collab",
    });
  });

  test("hop overage drops fan-out AND emits max_hop_exceeded", async () => {
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      federated: withFederation([makeNetwork({ max_hop: 1 })]),
    });
    const a = recordingAdapter({
      id: "fed-adapter",
      subjects: ["federated.research-collab.>"],
    });
    router.register(a.adapter);

    await router.dispatch(
      makeFederatedEnvelope({
        type: "tasks.code-review.typescript",
        signed_by: makeSignedByChain(["did:mf:alpha", "did:mf:beta", "did:mf:gamma"]),
      }),
      "federated.research-collab.tasks.code-review.typescript",
    );

    expect(a.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toMatchObject({
      reason: {
        kind: "max_hop_exceeded",
        observed_hops: 3,
        max_hop: 1,
      },
      network_id: "research-collab",
    });
  });

  test("no federated config → gate inert, federated.* envelopes flow through", async () => {
    // Mirror of the C.3.1 policy-engine contract: an unconfigured
    // gate is a no-op. cortex.yaml without `federated:` keeps
    // pre-D.2 behaviour — federated.* subjects flow to matching
    // adapters via classification alone.
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      // No `federated:` block — principal hasn't declared any networks.
    });
    const a = recordingAdapter({
      id: "fed-adapter",
      subjects: ["federated.research-collab.>"],
    });
    router.register(a.adapter);

    await router.dispatch(
      makeFederatedEnvelope({ type: "tasks.code-review.ts" }),
      "federated.research-collab.tasks.code-review.ts",
    );

    // Adapter receives the envelope: gate didn't engage.
    expect(a.calls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(0);
  });

  test("empty networks[] → gate inert (same as omitting the block)", async () => {
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      federated: { networks: [] },
    });
    const a = recordingAdapter({
      id: "fed-adapter",
      subjects: ["federated.research-collab.>"],
    });
    router.register(a.adapter);

    await router.dispatch(
      makeFederatedEnvelope({ type: "tasks.code-review.ts" }),
      "federated.research-collab.tasks.code-review.ts",
    );

    expect(a.calls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(0);
  });

  test("unknown network id in subject → denied with unknown_network: true", async () => {
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      federated: withFederation([makeNetwork({ id: "research-collab" })]),
    });
    const a = recordingAdapter({
      id: "fed-adapter",
      subjects: ["federated.>"],
    });
    router.register(a.adapter);

    await router.dispatch(
      makeFederatedEnvelope({ type: "tasks.x" }),
      "federated.some-other-net.tasks.x",
    );

    expect(a.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toMatchObject({
      reason: { kind: "peer_not_in_accept_list", unknown_network: true },
      network_id: "some-other-net",
    });
  });

  test("local.* envelopes pass the federation gate unchanged", async () => {
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      // No federated config: local.* still flows.
    });
    const a = recordingAdapter({
      id: "local-adapter",
      subjects: ["local.metafactory.review.>"],
    });
    router.register(a.adapter);

    await router.dispatch(
      makeEnvelope(),
      "local.metafactory.review.cycle.completed",
    );

    expect(a.calls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    // No federation denial — the gate didn't run on a local.* subject.
    expect(published).toHaveLength(0);
  });

  test("denied envelope carries signed_by chain verbatim (audit attribution)", async () => {
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      federated: withFederation([makeNetwork()]),
    });

    const chain = makeSignedByChain(["did:mf:alpha-stack", "did:mf:beta-stack"]);
    await router.dispatch(
      makeFederatedEnvelope({
        type: "tasks.other.thing",
        signed_by: chain,
      }),
      "federated.research-collab.tasks.other.thing",
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(1);
    const denied = published[0]!;
    const payload = denied.payload;
    expect(payload.principal_id).toBe("did:mf:alpha-stack");
    expect(payload.signed_by).toHaveLength(2);
    expect((payload.signed_by as { principal: string }[])[0]?.principal).toBe(
      "did:mf:alpha-stack",
    );
  });

  test("denied envelope is schema-valid (round-trips through validateEnvelope)", async () => {
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      federated: withFederation([makeNetwork()]),
    });

    await router.dispatch(
      makeFederatedEnvelope({ type: "tasks.other.thing" }),
      "federated.research-collab.tasks.other.thing",
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(1);
    const result = validateEnvelope(published[0]!);
    expect(result.ok).toBe(true);
  });

  test("denial without systemEventSource is silent (no envelope emitted)", async () => {
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      // No systemEventSource — emission is a no-op + console log.
      federated: withFederation([makeNetwork()]),
    });
    const a = recordingAdapter({ id: "x", subjects: ["federated.>"] });
    router.register(a.adapter);

    await router.dispatch(
      makeFederatedEnvelope({ type: "tasks.other.thing" }),
      "federated.research-collab.tasks.other.thing",
    );

    // Adapter still drops because the gate fired.
    expect(a.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(0);
  });

  test("unsigned denied envelope reports principal_id=\"unknown\"", async () => {
    const { runtime, published } = fakeRuntimeWithPublishLog();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      federated: withFederation([makeNetwork()]),
    });

    await router.dispatch(
      makeFederatedEnvelope({ type: "tasks.other.thing" }),
      "federated.research-collab.tasks.other.thing",
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(1);
    expect(published[0]!.payload.principal_id).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// cortex#137 — defensive .catch() on emitAccessFiltered runtime.publish
// ---------------------------------------------------------------------------

describe("emitAccessFiltered — defensive .catch on publish failure (cortex#137)", () => {
  test("a rejecting runtime.publish surfaces stderr instead of unhandled rejection", async () => {
    // Build a runtime whose publish() REJECTS — simulates a future
    // regression of the "never throws" contract on MyelinRuntime.
    const rejectingRuntime: MyelinRuntime = {
      enabled: true,
      onEnvelope: () => ({ unregister: () => {} }),
      publish: async () => { throw new Error("simulated publish failure"); },
      stop: async () => {},
    };
    // Capture stderr writes.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as { write: (chunk: unknown) => boolean }).write = (chunk) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      const router = createSurfaceRouter(rejectingRuntime, {
        systemEventSource: TEST_SYSTEM_EVENT_SOURCE,
      });
      const a = recordingAdapter({
        id: "dashboard",
        subjects: [">"],
        visibility: { hide_residency_outside: ["CH", "DE"] },
      });
      router.register(a.adapter);
      await router.dispatch(
        makeEnvelope({
          sovereignty: {
            classification: "federated", data_residency: "US", max_hop: 1,
            frontier_ok: true, model_class: "any",
          },
        }),
        "federated.metafactory.x.y.z",
      );
      // Yield so the catch fires.
      await new Promise((r) => setTimeout(r, 0));
      // Adapter was filtered (no render).
      expect(a.calls).toHaveLength(0);
      // Stderr got the audit-failure alert — principal-visible signal
      // instead of silent drop.
      const alert = captured.find((c) => c.includes("system.access.filtered"));
      expect(alert).toBeDefined();
      expect(alert).toContain("simulated publish failure");
    } finally {
      (process.stderr as { write: typeof originalWrite }).write = originalWrite;
    }
  });
});
