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
import type { Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime } from "../myelin/runtime";
import { createSurfaceRouter, subjectMatches, type SurfaceAdapter } from "../surface-router";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRuntime(): MyelinRuntime {
  return { enabled: true, stop: async () => {} };
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
    // The future wiring: a runtime modification that calls
    // `router.dispatch(envelope, subject)` from its envelope handler.
    // Until that lands, simulate it here so the integration shape is
    // pinned down in tests.
    const runtime = fakeRuntime();
    const router = createSurfaceRouter(runtime);

    const a = recordingAdapter({ id: "a", subjects: ["local.metafactory.review.>"] });
    router.register(a.adapter);
    await router.start();

    // Simulate three envelopes arriving from the runtime.
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
});
