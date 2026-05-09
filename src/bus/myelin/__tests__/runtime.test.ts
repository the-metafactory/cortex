/**
 * G-1100.E: MyelinRuntime tests.
 *
 * Tests focus on the opt-in / no-op surface — when nats config is
 * absent, runtime is a no-op (the bot stays installable). When
 * configured, it logs and connects. Direct integration with a real NATS
 * server is deferred to manual smoke (per design §8 / iteration plan).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NatsConnection, Subscription, Status } from "nats";
import type { BotConfig } from "../../../common/types/config";
import { startMyelinRuntime } from "../runtime";

function makeConfig(natsBlock: BotConfig["nats"]): BotConfig {
  return {
    agent: {
      name: "luna",
      displayName: "Luna",
      operatorId: "andreas",
      operatorName: "Andreas",
    },
    nats: natsBlock,
  } as unknown as BotConfig;
}

function makeFakeNatsConnection() {
  const statusListeners = new Set<(s: Status | null) => void>();
  const subscribePatterns: string[] = [];
  const publishes: { subject: string; payload: string | Uint8Array }[] = [];

  const status = () =>
    (async function* () {
      const queue: (Status | null)[] = [];
      let waiter: ((s: Status | null) => void) | null = null;
      const listener = (s: Status | null) => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(s);
        } else {
          queue.push(s);
        }
      };
      statusListeners.add(listener);
      try {
        while (true) {
          if (queue.length > 0) {
            const next = queue.shift()!;
            if (next === null) return;
            yield next;
            continue;
          }
          const next = await new Promise<Status | null>((r) => (waiter = r));
          if (next === null) return;
          yield next;
        }
      } finally {
        statusListeners.delete(listener);
      }
    })();

  const subscribe = mock((pattern: string) => {
    subscribePatterns.push(pattern);
    let iteratorResolve: (() => void) | null = null;
    const iteratorDone = new Promise<void>((r) => {
      iteratorResolve = r;
    });
    const iterator = (async function* () {
      await iteratorDone;
    })();
    return {
      [Symbol.asyncIterator]: () => iterator,
      drain: mock(async () => {
        iteratorResolve?.();
      }),
      closed: Promise.resolve(),
    } as unknown as Subscription;
  });

  const drain = mock(async () => {
    for (const l of statusListeners) l(null);
  });

  const publish = mock((subject: string, payload: string | Uint8Array) => {
    publishes.push({ subject, payload });
  });

  const nc = { status, subscribe, drain, publish } as unknown as NatsConnection;
  return { nc, subscribe, subscribePatterns, publishes, publish };
}

describe("MyelinRuntime", () => {
  let logs: { kind: "log" | "warn" | "error"; msg: string }[];
  let restore: () => void;

  beforeEach(() => {
    logs = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args: unknown[]) => {
      logs.push({ kind: "log", msg: args.map(String).join(" ") });
    };
    console.warn = (...args: unknown[]) => {
      logs.push({ kind: "warn", msg: args.map(String).join(" ") });
    };
    console.error = (...args: unknown[]) => {
      logs.push({ kind: "error", msg: args.map(String).join(" ") });
    };
    restore = () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    };
  });
  afterEach(() => restore());

  test("returns disabled runtime when nats config absent", async () => {
    const config = makeConfig(undefined);
    const runtime = await startMyelinRuntime(config);
    expect(runtime.enabled).toBe(false);
    expect(logs.filter((l) => l.msg.includes("myelin"))).toEqual([]);
    await runtime.stop();
  });

  test("disabled runtime exposes onEnvelope (handlers register but never fire)", async () => {
    const runtime = await startMyelinRuntime(makeConfig(undefined));
    expect(runtime.enabled).toBe(false);
    let called = 0;
    const reg = runtime.onEnvelope(() => {
      called++;
    });
    expect(typeof reg.unregister).toBe("function");
    reg.unregister();
    expect(called).toBe(0);
    await runtime.stop();
  });

  test("enabled runtime registers + unregisters handlers without throwing", async () => {
    const fake = makeFakeNatsConnection();
    const runtime = await startMyelinRuntime(
      makeConfig({
        url: "nats://localhost:4222",
        name: "grove-bot",
        subjects: ["local.test.>"],
      }),
      { connectImpl: async () => fake.nc },
    );
    expect(runtime.enabled).toBe(true);
    const reg = runtime.onEnvelope(() => {});
    expect(typeof reg.unregister).toBe("function");
    reg.unregister();
    // Re-registering after unregister also fine.
    const reg2 = runtime.onEnvelope(() => {});
    reg2.unregister();
    await runtime.stop();
  });

  test("warns + returns disabled when nats.url present but subjects empty", async () => {
    const config = makeConfig({
      url: "nats://localhost:4222",
      name: "grove-bot",
      subjects: [],
    });
    const runtime = await startMyelinRuntime(config);
    expect(runtime.enabled).toBe(false);
    const warned = logs.some(
      (l) => l.kind === "warn" && l.msg.includes("nats.subjects is empty"),
    );
    expect(warned).toBe(true);
  });

  test("returns disabled when NATS connect fails (logs error, doesn't throw)", async () => {
    const config = makeConfig({
      url: "nats://localhost:9999",
      name: "grove-bot",
      subjects: ["local.test.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => {
        throw new Error("connection refused");
      },
    });
    expect(runtime.enabled).toBe(false);
    const errored = logs.some(
      (l) => l.kind === "error" && l.msg.includes("failed to connect"),
    );
    expect(errored).toBe(true);
  });

  test("subjects placeholder {org} is substituted from agent.operatorId", async () => {
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://localhost:4222",
      name: "grove-bot",
      subjects: ["local.{org}.attention.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
    });
    expect(runtime.enabled).toBe(true);
    expect(fake.subscribePatterns[0]).toBe("local.andreas.attention.>");
    await runtime.stop();
  });

  test("redacts token-form credentials from NATS URL in log output", async () => {
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://secret-token@localhost:4222",
      name: "grove-bot",
      subjects: ["local.test.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
    });
    expect(runtime.enabled).toBe(true);
    const connectLog = logs.find(
      (l) => l.kind === "log" && l.msg.includes("myelin-runtime: connected"),
    );
    expect(connectLog).toBeDefined();
    expect(connectLog!.msg).not.toContain("secret-token");
    expect(connectLog!.msg).toContain("***@");
    await runtime.stop();
  });

  test("redacts user:pass-form credentials from NATS URL", async () => {
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://alice:hunter2@localhost:4222",
      name: "grove-bot",
      subjects: ["local.test.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
    });
    expect(runtime.enabled).toBe(true);
    const connectLog = logs.find(
      (l) => l.kind === "log" && l.msg.includes("myelin-runtime: connected"),
    );
    expect(connectLog).toBeDefined();
    // Both user and password redacted.
    expect(connectLog!.msg).not.toContain("alice");
    expect(connectLog!.msg).not.toContain("hunter2");
    expect(connectLog!.msg).toContain("***@");
    await runtime.stop();
  });

  test("stop() on enabled runtime drains subscribers and closes link, idempotent", async () => {
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://localhost:4222",
      name: "grove-bot",
      subjects: ["local.test.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
    });
    expect(runtime.enabled).toBe(true);
    await runtime.stop();
    await runtime.stop(); // second call must not redo work
    // The "stopped" log line must appear exactly once across both
    // invocations, not twice — proves the `stopped` flag in the
    // closure actually short-circuits.
    const stoppedLines = logs.filter(
      (l) => l.kind === "log" && l.msg.includes("myelin-runtime: stopped"),
    );
    expect(stoppedLines.length).toBe(1);
  });

  describe("publish()", () => {
    function makeEnvelope(overrides: Partial<{ id: string; type: string }> = {}) {
      return {
        id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
        source: "metafactory.grove.local",
        type: overrides.type ?? "system.adapter.degraded",
        timestamp: "2026-05-09T12:00:00.000Z",
        sovereignty: {
          classification: "local" as const,
          data_residency: "NZ",
          max_hop: 0,
          frontier_ok: true,
          model_class: "any" as const,
        },
        payload: { adapter_id: "discord-luna" },
      };
    }

    test("disabled runtime: publish is a no-op (resolves, no NATS calls)", async () => {
      const runtime = await startMyelinRuntime(makeConfig(undefined));
      expect(runtime.enabled).toBe(false);
      // Must not throw and must not log a publish line — there's no
      // connection to log against.
      await runtime.publish(makeEnvelope());
      const errLines = logs.filter((l) => l.kind === "error");
      expect(errLines).toEqual([]);
      await runtime.stop();
    });

    test("enabled runtime: publish forwards to NATS with subject local.{org}.{type}", async () => {
      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "grove-bot",
          subjects: ["local.{org}.system.>"],
        }),
        { connectImpl: async () => fake.nc },
      );
      expect(runtime.enabled).toBe(true);
      const env = makeEnvelope({ type: "system.adapter.degraded" });
      await runtime.publish(env);
      expect(fake.publish).toHaveBeenCalledTimes(1);
      // operatorId in makeConfig is "andreas" — that becomes the {org} segment.
      expect(fake.publishes[0]?.subject).toBe(
        "local.andreas.system.adapter.degraded",
      );
      // Payload is the JSON-serialised envelope; round-trip restores it intact.
      const payload = fake.publishes[0]?.payload as string;
      expect(typeof payload).toBe("string");
      expect(JSON.parse(payload)).toEqual(env);
      await runtime.stop();
    });

    test("publish swallows underlying NATS errors (logs, never throws)", async () => {
      const fake = makeFakeNatsConnection();
      // Force the underlying nc.publish to throw — simulates connection-closed
      // or oversized-payload errors.
      (fake.nc as { publish: (s: string, p: unknown) => void }).publish = () => {
        throw new Error("connection closed");
      };
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "grove-bot",
          subjects: ["local.{org}.system.>"],
        }),
        { connectImpl: async () => fake.nc },
      );
      // Must NOT throw — publish failure is non-fatal by design.
      await expect(runtime.publish(makeEnvelope())).resolves.toBeUndefined();
      const errored = logs.some(
        (l) => l.kind === "error" && l.msg.includes("publish failed"),
      );
      expect(errored).toBe(true);
      await runtime.stop();
    });

    test("publish after stop() is a no-op (no late publishes after drain)", async () => {
      // Pins the post-stop semantic documented on `publishEnabled` in
      // runtime.ts: once `stop()` returns, calls to `runtime.publish(...)`
      // must short-circuit before reaching `link.publish`. The underlying
      // nats client is drain-safe, but the runtime contract is explicit:
      // post-stop publish is a no-op the caller can rely on.
      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "grove-bot",
          subjects: ["local.{org}.system.>"],
        }),
        { connectImpl: async () => fake.nc },
      );
      expect(runtime.enabled).toBe(true);
      await runtime.stop();
      await runtime.publish(makeEnvelope());
      // The fake's publish was never called — runtime short-circuited.
      expect(fake.publish).not.toHaveBeenCalled();
    });
  });
});
