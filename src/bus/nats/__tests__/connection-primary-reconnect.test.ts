import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type ConnectionOptions, type NatsConnection } from "nats";
import { natsServerBinary, startServer, waitFor } from "../../__tests__/two-domain-broker";
import { makeIdleConnectionParts } from "../../myelin/__tests__/idle-nats-connection";
import { makeConfig, makeEnvelope } from "../../myelin/__tests__/runtime-publish-durable-fixture";
import { startMyelinRuntime } from "../../myelin/runtime";
import { NatsLink, type NatsLinkOptions } from "../connection";

afterEach(() => mock.restore());

async function captureLink(options: Partial<NatsLinkOptions> = {}) {
  let captured: ConnectionOptions | undefined;
  const link = await NatsLink.connect({
    url: "nats://synthetic.invalid:4222",
    ...options,
    connectImpl: async (opts) => {
      captured = opts;
      return makeIdleConnectionParts() as NatsConnection;
    },
  });
  if (!captured) throw new Error("connect options were not captured");
  return { link, options: captured };
}

describe("primary NATS reconnect policy", () => {
  test("sets explicit resilient defaults", async () => {
    const { link, options } = await captureLink();
    try {
      expect(options).toMatchObject({
        reconnect: true,
        waitOnFirstConnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2_000,
        reconnectJitter: 100,
        reconnectJitterTLS: 1_000,
        timeout: 20_000,
      });
      expect(options.reconnectDelayHandler?.()).toBeGreaterThanOrEqual(2_000);
      expect(options.reconnectDelayHandler?.()).toBeLessThan(2_100);
    } finally {
      await link.close();
    }
  });

  test("allows every timeout and reconnect option to be configured on the link", async () => {
    const overrides = {
      waitOnFirstConnect: false,
      maxReconnectAttempts: 12,
      reconnectTimeWait: 450,
      reconnectJitter: 80,
      reconnectJitterTLS: 160,
      timeout: 35_000,
    };
    const { link, options } = await captureLink({ ...overrides, tls: {} });
    try {
      expect(options).toMatchObject(overrides);
      spyOn(Math, "random").mockReturnValue(0.5);
      expect(options.reconnectDelayHandler?.()).toBe(530);
    } finally {
      await link.close();
    }
  });

  test("driver initial attempts wait 1s, double to 30s, and do not advance on timer wakeup", async () => {
    let now = 1_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const link = await NatsLink.connect({
      url: "nats://synthetic.invalid:4222",
      connectImpl: async (opts) => {
        const delay = opts.reconnectDelayHandler;
        if (!delay) throw new Error("missing reconnect delay handler");
        expect(delay()).toBe(0);
        for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
          now += 20_000;
          expect(delay()).toBe(20_000 + wait);
          now += wait - 1;
          expect(delay()).toBe(20_000 + wait);
          now += 1;
          expect(delay()).toBe(0);
        }
        return makeIdleConnectionParts() as NatsConnection;
      },
    });
    clock.mockRestore();
    await link.close();
  });

  test("runtime stays pending through repeated rejections and enables after capped retries", async () => {
    const pending: (() => void)[] = [];
    const waits: number[] = [];
    const publish = mock(() => {});
    let attempts = 0;
    let settled = false;
    const started = startMyelinRuntime(makeConfig({
      url: "nats://synthetic.invalid:4222", name: "synthetic-primary", subjects: [],
    }), {
      connectImpl: async () => {
        if (++attempts <= 7) throw new Error("synthetic broker unavailable");
        return { ...makeIdleConnectionParts(), publish } as unknown as NatsConnection;
      },
      reconnectTimer: {
        setTimer: (cb, ms) => {
          pending.push(cb);
          waits.push(ms);
          return {};
        },
        clearTimer: mock(() => {}),
      },
    }).then((runtime) => {
      settled = true;
      return runtime;
    });
    for (let index = 0; index < 7; index++) {
      await waitFor("primary retry scheduled", () => pending.length === 1);
      expect(settled).toBe(false);
      pending.shift()?.();
    }
    const runtime = await started;
    try {
      expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
      expect(runtime.enabled).toBe(true);
      expect(attempts).toBe(8);
      await runtime.publish(makeEnvelope());
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.stop();
    }
  });

  test("no configured bus remains disabled without attempting to connect", async () => {
    const connectImpl = mock(async () => makeIdleConnectionParts() as NatsConnection);
    const runtime = await startMyelinRuntime(makeConfig(), { connectImpl });
    expect(runtime.enabled).toBe(false);
    expect(connectImpl).not.toHaveBeenCalled();
    await runtime.stop();
  });
});

test.skipIf(!natsServerBinary)("primary waits at boot and restores its subscription after a broker outage longer than 20s", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-primary-reconnect-"));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let link: NatsLink | undefined;
  const info = spyOn(console, "info");
  const debug = spyOn(console, "debug");
  try {
    server = await startServer(root, "synthetic-primary");
    await server.stop();
    let delayCalls = 0;
    const connecting = NatsLink.connect({
      url: server.url,
      name: "synthetic-primary",
      initialConnectBackoff: { initialMs: 25, maxMs: 100 },
      connectImpl: (opts) => connect({
        ...opts,
        reconnectDelayHandler: () => {
          delayCalls++;
          return opts.reconnectDelayHandler?.() ?? 0;
        },
      }),
    });
    await waitFor("initial connection retried", () => delayCalls >= 3);
    server = await server.restart();
    link = await connecting;
    const messages: string[] = [];
    const subscription = link.raw.subscribe("synthetic.primary", {
      callback: (err, msg) => {
        if (err) throw err;
        messages.push(new TextDecoder().decode(msg.data));
      },
    });
    link.publish("synthetic.primary", "before");
    await link.raw.flush();
    await waitFor("initial subscription delivery", () => messages.length === 1);
    await server.stop();
    await Bun.sleep(21_000);
    expect(link.raw.isClosed()).toBe(false);
    server = await server.restart();
    await waitFor("primary reconnect", () => info.mock.calls.some(([line]) => String(line).includes("reconnected")));
    link.publish("synthetic.primary", "after");
    await link.raw.flush();
    await waitFor("subscription delivery after reconnect", () => messages.length === 2);
    expect(messages).toEqual(["before", "after"]);
    expect(debug.mock.calls.some(([line]) => String(line).includes('"synthetic-primary" connecting'))).toBe(true);
    expect(debug.mock.calls.some(([line]) => String(line).includes('"synthetic-primary" connected'))).toBe(true);
    expect(info.mock.calls.some(([line]) => String(line).includes('"synthetic-primary" reconnecting'))).toBe(true);
    subscription.unsubscribe();
  } finally {
    await link?.close();
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
