/**
 * MIG-3b-ii: integration tests for `system.adapter.*` event emission from
 * the Discord adapter.
 *
 * cortex#1797 (S12) — the adapter no longer builds/publishes envelopes
 * itself; it calls the host-injected `infra.systemEvents`
 * (`AdapterSystemEventPort`, `../../../surface-sdk`). Envelope construction +
 * the `MyelinRuntime.publish` call, plus the "runtime configured but source
 * missing" one-time-warning gate, moved to `plugin-support.ts`'s
 * `buildAdapterSystemEventPort` (cortex-side, NOT part of this bundle — see
 * `src/adapters/__tests__/plugin-support.test.ts` for THAT gate's coverage,
 * mirroring the split `metafactory-cortex-adapter-slack`'s system-events
 * suite already made). These tests assert only what `DiscordAdapter` itself
 * is responsible for: calling `.recovered()`/`.disconnected()`/`.degraded()`
 * with the right args at the right lifecycle transitions, and staying
 * silent (no throw) when no port is configured at all.
 *
 * The adapter's `start()` wires three discord.js shard events to port calls:
 *   - shardDisconnect → systemEvents.disconnected
 *   - degraded threshold elapsed → systemEvents.degraded
 *   - shardReady after degraded → systemEvents.recovered
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdapterSystemEventPort } from "../../../surface-sdk";
import type { DiscordPresence } from "../schema";
import { DiscordAdapter, type DiscordAdapterInfra, type AdapterAgentIdentity } from "../index";
import { NO_POLICY_PORT, fallbackFormatEnvelope } from "../plugin";

// MIG-7.2c-discord-flip: build a fresh (agent, presence) pair for each
// adapter so tests can mutate them safely.
function makePresence(overrides: Partial<DiscordPresence> = {}): DiscordPresence {
  return {
    enabled: true,
    token: "fake-token",
    guildId: "g1",
    agentChannelId: "ch1",
    logChannelId: "ch2",
    contextDepth: 5,
    enableAgentLog: false,
    trustedBotIds: [],
    dmOwner: true,
    surfaceSubjects: [],
    ...overrides,
  };
}

function makeAgent(presence: DiscordPresence): AdapterAgentIdentity {
  return {
    id: "test",
    displayName: "Test",
    presence: { discord: presence },
  };
}

type RecordedCall =
  | { kind: "recovered"; opts: Parameters<AdapterSystemEventPort["recovered"]>[0] }
  | { kind: "disconnected"; opts: Parameters<AdapterSystemEventPort["disconnected"]>[0] }
  | { kind: "degraded"; opts: Parameters<AdapterSystemEventPort["degraded"]>[0] }
  | { kind: "untrustedBotDenied"; opts: Parameters<AdapterSystemEventPort["untrustedBotDenied"]>[0] };

function makeRecordingSystemEvents(): AdapterSystemEventPort & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    recovered: (opts) => { calls.push({ kind: "recovered", opts }); },
    disconnected: (opts) => { calls.push({ kind: "disconnected", opts }); },
    degraded: (opts) => { calls.push({ kind: "degraded", opts }); },
    untrustedBotDenied: (opts) => { calls.push({ kind: "untrustedBotDenied", opts }); },
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
  systemEvents?: AdapterSystemEventPort;
} = {}) {
  const presence = makePresence();
  const agent = makeAgent(presence);
  const infra: DiscordAdapterInfra = {
    instanceId: "discord-test",
    principal: {},
    policy: NO_POLICY_PORT,
    formatEnvelope: fallbackFormatEnvelope,
    ...(opts.systemEvents !== undefined && { systemEvents: opts.systemEvents }),
  };
  const adapter = new DiscordAdapter(agent, presence, infra);
  // Reach in: replace client.login with a no-op before the real login fires.
  const { Client } = await import("discord.js");
  const origLogin = Client.prototype.login;
  Client.prototype.login = mock(async () => "fake-token");
  try {
    await adapter.start(async () => {});
  } finally {
    Client.prototype.login = origLogin;
  }
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
  test("shardDisconnect calls systemEvents.disconnected with correct opts", async () => {
    const systemEvents = makeRecordingSystemEvents();
    const adapter = await buildStartedAdapter({ systemEvents });
    const client = adapter.getClient()!;
    // Emit a non-clean disconnect (1006 = abnormal closure)
    (client as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      "shardDisconnect",
      { code: 1006, reason: "abnormal closure" },
      0,
    );

    expect(systemEvents.calls.length).toBe(1);
    const call = systemEvents.calls[0]!;
    expect(call.kind).toBe("disconnected");
    const opts = call.opts as Parameters<AdapterSystemEventPort["disconnected"]>[0];
    expect(opts.adapterId).toBe("discord-test");
    expect(opts.platform).toBe("discord");
    expect(opts.shardId).toBe(0);
    expect(opts.closeCode).toBe(1006);
    expect(opts.closeReason).toBe("abnormal closure");
    expect(opts.wasClean).toBe(false);
    await adapter.stop();
  });

  test("clean disconnect (code 1000) calls systemEvents.disconnected with wasClean: true", async () => {
    const systemEvents = makeRecordingSystemEvents();
    const adapter = await buildStartedAdapter({ systemEvents });
    const client = adapter.getClient()!;
    (client as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      "shardDisconnect",
      { code: 1000, reason: "shutting down" },
      0,
    );
    const opts = systemEvents.calls[0]!.opts as Parameters<AdapterSystemEventPort["disconnected"]>[0];
    expect(opts.wasClean).toBe(true);
    await adapter.stop();
  });

  test("degraded callback path calls systemEvents.degraded", async () => {
    // The adapter's degraded callback is wired inside start() with the
    // default 60 s threshold from createDiscordClient. Waiting 60 s in a test
    // is unacceptable; instead we exercise the port-call path directly by
    // invoking the private helper. The shardDisconnect → degraded threshold
    // timer itself is covered by `client-degraded.test.ts` — together those
    // two tests cover the full disconnect→degraded→port chain without adding
    // a configurable-threshold knob to DiscordAdapter solely for testability.
    const systemEvents = makeRecordingSystemEvents();
    const adapter = await buildStartedAdapter({ systemEvents });
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

    expect(systemEvents.calls.length).toBe(1);
    const call = systemEvents.calls[0]!;
    expect(call.kind).toBe("degraded");
    const opts = call.opts as Parameters<AdapterSystemEventPort["degraded"]>[0];
    expect(opts.adapterId).toBe("discord-test");
    expect(opts.platform).toBe("discord");
    expect(opts.disconnectedSince.toISOString()).toBe("2026-05-09T12:00:00.000Z");
    expect(opts.thresholdMs).toBe(60_000);
    await adapter.stop();
  });

  test("recovered callback path calls systemEvents.recovered", async () => {
    const systemEvents = makeRecordingSystemEvents();
    const adapter = await buildStartedAdapter({ systemEvents });
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

    expect(systemEvents.calls.length).toBe(1);
    const call = systemEvents.calls[0]!;
    expect(call.kind).toBe("recovered");
    const opts = call.opts as Parameters<AdapterSystemEventPort["recovered"]>[0];
    expect(opts.adapterId).toBe("discord-test");
    expect(opts.platform).toBe("discord");
    expect(opts.degradedForMs).toBe(14_200);
    await adapter.stop();
  });

  test("no systemEvents port configured: no calls (silent, doesn't throw)", async () => {
    const adapter = await buildStartedAdapter({
      // No port — adapter must keep working.
    });
    const client = adapter.getClient()!;
    (client as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      "shardDisconnect",
      { code: 1006, reason: "" },
      0,
    );
    // Nothing to assert beyond "didn't throw" — no port to record against.
    await adapter.stop();
  });
});
