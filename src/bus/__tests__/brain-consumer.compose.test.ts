/**
 * cortex#2257 — `compose` end-to-end at the consumer seam, integration
 * level: REAL `BrainConsumer` (its real post routing) + REAL
 * `DaemonBrainHost` (its real compose policy gates) + a fake brain + a FAKE
 * substrate seam (`ComposeFn`). No real NATS, socket, subprocess, or
 * `claude` spawn. Mirrors `brain-consumer.post-log.test.ts`'s harness.
 *
 * What this proves (the issue's integration criterion): a surface-style
 * flow where the brain emits `compose`, receives the substrate-rendered
 * `composed` text, and places that text into a `post` it already decided
 * to send — the post lands routed at the task's origin exactly as any
 * other post (the model never influenced routing), and the persona the
 * substrate saw is the agent's OWN (host-held), never brain wire input.
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
import { DaemonBrainHost, type ComposeFn } from "../../brain/daemon-brain-host";
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
const FAKE_NEWCOMER = "newcomer-fake-for-test";
const PERSONA = "You are the doorkeeper of this hall.";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("brain-consumer — compose → composed → post (cortex#2257)", () => {
  test("the brain composes, receives the substrate text, and places it into a post routed at the task's origin — persona is host-held, routing untouched by the model", async () => {
    const runtime = createRecordingRuntime();
    const brain = new FakeDaemonBrain();
    const composeCalls: { persona: string; intent: string; context?: string }[] = [];
    const composeFn: ComposeFn = async (opts) => {
      composeCalls.push(opts);
      return { ok: true, text: `Welcome in! (rendered for: ${opts.intent})` };
    };
    const host = new DaemonBrainHost({
      agentId: "escort-like",
      run: "bun b.ts",
      packDir: "/p",
      persona: PERSONA,
      transport: singleFakeDaemonTransport(brain),
      composeFn,
    });
    await host.start();
    const consumer = new BrainConsumer({
      agent: buildAgent(),
      source: SOURCE,
      runtime,
      daemonHost: host,
    });

    const decisionP = consumer.processEnvelope(mentionEnvelope(), "subj", null, "chat");
    await until(() => brain.hasTask());
    const tid = brain.taskId();

    // The deterministic shell asks for voice: short intent + the (untrusted)
    // newcomer message as context.
    brain.emit(
      JSON.stringify({
        v: 1,
        type: "compose",
        task_id: tid,
        compose_id: "welcome-1",
        intent: "greet this newcomer and walk the three things",
        context: "hello, I just arrived",
      }),
    );
    await until(() => brain.hasEvent("composed"));
    const composed = brain.received.find((e) => e.type === "composed");
    expect(composed).toMatchObject({ type: "composed", compose_id: "welcome-1" });
    const composedText = composed?.type === "composed" ? composed.text : "";
    expect(composedText).toContain("Welcome in!");

    // The substrate saw the agent's OWN persona (host-held) + the shell's
    // intent/context — never a brain-chosen model or system prompt (those
    // fields do not exist on the wire).
    expect(composeCalls).toEqual([
      {
        persona: PERSONA,
        intent: "greet this newcomer and walk the three things",
        context: "hello, I just arrived",
      },
    ]);

    // The brain places the composed text into the post it already decided.
    brain.emit(
      JSON.stringify({ v: 1, type: "post", task_id: tid, text: composedText }),
    );
    await until(() => posts(runtime).length === 1);
    const post = posts(runtime)[0];
    expect(post?.payload.text).toBe(composedText);
    // Routing is the task's origin — the model text changed the WORDS of the
    // post, never its destination.
    expect(routingOf(post)).toEqual({
      adapter_instance: FAKE_ADAPTER_INSTANCE,
      channel_id: FAKE_ARRIVALS_CHANNEL,
      thread_id: FAKE_ARRIVALS_CHANNEL,
    });

    expect(brain.hasEvent("effect_rejected")).toBe(false);

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: tid, status: "complete" }));
    const decision = await decisionP;
    expect(decision).toEqual({ kind: "ack" });
    await consumer.stop();
  });

  test("with NO compose seam wired the same flow degrades: compose refused cant_do, the brain falls back to its canned post, the task still completes", async () => {
    const runtime = createRecordingRuntime();
    const brain = new FakeDaemonBrain();
    const host = new DaemonBrainHost({
      agentId: "escort-like",
      run: "bun b.ts",
      packDir: "/p",
      persona: PERSONA,
      transport: singleFakeDaemonTransport(brain),
      // no composeFn — the deterministic-only deployment
    });
    await host.start();
    const consumer = new BrainConsumer({
      agent: buildAgent(),
      source: SOURCE,
      runtime,
      daemonHost: host,
    });

    const decisionP = consumer.processEnvelope(mentionEnvelope(), "subj", null, "chat");
    await until(() => brain.hasTask());
    const tid = brain.taskId();

    brain.emit(
      JSON.stringify({
        v: 1,
        type: "compose",
        task_id: tid,
        compose_id: "welcome-1",
        intent: "greet this newcomer",
      }),
    );
    await until(() => brain.hasEvent("effect_rejected"));
    const rej = brain.received.find((e) => e.type === "effect_rejected");
    expect(rej).toMatchObject({ type: "effect_rejected", effect: "compose" });
    if (rej?.type === "effect_rejected") {
      expect(rej.reason.kind).toBe("cant_do");
    }

    // The brain falls back to its canned line — the effect stream continues.
    brain.emit(
      JSON.stringify({ v: 1, type: "post", task_id: tid, text: "canned welcome line" }),
    );
    await until(() => posts(runtime).length === 1);
    expect(posts(runtime)[0]?.payload.text).toBe("canned welcome line");

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: tid, status: "complete" }));
    const decision = await decisionP;
    expect(decision).toEqual({ kind: "ack" });
    await consumer.stop();
  });
});
