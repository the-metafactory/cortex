/**
 * G-1100.A: NATS connection primitive tests.
 *
 * Uses the `connectImpl` test seam to inject a fake nats.js connection
 * without standing up a real NATS server.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NatsConnection } from "nats";
import { Events } from "nats";
import { NatsLink } from "../connection";

function makeFakeConnection() {
  const statusEvents: { type: string; data: unknown }[] = [];
  // Promise the test awaits to know an event has been observed by the status
  // loop. Avoids real-time setTimeout sleeps in tests.
  let observed: Promise<void> = Promise.resolve();
  let pushStatus: ((s: { type: string; data: unknown }) => void) | null = null;
  let closeStatus: (() => void) | null = null;

  const statusIterator = (async function* () {
    while (true) {
      const next = await new Promise<{ type: string; data: unknown } | null>((resolve) => {
        pushStatus = resolve as (s: { type: string; data: unknown }) => void;
        closeStatus = () => resolve(null);
      });
      if (next === null) return;
      yield next;
    }
  })();

  const drain = mock(async () => {
    if (closeStatus) closeStatus();
  });

  const fakeNc = {
    status: () => statusIterator,
    drain,
  } as unknown as NatsConnection;

  return {
    nc: fakeNc,
    /**
     * Push a status event AND return a promise that resolves once the
     * NatsLink status loop has had a chance to observe it. Tests await this
     * instead of sleeping, so they're deterministic on loaded CI.
     */
    push: async (status: { type: string; data: unknown }) => {
      observed = new Promise<void>((resolve) => {
        // Schedule resolution AFTER the iterator yields the value the loop
        // will observe — two microtask flushes is enough for the event to
        // hop from `resolve(next)` → loop body → console.* call.
        queueMicrotask(() => queueMicrotask(resolve));
      });
      pushStatus?.(status);
      statusEvents.push(status);
      await observed;
    },
    drain,
    statusEvents,
  };
}

describe("NatsLink", () => {
  let consoleSpy: {
    info: ReturnType<typeof mock>;
    warn: ReturnType<typeof mock>;
    error: ReturnType<typeof mock>;
    debug: ReturnType<typeof mock>;
  };
  let originalConsole: {
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
    debug: typeof console.debug;
  };

  beforeEach(() => {
    originalConsole = {
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    consoleSpy = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    console.info = consoleSpy.info;
    console.warn = consoleSpy.warn;
    console.error = consoleSpy.error;
    console.debug = consoleSpy.debug;
  });

  afterEach(() => {
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
  });

  test("requires a url", async () => {
    await expect(NatsLink.connect({ url: "" })).rejects.toThrow(/url is required/);
  });

  test("connects via injected impl and exposes raw + name", async () => {
    const fake = makeFakeConnection();
    const capturedOpts: unknown[] = [];
    const connectImpl = mock(async (opts: unknown) => {
      capturedOpts.push(opts);
      return fake.nc;
    });
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      name: "test-link",
      connectImpl: connectImpl as never,
    });
    expect(link.name).toBe("test-link");
    expect(link.raw).toBe(fake.nc);
    expect(connectImpl).toHaveBeenCalledTimes(1);
    expect(capturedOpts[0]).toMatchObject({
      servers: ["nats://localhost:4222"],
      name: "test-link",
      reconnect: true,
    });
    await link.close();
  });

  test("defaults name to grove-bot", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      connectImpl: async () => fake.nc,
    });
    expect(link.name).toBe("grove-bot");
    await link.close();
  });

  test("close() drains exactly once (idempotent)", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      connectImpl: async () => fake.nc,
    });
    await link.close();
    await link.close();
    expect(fake.drain).toHaveBeenCalledTimes(1);
  });

  test("logs disconnect events as warn", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      name: "warn-test",
      connectImpl: async () => fake.nc,
    });
    await fake.push({ type: Events.Disconnect, data: "nats://localhost:4222" });
    expect(consoleSpy.warn).toHaveBeenCalled();
    const msg = String(consoleSpy.warn.mock.calls[0]?.[0]);
    expect(msg).toContain("warn-test");
    expect(msg).toContain("disconnected");
    await link.close();
  });

  test("logs reconnect events as info", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      name: "info-test",
      connectImpl: async () => fake.nc,
    });
    await fake.push({ type: Events.Reconnect, data: "nats://localhost:4222" });
    expect(consoleSpy.info).toHaveBeenCalled();
    const msg = String(consoleSpy.info.mock.calls[0]?.[0]);
    expect(msg).toContain("info-test");
    expect(msg).toContain("reconnected");
    await link.close();
  });

  test("logs error events as error", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      name: "err-test",
      connectImpl: async () => fake.nc,
    });
    await fake.push({ type: Events.Error, data: new Error("boom") });
    expect(consoleSpy.error).toHaveBeenCalled();
    const msg = String(consoleSpy.error.mock.calls[0]?.[0]);
    expect(msg).toContain("err-test");
    expect(msg).toContain("error");
    await link.close();
  });

  test("propagates underlying connect errors", async () => {
    const failing = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      NatsLink.connect({ url: "nats://nowhere", connectImpl: failing as never }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  test("module is import-safe (no side effects on import)", () => {
    // The mere act of importing nats-connection should not connect, log, or
    // throw — verified implicitly by the test runner having loaded the module
    // already without an active NATS server. Make it explicit:
    expect(typeof NatsLink.connect).toBe("function");
  });
});
