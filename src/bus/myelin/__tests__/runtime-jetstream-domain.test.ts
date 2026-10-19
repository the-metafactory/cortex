import { describe, expect, mock, test } from "bun:test";
import type {
  Consumer,
  ConsumerMessages,
  JetStreamClient,
  JetStreamManager,
} from "@nats-io/jetstream";
import type { NatsConnection, Status } from "nats";
import type { AgentConfig } from "../../../common/types/config";
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
  const js = {
    consumers: { get: mock(async () => consumer) },
    views: { kv: mock(async () => ({})) },
  } as unknown as JetStreamClient;
  const jsm = {} as unknown as JetStreamManager;

  let endStatus: () => void = () => {};
  const nc = {
    status: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<Status>>((resolve) => {
            endStatus = () => {
              resolve({ done: true, value: undefined });
            };
          }),
      }),
    }),
    subscribe: mock(() => {
      throw new Error("no push subscription expected");
    }),
    publish: mock(() => {}),
    drain: mock(async () => {
      endStatus();
    }),
    close: mock(async () => {}),
    jetstream: mock((...args: unknown[]) => {
      jetstreamCalls.push(args);
      return js;
    }),
    jetstreamManager: mock(async (...args: unknown[]) => {
      managerCalls.push(args);
      return jsm;
    }),
  } as unknown as NatsConnection;

  return { nc, jetstreamCalls, managerCalls };
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
  test("unset: manager, KV client and pull subscriber get no domain argument", async () => {
    const fake = await startAndBind();

    expect(fake.managerCalls).toEqual([[]]);
    expect(fake.jetstreamCalls).toEqual([[], []]);
  });

  test("set: manager, KV client and pull subscriber are each created with the domain", async () => {
    const fake = await startAndBind(SYNTHETIC_DOMAIN);

    expect(fake.managerCalls).toEqual([[{ domain: SYNTHETIC_DOMAIN }]]);
    expect(fake.jetstreamCalls).toEqual([
      [{ domain: SYNTHETIC_DOMAIN }],
      [{ domain: SYNTHETIC_DOMAIN }],
    ]);
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
