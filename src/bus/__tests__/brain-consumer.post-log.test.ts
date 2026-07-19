/**
 * cortex#2256 — `post_log` end-to-end at the consumer seam, integration
 * level: REAL `BrainConsumer` (its real `makeHooks` post + post_log routing)
 * + REAL `DaemonBrainHost` (its real post_log policy gates) + a fake brain.
 * No real NATS, socket, subprocess, or Discord. Mirrors
 * `brain-consumer.thread-retarget.test.ts`'s harness.
 *
 * What this proves (the issue's integration criterion): a surface-style flow
 * lands ONE message routed at the agent's bound LOG channel while a normal
 * `post` still routes to the task's origin thread — and the log routing is
 * host-derived (`presence.discord.logChannelId` → `DaemonBrainHost.logChannelId`),
 * never brain input. Also: the log note is channel-only (no thread_id) and is
 * NOT dragged along by a cortex#2248 thread retarget.
 *
 * All ids are obviously-fake, non-numeric placeholders (confidentiality
 * gate — never a realistic-looking digit snowflake).
 */

import { describe, expect, test } from "bun:test";

import {
  BrainConsumer,
  buildBrainTaskPayload,
  buildDispatchTaskEnvelope,
  type BrainConsumerAgent,
} from "../brain-consumer";
import type { Envelope } from "../myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../myelin/runtime";
import type { SystemEventSource } from "../system-events";
import { DaemonBrainHost } from "../../brain/daemon-brain-host";
import {
  FakeDaemonBrain,
  singleFakeDaemonTransport,
} from "../../brain/__tests__/fake-daemon-brain";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE: SystemEventSource = {
  principal: "test-op",
  agent: "cortex",
  instance: "local",
};

const FAKE_ARRIVALS_CHANNEL = "arrivals-channel-fake-for-test";
const FAKE_ADAPTER_INSTANCE = "escort-discord";
const FAKE_AGENT_CHANNEL = "agent-channel-fake-for-test";
const FAKE_LOG_CHANNEL = "stewards-log-channel-fake-for-test";
const FAKE_THREAD_ID = "created-thread-fake-for-test";
const FAKE_NEWCOMER = "newcomer-fake-for-test";

interface RecordingRuntime extends MyelinRuntime {
  published: Envelope[];
}

function createRecordingRuntime(): RecordingRuntime {
  const published: Envelope[] = [];
  const handlers = new Set<EnvelopeHandler>();
  return {
    enabled: false,
    published,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    publish: async (envelope: Envelope) => {
      published.push(envelope);
    },
    stop: async () => {},
  };
}

function buildAgent(): BrainConsumerAgent {
  return {
    id: "escort-like",
    capabilities: ["chat"],
    dispatchCapabilities: [],
  };
}

/** The mention-shaped brain task envelope `dispatchInboundToBrain` publishes. */
function mentionEnvelope(): Envelope {
  return buildDispatchTaskEnvelope({
    source: SOURCE,
    capability: "chat",
    family: "brain",
    payload: buildBrainTaskPayload({
      text: "I think I'm ready",
      user: FAKE_NEWCOMER,
      surface: "discord",
      channel: FAKE_ARRIVALS_CHANNEL,
      thread: FAKE_ARRIVALS_CHANNEL,
      adapterInstance: FAKE_ADAPTER_INSTANCE,
    }),
  });
}

/** Wait until `cond()` is true (poll), or throw after `timeoutMs`. */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function posts(runtime: RecordingRuntime): Envelope[] {
  return runtime.published.filter((e) => e.type === "dispatch.task.post");
}

function routingOf(e: Envelope | undefined): Record<string, unknown> | undefined {
  const r = e?.payload.response_routing;
  return r !== null && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
}

/** A consumer + daemon host + fake brain wired like the escort deployment. */
async function makeStack(opts: {
  withLogChannel: boolean;
  withThreadCapability?: boolean;
}): Promise<{
  runtime: RecordingRuntime;
  brain: FakeDaemonBrain;
  consumer: BrainConsumer;
  host: DaemonBrainHost;
}> {
  const runtime = createRecordingRuntime();
  const brain = new FakeDaemonBrain();
  const host = new DaemonBrainHost({
    agentId: "escort-like",
    run: "bun b.ts",
    packDir: "/p",
    transport: singleFakeDaemonTransport(brain),
    ...(opts.withLogChannel && { logChannelId: FAKE_LOG_CHANNEL }),
    ...(opts.withThreadCapability === true && {
      agentChannelId: FAKE_AGENT_CHANNEL,
      anonReachable: true,
      createPrivateThread: async () => ({ ok: true as const, threadId: FAKE_THREAD_ID }),
    }),
  });
  await host.start();
  const consumer = new BrainConsumer({
    agent: buildAgent(),
    source: SOURCE,
    runtime,
    daemonHost: host,
  });
  return { runtime, brain, consumer, host };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("brain-consumer — post_log routing (cortex#2256)", () => {
  test("surface flow: one post lands in the origin thread AND one post_log lands routed at the LOG channel (channel only, no thread)", async () => {
    const { runtime, brain, consumer } = await makeStack({ withLogChannel: true });

    const decisionP = consumer.processEnvelope(mentionEnvelope(), "subj", null, "chat");
    await until(() => brain.hasTask());
    const tid = brain.taskId();

    // The normal in-thread reply — routed to the task's origin exactly as today.
    brain.emit(
      JSON.stringify({ v: 1, type: "post", task_id: tid, text: "the three things look done" }),
    );
    // The steward note — the brain names NO channel; the host derives it.
    brain.emit(
      JSON.stringify({
        v: 1,
        type: "post_log",
        task_id: tid,
        text: "newcomer is ready for review",
      }),
    );
    await until(() => posts(runtime).length === 2);

    const [threadPost, logPost] = posts(runtime);
    expect(routingOf(threadPost)).toEqual({
      adapter_instance: FAKE_ADAPTER_INSTANCE,
      channel_id: FAKE_ARRIVALS_CHANNEL,
      thread_id: FAKE_ARRIVALS_CHANNEL,
    });
    expect(threadPost?.payload.text).toBe("the three things look done");

    // The log post: SAME adapter instance (the agent's own), DIFFERENT
    // channel (the bound log channel), and NO thread_id — a log note goes
    // to the channel, never a thread.
    expect(routingOf(logPost)).toEqual({
      adapter_instance: FAKE_ADAPTER_INSTANCE,
      channel_id: FAKE_LOG_CHANNEL,
    });
    expect(logPost?.payload.text).toBe("newcomer is ready for review");

    // No rejection went back — the effect passed every gate.
    expect(brain.hasEvent("effect_rejected")).toBe(false);

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: tid, status: "complete" }));
    const decision = await decisionP;
    expect(decision).toEqual({ kind: "ack" });
    await consumer.stop();
  });

  test("a cortex#2248 thread retarget does NOT drag post_log into the created thread — log notes stay channel-only", async () => {
    const { runtime, brain, consumer } = await makeStack({
      withLogChannel: true,
      withThreadCapability: true,
    });

    const decisionP = consumer.processEnvelope(mentionEnvelope(), "subj", null, "chat");
    await until(() => brain.hasTask());
    const tid = brain.taskId();

    // Open the private thread; subsequent task posts retarget into it.
    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: tid,
        name: "welcome newcomer",
        members: "source",
      }),
    );
    await until(() => brain.hasEvent("thread_created"));

    brain.emit(JSON.stringify({ v: 1, type: "post", task_id: tid, text: "in the thread" }));
    brain.emit(JSON.stringify({ v: 1, type: "post_log", task_id: tid, text: "steward note" }));
    await until(() => posts(runtime).length === 2);

    const [threadPost, logPost] = posts(runtime);
    // The task post followed the retarget into the created thread…
    expect(routingOf(threadPost)).toEqual({
      adapter_instance: FAKE_ADAPTER_INSTANCE,
      channel_id: FAKE_ARRIVALS_CHANNEL,
      thread_id: FAKE_THREAD_ID,
    });
    // …but the log note did not: channel-only, at the log channel.
    expect(routingOf(logPost)).toEqual({
      adapter_instance: FAKE_ADAPTER_INSTANCE,
      channel_id: FAKE_LOG_CHANNEL,
    });

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: tid, status: "complete" }));
    await decisionP;
    await consumer.stop();
  });

  test("no logChannelId bound → effect_rejected cant_do; no log envelope published; task posts and lifecycle unaffected", async () => {
    const { runtime, brain, consumer } = await makeStack({ withLogChannel: false });

    const decisionP = consumer.processEnvelope(mentionEnvelope(), "subj", null, "chat");
    await until(() => brain.hasTask());
    const tid = brain.taskId();

    brain.emit(JSON.stringify({ v: 1, type: "post_log", task_id: tid, text: "goes nowhere" }));
    await until(() => brain.hasEvent("effect_rejected"));
    const rej = brain.received.find((e) => e.type === "effect_rejected");
    expect(rej).toMatchObject({ type: "effect_rejected", effect: "post_log" });
    if (rej?.type === "effect_rejected") {
      expect(rej.reason.kind).toBe("cant_do");
    }

    // The in-thread flow is untouched by the refusal.
    brain.emit(JSON.stringify({ v: 1, type: "post", task_id: tid, text: "still fine" }));
    await until(() => posts(runtime).length === 1);
    expect(routingOf(posts(runtime)[0])).toEqual({
      adapter_instance: FAKE_ADAPTER_INSTANCE,
      channel_id: FAKE_ARRIVALS_CHANNEL,
      thread_id: FAKE_ARRIVALS_CHANNEL,
    });

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: tid, status: "complete" }));
    const decision = await decisionP;
    expect(decision).toEqual({ kind: "ack" });
    await consumer.stop();
  });
});
