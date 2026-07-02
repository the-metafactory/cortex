/**
 * R26 P1 (cortex#1371) — enforcement-point tests: the ADMISSION GATE stage
 * inside `handleDispatchEnvelope` (after the policy allow, before harness
 * construction — design §4.2 enforcement point 1).
 *
 * Coverage:
 *   1. INERTNESS — no `admissionGate` option (i.e. no `policy.admission`
 *      block) ⇒ the dispatch pipeline emits exactly what it emitted pre-R26:
 *      no `system.admission.*` envelopes, session spawns normally. This is
 *      the listener-level proof of the CO-4 byte-identical contract.
 *   2. THROTTLE — a refusing gate ⇒ `system.admission.throttled` (audit leg)
 *      + terminal `dispatch.task.failed { kind: "not_now", retry_after_ms }`
 *      with the friendly renderer summary, and NO session spawn.
 *   3. ORDERING — a policy DENY never consults the admission gate (permanent
 *      refusals before transient ones, `gate-floor.ts:195-202`).
 *   4. IDENTITY — the gate is keyed on the SAME principal the policy gate
 *      resolved.
 *   5. LEASE LIFECYCLE — a `max_concurrent: 1` gate readmits after the first
 *      dispatch terminates (the `finally` release around the harness drain).
 *
 * Mirrors the fixtures of `dispatch-listener.test.ts` (recording runtime,
 * canonical Tasks-Domain subject, fake CC factory); chain verification is
 * deliberately unwired (no trustResolver) — admission ordering relative to
 * the POLICY gate is what's under test.
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
import { AdmissionGate } from "../../bus/admission";
import type { AdmissionPolicy } from "../../common/types/admission";
import type { ProvisionKv, ProvisionKvEntry } from "../../bus/jetstream/types";

const SOURCE: SystemEventSource = {
  principal: "metafactory",
  agent: "cortex",
  instance: "local",
};

const CANONICAL_CORTEX_CHAT_SUBJECT =
  "local.metafactory.tasks.@did-mf-cortex.chat";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID_2 = "22222222-2222-4222-8222-222222222222";

const TERMINAL_TYPES = new Set([
  "dispatch.task.completed",
  "dispatch.task.failed",
  "dispatch.task.aborted",
  "system.access.denied",
]);

/** Wait for a terminal envelope (same de-flake rationale as the sibling
 * suite, cortex#771): the pipeline's end is observable, never a fixed sleep. */
async function settle(
  published: () => readonly Envelope[],
  { minObserveMs = 250, idleMs = 25 }: { minObserveMs?: number; idleMs?: number } = {},
): Promise<void> {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
  const hasTerminal = () => published().some((e) => TERMINAL_TYPES.has(e.type));
  const observeUntil = Date.now() + minObserveMs;
  while (Date.now() < observeUntil && !hasTerminal()) {
    await tick();
  }
  const idleUntil = Date.now() + idleMs;
  while (Date.now() < idleUntil) {
    await tick();
  }
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
        return {
          unregister: () => {
            handlers.delete(handler);
          },
        };
      },
       
      publish: async (env) => {
        published.push(env);
      },
       
      subscribe: async (pattern) =>
        ({
          pattern,
          ready: Promise.resolve(),
          stop: async () => {},
        }) as unknown as Awaited<
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

function makeReceivedEnvelope(
  payloadOverrides: Partial<DispatchTaskReceivedPayload> = {},
): Envelope {
  const payload: DispatchTaskReceivedPayload = {
    task_id: TASK_ID,
    agent_id: "cortex",
    prompt: "say hello",
    ...payloadOverrides,
  };
  return {
    id: "00000000-0000-4000-8000-000000000000",
    source: "metafactory.dispatch-handler.local",
    type: "dispatch.task.received",
    distribution_mode: "direct",
    target_assistant: `did:mf:${payload.agent_id}`,
    timestamp: "2026-05-09T12:00:00Z",
    correlation_id: payload.task_id,
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload: payload as unknown as Record<string, unknown>,
  };
}

const SUCCESS_RESULT: CCSessionResult = {
  success: true,
  response: "Hello!",
  exitCode: 0,
  durationMs: 10,
  sessionId: "session-admission-test",
};

function fakeFactory(result: CCSessionResult): {
  factory: CCSessionFactory;
  spawnCount: () => number;
} {
  let spawns = 0;
  const factory: CCSessionFactory = () => {
    spawns++;
    const session = {
      start() {
        return session;
      },
      async wait() {
        return result;
      },
    };
    return session;
  };
  return { factory, spawnCount: () => spawns };
}

function engineGranting(capabilities: readonly string[]): PolicyEngine {
  return new PolicyEngine({
    principals: [
      {
        id: "cortex",
        home_principal: "andreas",
        home_stack: "andreas/research",
        role: ["operator"],
        trust: [],
      },
    ],
    roles: [{ id: "operator", capabilities }],
  });
}

/** In-memory CAS-faithful KV (same semantics as the gate suite's stub). */
function memoryKv(): ProvisionKv {
  const data = new Map<string, { value: Uint8Array; revision: number }>();
  let revisionCounter = 0;
  return {
     
    get: async (key): Promise<ProvisionKvEntry | null> => {
      const e = data.get(key);
      return e === undefined
        ? null
        : { value: e.value, revision: e.revision, operation: "PUT" };
    },
     
    create: async (key, value): Promise<number> => {
      if (data.has(key)) throw new Error("wrong last sequence: exists");
      const revision = ++revisionCounter;
      data.set(key, { value, revision });
      return revision;
    },
     
    update: async (key, value, revision): Promise<number> => {
      const e = data.get(key);
      if (e?.revision !== revision) {
        throw new Error("wrong last sequence");
      }
      const next = ++revisionCounter;
      data.set(key, { value, revision: next });
      return next;
    },
  };
}

function makeGate(config: AdmissionPolicy): AdmissionGate {
  return new AdmissionGate({
    config,
    kv: memoryKv(),
    principalRoles: new Map(),
    log: { warn: () => {} },
  });
}

describe("dispatch-listener — admission gate (R26 P1 enforcement point 1)", () => {
  test("INERT without an admissionGate: no system.admission.* envelopes, session spawns", async () => {
    const r = recordingRuntime();
    const { factory, spawnCount } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      // no admissionGate — the `policy.admission`-absent posture
    });
    await listener.start();
    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await settle(() => r.published);
    await listener.stop();

    expect(spawnCount()).toBe(1);
    const types = r.published.map((e) => e.type);
    expect(types).toContain("dispatch.task.completed");
    expect(types.some((t) => t.startsWith("system.admission."))).toBe(false);
  });

  test("THROTTLED: audit + terminal not_now with retry hint, and NO spawn", async () => {
    const r = recordingRuntime();
    const { factory, spawnCount } = fakeFactory(SUCCESS_RESULT);
    // per_minute: 1 — the second dispatch in the window must throttle.
    const gate = makeGate({ defaults: { per_minute: 1 } });
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      admissionGate: gate,
    });
    await listener.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await settle(() => r.published);
    expect(spawnCount()).toBe(1);

    const before = r.published.length;
    r.trigger(
      makeReceivedEnvelope({ task_id: TASK_ID_2 }),
      CANONICAL_CORTEX_CHAT_SUBJECT,
    );
    await settle(() => r.published.slice(before));
    await listener.stop();

    // No second spawn.
    expect(spawnCount()).toBe(1);

    const after = r.published.slice(before);
    // Audit leg — system.admission.throttled with the structured reason.
    const throttled = after.find((e) => e.type === "system.admission.throttled");
    expect(throttled).toBeDefined();
    expect(throttled?.correlation_id).toBe(TASK_ID_2);
    const reason = (throttled?.payload as {
      principal_id?: string;
      reason?: Record<string, unknown>;
    });
    expect(reason.principal_id).toBe("cortex");
    expect(reason.reason?.kind).toBe("rate");
    expect(reason.reason?.tier).toBe("principal");
    expect(reason.reason?.window).toBe("per_minute");
    expect(reason.reason?.degraded).toBe(false);
    expect(reason.reason?.retry_after_ms).toBeGreaterThan(0);

    // Lifecycle leg — TERMINAL not_now on the dispatch's correlation id with
    // the friendly renderer summary (Q6). Never `policy_denied`, never a
    // permanent kind.
    const failed = after.find((e) => e.type === "dispatch.task.failed");
    expect(failed).toBeDefined();
    expect(failed?.correlation_id).toBe(TASK_ID_2);
    const failedPayload = failed?.payload as {
      reason?: { kind?: string; retry_after_ms?: number; detail?: string };
      error?: string;
      error_summary?: string;
    };
    expect(failedPayload.reason?.kind).toBe("not_now");
    expect(failedPayload.reason?.retry_after_ms).toBeGreaterThan(0);
    expect(failedPayload.reason?.detail).toContain("admission: rate limit");
    expect(JSON.stringify(failed?.payload)).toContain("busy — try again in ~");

    // No started/completed for the throttled task.
    const startedForThrottled = after.some(
      (e) => e.type === "dispatch.task.started" && e.correlation_id === TASK_ID_2,
    );
    expect(startedForThrottled).toBe(false);
  });

  test("ORDERING: a policy DENY never consults the admission gate", async () => {
    const r = recordingRuntime();
    const { factory, spawnCount } = fakeFactory(SUCCESS_RESULT);
    const gate = makeGate({ defaults: { per_minute: 100 } });
    let checked = 0;
    const realCheck = gate.check.bind(gate);
    gate.check = async (req) => {
      checked++;
      return realCheck(req);
    };
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      // Engine grants NOTHING — the policy gate denies dispatch.cortex.
      policyEngine: engineGranting([]),
      admissionGate: gate,
    });
    await listener.start();
    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await settle(() => r.published);
    await listener.stop();

    expect(spawnCount()).toBe(0);
    expect(checked).toBe(0); // the transient gate ran AFTER the permanent one — never
    const types = r.published.map((e) => e.type);
    expect(types).toContain("system.access.denied");
    expect(types.some((t) => t.startsWith("system.admission."))).toBe(false);
    // The terminal deny is policy_denied, not not_now.
    const failed = r.published.find((e) => e.type === "dispatch.task.failed");
    expect((failed?.payload as { reason?: { kind?: string } }).reason?.kind).toBe(
      "policy_denied",
    );
  });

  test("IDENTITY: the gate is keyed on the policy-resolved principal", async () => {
    const r = recordingRuntime();
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const gate = makeGate({ defaults: { per_minute: 100 } });
    const seen: { principalId: string; anonymous: boolean; leaseId: string }[] = [];
    const realCheck = gate.check.bind(gate);
    gate.check = async (req) => {
      seen.push(req);
      return realCheck(req);
    };
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      admissionGate: gate,
    });
    await listener.start();
    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await settle(() => r.published);
    await listener.stop();

    // No chain, no originator ⇒ the policy gate resolved `payload.agent_id`
    // ("cortex") — the admission gate MUST key on the same identity, with the
    // task id as the lease id (myelin spec §1).
    expect(seen).toEqual([
      { principalId: "cortex", anonymous: false, leaseId: TASK_ID },
    ]);
  });

  test("LEASE LIFECYCLE: max_concurrent slot is released when the dispatch terminates", async () => {
    const r = recordingRuntime();
    const { factory, spawnCount } = fakeFactory(SUCCESS_RESULT);
    const gate = makeGate({ defaults: { max_concurrent: 1 } });
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      admissionGate: gate,
    });
    await listener.start();

    // Dispatch 1 — admitted, runs, terminates (fake session resolves fast).
    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await settle(() => r.published);
    expect(spawnCount()).toBe(1);

    // Dispatch 2 — the ONLY way this admits is if dispatch 1's in-flight
    // lease was released in the `finally` around the harness drain.
    const before = r.published.length;
    r.trigger(
      makeReceivedEnvelope({ task_id: TASK_ID_2 }),
      CANONICAL_CORTEX_CHAT_SUBJECT,
    );
    await settle(() => r.published.slice(before));
    await listener.stop();

    expect(spawnCount()).toBe(2);
    const after = r.published.slice(before);
    expect(after.some((e) => e.type === "system.admission.throttled")).toBe(false);
    expect(after.some((e) => e.type === "dispatch.task.completed")).toBe(true);
  });
});
