/**
 * G-1114.B.3 — runtime agent-presence registry (subscriber) tests.
 *
 * Coverage axes:
 *   1. Fold — a scripted online/heartbeat/offline/capabilities-changed stream
 *      produces the correct snapshot via `getAgents()`.
 *   2. Heartbeat-before-online — an unknown agent's heartbeat upserts it online.
 *   3. Change seam — `onChange` fires after each mutation with the new record.
 *   4. Malformed payload — dropped (not thrown), snapshot unchanged.
 *   5. Boundary — B records `lastHeartbeatAt` but NEVER times anything out
 *      (no TTL/FSM; Phase C).
 *   6. Wiring — `startAgentPresenceRegistry` self-subscribes + filters by
 *      subject; dormant when the runtime can't subscribe; `stop()` idempotent.
 */

import { describe, expect, test, mock } from "bun:test";
import {
  AgentPresenceRegistry,
  agentPresenceSubject,
  startAgentPresenceRegistry,
  PRESENCE_LIVENESS_TTL_MS,
  TTL_LAPSE_OFFLINE_REASON,
  type PresenceReaperScheduler,
} from "../registry";
import {
  createAgentOnlineEvent,
  createAgentHeartbeatEvent,
  createAgentOfflineEvent,
  createAgentCapabilitiesChangedEvent,
  type AgentPresenceSource,
} from "../builders";
import type { Envelope } from "../../myelin/envelope-validator";
import type { MyelinRuntime, EnvelopeHandler } from "../../myelin/runtime";
import type { MyelinSubscriber } from "../../myelin/subscriber";

const SOURCE: AgentPresenceSource = {
  principal: "andreas",
  stack: "meta-factory",
  instance: "local",
};
const IDENTITY = {
  nkey_public_key: "UABC1234567890",
  agent_id: "luna",
  assistant_name: "Luna",
};
const SCOPE = { principal: "andreas", stack: "meta-factory" };

function online(caps: string[] = ["code-review.typescript"]): Envelope {
  return createAgentOnlineEvent({
    source: SOURCE,
    identity: IDENTITY,
    scope: SCOPE,
    capabilities: caps,
    startedAt: new Date("2026-06-10T09:00:00.000Z"),
  });
}
function heartbeat(): Envelope {
  return createAgentHeartbeatEvent({
    source: SOURCE,
    identity: IDENTITY,
    scope: SCOPE,
    sentAt: new Date("2026-06-10T09:05:00.000Z"),
  });
}
function offline(): Envelope {
  return createAgentOfflineEvent({
    source: SOURCE,
    identity: IDENTITY,
    scope: SCOPE,
    reason: "shutdown",
    sentAt: new Date("2026-06-10T09:10:00.000Z"),
  });
}

describe("AgentPresenceRegistry.apply", () => {
  test("online → record present, online, capabilities + startedAt stored", () => {
    let clock = 1000;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 2000;
    reg.apply(online(["code-review.typescript", "research"]));
    const agents = reg.getAgents();
    expect(agents.length).toBe(1);
    expect(agents[0]).toMatchObject({
      key: "andreas/meta-factory/luna",
      agentId: "luna",
      nkeyPublicKey: "UABC1234567890",
      assistantName: "Luna",
      principal: "andreas",
      stack: "meta-factory",
      capabilities: ["code-review.typescript", "research"],
      state: "online",
      startedAt: "2026-06-10T09:00:00.000Z",
      lastSeenAt: 2000,
    });
  });

  test("scripted online→heartbeat→offline yields the correct final snapshot", () => {
    let clock = 0;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 100;
    reg.apply(online());
    clock = 200;
    reg.apply(heartbeat());
    clock = 300;
    reg.apply(offline());
    const [rec] = reg.getAgents();
    expect(rec?.state).toBe("offline");
    expect(rec?.offlineReason).toBe("shutdown");
    // heartbeat was recorded along the way and survives the offline.
    expect(rec?.lastHeartbeatAt).toBe(200);
    expect(rec?.lastSeenAt).toBe(300);
  });

  test("heartbeat bumps lastHeartbeatAt without losing capabilities", () => {
    let clock = 0;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 100;
    reg.apply(online(["research"]));
    clock = 250;
    reg.apply(heartbeat());
    const [rec] = reg.getAgents();
    expect(rec?.capabilities).toEqual(["research"]);
    expect(rec?.lastHeartbeatAt).toBe(250);
    expect(rec?.state).toBe("online");
  });

  test("heartbeat for an UNKNOWN agent upserts it online (liveness signal)", () => {
    const clock = 500;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    reg.apply(heartbeat());
    const [rec] = reg.getAgents();
    expect(rec?.state).toBe("online");
    expect(rec?.agentId).toBe("luna");
    expect(rec?.capabilities).toEqual([]);
    expect(rec?.lastHeartbeatAt).toBe(500);
  });

  test("online after offline clears the offline reason (re-online)", () => {
    const reg = new AgentPresenceRegistry();
    reg.apply(online());
    reg.apply(offline());
    expect(reg.getAgents()[0]?.state).toBe("offline");
    reg.apply(online());
    const [rec] = reg.getAgents();
    expect(rec?.state).toBe("online");
    expect(rec?.offlineReason).toBeUndefined();
  });

  test("capabilities-changed stores the latest full set (B: latest only)", () => {
    const reg = new AgentPresenceRegistry();
    reg.apply(online(["research"]));
    reg.apply(
      createAgentCapabilitiesChangedEvent({
        source: SOURCE,
        identity: IDENTITY,
        scope: SCOPE,
        capabilities: ["research", "code-review.typescript"],
        sentAt: new Date("2026-06-10T09:07:00.000Z"),
      }),
    );
    expect(reg.getAgents()[0]?.capabilities).toEqual([
      "research",
      "code-review.typescript",
    ]);
    // state unchanged — capabilities-changed does not assert liveness.
    expect(reg.getAgents()[0]?.state).toBe("online");
  });

  test("getAgents returns COPIES — caller mutation does not corrupt state", () => {
    const reg = new AgentPresenceRegistry();
    reg.apply(online(["research"]));
    const snap = reg.getAgents();
    (snap[0] as { state: string }).state = "offline";
    expect(reg.getAgents()[0]?.state).toBe("online");
  });

  test("a bare registry (reaper NOT started) NEVER expires a record", () => {
    let clock = 0;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 100;
    reg.apply(online());
    clock = 100 + 10 * 60_000; // 10 minutes later — well past the 5-min TTL
    // The reaper is opt-in (G-1114.C.3): without startReaper()/reapStale() the
    // record stays online until an explicit offline. This preserves the B.3
    // "records-only, no FSM" contract for fold-only callers.
    expect(reg.getAgents()[0]?.state).toBe("online");
  });

  test("malformed payload is dropped, not thrown; snapshot unchanged", () => {
    const reg = new AgentPresenceRegistry();
    reg.apply(online());
    const bad = { ...heartbeat(), payload: { not: "a heartbeat" } } as Envelope;
    expect(() => reg.apply(bad)).not.toThrow();
    expect(reg.apply(bad)).toBeNull();
    expect(reg.getAgents().length).toBe(1);
    expect(reg.getAgents()[0]?.state).toBe("online");
  });

  test("non-presence envelope type is ignored", () => {
    const reg = new AgentPresenceRegistry();
    const notPresence: Envelope = { ...online(), type: "system.foo" };
    expect(reg.apply(notPresence)).toBeNull();
    expect(reg.getAgents().length).toBe(0);
  });
});

describe("AgentPresenceRegistry.onChange", () => {
  test("fires after each mutation with the affected key + new record", () => {
    const reg = new AgentPresenceRegistry();
    const seen: { key: string; state: string }[] = [];
    const sub = reg.onChange((key, rec) => {
      seen.push({ key, state: rec.state });
    });
    reg.apply(online());
    reg.apply(offline());
    expect(seen).toEqual([
      { key: "andreas/meta-factory/luna", state: "online" },
      { key: "andreas/meta-factory/luna", state: "offline" },
    ]);
    sub.unsubscribe();
    reg.apply(online());
    // No further events after unsubscribe.
    expect(seen.length).toBe(2);
  });

  test("a throwing listener does not break sibling listeners or apply", () => {
    const reg = new AgentPresenceRegistry();
    let secondFired = false;
    reg.onChange(() => {
      throw new Error("boom");
    });
    reg.onChange(() => {
      secondFired = true;
    });
    expect(() => reg.apply(online())).not.toThrow();
    expect(secondFired).toBe(true);
    expect(reg.getAgents().length).toBe(1);
  });
});

describe("agentPresenceSubject", () => {
  test("derives the stack-local agent.> pattern (no federated)", () => {
    expect(agentPresenceSubject("andreas", "meta-factory")).toBe(
      "local.andreas.meta-factory.agent.>",
    );
  });
});

// --- wiring -----------------------------------------------------------------

interface FakeRuntime extends MyelinRuntime {
  fire(envelope: Envelope, subject: string): void;
  subscribedPatterns: string[];
}

function makeFakeRuntime(opts: { enabled?: boolean; canSubscribe?: boolean } = {}): FakeRuntime {
  const enabled = opts.enabled ?? true;
  const canSubscribe = opts.canSubscribe ?? true;
  const handlers = new Set<EnvelopeHandler>();
  const subscribedPatterns: string[] = [];
  const subscriberStop = mock(() => Promise.resolve());
  const fakeSubscriber: MyelinSubscriber = {
    stop: subscriberStop,
  } as unknown as MyelinSubscriber;
  return {
    enabled,
    subscribedPatterns,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    publish: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    subscribe: (pattern: string) => {
      subscribedPatterns.push(pattern);
      return Promise.resolve(canSubscribe ? fakeSubscriber : null);
    },
    fire(envelope, subject) {
      for (const h of handlers) h(envelope, subject);
    },
  };
}

describe("startAgentPresenceRegistry (wiring)", () => {
  test("self-subscribes to the stack-local pattern + folds matching envelopes", async () => {
    const runtime = makeFakeRuntime();
    const handle = await startAgentPresenceRegistry({
      runtime,
      principal: "andreas",
      stack: "meta-factory",
    });
    expect(runtime.subscribedPatterns).toEqual([
      "local.andreas.meta-factory.agent.>",
    ]);
    // Fire an online envelope on the matching subject.
    runtime.fire(online(), "local.andreas.meta-factory.agent.online");
    expect(handle.registry.getAgents().length).toBe(1);
    expect(handle.registry.getAgents()[0]?.state).toBe("online");
    await handle.stop();
  });

  test("filters out envelopes on non-matching subjects", async () => {
    const runtime = makeFakeRuntime();
    const handle = await startAgentPresenceRegistry({
      runtime,
      principal: "andreas",
      stack: "meta-factory",
    });
    // A different stack's subject must not land in this stack's registry.
    runtime.fire(online(), "local.andreas.other-stack.agent.online");
    expect(handle.registry.getAgents().length).toBe(0);
    // A federated subject is NOT subscribed in B (Phase E).
    runtime.fire(online(), "federated.andreas.meta-factory.agent.online");
    expect(handle.registry.getAgents().length).toBe(0);
    await handle.stop();
  });

  test("dormant when runtime cannot push-subscribe (returns null)", async () => {
    const runtime = makeFakeRuntime({ enabled: true, canSubscribe: false });
    const handle = await startAgentPresenceRegistry({
      runtime,
      principal: "andreas",
      stack: "meta-factory",
    });
    // Still constructed + queryable; onEnvelope still folds (the fan-out is
    // independent of the self-subscribe).
    expect(handle.registry.getAgents().length).toBe(0);
    await handle.stop();
  });

  test("stop() is idempotent + unregisters the fan-out handler", async () => {
    const runtime = makeFakeRuntime();
    const handle = await startAgentPresenceRegistry({
      runtime,
      principal: "andreas",
      stack: "meta-factory",
    });
    await handle.stop();
    await handle.stop(); // no throw
    // After stop, fan-out is unregistered — new fires are ignored.
    runtime.fire(online(), "local.andreas.meta-factory.agent.online");
    expect(handle.registry.getAgents().length).toBe(0);
  });

  test("starts the liveness reaper by default; stop() stops it", async () => {
    const runtime = makeFakeRuntime();
    const handle = await startAgentPresenceRegistry({
      runtime,
      principal: "andreas",
      stack: "meta-factory",
    });
    expect(handle.registry.isReaperRunning()).toBe(true);
    await handle.stop();
    expect(handle.registry.isReaperRunning()).toBe(false);
  });

  test("startReaper: false leaves the reaper dormant (fold-only callers)", async () => {
    const runtime = makeFakeRuntime();
    const handle = await startAgentPresenceRegistry({
      runtime,
      principal: "andreas",
      stack: "meta-factory",
      startReaper: false,
    });
    expect(handle.registry.isReaperRunning()).toBe(false);
    await handle.stop();
  });
});

// --- G-1114.C.3 liveness FSM / TTL reaper ------------------------------------

/**
 * A deterministic interval scheduler: it captures the registered tick callback
 * and exposes `tick()` so a test drives sweeps explicitly instead of waiting on
 * wall-clock `setInterval`. `cleared` records that the registry cancelled the
 * interval on stop.
 */
function makeFakeScheduler(): PresenceReaperScheduler & {
  tick(): void;
  readonly cleared: boolean;
  readonly scheduled: boolean;
} {
  let fn: (() => void) | null = null;
  let cleared = false;
  const handle = {};
  return {
    setInterval(cb: () => void) {
      fn = cb;
      return handle;
    },
    clearInterval(h: unknown) {
      if (h === handle) {
        cleared = true;
        fn = null;
      }
    },
    tick() {
      if (fn) fn();
    },
    get cleared() {
      return cleared;
    },
    get scheduled() {
      return fn !== null;
    },
  };
}

describe("AgentPresenceRegistry liveness reaper (C.3)", () => {
  test("TTL constant is 5 minutes", () => {
    expect(PRESENCE_LIVENESS_TTL_MS).toBe(5 * 60_000);
  });

  test("online → heartbeats keep online → silence past TTL → offline(ttl_lapse)", () => {
    let clock = 0;
    const sched = makeFakeScheduler();
    const reg = new AgentPresenceRegistry({ now: () => clock, scheduler: sched });
    reg.startReaper();
    expect(sched.scheduled).toBe(true);

    const changes: { state: string; reason?: string }[] = [];
    reg.onChange((_k, rec) => {
      changes.push({ state: rec.state, reason: rec.offlineReason });
    });

    // boot
    clock = 1_000;
    reg.apply(online());
    // heartbeat at +1min, +2min, +3min, +4min — each within the 5-min window.
    for (const t of [60_000, 120_000, 180_000, 240_000]) {
      clock = 1_000 + t;
      reg.apply(heartbeat());
      reg.reapStale(); // a sweep between beats must NOT trip (still fresh)
      expect(reg.getAgents()[0]?.state).toBe("online");
    }
    // Now go silent. A sweep just before the TTL line — still online.
    clock = 1_000 + 240_000 + PRESENCE_LIVENESS_TTL_MS - 1;
    sched.tick();
    expect(reg.getAgents()[0]?.state).toBe("online");

    // Cross the TTL line (last heartbeat was at clock=241_000).
    clock = 241_000 + PRESENCE_LIVENESS_TTL_MS + 1;
    sched.tick();
    const rec = reg.getAgents()[0];
    expect(rec?.state).toBe("offline");
    expect(rec?.offlineReason).toBe(TTL_LAPSE_OFFLINE_REASON);
    // lastHeartbeatAt survives the reap (last-seen liveness preserved).
    expect(rec?.lastHeartbeatAt).toBe(241_000);

    // onChange fired ONCE for the offline transition (state changed once).
    const offlineEvents = changes.filter((c) => c.state === "offline");
    expect(offlineEvents.length).toBe(1);
    expect(offlineEvents[0]?.reason).toBe(TTL_LAPSE_OFFLINE_REASON);
  });

  test("graceful agent.offline BEFORE the TTL wins (reason: shutdown, not ttl_lapse)", () => {
    let clock = 0;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 1_000;
    reg.apply(online());
    clock = 60_000;
    reg.apply(heartbeat());
    // Graceful offline well before the TTL would lapse.
    clock = 90_000;
    reg.apply(offline());
    expect(reg.getAgents()[0]?.state).toBe("offline");
    expect(reg.getAgents()[0]?.offlineReason).toBe("shutdown");
    // A later sweep must NOT re-stamp ttl_lapse over the graceful reason.
    clock = 90_000 + PRESENCE_LIVENESS_TTL_MS + 1_000;
    const reaped = reg.reapStale();
    expect(reaped).toEqual([]);
    expect(reg.getAgents()[0]?.offlineReason).toBe("shutdown");
  });

  test("heartbeat AFTER a TTL-lapse offline REVIVES the record to online", () => {
    let clock = 0;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 1_000;
    reg.apply(online());
    // Lapse it.
    clock = 1_000 + PRESENCE_LIVENESS_TTL_MS + 1;
    expect(reg.reapStale()).toEqual(["andreas/meta-factory/luna"]);
    expect(reg.getAgents()[0]?.state).toBe("offline");
    expect(reg.getAgents()[0]?.offlineReason).toBe(TTL_LAPSE_OFFLINE_REASON);
    // A fresh heartbeat revives it (applyHeartbeat upserts online).
    clock = 1_000 + PRESENCE_LIVENESS_TTL_MS + 10_000;
    reg.apply(heartbeat());
    const rec = reg.getAgents()[0];
    expect(rec?.state).toBe("online");
    expect(rec?.offlineReason).toBeUndefined();
    expect(rec?.lastHeartbeatAt).toBe(1_000 + PRESENCE_LIVENESS_TTL_MS + 10_000);
    // And it survives subsequent in-window sweeps.
    reg.reapStale();
    expect(reg.getAgents()[0]?.state).toBe("online");
  });

  test("reaper is idempotent — an already-offline record does not re-emit", () => {
    let clock = 0;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 1_000;
    reg.apply(online());
    const changes: string[] = [];
    reg.onChange((_k, rec) => changes.push(rec.state));
    // First sweep past TTL → one offline transition.
    clock = 1_000 + PRESENCE_LIVENESS_TTL_MS + 1;
    expect(reg.reapStale()).toEqual(["andreas/meta-factory/luna"]);
    // Subsequent sweeps at ever-later times reap nothing + emit nothing.
    clock += 10 * 60_000;
    expect(reg.reapStale()).toEqual([]);
    clock += 10 * 60_000;
    expect(reg.reapStale()).toEqual([]);
    expect(changes.filter((s) => s === "offline").length).toBe(1);
  });

  test("an online record that never heartbeated times out against lastSeenAt", () => {
    let clock = 0;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 1_000;
    reg.apply(online()); // lastSeenAt = 1_000, no lastHeartbeatAt
    // Just before the TTL relative to lastSeenAt — still online.
    clock = 1_000 + PRESENCE_LIVENESS_TTL_MS - 1;
    expect(reg.reapStale()).toEqual([]);
    // Past it — reaped.
    clock = 1_000 + PRESENCE_LIVENESS_TTL_MS + 1;
    expect(reg.reapStale()).toEqual(["andreas/meta-factory/luna"]);
    expect(reg.getAgents()[0]?.offlineReason).toBe(TTL_LAPSE_OFFLINE_REASON);
  });

  test("a reaper tick AFTER stopReaper() is a no-op", () => {
    let clock = 0;
    const sched = makeFakeScheduler();
    const reg = new AgentPresenceRegistry({ now: () => clock, scheduler: sched });
    reg.startReaper();
    clock = 1_000;
    reg.apply(online());
    reg.stopReaper();
    expect(sched.cleared).toBe(true);
    expect(reg.isReaperRunning()).toBe(false);
    // Even if a stale tick somehow fired, the captured fn is cleared → no-op.
    clock = 1_000 + PRESENCE_LIVENESS_TTL_MS + 1;
    sched.tick();
    expect(reg.getAgents()[0]?.state).toBe("online");
  });

  test("startReaper() is idempotent — does not stack a second interval", () => {
    const sched = makeFakeScheduler();
    const setSpy = mock(sched.setInterval.bind(sched));
    const reg = new AgentPresenceRegistry({
      scheduler: { setInterval: setSpy, clearInterval: sched.clearInterval.bind(sched) },
    });
    reg.startReaper();
    reg.startReaper();
    reg.startReaper();
    expect(setSpy).toHaveBeenCalledTimes(1);
    reg.stopReaper();
  });

  test("stopReaper() is idempotent + safe when never started", () => {
    const reg = new AgentPresenceRegistry();
    expect(() => reg.stopReaper()).not.toThrow();
    reg.startReaper();
    reg.stopReaper();
    expect(() => reg.stopReaper()).not.toThrow();
    expect(reg.isReaperRunning()).toBe(false);
  });

  test("reaper sweeps multiple agents in one tick; only stale ones flip", () => {
    let clock = 0;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    // luna (the shared IDENTITY) + a second agent echo.
    clock = 1_000;
    reg.apply(online());
    clock = 2_000;
    reg.apply(
      createAgentOnlineEvent({
        source: SOURCE,
        identity: { ...IDENTITY, agent_id: "echo", nkey_public_key: "UECHO" },
        scope: SCOPE,
        capabilities: [],
        startedAt: new Date("2026-06-10T09:00:00.000Z"),
      }),
    );
    // luna last-seen 1_000, echo last-seen 2_000. Set clock so only luna is stale.
    clock = 1_000 + PRESENCE_LIVENESS_TTL_MS + 1; // echo still within window (2_000 + TTL > clock)
    const reaped = reg.reapStale();
    expect(reaped).toEqual(["andreas/meta-factory/luna"]);
    const byKey = new Map(reg.getAgents().map((r) => [r.agentId, r.state]));
    expect(byKey.get("luna")).toBe("offline");
    expect(byKey.get("echo")).toBe("online");
  });
});

// --- G-1114.E.2 provenance (local vs foreign origin) -------------------------

describe("AgentPresenceRegistry provenance (E.2)", () => {
  test("apply() tags records as local origin by default", () => {
    const reg = new AgentPresenceRegistry();
    reg.apply(online());
    expect(reg.getAgents()[0]?.origin).toBe("local");
  });

  test("applyForeign() tags records with {principal}/{stack} foreign origin", () => {
    const reg = new AgentPresenceRegistry();
    const env = createAgentOnlineEvent({
      source: { principal: "joel", stack: "research", instance: "local" },
      identity: { nkey_public_key: "UPEER", agent_id: "sage", assistant_name: "Sage" },
      scope: { principal: "joel", stack: "research" },
      capabilities: ["research"],
      startedAt: new Date("2026-06-11T09:00:00.000Z"),
      classification: "federated",
    });
    reg.applyForeign(env, { principal: "joel", stack: "research" });
    const rec = reg.getAgents()[0];
    expect(rec?.origin).toEqual({ kind: "foreign", principal: "joel", stack: "research" });
    expect(rec?.agentId).toBe("sage");
  });

  test("removeForeign() drops foreign records, keeps local, fires onChange", () => {
    const reg = new AgentPresenceRegistry();
    reg.apply(online()); // local luna
    const env = createAgentOnlineEvent({
      source: { principal: "joel", stack: "research", instance: "local" },
      identity: { nkey_public_key: "UPEER", agent_id: "sage", assistant_name: "Sage" },
      scope: { principal: "joel", stack: "research" },
      capabilities: [],
      startedAt: new Date("2026-06-11T09:00:00.000Z"),
      classification: "federated",
    });
    reg.applyForeign(env, { principal: "joel", stack: "research" });
    expect(reg.getAgents().length).toBe(2);

    const changes: string[] = [];
    reg.onChange((key) => changes.push(key));
    const removed = reg.removeForeign();

    expect(removed).toEqual(["joel/research/sage"]);
    const remaining = reg.getAgents();
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.agentId).toBe("luna");
    expect(remaining[0]?.origin).toBe("local");
    // onChange fired for the foreign removal (terminal snapshot).
    expect(changes).toContain("joel/research/sage");
  });
});
