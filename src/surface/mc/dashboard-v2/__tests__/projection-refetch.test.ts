/**
 * MC-I1.S6 / C-863 — `mc.projection` → debounced-refetch wiring tests.
 *
 * Covers (per the issue's test plan):
 *   - the family→view routing policy (`projection-routing`);
 *   - the subscriber core (`projection-subscriber`): a targeting frame fires a
 *     debounced refetch; a burst of N frames coalesces into ONE; non-targeting
 *     and unknown families are ignored; OTHER frame types are unaffected;
 *     teardown cancels a pending refetch (no setState-after-unmount).
 *
 * No DOM: the subscriber is exercised against a fake `WsClient.subscribe` and a
 * fake clock, mirroring the codebase's "extract the logic, unit-test the helper"
 * convention (see working-grid / markdown tests).
 */

import { describe, it, expect } from "bun:test";
import {
  routeProjectionFamily,
  projectionAffectsView,
  PROJECTION_FAMILIES,
} from "../lib/projection-routing";
import {
  attachProjectionRefetch,
  type TimerLike,
} from "../lib/projection-subscriber";
import type { WsClient, WsMessage } from "../hooks/use-websocket";

// ----- fake WS client: capture subscriptions, emit frames manually -----

function makeFakeWs(): {
  ws: Pick<WsClient, "subscribe">;
  emit: (msg: WsMessage) => void;
  subCount: (type: string) => number;
} {
  const subs = new Map<string, Set<(m: WsMessage) => void>>();
  const subscribe: WsClient["subscribe"] = (type, handler) => {
    let set = subs.get(type);
    if (!set) {
      set = new Set();
      subs.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) subs.delete(type);
    };
  };
  return {
    ws: { subscribe },
    emit: (msg) => subs.get(msg.type)?.forEach((h) => h(msg)),
    subCount: (type) => subs.get(type)?.size ?? 0,
  };
}

// ----- fake clock: manual trailing-debounce control -----

function makeFakeTimer(): { timer: TimerLike; flush: () => void; pendingCount: () => number } {
  let next = 1;
  const cbs = new Map<number, () => void>();
  const timer: TimerLike = {
    set: (cb) => {
      const id = next++;
      cbs.set(id, cb);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (h) => {
      cbs.delete(h as unknown as number);
    },
  };
  return {
    timer,
    flush: () => {
      const snapshot = [...cbs.entries()];
      cbs.clear();
      for (const [, cb] of snapshot) cb();
    },
    pendingCount: () => cbs.size,
  };
}

function projFrame(family: string, extra: Record<string, unknown> = {}): WsMessage {
  return { type: "mc.projection", family, ...extra };
}

describe("routeProjectionFamily — S6 family → live-view policy", () => {
  it("dispatch.lifecycle invalidates the working grid AND the task table", () => {
    expect(routeProjectionFamily("dispatch.lifecycle")).toEqual([
      "working-agents",
      "tasks",
    ]);
  });

  it("review.verdict invalidates the working grid AND the attention queue", () => {
    expect(routeProjectionFamily("review.verdict")).toEqual([
      "working-agents",
      "attention",
    ]);
  });

  it("agent.heartbeat invalidates only the working grid", () => {
    expect(routeProjectionFamily("agent.heartbeat")).toEqual(["working-agents"]);
  });

  it("attention invalidates only the attention queue", () => {
    expect(routeProjectionFamily("attention")).toEqual(["attention"]);
  });

  it("adapter.health touches no live execution pane (empty route)", () => {
    expect(routeProjectionFamily("adapter.health")).toEqual([]);
  });

  it("an unknown family routes to nothing (defensive against future server families)", () => {
    expect(routeProjectionFamily("future.thing")).toEqual([]);
    expect(routeProjectionFamily("")).toEqual([]);
  });

  it("every declared family is routable without throwing", () => {
    for (const fam of PROJECTION_FAMILIES) {
      expect(Array.isArray(routeProjectionFamily(fam))).toBe(true);
    }
  });

  it("projectionAffectsView agrees with the route", () => {
    expect(projectionAffectsView("dispatch.lifecycle", "tasks")).toBe(true);
    expect(projectionAffectsView("dispatch.lifecycle", "attention")).toBe(false);
    expect(projectionAffectsView("attention", "attention")).toBe(true);
    expect(projectionAffectsView("adapter.health", "working-agents")).toBe(false);
  });
});

describe("attachProjectionRefetch — debounced refetch on mc.projection", () => {
  it("subscribes to exactly the mc.projection frame type", () => {
    const { ws, subCount } = makeFakeWs();
    const { timer } = makeFakeTimer();
    const teardown = attachProjectionRefetch({
      subscribe: ws.subscribe,
      view: "working-agents",
      refetch: () => {},
      debounceMs: 300,
      timer,
    });
    expect(subCount("mc.projection")).toBe(1);
    expect(subCount("state.transition")).toBe(0);
    teardown();
    expect(subCount("mc.projection")).toBe(0);
  });

  it("a targeting frame schedules a refetch that fires after the debounce window", () => {
    const { ws, emit } = makeFakeWs();
    const { timer, flush } = makeFakeTimer();
    let calls = 0;
    attachProjectionRefetch({
      subscribe: ws.subscribe,
      view: "working-agents",
      refetch: () => calls++,
      debounceMs: 300,
      timer,
    });

    emit(projFrame("agent.heartbeat"));
    expect(calls).toBe(0); // not yet — trailing debounce
    flush();
    expect(calls).toBe(1);
  });

  it("a burst of N targeting frames coalesces into ONE refetch", () => {
    const { ws, emit } = makeFakeWs();
    const { timer, flush, pendingCount } = makeFakeTimer();
    let calls = 0;
    attachProjectionRefetch({
      subscribe: ws.subscribe,
      view: "tasks",
      refetch: () => calls++,
      debounceMs: 300,
      timer,
    });

    for (let i = 0; i < 5; i++) emit(projFrame("dispatch.lifecycle", { sessionId: `s${i}` }));
    // Each frame resets the trailing timer → only one pending callback.
    expect(pendingCount()).toBe(1);
    flush();
    expect(calls).toBe(1);
  });

  it("ignores frames whose family does not route to this view", () => {
    const { ws, emit } = makeFakeWs();
    const { timer, flush, pendingCount } = makeFakeTimer();
    let calls = 0;
    attachProjectionRefetch({
      subscribe: ws.subscribe,
      view: "attention",
      refetch: () => calls++,
      debounceMs: 300,
      timer,
    });

    // agent.heartbeat → working-agents only, not attention.
    emit(projFrame("agent.heartbeat"));
    expect(pendingCount()).toBe(0);
    flush();
    expect(calls).toBe(0);

    // attention → attention: now it fires.
    emit(projFrame("attention"));
    flush();
    expect(calls).toBe(1);
  });

  it("ignores unknown families and malformed frames (no family / non-string family)", () => {
    const { ws, emit } = makeFakeWs();
    const { timer, flush } = makeFakeTimer();
    let calls = 0;
    attachProjectionRefetch({
      subscribe: ws.subscribe,
      view: "working-agents",
      refetch: () => calls++,
      debounceMs: 300,
      timer,
    });

    emit(projFrame("future.unknown"));
    emit({ type: "mc.projection" }); // no family
    emit({ type: "mc.projection", family: 42 }); // non-string family
    flush();
    expect(calls).toBe(0);
  });

  it("does NOT react to other frame types (additive — existing handling untouched)", () => {
    const { ws, emit } = makeFakeWs();
    const { timer, flush } = makeFakeTimer();
    let calls = 0;
    attachProjectionRefetch({
      subscribe: ws.subscribe,
      view: "working-agents",
      refetch: () => calls++,
      debounceMs: 300,
      timer,
    });

    emit({ type: "state.transition" });
    emit({ type: "task.updated", task: {} });
    emit({ type: "iteration.created" });
    flush();
    expect(calls).toBe(0);
  });

  it("teardown cancels a pending refetch — no fire after unmount", () => {
    const { ws, emit, subCount } = makeFakeWs();
    const { timer, flush, pendingCount } = makeFakeTimer();
    let calls = 0;
    const teardown = attachProjectionRefetch({
      subscribe: ws.subscribe,
      view: "working-agents",
      refetch: () => calls++,
      debounceMs: 300,
      timer,
    });

    emit(projFrame("agent.heartbeat"));
    expect(pendingCount()).toBe(1);
    teardown();
    expect(pendingCount()).toBe(0); // pending timer cleared
    expect(subCount("mc.projection")).toBe(0); // unsubscribed
    flush();
    expect(calls).toBe(0); // never fired post-teardown
  });

  it("frames arriving after teardown are not handled (unsubscribed)", () => {
    const { ws, emit } = makeFakeWs();
    const { timer, flush } = makeFakeTimer();
    let calls = 0;
    const teardown = attachProjectionRefetch({
      subscribe: ws.subscribe,
      view: "working-agents",
      refetch: () => calls++,
      debounceMs: 300,
      timer,
    });
    teardown();
    emit(projFrame("agent.heartbeat"));
    flush();
    expect(calls).toBe(0);
  });
});
