// glossary-ignore: run
import { describe, expect, mock, test } from "bun:test";
import { startVigilTick } from "../tick";
import { fakeTickScheduler, flushTick } from "./fixtures";

describe("Vigil tick loop", () => {
  test("runs once at startup and at every five-minute interval", async () => {
    const scheduler = fakeTickScheduler();
    const run = mock(() => {});
    const loop = startVigilTick({ run, schedule: scheduler.schedule });
    await flushTick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.intervalMs).toBe(300_000);
    scheduler.tick(); await flushTick();
    scheduler.tick(); await flushTick();
    expect(run).toHaveBeenCalledTimes(3);
    await loop.stop();
  });

  test("accepts an injected interval", async () => {
    const scheduler = fakeTickScheduler();
    const loop = startVigilTick({ run: () => {}, intervalMs: 42, schedule: scheduler.schedule });
    expect(scheduler.intervalMs).toBe(42);
    await loop.stop();
  });

  test("logs synchronous throws and rejected promises, then keeps ticking", async () => {
    const scheduler = fakeTickScheduler();
    const onError = mock((_err: unknown) => {});
    let runs = 0;
    const loop = startVigilTick({
      run: () => {
        runs += 1;
        if (runs === 1) throw new Error("sync failure");
        if (runs === 2) return Promise.reject(new Error("async failure"));
      },
      onError, schedule: scheduler.schedule,
    });
    await flushTick();
    scheduler.tick(); await flushTick();
    scheduler.tick(); await flushTick();
    expect(runs).toBe(3);
    expect(onError.mock.calls.map(([err]) => (err as Error).message)).toEqual(["sync failure", "async failure"]);
    await loop.stop();
  });

  test("stop cancels once, ignores queued callbacks and drains for every caller", async () => {
    const scheduler = fakeTickScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = mock(async () => { await gate; });
    const loop = startVigilTick({ run, schedule: scheduler.schedule });
    await flushTick();
    scheduler.tick(); // no overlapping passes while the first is parked
    await flushTick();
    expect(run).toHaveBeenCalledTimes(1);

    let stopped = 0;
    const first = loop.stop().then(() => { stopped += 1; });
    const second = loop.stop().then(() => { stopped += 1; });
    await flushTick();
    expect(scheduler.cancellations).toBe(1);
    expect(stopped).toBe(0);
    scheduler.tick();
    release();
    await Promise.all([first, second]);
    expect(stopped).toBe(2);
    scheduler.tick(); await flushTick();
    expect(run).toHaveBeenCalledTimes(1);
    await loop.stop();
    expect(scheduler.cancellations).toBe(1);
  });

  test("stop still drains an in-flight tick that rejects", async () => {
    const scheduler = fakeTickScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onError = mock((_err: unknown) => {});
    const loop = startVigilTick({
      run: async () => { await gate; throw new Error("failed while stopping"); },
      onError, schedule: scheduler.schedule,
    });
    await flushTick();
    const stopping = loop.stop();
    release();
    await stopping;
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
