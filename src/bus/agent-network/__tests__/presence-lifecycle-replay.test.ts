/**
 * G-1114.C.5 — agent-presence lifecycle FIXTURE-REPLAY integration test.
 *
 * The final Phase C slice of umbrella #355 (per
 * `docs/plan-agent-network-topology.md` §4.3: "fixture tests replaying scripted
 * envelope streams"). TESTS-ONLY — it adds NO production code.
 *
 * ## What this is (and what the per-slice unit tests are NOT)
 *
 * The per-slice unit tests already cover each component in isolation:
 *   - `builders.test.ts`  (B.1) — the envelope SHAPE + subject derivation.
 *   - `registry.test.ts`  (B.3 fold + C.3 FSM reaper) — `apply()` folds + the
 *     reaper's `online→offline` edge, driven by calling `apply`/`reapStale`
 *     DIRECTLY on a bare `AgentPresenceRegistry`.
 *   - the C.1 producer diff + C.4 panel tests cover their own layers.
 *
 * This file is the END-TO-END replay that ties them together at a HIGHER level:
 * it drives the FULL lifecycle through the REAL components, exactly as the live
 * subscriber does, and asserts the snapshot + `onChange` emissions at each step.
 *
 * **The real path under test (no shortcuts):**
 *   builder (`createAgentOnlineEvent` …)
 *     → `deriveNatsSubject(envelope, stack)`  — the SAME subject the publish
 *       path stamps (`runtime.publish` derives it from the envelope)
 *     → `runtime.fire(envelope, subject)`     — the bus fan-out
 *     → `startAgentPresenceRegistry`'s fan-out handler
 *     → `subjectMatches(pattern, subject)`    — the live subject filter
 *     → `registry.apply(envelope)`            — the B.3 fold
 *     → the C.3 FSM reaper (driven via the injected scheduler tick)
 *     → `getAgents()` snapshot + `onChange` emissions  — the assertions.
 *
 * Determinism: an injected `now()` clock + a fake `PresenceReaperScheduler`
 * (capture-and-tick) replace wall-clock time, so the 5-minute TTL is crossed by
 * advancing a variable, never by sleeping. This is the test that would catch a
 * regression in the producer↔registry↔FSM contract that the per-component unit
 * tests miss — e.g. a subject-derivation change that stops the fan-out filter
 * matching, or a builder field rename that breaks the fold's payload parse.
 *
 * Scripted stream (single + multi-agent):
 *   1. agent.online (with caps)            → snapshot: online + caps.
 *   2. agent.heartbeat × N under the TTL   → stays online, lastHeartbeatAt advances.
 *   3. agent.capabilities-changed          → snapshot reflects the new cap set.
 *   4. clock past the 5-min TTL, no beat   → reaper sweep → offline(ttl_lapse),
 *                                            onChange fired ONCE for the edge.
 *   5. agent.heartbeat after ttl_lapse     → revived online, reason cleared.
 *   6. agent.offline (graceful)            → offline(shutdown) — distinct reason.
 *   7. multi-agent: one lapses while the other stays online (independent FSM).
 */

import { describe, expect, test, mock } from "bun:test";
import {
  AgentPresenceRegistry,
  agentPresenceSubject,
  startAgentPresenceRegistry,
  PRESENCE_LIVENESS_TTL_MS,
  TTL_LAPSE_OFFLINE_REASON,
  type AgentPresenceRecord,
  type PresenceReaperScheduler,
} from "../registry";
import {
  createAgentOnlineEvent,
  createAgentHeartbeatEvent,
  createAgentOfflineEvent,
  createAgentCapabilitiesChangedEvent,
  type AgentPresenceSource,
} from "../builders";
import { deriveNatsSubject } from "../../myelin/envelope-validator";
import type { Envelope } from "../../myelin/envelope-validator";
import type { MyelinRuntime, EnvelopeHandler } from "../../myelin/runtime";
import type { MyelinSubscriber } from "../../myelin/subscriber";

// --- fixtures ----------------------------------------------------------------

const PRINCIPAL = "andreas";
const STACK = "meta-factory";

const SOURCE: AgentPresenceSource = {
  principal: PRINCIPAL,
  stack: STACK,
  instance: "local",
};

/** Build a fresh source/identity/scope triple for a named agent in the stack. */
function agent(agentId: string, nkey: string, assistant: string | null) {
  return {
    source: SOURCE,
    identity: {
      nkey_public_key: nkey,
      agent_id: agentId,
      assistant_name: assistant,
    },
    scope: { principal: PRINCIPAL, stack: STACK },
  };
}

const LUNA = agent("luna", "ULUNA000", "Luna");
const ECHO = agent("echo", "UECHO000", "Echo");

const T0 = new Date("2026-06-11T09:00:00.000Z");

function onlineEnv(a: typeof LUNA, caps: string[]): Envelope {
  return createAgentOnlineEvent({ ...a, capabilities: caps, startedAt: T0 });
}
function heartbeatEnv(a: typeof LUNA): Envelope {
  return createAgentHeartbeatEvent({ ...a, sentAt: T0 });
}
function capsChangedEnv(a: typeof LUNA, caps: string[]): Envelope {
  return createAgentCapabilitiesChangedEvent({ ...a, capabilities: caps, sentAt: T0 });
}
function offlineEnv(a: typeof LUNA, reason: "shutdown" | "restart" | "error"): Envelope {
  return createAgentOfflineEvent({ ...a, reason, sentAt: T0 });
}

// --- a fake runtime that mirrors the live fan-out + push-subscribe seam -------

/**
 * The same fake-runtime shape `registry.test.ts` uses for its wiring tests, but
 * here it carries a `publish` that derives the subject via the REAL
 * `deriveNatsSubject` and fans the envelope back out on that derived subject —
 * so a replay can `publish(builder())` and exercise the EXACT subject the live
 * stack would stamp, rather than a hand-typed subject string.
 */
interface ReplayRuntime extends MyelinRuntime {
  /** Publish like the live stack: derive the subject, then fan out on it. */
  publish(envelope: Envelope): Promise<void>;
  /** Direct fan-out on an explicit subject (for negative/cross-stack cases). */
  fire(envelope: Envelope, subject: string): void;
  readonly subscribedPatterns: string[];
  readonly publishedSubjects: string[];
}

function makeReplayRuntime(): ReplayRuntime {
  const handlers = new Set<EnvelopeHandler>();
  const subscribedPatterns: string[] = [];
  const publishedSubjects: string[] = [];
  const subscriberStop = mock(() => Promise.resolve());
  const fakeSubscriber: MyelinSubscriber = {
    stop: subscriberStop,
  } as unknown as MyelinSubscriber;

  const fire = (envelope: Envelope, subject: string): void => {
    for (const h of handlers) h(envelope, subject);
  };

  return {
    enabled: true,
    subscribedPatterns,
    publishedSubjects,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    publish(envelope: Envelope) {
      // The live publish path derives the subject from the envelope + stack.
      const subject = deriveNatsSubject(envelope, STACK);
      publishedSubjects.push(subject);
      fire(envelope, subject);
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
    subscribe: (pattern: string) => {
      subscribedPatterns.push(pattern);
      return Promise.resolve(fakeSubscriber);
    },
    fire,
  };
}

/** A capture-and-tick scheduler — drive reaper sweeps deterministically. */
function makeFakeScheduler(): PresenceReaperScheduler & { tick(): void } {
  let fn: (() => void) | null = null;
  const handle = {};
  return {
    setInterval(cb: () => void) {
      fn = cb;
      return handle;
    },
    clearInterval(h: unknown) {
      if (h === handle) fn = null;
    },
    tick() {
      if (fn) fn();
    },
  };
}

/**
 * Stand up the REAL wired registry over the replay runtime, with an injected
 * clock + fake scheduler. Returns the handle + the clock setter + a recorded
 * `onChange` log so each test asserts both the snapshot AND the emissions.
 */
async function standUpReplay() {
  const runtime = makeReplayRuntime();
  const sched = makeFakeScheduler();
  let clock = 0;
  const registry = new AgentPresenceRegistry({
    now: () => clock,
    scheduler: sched,
  });
  const handle = await startAgentPresenceRegistry({
    runtime,
    principal: PRINCIPAL,
    stack: STACK,
    registry,
  });
  const changes: { key: string; state: string; reason?: string }[] = [];
  registry.onChange((key, rec) => {
    changes.push({ key, state: rec.state, reason: rec.offlineReason });
  });
  return {
    runtime,
    sched,
    registry,
    handle,
    changes,
    setClock: (t: number) => {
      clock = t;
    },
  };
}

function recordFor(reg: AgentPresenceRegistry, agentId: string): AgentPresenceRecord | undefined {
  return reg.getAgents().find((r) => r.agentId === agentId);
}

// --- the comprehensive single-agent replay -----------------------------------

describe("agent-presence lifecycle fixture-replay (single agent, end-to-end)", () => {
  test("online → heartbeats → caps-changed → ttl_lapse → revive → graceful offline", async () => {
    const { runtime, sched, registry, handle, changes, setClock } =
      await standUpReplay();

    // The wired registry self-subscribed to the REAL stack-local pattern, and
    // the reaper is running on the injected scheduler.
    expect(runtime.subscribedPatterns).toEqual([
      agentPresenceSubject(PRINCIPAL, STACK),
    ]);
    expect(registry.isReaperRunning()).toBe(true);

    // 1. agent.online (with caps) — published through the REAL subject path.
    setClock(1_000);
    await runtime.publish(onlineEnv(LUNA, ["code-review.typescript", "research"]));
    // It went out on the subject the live publish path would derive.
    expect(runtime.publishedSubjects.at(-1)).toBe(
      "local.andreas.meta-factory.agent.online",
    );
    {
      const rec = recordFor(registry, "luna");
      expect(rec?.state).toBe("online");
      expect(rec?.capabilities).toEqual(["code-review.typescript", "research"]);
      expect(rec?.assistantName).toBe("Luna");
      expect(rec?.startedAt).toBe(T0.toISOString());
      expect(rec?.lastSeenAt).toBe(1_000);
    }

    // 2. agent.heartbeat × N under the TTL — stays online, lastHeartbeatAt advances.
    for (const t of [60_000, 120_000, 180_000, 240_000]) {
      setClock(1_000 + t);
      await runtime.publish(heartbeatEnv(LUNA));
      // A sweep between beats must NOT trip (still fresh).
      sched.tick();
      const rec = recordFor(registry, "luna");
      expect(rec?.state).toBe("online");
      expect(rec?.lastHeartbeatAt).toBe(1_000 + t);
    }

    // 3. agent.capabilities-changed — snapshot reflects the new full set, state
    //    unchanged (caps-changed does not assert liveness).
    setClock(1_000 + 250_000);
    await runtime.publish(capsChangedEnv(LUNA, ["research"]));
    {
      const rec = recordFor(registry, "luna");
      expect(rec?.capabilities).toEqual(["research"]);
      expect(rec?.state).toBe("online");
      expect(rec?.lastHeartbeatAt).toBe(1_000 + 240_000); // unchanged by caps-changed
    }

    // 4. clock past the 5-min TTL with NO heartbeat → reaper sweep → offline.
    //    Last heartbeat was at clock = 241_000.
    const lastBeat = 1_000 + 240_000;
    // Just before the line — a tick keeps it online.
    setClock(lastBeat + PRESENCE_LIVENESS_TTL_MS - 1);
    sched.tick();
    expect(recordFor(registry, "luna")?.state).toBe("online");
    // Cross the line — the sweep trips it to offline(ttl_lapse).
    setClock(lastBeat + PRESENCE_LIVENESS_TTL_MS + 1);
    sched.tick();
    {
      const rec = recordFor(registry, "luna");
      expect(rec?.state).toBe("offline");
      expect(rec?.offlineReason).toBe(TTL_LAPSE_OFFLINE_REASON);
      // lastHeartbeatAt survives the reap (last-seen liveness preserved).
      expect(rec?.lastHeartbeatAt).toBe(lastBeat);
    }
    // onChange fired exactly ONCE for the offline edge so far (idempotent reaper).
    expect(changes.filter((c) => c.state === "offline").length).toBe(1);
    expect(changes.find((c) => c.state === "offline")?.reason).toBe(
      TTL_LAPSE_OFFLINE_REASON,
    );

    // 5. agent.heartbeat after ttl_lapse → revived to online, reason cleared.
    const reviveAt = lastBeat + PRESENCE_LIVENESS_TTL_MS + 10_000;
    setClock(reviveAt);
    await runtime.publish(heartbeatEnv(LUNA));
    {
      const rec = recordFor(registry, "luna");
      expect(rec?.state).toBe("online");
      expect(rec?.offlineReason).toBeUndefined();
      expect(rec?.lastHeartbeatAt).toBe(reviveAt);
    }
    // A subsequent in-window sweep does not flip it back.
    sched.tick();
    expect(recordFor(registry, "luna")?.state).toBe("online");

    // 6. agent.offline (graceful shutdown) → offline(shutdown), DISTINCT from ttl_lapse.
    setClock(reviveAt + 5_000);
    await runtime.publish(offlineEnv(LUNA, "shutdown"));
    {
      const rec = recordFor(registry, "luna");
      expect(rec?.state).toBe("offline");
      expect(rec?.offlineReason).toBe("shutdown");
      expect(rec?.offlineReason).not.toBe(TTL_LAPSE_OFFLINE_REASON);
    }
    // A later sweep must NOT re-stamp ttl_lapse over the graceful reason.
    setClock(reviveAt + 5_000 + PRESENCE_LIVENESS_TTL_MS + 1);
    sched.tick();
    expect(recordFor(registry, "luna")?.offlineReason).toBe("shutdown");

    // The full emission trace: online, 4 heartbeats (online), caps-changed
    // (online), ttl_lapse offline, revive (online), graceful offline. Exactly
    // two distinct offline reasons appeared across the run.
    const offlineReasons = changes
      .filter((c) => c.state === "offline")
      .map((c) => c.reason);
    expect(offlineReasons).toEqual([TTL_LAPSE_OFFLINE_REASON, "shutdown"]);

    await handle.stop();
    expect(registry.isReaperRunning()).toBe(false);
  });
});

// --- multi-agent replay: independent FSM per agent ---------------------------

describe("agent-presence lifecycle fixture-replay (multi-agent, independent FSM)", () => {
  test("one agent lapses while the other stays online", async () => {
    const { runtime, sched, registry, handle, changes, setClock } =
      await standUpReplay();

    // luna online at t=1_000, echo online at t=2_000 — staggered so the TTL
    // line falls between them.
    setClock(1_000);
    await runtime.publish(onlineEnv(LUNA, ["research"]));
    setClock(2_000);
    await runtime.publish(onlineEnv(ECHO, ["code-review.typescript"]));

    expect(registry.getAgents().length).toBe(2);
    expect(recordFor(registry, "luna")?.state).toBe("online");
    expect(recordFor(registry, "echo")?.state).toBe("online");

    // Keep echo alive with a heartbeat well after luna's last-seen, then sweep
    // at a clock where luna is stale (1_000 + TTL passed) but echo is fresh.
    setClock(2_500);
    await runtime.publish(heartbeatEnv(ECHO));

    // luna last-live = 1_000; echo last-live = 2_500. Cross luna's TTL only.
    setClock(1_000 + PRESENCE_LIVENESS_TTL_MS + 1);
    sched.tick();

    {
      const luna = recordFor(registry, "luna");
      const echo = recordFor(registry, "echo");
      expect(luna?.state).toBe("offline");
      expect(luna?.offlineReason).toBe(TTL_LAPSE_OFFLINE_REASON);
      // echo's FSM is independent — it is still online (2_500 + TTL > clock).
      expect(echo?.state).toBe("online");
      expect(echo?.capabilities).toEqual(["code-review.typescript"]);
    }

    // Exactly one offline emission, and it was for luna only.
    const offline = changes.filter((c) => c.state === "offline");
    expect(offline.length).toBe(1);
    expect(offline[0]?.key).toBe("andreas/meta-factory/luna");

    // Drive echo to lapse on a later sweep (now past echo's TTL too).
    setClock(2_500 + PRESENCE_LIVENESS_TTL_MS + 1);
    sched.tick();
    expect(recordFor(registry, "echo")?.state).toBe("offline");
    expect(recordFor(registry, "echo")?.offlineReason).toBe(TTL_LAPSE_OFFLINE_REASON);
    // luna did NOT re-emit (already offline — idempotent).
    expect(changes.filter((c) => c.state === "offline").length).toBe(2);

    await handle.stop();
  });
});

// --- subject-contract guard: the fan-out filter only admits this stack -------

describe("agent-presence fixture-replay (subject contract under the real filter)", () => {
  test("a cross-stack / federated subject is filtered out by the live handler", async () => {
    const { runtime, registry, handle, setClock } = await standUpReplay();

    setClock(1_000);
    // Same envelope, but fired on subjects the stack-local pattern must reject:
    // a different stack and the (not-yet-subscribed) federated scope.
    runtime.fire(
      onlineEnv(LUNA, ["research"]),
      "local.andreas.other-stack.agent.online",
    );
    runtime.fire(
      onlineEnv(LUNA, ["research"]),
      "federated.andreas.meta-factory.agent.online",
    );
    expect(registry.getAgents().length).toBe(0);

    // The matching subject (the one the REAL publish path derives) lands.
    await runtime.publish(onlineEnv(LUNA, ["research"]));
    expect(registry.getAgents().length).toBe(1);
    expect(recordFor(registry, "luna")?.state).toBe("online");

    await handle.stop();
  });
});
