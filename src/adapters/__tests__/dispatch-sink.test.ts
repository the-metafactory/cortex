/**
 * cortex#491 — dispatch sink (OUTBOUND) tests.
 *
 * Pins the consumer's contract (CONTEXT.md §Dispatch-sink / §Response-routing):
 *   - subscribes to `local.{principal}[.{stack}].dispatch.task.>`
 *   - reads `payload.response_routing` echoed by the runner
 *   - filters to envelopes whose `adapter_instance` is THIS instance
 *   - renders via `formatDispatchLifecycle` (reused from cortex#497)
 *   - posts to the EXACT originating channel/thread (`postResponse`)
 *   - `started` → `sendProgress` (typing/progress indicator)
 *   - single delivery path: exactly one post per terminal envelope
 */

import { describe, expect, test } from "bun:test";
import { createDispatchSink } from "../dispatch-sink";
import { MockAdapter } from "../mock";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { MyelinSubscriber } from "../../bus/myelin/subscriber";

/**
 * Minimal runtime stub. Records subscribe patterns and lets a test fire an
 * envelope through every registered `onEnvelope` handler. Mirrors the
 * recordingRuntime in the dispatch-listener tests.
 */
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
      // onEnvelope fan-out hands (envelope, subject); the sink filters by
      // envelope.type, so subject is informational here.
      for (const h of handlers) h(env, "local.metafactory.dispatch.task.completed");
    },
    subscribedPatterns,
    subscribers,
  };
}

function lifecycleEnvelope(
  type: string,
  payload: Record<string, unknown>,
): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    source: "metafactory.runner.local",
    type,
    timestamp: "2026-05-09T12:00:00Z",
    correlation_id: "task-1",
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

const routing = (instance: string, channel: string, thread?: string) => ({
  adapter_instance: instance,
  channel_id: channel,
  ...(thread !== undefined && { thread_id: thread }),
});

describe("dispatch-sink — subscription", () => {
  test("subscribes to the stack-less lifecycle pattern when no stack", async () => {
    const { runtime, subscribedPatterns } = fakeRuntime();
    const sink = createDispatchSink({ runtime, adapters: [], principal: "metafactory" });
    await sink.start();
    expect(sink.subjects).toEqual(["local.metafactory.dispatch.task.>"]);
    expect(subscribedPatterns).toEqual(["local.metafactory.dispatch.task.>"]);
  });

  test("subscribes to the stack-aware pattern when a stack is given", async () => {
    const { runtime, subscribedPatterns } = fakeRuntime();
    const sink = createDispatchSink({
      runtime,
      adapters: [],
      principal: "andreas",
      stack: "meta-factory",
    });
    await sink.start();
    expect(subscribedPatterns).toEqual([
      "local.andreas.meta-factory.dispatch.task.>",
    ]);
  });

  test("start() is idempotent — no duplicate subscriptions", async () => {
    const { runtime, subscribedPatterns } = fakeRuntime();
    const sink = createDispatchSink({ runtime, adapters: [], principal: "metafactory" });
    await sink.start();
    await sink.start();
    expect(subscribedPatterns).toHaveLength(1);
  });

  test("stop() drains subscribers and is idempotent", async () => {
    const { runtime, subscribers } = fakeRuntime();
    const sink = createDispatchSink({ runtime, adapters: [], principal: "metafactory" });
    await sink.start();
    await sink.stop();
    await sink.stop();
    expect(subscribers.every((s) => s.stopped)).toBe(true);
  });
});

describe("dispatch-sink — delivery to the originating target", () => {
  test("posts a completed reply to the exact channel + thread via formatDispatchLifecycle", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = new MockAdapter("discord-pai-collab");
    const sink = createDispatchSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      lifecycleEnvelope("dispatch.task.completed", {
        agent_id: "luna",
        result_summary: "first-line label",
        chat_response: "Here is the full answer.",
        response_routing: routing("discord-pai-collab", "C123", "T456"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages).toHaveLength(1);
    const sent = adapter.sentMessages[0]!;
    // Prefers the full chat_response over result_summary (cortex#491).
    expect(sent.text).toBe("Here is the full answer.");
    // EXACT originating target.
    expect(sent.target).toEqual({
      instanceId: "discord-pai-collab",
      channelId: "C123",
      threadId: "T456",
    });
  });

  test("falls back to result_summary when no chat_response is carried", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = new MockAdapter("discord-pai-collab");
    const sink = createDispatchSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      lifecycleEnvelope("dispatch.task.completed", {
        agent_id: "luna",
        result_summary: "🗣️ Luna: Done.",
        response_routing: routing("discord-pai-collab", "C123"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages[0]!.text).toBe("🗣️ Luna: Done.");
    // No thread_id → channel-scope target (no threadId field).
    expect(adapter.sentMessages[0]!.target).toEqual({
      instanceId: "discord-pai-collab",
      channelId: "C123",
    });
  });

  test("posts a failed reply via postResponse", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = new MockAdapter("discord-pai-collab");
    const sink = createDispatchSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      lifecycleEnvelope("dispatch.task.failed", {
        agent_id: "echo",
        error_summary: "claude exited 1",
        response_routing: routing("discord-pai-collab", "C9"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]!.text).toBe("Echo failed: claude exited 1");
  });

  test("started uses sendProgress, not postResponse", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = new MockAdapter("discord-pai-collab");
    const sink = createDispatchSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      lifecycleEnvelope("dispatch.task.started", {
        agent_id: "luna",
        response_routing: routing("discord-pai-collab", "C123", "T456"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages).toHaveLength(0);
    expect(adapter.progressSent).toHaveLength(1);
    expect(adapter.progressSent[0]!.text).toBe("Luna is working...");
  });
});

describe("dispatch-sink — instance filter (no cross-instance posting)", () => {
  test("ignores a lifecycle envelope routed to ANOTHER adapter instance", async () => {
    const { runtime, trigger } = fakeRuntime();
    const mine = new MockAdapter("discord-pai-collab");
    const sink = createDispatchSink({ runtime, adapters: [mine], principal: "metafactory" });
    await sink.start();

    trigger(
      lifecycleEnvelope("dispatch.task.completed", {
        agent_id: "luna",
        result_summary: "for someone else",
        response_routing: routing("discord-other-instance", "C999"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(mine.sentMessages).toHaveLength(0);
  });

  test("routes each envelope to its own instance among many adapters", async () => {
    const { runtime, trigger } = fakeRuntime();
    const a = new MockAdapter("inst-a");
    const b = new MockAdapter("inst-b");
    const sink = createDispatchSink({ runtime, adapters: [a, b], principal: "metafactory" });
    await sink.start();

    trigger(
      lifecycleEnvelope("dispatch.task.completed", {
        agent_id: "luna",
        result_summary: "to B",
        response_routing: routing("inst-b", "Cb"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(a.sentMessages).toHaveLength(0);
    expect(b.sentMessages).toHaveLength(1);
    expect(b.sentMessages[0]!.target.channelId).toBe("Cb");
  });
});

describe("dispatch-sink — no-routing and non-lifecycle envelopes", () => {
  test("ignores a lifecycle envelope with NO response_routing (bus-peer / Offer)", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = new MockAdapter("discord-pai-collab");
    const sink = createDispatchSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      lifecycleEnvelope("dispatch.task.completed", {
        agent_id: "luna",
        result_summary: "no routing here",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages).toHaveLength(0);
  });

  test("ignores non-lifecycle envelope types entirely", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = new MockAdapter("discord-pai-collab");
    const sink = createDispatchSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    trigger(
      lifecycleEnvelope("review.cycle.completed", {
        agent_id: "luna",
        response_routing: routing("discord-pai-collab", "C123"),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sentMessages).toHaveLength(0);
    expect(adapter.progressSent).toHaveLength(0);
  });

  test("single delivery path — exactly one post per terminal envelope", async () => {
    const { runtime, trigger } = fakeRuntime();
    const adapter = new MockAdapter("discord-pai-collab");
    const sink = createDispatchSink({ runtime, adapters: [adapter], principal: "metafactory" });
    await sink.start();

    const env = lifecycleEnvelope("dispatch.task.completed", {
      agent_id: "luna",
      chat_response: "answer",
      response_routing: routing("discord-pai-collab", "C123"),
    });
    trigger(env);
    await Promise.resolve();
    await Promise.resolve();

    // The sink is the ONLY thing posting — never doubles a single envelope.
    expect(adapter.sentMessages).toHaveLength(1);
  });
});
