/**
 * cortex#502 — review sink (OUTBOUND) tests. Mirrors dispatch-sink.test.ts.
 *
 * Pins the consumer's contract:
 *   - subscribes to BOTH `local.{principal}[.{stack}].dispatch.task.>` AND
 *     `…review.verdict.>`
 *   - reads `payload.response_routing` (LOGICAL shape — `{ surface, channel,
 *     thread? }`)
 *   - filters by `surface` matching an adapter it drives (no cross-surface)
 *   - resolves logical→native via `adapter.resolveLogicalTarget`
 *   - `dispatch.task.started` → `sendProgress`
 *   - `review.verdict.*` / `completed`/`failed`/`aborted` → `postResponse`
 *   - verdict renders the one-liner + GitHub link + requester ping
 *   - ignores envelopes with no response_routing (pilot-only / Offer)
 *   - single post per terminal envelope; never throws when postResponse rejects
 */

import { describe, expect, test } from "bun:test";
import { createReviewSink } from "../review-sink";
import { MockAdapter } from "../mock";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { MyelinSubscriber } from "../../bus/myelin/subscriber";

function fakeRuntime(): {
  runtime: MyelinRuntime;
  trigger: (env: Envelope) => void;
  subscribedPatterns: string[];
  subscribers: { pattern: string; stopped: boolean }[];
} {
  const handlers = new Set<Parameters<MyelinRuntime["onEnvelope"]>[0]>();
  const subscribedPatterns: string[] = [];
  const subscribers: { pattern: string; stopped: boolean }[] = [];
  const runtime: MyelinRuntime = {
    enabled: true,
    onEnvelope: (handler: Parameters<MyelinRuntime["onEnvelope"]>[0]) => {
      handlers.add(handler);
      return { unregister: () => { handlers.delete(handler); } };
    },
    publish: async () => {},
    subscribe: async (pattern: string) => {
      subscribedPatterns.push(pattern);
      const entry = { pattern, stopped: false };
      subscribers.push(entry);
      return {
        stop: async () => { entry.stopped = true; },
      } as unknown as MyelinSubscriber;
    },
    stop: async () => {},
  };
  return {
    runtime,
    trigger: (env) => {
      for (const h of handlers) h(env, "local.metafactory.review.verdict.approved");
    },
    subscribedPatterns,
    subscribers,
  };
}

function envelope(type: string, payload: Record<string, unknown>): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    source: "metafactory.echo.local",
    type,
    timestamp: "2026-05-29T12:00:00Z",
    correlation_id: "req-1",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload,
  };
}

const logicalRouting = (surface: string, channel: string, thread?: string) => ({
  surface,
  channel,
  ...(thread !== undefined && { thread }),
});

function verdictPayload(overrides: Record<string, unknown> = {}) {
  return {
    repo: "the-metafactory/cortex",
    pr: 57,
    reviewer: "luna",
    verdict: "changes-requested",
    summary: "verdict: blockers=1 majors=2 nits=3 — request-changes",
    github_review_id: 123,
    github_review_url:
      "https://github.com/the-metafactory/cortex/pull/57#pullrequestreview-123",
    submitted_at: "2026-05-29T12:01:00Z",
    commit_id: "abc123",
    findings: { blockers: 1, majors: 2, nits: 3 },
    inline_comments: 5,
    ...overrides,
  };
}

// A mock adapter whose `platform`/`logicalSurface` is "discord" so it
// matches a `surface: "discord"` envelope.
function discordMock(instanceId = "discord-cortex"): MockAdapter {
  const a = new MockAdapter(instanceId);
  // Override the readonly `platform` for the surface filter. The sink
  // pre-filters on `adapter.platform === routing.surface`.
  Object.defineProperty(a, "platform", { value: "discord", writable: false });
  a.logicalSurface = "discord";
  return a;
}

describe("review-sink — subscription", () => {
  test("subscribes to BOTH dispatch.task.> and review.verdict.> (stack-less)", async () => {
    const { runtime, subscribedPatterns } = fakeRuntime();
    const sink = createReviewSink({ runtime, adapters: [], principal: "metafactory" });
    await sink.start();
    expect(sink.subjects).toEqual([
      "local.metafactory.dispatch.task.>",
      "local.metafactory.review.verdict.>",
      "local.metafactory.system.attention.>",
    ]);
    expect(subscribedPatterns).toEqual([
      "local.metafactory.dispatch.task.>",
      "local.metafactory.review.verdict.>",
      "local.metafactory.system.attention.>",
    ]);
  });

  test("subscribes to the stack-aware patterns when a stack is given", async () => {
    const { runtime, subscribedPatterns } = fakeRuntime();
    const sink = createReviewSink({
      runtime,
      adapters: [],
      principal: "andreas",
      stack: "meta-factory",
    });
    await sink.start();
    expect(subscribedPatterns).toEqual([
      "local.andreas.meta-factory.dispatch.task.>",
      "local.andreas.meta-factory.review.verdict.>",
      "local.andreas.meta-factory.system.attention.>",
    ]);
  });

  test("start() is idempotent; stop() drains and is idempotent", async () => {
    const { runtime, subscribedPatterns, subscribers } = fakeRuntime();
    const sink = createReviewSink({ runtime, adapters: [], principal: "metafactory" });
    await sink.start();
    await sink.start();
    expect(subscribedPatterns).toHaveLength(3);
    await sink.stop();
    await sink.stop();
    expect(subscribers.every((s) => s.stopped)).toBe(true);
  });
});

describe("review-sink — verdict delivery", () => {
  test("posts the verdict one-liner + GitHub link + requester ping to the resolved thread", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("review.verdict.changes-requested", {
        ...verdictPayload(),
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // resolveLogicalTarget was called with the logical triple.
    expect(adapter.logicalTargetsResolved).toEqual([
      { surface: "discord", channel: "cortex", thread: "cortex/pr/57" },
    ]);
    // Exactly one post, to the resolved native target.
    expect(adapter.sentMessages).toHaveLength(1);
    const sent = adapter.sentMessages[0]!;
    expect(sent.target).toEqual({
      instanceId: "discord-cortex",
      channelId: "chan:cortex",
      threadId: "thread:cortex/pr/57",
    });
    // Text carries the ping + emoji + verdict label + findings + url.
    expect(sent.text).toContain("@luna");
    expect(sent.text).toContain("🔴");
    expect(sent.text).toContain("requested changes");
    expect(sent.text).toContain("the-metafactory/cortex#57");
    expect(sent.text).toContain("1B/2M/3N");
    expect(sent.text).toContain(
      "https://github.com/the-metafactory/cortex/pull/57#pullrequestreview-123",
    );
  });

  test("approved verdict renders the ✅ label", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("review.verdict.approved", {
        ...verdictPayload({
          verdict: "approved",
          findings: { blockers: 0, majors: 0, nits: 0 },
        }),
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages[0]!.text).toContain("✅");
    expect(adapter.sentMessages[0]!.text).toContain("approved");
  });
});

describe("review-sink — lifecycle delivery", () => {
  test("dispatch.task.started → sendProgress (not postResponse)", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("dispatch.task.started", {
        agent_id: "luna",
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages).toHaveLength(0);
    expect(adapter.progressSent).toHaveLength(1);
    expect(adapter.progressSent[0]!.text).toContain("Luna is working");
  });

  test("dispatch.task.failed → postResponse error reply", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("dispatch.task.failed", {
        agent_id: "echo",
        error_summary: "claude exited 1",
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]!.text).toBe("Echo failed: claude exited 1");
  });

  test("dispatch.task.aborted → postResponse", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("dispatch.task.aborted", {
        agent_id: "echo",
        reason: "timeout",
        response_routing: logicalRouting("discord", "cortex"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]!.text).toContain("stopped");
  });
});

describe("review-sink — reviewer authorship", () => {
  test("posts as the REVIEWING agent (echo), not the first surface-matching adapter (luna)", async () => {
    // All three bots share one Discord guild/channel; the review must be
    // authored by the reviewer (echo), not whichever adapter is listed first.
    const { runtime, trigger } = fakeRuntime();
    const luna = discordMock("luna-discord"); // listed FIRST — the old bug posted here
    const echo = discordMock("echo-discord");
    const sink = createReviewSink({ runtime, adapters: [luna, echo], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("dispatch.task.completed", {
        agent_id: "echo",
        chat_response: "Code Review — cortex#464: approve. Clean mechanical rename.",
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/464"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(echo.sentMessages).toHaveLength(1);
    expect(echo.sentMessages[0]!.text).toContain("Code Review");
    expect(luna.sentMessages).toHaveLength(0); // NOT posted under Luna
  });

  test("verdict authored by reviewer field (echo) when adapters list luna first", async () => {
    const { runtime, trigger } = fakeRuntime();
    const luna = discordMock("luna-discord");
    const echo = discordMock("echo-discord");
    const sink = createReviewSink({ runtime, adapters: [luna, echo], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("review.verdict.approved", {
        ...verdictPayload({ verdict: "approved", reviewer: "echo" }),
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/464"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(echo.sentMessages).toHaveLength(1);
    expect(luna.sentMessages).toHaveLength(0);
  });
});

describe("review-sink — surface filter", () => {
  test("ignores an envelope for a surface this sink doesn't drive", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock(); // drives "discord"
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("review.verdict.approved", {
        ...verdictPayload({ verdict: "approved" }),
        response_routing: logicalRouting("slack", "cortex", "cortex/pr/57"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The pre-filter (`adapter.platform !== surface`) skips the adapter
    // entirely — resolveLogicalTarget is not even called.
    expect(adapter.logicalTargetsResolved).toHaveLength(0);
    expect(adapter.sentMessages).toHaveLength(0);
  });

  test("routes to the matching surface among many adapters", async () => {
    const { runtime, trigger } = fakeRuntime();
    const disc = discordMock("discord-cortex");
    const other = new MockAdapter("mock-other"); // platform "mock"
    const sink = createReviewSink({
      runtime,
      adapters: [other, disc],
      principal: "metafactory",
    });
    await sink.start();

    trigger(
      envelope("review.verdict.approved", {
        ...verdictPayload({ verdict: "approved" }),
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(other.sentMessages).toHaveLength(0);
    expect(disc.sentMessages).toHaveLength(1);
  });
});

describe("review-sink — no-routing and resilience", () => {
  test("ignores an envelope with NO response_routing (pilot-only / Offer)", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("review.verdict.approved", verdictPayload({ verdict: "approved" })),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.logicalTargetsResolved).toHaveLength(0);
    expect(adapter.sentMessages).toHaveLength(0);
  });

  test("ignores non-review/non-lifecycle envelope types entirely", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("review.cycle.completed", {
        agent_id: "luna",
        response_routing: logicalRouting("discord", "cortex"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages).toHaveLength(0);
    expect(adapter.progressSent).toHaveLength(0);
  });

  test("single post per terminal envelope (no double-reply)", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("review.verdict.approved", {
        ...verdictPayload({ verdict: "approved" }),
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages).toHaveLength(1);
  });

  test("verdict + co-emitted dispatch.task.completed → exactly ONE terminal post", async () => {
    // A successful review co-emits BOTH review.verdict.* (the human-facing
    // reply) AND dispatch.task.completed (whose result_summary duplicates the
    // verdict) on the same correlation_id + routing. The sink must post only
    // the verdict — completed is suppressed — so the thread isn't double-replied.
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    const routing = logicalRouting("discord", "cortex", "cortex/pr/57");
    trigger(
      envelope("review.verdict.approved", {
        ...verdictPayload({ verdict: "approved" }),
        response_routing: routing,
      }),
    );
    trigger(
      envelope("dispatch.task.completed", {
        result_summary: "verdict: blockers=0 majors=0 nits=0 — recommend: merge",
        response_routing: routing,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Exactly one terminal message, and it's the VERDICT (carries the `@luna`
    // requester ping, which only the verdict path adds) — not the completed
    // envelope's result_summary.
    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]?.text).toContain("@luna");
  });

  test("never throws when postResponse rejects", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    adapter.postResponse = async () => {
      throw new Error("rate limited");
    };
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    expect(() =>
      trigger(
        envelope("review.verdict.approved", {
          ...verdictPayload({ verdict: "approved" }),
          response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
        }),
      ),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// cortex#503 — presentation rendering + prose-fallback + never-JSON + idempotency
// ---------------------------------------------------------------------------

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

/** envelope() variant with an explicit id (for the idempotency test). */
function envelopeWithId(
  id: string,
  type: string,
  payload: Record<string, unknown>,
): Envelope {
  return { ...envelope(type, payload), id };
}

describe("review-sink — cortex#503 presentation rendering", () => {
  test("renders ONLY payload.presentation verbatim when present (not the one-liner)", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    const presentation =
      "### 🔴 Changes requested\n\nBlocking: SQL injection.\n\n" +
      "**Findings:** 1 blockers · 0 majors · 2 nits · 4 inline comments\n\n" +
      "[Review on GitHub](https://github.com/the-metafactory/cortex/pull/57#r1) (`deadbee`)";

    trigger(
      envelope("review.verdict.changes-requested", {
        ...verdictPayload({ presentation }),
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
      }),
    );
    await flushMicrotasks();

    expect(adapter.sentMessages).toHaveLength(1);
    const text = adapter.sentMessages[0]!.text;
    // The verbatim presentation markdown is present, with the reviewer ping.
    expect(text).toContain("@luna");
    expect(text).toContain(presentation);
    // It did NOT fall back to the one-liner format (which uses "1B/2M/3N").
    expect(text).not.toContain("1B/2M/3N");
  });

  test("falls back to the one-liner (never JSON) when presentation is absent", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    // verdictPayload() has NO presentation field.
    trigger(
      envelope("review.verdict.changes-requested", {
        ...verdictPayload(),
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
      }),
    );
    await flushMicrotasks();

    expect(adapter.sentMessages).toHaveLength(1);
    const text = adapter.sentMessages[0]!.text;
    expect(text).toContain("1B/2M/3N"); // the one-liner fallback
    // Never a raw JSON dump.
    expect(text).not.toContain('"verdict"');
    expect(text).not.toContain('"findings"');
    expect(text).not.toContain("```json");
  });

  test("prose-fallback dispatch.task.completed (chat_response) → posted as markdown reply", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    const prose = "I reviewed the PR.\n\nLGTM, no blockers.";
    trigger(
      envelope("dispatch.task.completed", {
        agent_id: "luna",
        result_summary: "I reviewed the PR.",
        chat_response: prose,
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
      }),
    );
    await flushMicrotasks();

    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]!.text).toBe(prose);
  });

  test("verdict-path completed (no chat_response) is still suppressed", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      envelope("dispatch.task.completed", {
        agent_id: "luna",
        result_summary: "verdict: blockers=0 — approved",
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
      }),
    );
    await flushMicrotasks();

    // No chat_response → this is the co-emitted completed; suppress it.
    expect(adapter.sentMessages).toHaveLength(0);
  });

  test("idempotent render — second delivery of same envelope.id is a no-op", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    const env = envelopeWithId(
      "11111111-1111-4111-8111-111111111111",
      "review.verdict.approved",
      {
        ...verdictPayload({ verdict: "approved" }),
        response_routing: logicalRouting("discord", "cortex", "cortex/pr/57"),
      },
    );

    trigger(env);
    await flushMicrotasks();
    trigger(env); // accidental double-delivery (same id)
    await flushMicrotasks();

    // Exactly ONE post despite two deliveries.
    expect(adapter.sentMessages).toHaveLength(1);
  });
});

describe("review-sink — attention delivery (ML.4)", () => {
  const attnPayload = (presentation: string) => ({
    attention: { id: "att:stale:wi-1", stack_id: "laptop", kind: "stale", severity: "low", work_item_id: "wi-1", session_id: null },
    deep_link_url: "https://cortex.meta-factory.ai/work-items/wi-1",
    presentation,
  });

  test("posts the deterministic presentation to the configured attention channel", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({
      runtime,
      adapters: [adapter],
      principal: "metafactory",
      attentionRouting: logicalRouting("discord", "attention"),
    });
    await sink.start();

    trigger(envelope("system.attention.opened", attnPayload("[low] stale needs attention — https://x/wi-1")));
    await flushMicrotasks();

    // Routed to the CONFIGURED attention channel (no response_routing on the envelope).
    expect(adapter.logicalTargetsResolved).toEqual([{ surface: "discord", channel: "attention" }]);
    expect(adapter.sentMessages).toHaveLength(1);
    // Posts the presentation verbatim (no @reviewer ping — attention isn't a reply).
    expect(adapter.sentMessages[0]!.text).toBe("[low] stale needs attention — https://x/wi-1");
    expect(adapter.sentMessages[0]!.text).not.toContain("@");
  });

  test("ignored when no attentionRouting is configured (no destination)", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();
    trigger(envelope("system.attention.resolved", attnPayload("[low] stale cleared")));
    await flushMicrotasks();
    expect(adapter.sentMessages).toHaveLength(0);
  });

  test("an envelope with no presentation is not posted", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({
      runtime, adapters: [adapter], principal: "metafactory",
      attentionRouting: logicalRouting("discord", "attention"),
    });
    await sink.start();
    trigger(envelope("system.attention.opened", { attention: {}, deep_link_url: null }));
    await flushMicrotasks();
    expect(adapter.sentMessages).toHaveLength(0);
  });

  test("attentionRouting must NOT rescue a non-attention envelope with no response_routing", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({
      runtime, adapters: [adapter], principal: "metafactory",
      attentionRouting: logicalRouting("discord", "attention"),
    });
    await sink.start();
    // A verdict with NO response_routing (pilot-only/Offer) must stay ignored —
    // attentionRouting is for system.attention.* only, never verdict/lifecycle.
    trigger(envelope("review.verdict.approved", verdictPayload({ verdict: "approved" })));
    await flushMicrotasks();
    expect(adapter.sentMessages).toHaveLength(0);
  });

  test("an attention envelope's own response_routing wins over attentionRouting", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = discordMock();
    const sink = createReviewSink({
      runtime, adapters: [adapter], principal: "metafactory",
      attentionRouting: logicalRouting("discord", "attention"),
    });
    await sink.start();
    trigger(
      envelope("system.attention.opened", {
        attention: { id: "att:stale:wi-1" },
        deep_link_url: null,
        presentation: "[low] stale needs attention",
        response_routing: logicalRouting("discord", "ops", "ops/thread"),
      })
    );
    await flushMicrotasks();
    // Routed to the envelope's own response_routing, not the configured default.
    expect(adapter.logicalTargetsResolved).toEqual([{ surface: "discord", channel: "ops", thread: "ops/thread" }]);
    expect(adapter.sentMessages).toHaveLength(1);
  });
});
