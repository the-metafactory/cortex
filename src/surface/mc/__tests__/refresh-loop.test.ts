/**
 * ML.5 — cockpit refresh loop: scheduling + isolation + stop (injected scheduler).
 */
import { describe, it, expect } from "bun:test";
import { startCockpitRefreshLoop } from "../refresh-loop";

/** A fake scheduler that captures the tick fn so the test drives it manually. */
function fakeScheduler() {
  let captured: (() => void) | null = null;
  let cancelled = false;
  const schedule = (fn: () => void, _ms: number) => {
    captured = fn;
    return () => { cancelled = true; };
  };
  return { schedule, tick: () => captured?.(), get cancelled() { return cancelled; } };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("startCockpitRefreshLoop (ML.5)", () => {
  it("runs once on start, then on each scheduled tick", async () => {
    const s = fakeScheduler();
    let runs = 0;
    startCockpitRefreshLoop({ run: async () => { runs += 1; }, intervalMs: 1000, schedule: s.schedule });
    await flush();
    expect(runs).toBe(1); // runOnStart
    s.tick(); await flush();
    s.tick(); await flush();
    expect(runs).toBe(3);
  });

  it("runOnStart:false defers the first run to the first tick", async () => {
    const s = fakeScheduler();
    let runs = 0;
    startCockpitRefreshLoop({ run: async () => { runs += 1; }, intervalMs: 1000, runOnStart: false, schedule: s.schedule });
    await flush();
    expect(runs).toBe(0);
    s.tick(); await flush();
    expect(runs).toBe(1);
  });

  it("isolates a failing run: routes to onError, keeps ticking", async () => {
    const s = fakeScheduler();
    const errors: unknown[] = [];
    let runs = 0;
    startCockpitRefreshLoop({
      run: async () => { runs += 1; throw new Error(`boom ${runs}`); },
      intervalMs: 1000,
      onError: (e) => errors.push(e),
      schedule: s.schedule,
    });
    await flush();
    s.tick(); await flush();
    expect(runs).toBe(2); // kept ticking despite the first throw
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe("boom 1");
  });

  it("stop() cancels the schedule and is idempotent", () => {
    const s = fakeScheduler();
    const loop = startCockpitRefreshLoop({ run: async () => {}, intervalMs: 1000, runOnStart: false, schedule: s.schedule });
    expect(s.cancelled).toBe(false);
    loop.stop();
    expect(s.cancelled).toBe(true);
    loop.stop(); // idempotent — no throw
  });
});
