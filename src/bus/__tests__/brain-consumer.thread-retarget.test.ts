/**
 * cortex#2248 — post-after-create_private_thread retargeting, integration
 * level: REAL `BrainConsumer` (its real `makeHooks` post routing) + REAL
 * `DaemonBrainHost` (its real `create_private_thread` policy/success path) +
 * a fake brain and a fake adapter thread-create seam. No real NATS, socket,
 * subprocess, or Discord.
 *
 * The bug (first live repro: the guildhall escort's onboarding flow): after a
 * successful `create_private_thread`, the task's subsequent `post` effects
 * still routed to the task's ORIGINAL source — `onPost` publishes with a
 * per-task frozen `brainPostSource` — so the "private" greeting posted
 * publicly into the parent channel and the created thread stayed empty.
 *
 * The fix is a HOST-SIDE retarget (`hooks.onThreadCreated`): on success the
 * host tells the consumer, which repoints the task's post source at the
 * created thread. §5 property 1 holds throughout — `PostEffect` stays
 * target-less; the only routing values ever used are host-derived.
 *
 * The envelope driven here is built with `buildBrainTaskPayload` +
 * `buildDispatchTaskEnvelope(family: "brain")` — the EXACT construction the
 * inbound @-mention path (`dispatchInboundToBrain`, cortex.ts) publishes, so
 * this is the mention → create → post flow end-to-end minus the wire.
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
      text: "hello, I just arrived",
      user: FAKE_NEWCOMER,
      surface: "discord",
      channel: FAKE_ARRIVALS_CHANNEL,
      // Top-level mention: the inbound path keys thread = channel when the
      // message has no native thread (cortex.ts `thread = threadId ?? channelId`).
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
async function makeStack(opts: { withThreadCapability: boolean }): Promise<{
  runtime: RecordingRuntime;
  brain: FakeDaemonBrain;
  consumer: BrainConsumer;
  host: DaemonBrainHost;
  threadCalls: { channelId: string; name: string; memberIds: string[] }[];
}> {
  const runtime = createRecordingRuntime();
  const brain = new FakeDaemonBrain();
  const threadCalls: { channelId: string; name: string; memberIds: string[] }[] = [];
  const host = new DaemonBrainHost({
    agentId: "escort-like",
    run: "bun b.ts",
    packDir: "/p",
    transport: singleFakeDaemonTransport(brain),
    ...(opts.withThreadCapability && {
      agentChannelId: FAKE_AGENT_CHANNEL,
      anonReachable: true,
      // The fake ADAPTER seam — stands in for the Discord adapter's
      // createPrivateThread (REST create + add-member), same seam the boot
      // wiring injects via `makeCreatePrivateThreadFn`.
      createPrivateThread: async (callOpts: {
        channelId: string;
        name: string;
        memberIds: string[];
      }) => {
        threadCalls.push({ ...callOpts });
        return { ok: true as const, threadId: FAKE_THREAD_ID };
      },
    }),
  });
  await host.start();
  const consumer = new BrainConsumer({
    agent: buildAgent(),
    source: SOURCE,
    runtime,
    daemonHost: host,
  });
  return { runtime, brain, consumer, host, threadCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("brain-consumer — post routing after create_private_thread (cortex#2248)", () => {
  test("mention → create_private_thread → post: the post lands IN THE CREATED THREAD, not the parent channel; a pre-thread post still lands at the source", async () => {
    const { runtime, brain, consumer, threadCalls } = await makeStack({
      withThreadCapability: true,
    });

    const decisionP = consumer.processEnvelope(mentionEnvelope(), "subj", null, "chat");
    await until(() => brain.hasTask());
    const tid = brain.taskId();

    // 1. A post BEFORE any thread exists routes to the original source —
    // exactly as today.
    brain.emit(JSON.stringify({ v: 1, type: "post", task_id: tid, text: "one moment…" }));
    await until(() => posts(runtime).length === 1);
    expect(routingOf(posts(runtime)[0])).toEqual({
      adapter_instance: FAKE_ADAPTER_INSTANCE,
      channel_id: FAKE_ARRIVALS_CHANNEL,
      thread_id: FAKE_ARRIVALS_CHANNEL,
    });

    // 2. The brain opens its private thread (members: "source" — the only
    // form an anon-reachable agent may request).
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
    // Host policy did its normal job: agent's OWN channel, source-resolved member.
    expect(threadCalls).toEqual([
      {
        channelId: FAKE_AGENT_CHANNEL,
        name: "welcome newcomer",
        memberIds: [FAKE_NEWCOMER],
      },
    ]);

    // 3. THE FIX — the subsequent post routes into the created thread. Same
    // adapter instance and channel family, but thread_id is now the HOST-
    // created thread, so the dispatch sink posts there and the greeting is
    // no longer public.
    brain.emit(
      JSON.stringify({ v: 1, type: "post", task_id: tid, text: "welcome! this is your private thread" }),
    );
    await until(() => posts(runtime).length === 2);
    expect(routingOf(posts(runtime)[1])).toEqual({
      adapter_instance: FAKE_ADAPTER_INSTANCE,
      channel_id: FAKE_ARRIVALS_CHANNEL,
      thread_id: FAKE_THREAD_ID,
    });

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: tid, status: "complete" }));
    const decision = await decisionP;
    expect(decision).toEqual({ kind: "ack" });
    await consumer.stop();
  });

  test("a task that never creates a thread posts exactly as today — every post keeps the original routing", async () => {
    const { runtime, brain, consumer } = await makeStack({ withThreadCapability: true });

    const decisionP = consumer.processEnvelope(mentionEnvelope(), "subj", null, "chat");
    await until(() => brain.hasTask());
    const tid = brain.taskId();

    brain.emit(JSON.stringify({ v: 1, type: "post", task_id: tid, text: "reply one" }));
    brain.emit(JSON.stringify({ v: 1, type: "post", task_id: tid, text: "reply two" }));
    await until(() => posts(runtime).length === 2);
    for (const p of posts(runtime)) {
      expect(routingOf(p)).toEqual({
        adapter_instance: FAKE_ADAPTER_INSTANCE,
        channel_id: FAKE_ARRIVALS_CHANNEL,
        thread_id: FAKE_ARRIVALS_CHANNEL,
      });
    }

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: tid, status: "complete" }));
    await decisionP;
    await consumer.stop();
  });

  test("a REFUSED create_private_thread leaves post routing untouched (agent has no thread capability wired)", async () => {
    const { runtime, brain, consumer } = await makeStack({ withThreadCapability: false });

    const decisionP = consumer.processEnvelope(mentionEnvelope(), "subj", null, "chat");
    await until(() => brain.hasTask());
    const tid = brain.taskId();

    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: tid,
        name: "cannot happen",
        members: "source",
      }),
    );
    await until(() => brain.hasEvent("effect_rejected"));

    brain.emit(JSON.stringify({ v: 1, type: "post", task_id: tid, text: "still public path" }));
    await until(() => posts(runtime).length === 1);
    expect(routingOf(posts(runtime)[0])).toEqual({
      adapter_instance: FAKE_ADAPTER_INSTANCE,
      channel_id: FAKE_ARRIVALS_CHANNEL,
      thread_id: FAKE_ARRIVALS_CHANNEL,
    });

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: tid, status: "complete" }));
    await decisionP;
    await consumer.stop();
  });
});
