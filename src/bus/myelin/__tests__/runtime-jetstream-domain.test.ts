import { describe, expect, mock, test } from "bun:test";
import type {
  Consumer,
  ConsumerMessages,
  JetStreamClient,
  JetStreamManager,
} from "@nats-io/jetstream";
import type { NatsConnection } from "nats";
import type { AgentConfig } from "../../../common/types/config";
import { makeIdleConnectionParts } from "./idle-nats-connection";
import { MyelinRuntimeConfigError, startMyelinRuntime } from "../runtime";

const SYNTHETIC_DOMAIN = "synthetic-domain";

function makeConfig(): AgentConfig {
  return {
    agent: { name: "tester", displayName: "Tester" },
    nats: { url: "nats://localhost:4222", subjects: [] },
  } as unknown as AgentConfig;
}

function makeRecordingConn() {
  const jetstreamCalls: unknown[][] = [];
  const managerCalls: unknown[][] = [];

  let endIteration: (result: IteratorResult<never>) => void = () => {};
  const idleMessages = {
    close: mock(async () => {
      endIteration({ done: true, value: undefined });
    }),
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<never>>((resolve) => {
          endIteration = resolve;
        }),
    }),
  } as unknown as ConsumerMessages;
  const consumer = { consume: mock(async () => idleMessages) } as unknown as Consumer;
  const consumerGet = mock(async () => consumer);
  const js = {
    consumers: { get: consumerGet },
    views: { kv: mock(async () => ({})) },
  } as unknown as JetStreamClient;
  const jsm = {} as unknown as JetStreamManager;

  const nc = {
    ...makeIdleConnectionParts(),
    publish: mock(() => {}),
    jetstream: mock((...args: unknown[]) => {
      jetstreamCalls.push(args);
      return js;
    }),
    jetstreamManager: mock(async (...args: unknown[]) => {
      managerCalls.push(args);
      return jsm;
    }),
  } as unknown as NatsConnection;

  return { nc, jetstreamCalls, managerCalls, consumerGet };
}

async function startAndBind(jetstreamDomain?: string) {
  const fake = makeRecordingConn();
  const runtime = await startMyelinRuntime(makeConfig(), {
    connectImpl: async () => fake.nc,
    ...(jetstreamDomain !== undefined && { jetstreamDomain }),
  });
  await runtime.jetstreamManager?.();
  await runtime.kvBucket?.("synthetic-bucket");
  const sub = runtime.subscribePull?.({
    pattern: "local.>",
    stream: "SYNTHETIC",
    durable: "synthetic-durable",
    onEnvelope: () => {},
  });
  await sub?.ready;
  await runtime.stop();
  return fake;
}

describe("startMyelinRuntime jetstreamDomain", () => {
  test("a rejected manager promise is shared only until rejection", async () => {
    const fake = makeRecordingConn();
    const manager = {} as Awaited<ReturnType<NatsConnection["jetstreamManager"]>>;
    const timeout = Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
    const getManager = mock(async () => {
      if (getManager.mock.calls.length === 1) throw timeout;
      return manager;
    });
    fake.nc.jetstreamManager = getManager;
    const runtime = await startMyelinRuntime(makeConfig(), { connectImpl: async () => fake.nc });
    try {
      const first = runtime.jetstreamManager!();
      const concurrent = runtime.jetstreamManager!();
      expect(first).toBe(concurrent);
      await expect(first).rejects.toBe(timeout);
      await expect(runtime.jetstreamManager!()).resolves.toBe(manager);
      await expect(runtime.jetstreamManager!()).resolves.toBe(manager);
      expect(getManager).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
    }
  });

  test.each([false, true])("pull retry is opt-in through runtime (enabled=%s)", async (enabled) => {
    const fake = makeRecordingConn();
    const error = Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
    fake.consumerGet.mockImplementationOnce(async () => { throw error; });
    const runtime = await startMyelinRuntime(makeConfig(), { connectImpl: async () => fake.nc });
    const delays: number[] = [];
    try {
      const sub = runtime.subscribePull!({
        pattern: "local.>", stream: "SYNTHETIC", durable: "synthetic-retry", onEnvelope: () => {},
        ...(enabled && { bootRetry: { sleep: async (ms: number) => { delays.push(ms); } } }),
      });
      if (enabled) {
        await sub!.ready;
        expect(delays).toEqual([1_000]);
        expect(fake.consumerGet).toHaveBeenCalledTimes(2);
      } else {
        await expect(sub!.ready).rejects.toBe(error);
        expect(delays).toEqual([]);
        expect(fake.consumerGet).toHaveBeenCalledTimes(1);
      }
    } finally {
      await runtime.stop();
    }
  });

  test("unset: manager, KV client and pull subscriber get no domain argument", async () => {
    const fake = await startAndBind();

    expect(fake.managerCalls).toEqual([[{ timeout: 10_000 }]]);
    expect(fake.jetstreamCalls).toEqual([[{ timeout: 10_000 }], [{ timeout: 10_000 }]]);
  });

  test("set: manager, KV client and pull subscriber are each created with the domain", async () => {
    const fake = await startAndBind(SYNTHETIC_DOMAIN);

    expect(fake.managerCalls).toEqual([[{ domain: SYNTHETIC_DOMAIN, timeout: 10_000 }]]);
    expect(fake.jetstreamCalls).toEqual([
      [{ domain: SYNTHETIC_DOMAIN, timeout: 10_000 }],
      [{ domain: SYNTHETIC_DOMAIN, timeout: 10_000 }],
    ]);
  });

  test.each(["config", "option"])("API timeout is configurable through %s", async (via) => {
    const fake = makeRecordingConn();
    const config = makeConfig();
    if (via === "config") config.nats!.jetstreamTimeoutMs = 25_000;
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
      ...(via === "option" && { jetstreamTimeoutMs: 25_000 }),
    });
    try {
      await runtime.jetstreamManager!();
      await runtime.kvBucket!("synthetic-bucket");
      const sub = runtime.subscribePull!({ pattern: "local.>", stream: "SYNTHETIC", durable: "synthetic-durable", onEnvelope: () => {} });
      await sub!.ready;
      expect(fake.managerCalls).toEqual([[{ timeout: 25_000 }]]);
      expect(fake.jetstreamCalls).toEqual([[{ timeout: 25_000 }], [{ timeout: 25_000 }]]);
    } finally {
      await runtime.stop();
    }
  });

  test.each([0, -1, NaN, Infinity])("rejects invalid API timeout %s before connecting", async (jetstreamTimeoutMs) => {
    const connect = mock(async () => makeRecordingConn().nc);
    await expect(startMyelinRuntime(makeConfig(), { connectImpl: connect, jetstreamTimeoutMs })).rejects.toBeInstanceOf(MyelinRuntimeConfigError);
    expect(connect).not.toHaveBeenCalled();
  });

  test.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["number", 7],
    ["null", null],
    ["object", {}],
  ])("rejects %s with a typed configuration error", async (_label, bad) => {
    const fake = makeRecordingConn();
    const connect = mock(async () => fake.nc);

    const started = startMyelinRuntime(makeConfig(), {
      connectImpl: connect,
      jetstreamDomain: bad as unknown as string,
    });

    await expect(started).rejects.toBeInstanceOf(MyelinRuntimeConfigError);
    await expect(started).rejects.toMatchObject({ option: "jetstreamDomain" });
    expect(connect).not.toHaveBeenCalled();
  });
});
