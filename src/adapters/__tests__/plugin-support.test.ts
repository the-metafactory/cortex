/**
 * cortex#1797 (S12) — cortex-side coverage for `plugin-support.ts`'s
 * `buildAdapterSystemEventPort`, the host-bound implementation of
 * `AdapterSystemEventPort` every extracted adapter bundle (web/slack/
 * mattermost/discord) calls through instead of touching `bus/system-events`/
 * `bus/myelin/runtime` directly. The `.recovered()`/`.disconnected()` gate
 * (no runtime → silent; runtime but no source → warn once) was already
 * exercised indirectly via the in-tree Slack/Discord adapter suites before
 * their extraction; this file is the durable, bundle-independent home for
 * it — plus the `.degraded()`/`.untrustedBotDenied()` methods S12 added for
 * Discord's dependency-inversion (no other adapter used them yet, so they
 * had zero direct coverage before this file).
 */

import { describe, expect, test } from "bun:test";
import { buildAdapterSystemEventPort } from "../plugin-support";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { SystemEventSource } from "../../bus/system-events";
import type { Envelope } from "../../bus/myelin/envelope-validator";

function makeRecordingRuntime(): MyelinRuntime & { publishes: Envelope[] } {
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

const SOURCE: SystemEventSource = { principal: "metafactory", agent: "cortex", instance: "local" };

describe("buildAdapterSystemEventPort — no-runtime / no-source gate", () => {
  test("no runtime configured: every method is a silent no-op", () => {
    const port = buildAdapterSystemEventPort({});
    expect(() => port.recovered({
      adapterId: "a", platform: "discord", disconnectedSince: new Date(), degradedForMs: 1,
    })).not.toThrow();
    expect(() => port.disconnected({
      adapterId: "a", platform: "discord", disconnectedSince: new Date(), wasClean: true,
    })).not.toThrow();
    expect(() => port.degraded({
      adapterId: "a", platform: "discord", disconnectedSince: new Date(), thresholdMs: 60_000,
    })).not.toThrow();
    expect(() => port.untrustedBotDenied({
      platform: "discord", principalId: "discord:1", correlationId: "discord:2",
      envelopeSubject: "discord.dm.3.messageCreate", envelopeId: "3",
      reason: { kind: "untrusted_bot_author" },
    })).not.toThrow();
  });

  test("runtime configured but source missing: warns once, no publish", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const runtime = makeRecordingRuntime();
      const port = buildAdapterSystemEventPort({ runtime });
      port.disconnected({ adapterId: "a", platform: "discord", disconnectedSince: new Date(), wasClean: true });
      port.degraded({ adapterId: "a", platform: "discord", disconnectedSince: new Date(), thresholdMs: 60_000 });
      expect(runtime.publishes.length).toBe(0);
      expect(warnings.some((w) => w.includes("systemEventSource is missing"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("buildAdapterSystemEventPort.degraded (cortex#1797 S12)", () => {
  test("publishes a system.adapter.degraded envelope with the right payload", async () => {
    const runtime = makeRecordingRuntime();
    const port = buildAdapterSystemEventPort({ runtime, source: SOURCE });
    port.degraded({
      adapterId: "discord-test",
      platform: "discord",
      disconnectedSince: new Date("2026-05-09T12:00:00.000Z"),
      thresholdMs: 60_000,
      reconnectAttempts: 3,
    });
    await Promise.resolve();
    expect(runtime.publishes.length).toBe(1);
    const env = runtime.publishes[0]!;
    expect(env.type).toBe("system.adapter.degraded");
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.payload).toMatchObject({
      adapter_id: "discord-test",
      platform: "discord",
      disconnected_since: "2026-05-09T12:00:00.000Z",
      threshold_ms: 60_000,
      reconnect_attempts: 3,
    });
  });
});

describe("buildAdapterSystemEventPort.untrustedBotDenied (cortex#1797 S12)", () => {
  test("publishes a system.access.denied envelope with synthesised sovereignty", async () => {
    const runtime = makeRecordingRuntime();
    const port = buildAdapterSystemEventPort({ runtime, source: SOURCE });
    port.untrustedBotDenied({
      platform: "discord",
      principalId: "discord:12345",
      correlationId: "discord:msg-1",
      envelopeSubject: "discord.111.222.messageCreate",
      envelopeId: "msg-1",
      reason: {
        kind: "untrusted_bot_author",
        platform: "discord",
        author_id: "12345",
        channel_id: "222",
        guild_id: "111",
      },
    });
    await Promise.resolve();
    expect(runtime.publishes.length).toBe(1);
    const env = runtime.publishes[0]!;
    expect(env.type).toBe("system.access.denied");
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.correlation_id).toBe("discord:msg-1");
    // `createSystemAccessDeniedEvent` computes the envelope's TOP-LEVEL
    // `sovereignty` via `defaultSystemSovereignty(source, classification)` —
    // the synthesised "local inbound deny" shape this port builds rides
    // through as `payload.intent_sovereignty` instead (mirrors the
    // pre-extraction `DiscordAdapter.publishUntrustedBotDenied`'s exact call
    // shape, byte-identical behaviour).
    expect(env.payload).toMatchObject({
      principal_id: "discord:12345",
      capability: "discord.inbound",
      envelope_id: "msg-1",
      envelope_subject: "discord.111.222.messageCreate",
      signed_by: [],
      reason: { kind: "untrusted_bot_author", author_id: "12345" },
      intent_sovereignty: {
        classification: "local",
        data_residency: "metafactory",
        max_hop: 0,
        frontier_ok: false,
        model_class: "local-only",
      },
    });
  });

  test("no runtime: untrustedBotDenied is a silent no-op", () => {
    const port = buildAdapterSystemEventPort({});
    expect(() => port.untrustedBotDenied({
      platform: "discord",
      principalId: "discord:1",
      correlationId: "discord:2",
      envelopeSubject: "discord.dm.3.messageCreate",
      envelopeId: "3",
      reason: { kind: "untrusted_bot_author" },
    })).not.toThrow();
  });
});
