/**
 * cortex#2195 — enforcement-point tests: the MODEL-PLACEMENT gate stage inside
 * `handleDispatchEnvelope` (after harness selection, before the spawn —
 * RFC-0005 §2.5 consumer half). Mirrors the fixtures of
 * `dispatch-listener-admission.test.ts` (recording runtime, canonical
 * Tasks-Domain subject, fake CC factory; no trustResolver).
 *
 * The default dispatch resolves to the `claude-code` harness (no
 * agentRuntimesById), and `makeReceivedEnvelope` defaults to a LOCAL-ONLY
 * sovereignty block — so a `{ "claude-code": "frontier" }` placement map refuses
 * it; a frontier-cleared envelope, or a `local` placement, is admitted.
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { SystemEventSource } from "../../bus/system-events";
import {
  createDispatchListener,
  type CCSessionFactory,
  type DispatchTaskReceivedPayload,
} from "../dispatch-listener";
import type { CCSessionResult } from "../cc-session";
import { PolicyEngine } from "../../common/policy/engine";
import type { ModelPlacementConfig } from "../model-placement-gate";

const SOURCE: SystemEventSource = { principal: "metafactory", agent: "cortex", instance: "local" };
const SUBJECT = "local.metafactory.tasks.@did-mf-cortex.chat";
const TASK_ID = "11111111-1111-4111-8111-111111111111";

const TERMINAL_TYPES = new Set([
  "dispatch.task.completed",
  "dispatch.task.failed",
  "dispatch.task.aborted",
  "system.access.denied",
]);

async function settle(published: () => readonly Envelope[]): Promise<void> {
  const tick = () => new Promise<void>((r) => setTimeout(r, 2));
  const observeUntil = Date.now() + 250;
  while (Date.now() < observeUntil && !published().some((e) => TERMINAL_TYPES.has(e.type))) {
    await tick();
  }
  const idleUntil = Date.now() + 25;
  while (Date.now() < idleUntil) await tick();
}

function recordingRuntime(): {
  runtime: MyelinRuntime;
  published: Envelope[];
  trigger: (env: Envelope, subject: string) => void;
} {
  const handlers = new Set<Parameters<MyelinRuntime["onEnvelope"]>[0]>();
  const published: Envelope[] = [];
  return {
    runtime: {
      enabled: true,
      onEnvelope: (handler) => {
        handlers.add(handler);
        return { unregister: () => handlers.delete(handler) };
      },
      publish: async (env) => {
        published.push(env);
      },
      subscribe: async (pattern) =>
        ({ pattern, ready: Promise.resolve(), stop: async () => {} }) as unknown as Awaited<
          ReturnType<NonNullable<MyelinRuntime["subscribe"]>>
        >,
      stop: async () => {},
    },
    published,
    trigger: (env, subject) => {
      for (const h of handlers) h(env, subject);
    },
  };
}

/** `local` demands local execution; `frontier` clears it. */
function makeReceivedEnvelope(placement: "local" | "frontier"): Envelope {
  const payload: DispatchTaskReceivedPayload = { task_id: TASK_ID, agent_id: "cortex", prompt: "hi" };
  const sovereignty: Envelope["sovereignty"] =
    placement === "local"
      ? { classification: "local", data_residency: "NZ", max_hop: 0, frontier_ok: false, model_class: "local-only" }
      : { classification: "public", data_residency: "NZ", max_hop: 3, frontier_ok: true, model_class: "any" };
  return {
    id: "00000000-0000-4000-8000-000000000000",
    source: "metafactory.dispatch-handler.local",
    type: "dispatch.task.received",
    distribution_mode: "direct",
    target_assistant: "did:mf:cortex",
    timestamp: "2026-05-09T12:00:00Z",
    correlation_id: TASK_ID,
    sovereignty,
    payload: payload as unknown as Record<string, unknown>,
  };
}

function fakeFactory(): { factory: CCSessionFactory; spawnCount: () => number } {
  let spawns = 0;
  const result: CCSessionResult = { success: true, response: "Hi!", exitCode: 0, durationMs: 5, sessionId: "s" };
  const factory: CCSessionFactory = () => {
    spawns++;
    const session = { start() { return session; }, async wait() { return result; } };
    return session;
  };
  return { factory, spawnCount: () => spawns };
}

function engineGranting(capabilities: readonly string[]): PolicyEngine {
  return new PolicyEngine({
    principals: [{ id: "cortex", home_principal: "andreas", home_stack: "andreas/research", role: ["operator"], trust: [] }],
    roles: [{ id: "operator", capabilities }],
  });
}

const FRONTIER_MAP: ModelPlacementConfig = { harnesses: { "claude-code": "frontier" } };

describe("dispatch-listener — model-placement gate (cortex#2195, RFC-0005 §2.5)", () => {
  test("INERT without modelPlacement: a local-only envelope still spawns (byte-identical)", async () => {
    const r = recordingRuntime();
    const { factory, spawnCount } = fakeFactory();
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      // no modelPlacement — the gate is skipped entirely.
    });
    await listener.start();
    r.trigger(makeReceivedEnvelope("local"), SUBJECT);
    await settle(() => r.published);
    await listener.stop();

    expect(spawnCount()).toBe(1);
    expect(r.published.map((e) => e.type)).toContain("dispatch.task.completed");
  });

  test("REFUSED: only a frontier harness for a local-only envelope → policy_denied/term, NO spawn", async () => {
    const r = recordingRuntime();
    const { factory, spawnCount } = fakeFactory();
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      modelPlacement: FRONTIER_MAP,
    });
    await listener.start();
    r.trigger(makeReceivedEnvelope("local"), SUBJECT);
    await settle(() => r.published);
    await listener.stop();

    // Never spawned.
    expect(spawnCount()).toBe(0);

    const failed = r.published.find((e) => e.type === "dispatch.task.failed");
    expect(failed).toBeDefined();
    expect(failed?.correlation_id).toBe(TASK_ID);
    const p = failed?.payload as { reason?: { kind?: string; deny?: Record<string, unknown> } };
    // The RFC-0010 PERMANENT shape — never the transient not_now.
    expect(p.reason?.kind).toBe("policy_denied");
    expect(p.reason?.deny?.harness).toBe("claude-code");
    expect(p.reason?.deny?.placement).toBe("frontier");

    // No started/completed for the refused task.
    expect(r.published.some((e) => e.type === "dispatch.task.started")).toBe(false);
    expect(r.published.some((e) => e.type === "dispatch.task.completed")).toBe(false);
  });

  test("ALLOWED: a frontier-cleared envelope on the frontier harness spawns normally", async () => {
    const r = recordingRuntime();
    const { factory, spawnCount } = fakeFactory();
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      modelPlacement: FRONTIER_MAP,
    });
    await listener.start();
    r.trigger(makeReceivedEnvelope("frontier"), SUBJECT);
    await settle(() => r.published);
    await listener.stop();

    expect(spawnCount()).toBe(1);
    const types = r.published.map((e) => e.type);
    expect(types).toContain("dispatch.task.completed");
    expect(types.some((t) => t === "dispatch.task.failed")).toBe(false);
  });

  test("ALLOWED: a local-placement harness runs a local-only envelope", async () => {
    const r = recordingRuntime();
    const { factory, spawnCount } = fakeFactory();
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      modelPlacement: { harnesses: { "claude-code": "local" } },
    });
    await listener.start();
    r.trigger(makeReceivedEnvelope("local"), SUBJECT);
    await settle(() => r.published);
    await listener.stop();

    expect(spawnCount()).toBe(1);
    expect(r.published.map((e) => e.type)).toContain("dispatch.task.completed");
  });
});
