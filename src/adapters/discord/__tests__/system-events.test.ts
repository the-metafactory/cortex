/**
 * MIG-3b-ii: integration tests for `system.adapter.*` event emission from
 * the Discord adapter.
 *
 * The adapter's `start()` wires three discord.js shard events to bus
 * publishes via the new system-events helpers:
 *   - shardDisconnect → system.adapter.disconnected
 *   - degraded threshold elapsed → system.adapter.degraded
 *   - shardReady after degraded → system.adapter.recovered
 *
 * Tests use a fake `MyelinRuntime` that records publishes; the discord.js
 * client is started in headless mode (no `login()` call) and shard events
 * are emitted directly via `client.emit(...)` — same pattern as
 * `client-degraded.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../../bus/myelin/runtime";
import type { BotConfig } from "../../../common/types/config";
import { DiscordAdapter, type DiscordAdapterConfig } from "../index";

const stubBotConfig = {
  agent: { displayName: "Test", operatorId: "andreas" },
  discord: [{ guildId: "g1" }],
} as unknown as BotConfig;

function makeAdapterConfig(overrides: Partial<DiscordAdapterConfig> = {}): DiscordAdapterConfig {
  return {
    instanceId: "discord-test",
    token: "fake-token",
    guildId: "g1",
    agentChannelId: "ch1",
    logChannelId: "ch2",
    contextDepth: 5,
    enableAgentLog: false,
    ...overrides,
  };
}

interface RecordingRuntime extends MyelinRuntime {
  publishes: Envelope[];
}

function makeRecordingRuntime(): RecordingRuntime {
  const publishes: Envelope[] = [];
  return {
    enabled: true,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: async (envelope: Envelope) => {
      publishes.push(envelope);
    },
    stop: async () => {},
    publishes,
  };
}

/**
 * Build an adapter and start it in a way that doesn't require a real Discord
 * connection. We monkey-patch `client.login` AFTER `start()` is called by
 * extracting the client mid-start: the trick is that `start()` builds the
 * client first, then awaits login. We intercept by overriding the underlying
 * `Client.prototype.login` once via mock.
 */
async function buildStartedAdapter(opts: {
  runtime?: MyelinRuntime;
  systemEventSource?: { org: string; agent: string; instance: string };
  degradedThresholdMs?: number;
} = {}) {
  // discord.js Client is constructed inside start(); the only way to skip
  // the network call is to make login() resolve without doing anything.
  // We do this via a subclass-style override on the result.
  const adapter = new DiscordAdapter(
    makeAdapterConfig(),
    stubBotConfig,
    {
      ...(opts.runtime !== undefined && { runtime: opts.runtime }),
      ...(opts.systemEventSource !== undefined && {
        systemEventSource: opts.systemEventSource,
      }),
    },
  );
  // Reach in: replace client.login with a no-op before the real login fires.
  // The cleanest way is to start, then immediately replace the running
  // client's login — but start() awaits login. Instead, we patch the
  // discord.js Client prototype temporarily.
  const { Client } = await import("discord.js");
  const origLogin = Client.prototype.login;
  Client.prototype.login = mock(async () => "fake-token");
  try {
    await adapter.start(async () => {});
  } finally {
    Client.prototype.login = origLogin;
  }
  // The default degraded threshold is 60s; tests need a short value to keep
  // wall time low. We can't pass it in via adapter constructor (Discord
  // adapter currently doesn't expose that knob), so reach into the client's
  // internals isn't a stable test. Instead we manipulate the client directly.
  return adapter;
}

let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let originalError: typeof console.error;

beforeEach(() => {
  originalLog = console.log;
  originalWarn = console.warn;
  originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
});

describe("DiscordAdapter system.adapter.* emission", () => {
  test("shardDisconnect publishes system.adapter.disconnected with correct payload", async () => {
    const runtime = makeRecordingRuntime();
    const adapter = await buildStartedAdapter({
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    const client = adapter.getClient()!;
    // Emit a non-clean disconnect (1006 = abnormal closure)
    (client as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      "shardDisconnect",
      { code: 1006, reason: "abnormal closure" },
      0,
    );

    expect(runtime.publishes.length).toBe(1);
    const env = runtime.publishes[0]!;
    expect(env.type).toBe("system.adapter.disconnected");
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.payload).toMatchObject({
      adapter_id: "discord-test",
      platform: "discord",
      shard_id: 0,
      close_code: 1006,
      close_reason: "abnormal closure",
      was_clean: false,
    });
    await adapter.stop();
  });

  test("clean disconnect (code 1000) publishes was_clean: true", async () => {
    const runtime = makeRecordingRuntime();
    const adapter = await buildStartedAdapter({
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    const client = adapter.getClient()!;
    (client as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      "shardDisconnect",
      { code: 1000, reason: "shutting down" },
      0,
    );
    expect(runtime.publishes[0]?.payload).toMatchObject({ was_clean: true });
    await adapter.stop();
  });

  test("degraded callback path produces system.adapter.degraded envelope", async () => {
    // The adapter's degraded callback is wired inside start() with the
    // default 60 s threshold from createDiscordClient. Waiting 60 s in a test
    // is unacceptable; instead we exercise the publish path directly by
    // invoking the private helper. The shardDisconnect → degraded threshold
    // timer itself is covered by `client-degraded.test.ts` — together those
    // two tests cover the full disconnect→degraded→publish chain without
    // adding a configurable-threshold knob to DiscordAdapter solely for
    // testability.
    const runtime = makeRecordingRuntime();
    const adapter = await buildStartedAdapter({
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    // Exercise the wired callback. `publishAdapterDegraded` is private; the
    // bracket access is the standard escape hatch for adapter-internal tests.
    (
      adapter as unknown as {
        publishAdapterDegraded: (opts: {
          instanceId: string;
          thresholdMs: number;
          since: Date;
        }) => void;
      }
    ).publishAdapterDegraded({
      instanceId: "discord-test",
      thresholdMs: 60_000,
      since: new Date("2026-05-09T12:00:00.000Z"),
    });

    expect(runtime.publishes.length).toBe(1);
    const env = runtime.publishes[0]!;
    expect(env.type).toBe("system.adapter.degraded");
    expect(env.payload).toMatchObject({
      adapter_id: "discord-test",
      platform: "discord",
      disconnected_since: "2026-05-09T12:00:00.000Z",
      threshold_ms: 60_000,
    });
    await adapter.stop();
  });

  test("recovered callback path produces system.adapter.recovered envelope", async () => {
    const runtime = makeRecordingRuntime();
    const adapter = await buildStartedAdapter({
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    (
      adapter as unknown as {
        publishAdapterRecovered: (opts: {
          instanceId: string;
          degradedForMs: number;
        }) => void;
      }
    ).publishAdapterRecovered({
      instanceId: "discord-test",
      degradedForMs: 14_200,
    });

    expect(runtime.publishes.length).toBe(1);
    const env = runtime.publishes[0]!;
    expect(env.type).toBe("system.adapter.recovered");
    expect(env.payload).toMatchObject({
      adapter_id: "discord-test",
      platform: "discord",
      degraded_for_ms: 14_200,
    });
    await adapter.stop();
  });

  test("no runtime configured: no publishes (silent, doesn't throw)", async () => {
    const adapter = await buildStartedAdapter({
      // No runtime, no source — adapter must keep working
    });
    const client = adapter.getClient()!;
    (client as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      "shardDisconnect",
      { code: 1006, reason: "" },
      0,
    );
    // Nothing to assert beyond "didn't throw" — the adapter has no recorder.
    await adapter.stop();
  });

  test("runtime configured but systemEventSource missing: warns + skips publish", async () => {
    const warnLogs: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnLogs.push(args.map(String).join(" "));
    };
    const runtime = makeRecordingRuntime();
    const adapter = await buildStartedAdapter({
      runtime,
      // intentionally omit systemEventSource
    });
    const client = adapter.getClient()!;
    (client as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      "shardDisconnect",
      { code: 1006, reason: "" },
      0,
    );
    expect(runtime.publishes.length).toBe(0);
    const warned = warnLogs.some((m) =>
      m.includes("systemEventSource is missing"),
    );
    expect(warned).toBe(true);
    await adapter.stop();
  });

  test("emitted envelopes pass myelin schema validation", async () => {
    const runtime = makeRecordingRuntime();
    const adapter = await buildStartedAdapter({
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    const client = adapter.getClient()!;
    (client as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      "shardDisconnect",
      { code: 1006, reason: "abnormal closure" },
      0,
    );
    expect(runtime.publishes.length).toBe(1);
    const { validateEnvelope } = await import("../../../bus/myelin/envelope-validator");
    const result = validateEnvelope(runtime.publishes[0]);
    expect(result.ok).toBe(true);
    await adapter.stop();
  });
});
