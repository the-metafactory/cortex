import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, ErrorCode, NatsError, type ConnectionOptions, type NatsConnection } from "nats";
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
    const info = spyOn(console, "info");
    const error = spyOn(console, "error");
    const log = spyOn(console, "log");
    const captured: ConnectionOptions[] = [];
    let attempts = 0;
    let settled = false;
    const started = startMyelinRuntime(makeConfig({
      url: "nats://synthetic.invalid:4222", name: "synthetic-primary", subjects: [],
    }), {
      connectImpl: async (opts) => {
        captured.push(opts);
        if (++attempts <= 7) throw NatsError.errorForCode(ErrorCode.ConnectionRefused);
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
      expect(captured.every((opts) => opts.waitOnFirstConnect === false)).toBe(true);
      expect(captured.every((opts) => opts.maxReconnectAttempts === -1)).toBe(true);
      expect(info.mock.calls.filter(([line]) => String(line).includes("connecting (link=primary)"))).toHaveLength(8);
      expect(error.mock.calls.filter(([line]) => String(line).includes("connecting again in"))).toHaveLength(7);
      expect(log.mock.calls.some(([line]) => String(line).includes("connected to nats"))).toBe(true);
      await runtime.publish(makeEnvelope());
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.stop();
    }
  });

  test.each([
    ErrorCode.ConnectionTimeout,
    ErrorCode.Timeout,
    ErrorCode.AuthenticationTimeout,
    ErrorCode.Disconnect,
    ErrorCode.ConnectionClosed,
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EPIPE",
  ])("transient primary connect error recovers: %s", async (code) => {
    let attempts = 0;
    const runtime = await startMyelinRuntime(makeConfig({
      url: "nats://synthetic.invalid:4222", name: "synthetic-primary", subjects: [],
    }), {
      reconnectBackoff: { initialMs: 1 },
      connectImpl: async () => {
        if (++attempts === 1) throw Object.assign(new Error("synthetic unavailable broker"), { code });
        return makeIdleConnectionParts() as NatsConnection;
      },
    });
    try {
      expect(runtime.enabled).toBe(true);
      expect(attempts).toBe(2);
    } finally {
      await runtime.stop();
    }
  });

  test.each([
    new Error("synthetic invalid configuration"),
    Object.assign(new Error("synthetic inaccessible credentials"), { code: "EACCES" }),
    NatsError.errorForCode(ErrorCode.BadCreds),
    NatsError.errorForCode(ErrorCode.BadAuthentication),
    NatsError.errorForCode(ErrorCode.AuthorizationViolation),
    NatsError.errorForCode(ErrorCode.Tls),
    NatsError.errorForCode(ErrorCode.InvalidOption),
  ])("permanent primary connect error rejects startup: %s", async (error) => {
    const setTimer = mock(() => ({}));
    const connectImpl = mock(async () => { throw error; });
    await expect(Promise.race([
      startMyelinRuntime(makeConfig({
        url: "nats://synthetic.invalid:4222", name: "synthetic-primary", subjects: [],
      }), {
        connectImpl,
        reconnectTimer: { setTimer, clearTimer: mock(() => {}) },
      }),
      Bun.sleep(100),
    ])).rejects.toBe(error);
    expect(connectImpl).toHaveBeenCalledTimes(1);
    expect(setTimer).not.toHaveBeenCalled();
  });

  test.each(["missing", "unsafe"])("%s credentials reject startup before dialing", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "cortex-primary-creds-"));
    const credsPath = join(root, "synthetic.creds");
    const connectImpl = mock(async () => makeIdleConnectionParts() as NatsConnection);
    const setTimer = mock(() => ({}));
    try {
      if (mode === "unsafe") {
        await writeFile(credsPath, "synthetic credentials");
        await chmod(credsPath, 0o644);
      }
      await expect(Promise.race([
        startMyelinRuntime(makeConfig({
          url: "nats://synthetic.invalid:4222", name: "synthetic-primary", subjects: [], credsPath,
        }), {
          connectImpl,
          reconnectTimer: { setTimer, clearTimer: mock(() => {}) },
        }),
        Bun.sleep(100),
      ])).rejects.toThrow(mode === "missing" ? /ENOENT/ : /600/);
      expect(connectImpl).not.toHaveBeenCalled();
      expect(setTimer).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
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

test.skipIf(!natsServerBinary)("runtime waits for its primary broker and enables after it starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-primary-boot-"));
  let broker: Awaited<ReturnType<typeof startServer>> | undefined;
  let runtime: Awaited<ReturnType<typeof startMyelinRuntime>> | undefined;
  let starting: ReturnType<typeof startMyelinRuntime> | undefined;
  const error = spyOn(console, "error");
  try {
    broker = await startServer(root, "synthetic-primary");
    await broker.stop();
    let enabled = false;
    starting = startMyelinRuntime(makeConfig({
      url: broker.url, name: "synthetic-primary", subjects: [],
    }), {
      reconnectBackoff: { initialMs: 25, maxMs: 100 },
    }).then((connected) => {
      enabled = connected.enabled;
      return connected;
    });
    await waitFor("runtime retries unavailable primary", () => error.mock.calls.filter(
      ([line]) => String(line).includes("primary connect failed; connecting again"),
    ).length >= 3);
    expect(enabled).toBe(false);
    broker = await broker.restart();
    runtime = await starting;
    expect(runtime.enabled).toBe(true);
  } finally {
    try {
      if (broker && starting && !runtime) {
        await broker.stop();
        broker = await broker.restart();
        runtime = await starting;
      }
      await runtime?.stop();
    } finally {
      await broker?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
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
