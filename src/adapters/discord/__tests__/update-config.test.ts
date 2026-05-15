/**
 * Tests for `DiscordAdapter.updateConfig` (F-092 hot-reload).
 *
 * MIG-7.2c-discord-flip reworked the implementation three ways at once:
 *   1. instance matching key flipped from computed `instanceId` to raw
 *      `presence.guildId`
 *   2. hot-reload-safe fields apply via immutable spread on `this.presence`
 *      (rather than in-place mutation of a legacy `adapterConfig`)
 *   3. `this.agent` is rebuilt with the fresh presence + new
 *      `botConfig.agent.{name,displayName}` so PresenceBinding / TrustResolver
 *      see live values after a config refresh (Holly cycle 1 invariant from #46)
 *
 * Holly cycle 2 flagged the missing coverage on these three changes. The
 * suite below pins each to a behavioural assertion: matching, spread
 * semantics (safe fields update, reconnect-only fields don't), and the
 * agent-rebuild invariant. Tests stay implementation-light — they reach into
 * the adapter's private state via the same `as unknown as { … }` cast the
 * existing operator-dm-buffer / render-envelope suites use.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { DiscordAdapter, type DiscordAdapterInfra } from "../index";
import type { BotConfig } from "../../../common/types/config";
import { DMConfigSchema } from "../../../common/types/config";
import type { Agent, DiscordPresence } from "../../../common/types/cortex-config";

let originalLog: typeof console.log;
let originalWarn: typeof console.warn;

beforeEach(() => {
  originalLog = console.log;
  originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
});

function makePresence(overrides: Partial<DiscordPresence> = {}): DiscordPresence {
  return {
    enabled: true,
    token: "initial-token",
    guildId: "guild-1",
    agentChannelId: "ch-agent",
    logChannelId: "ch-log",
    contextDepth: 5,
    enableAgentLog: false,
    roles: [],
    defaultRole: "allow-all",
    dm: DMConfigSchema.parse({}),
    trustedBotIds: [],
    surfaceSubjects: [],
    ...overrides,
  };
}

function makeAgent(presence: DiscordPresence, overrides: Partial<Agent> = {}): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "(test)",
    roles: [],
    trust: [],
    presence: { discord: presence },
    ...overrides,
  };
}

function makeBotConfig(overrides: Partial<{
  name: string;
  displayName: string;
  guildId: string;
  contextDepth: number;
  defaultRole: string;
  token: string;
}> = {}): BotConfig {
  return {
    agent: {
      name: overrides.name ?? "luna",
      displayName: overrides.displayName ?? "Luna",
    },
    discord: [
      {
        guildId: overrides.guildId ?? "guild-1",
        token: overrides.token ?? "initial-token",
        agentChannelId: "ch-agent",
        logChannelId: "ch-log",
        contextDepth: overrides.contextDepth ?? 5,
        enableAgentLog: false,
        roles: [],
        defaultRole: overrides.defaultRole ?? "allow-all",
        dm: DMConfigSchema.parse({}),
      },
    ],
  } as unknown as BotConfig;
}

function makeAdapter(overrides: { presence?: Partial<DiscordPresence> } = {}) {
  const presence = makePresence(overrides.presence);
  const agent = makeAgent(presence);
  const infra: DiscordAdapterInfra = {
    instanceId: "luna-discord-guild-1",
    operator: {},
  };
  return new DiscordAdapter(agent, presence, infra);
}

function getPresence(adapter: DiscordAdapter): DiscordPresence {
  return (adapter as unknown as { presence: DiscordPresence }).presence;
}
function getAgent(adapter: DiscordAdapter): Agent {
  return (adapter as unknown as { agent: Agent }).agent;
}

describe("DiscordAdapter.updateConfig", () => {
  test("matches the live presence by guildId (not instanceId)", () => {
    // The adapter was constructed with instanceId="luna-discord-guild-1".
    // A BotConfig whose discord[].instanceId is something else (or omitted)
    // but whose guildId matches MUST still hot-reload — the match key is
    // guildId, not instanceId.
    const adapter = makeAdapter();
    const newConfig = makeBotConfig({ contextDepth: 99 });
    // intentionally do NOT carry an `instanceId` field on the new entry.
    adapter.updateConfig(newConfig);
    expect(getPresence(adapter).contextDepth).toBe(99);
  });

  test("skips update when no discord entry matches the live guildId", () => {
    const adapter = makeAdapter();
    const before = getPresence(adapter);
    // Update arrives for a different guild — must be ignored, no mutation.
    adapter.updateConfig(makeBotConfig({ guildId: "guild-NOT-MATCHING", contextDepth: 99 }));
    expect(getPresence(adapter)).toBe(before);
    expect(getPresence(adapter).contextDepth).toBe(5);
  });

  test("applies only hot-reload-safe fields to presence (token reconnect-only stays)", () => {
    const adapter = makeAdapter();
    // New config carries a different token + a different contextDepth.
    // contextDepth is hot-reload safe and must update; token is reconnect-only
    // and must NOT be overwritten in-place.
    adapter.updateConfig(makeBotConfig({ token: "rotated-token", contextDepth: 42 }));
    expect(getPresence(adapter).contextDepth).toBe(42);
    expect(getPresence(adapter).token).toBe("initial-token");
  });

  test("rebuilds presence via immutable spread (new object reference)", () => {
    const adapter = makeAdapter();
    const before = getPresence(adapter);
    adapter.updateConfig(makeBotConfig({ contextDepth: 7 }));
    const after = getPresence(adapter);
    expect(after).not.toBe(before);
    // Reconnect-only fields preserved across the spread.
    expect(after.token).toBe(before.token);
    expect(after.guildId).toBe(before.guildId);
    expect(after.agentChannelId).toBe(before.agentChannelId);
    expect(after.logChannelId).toBe(before.logChannelId);
  });

  test("rebuilds agent with fresh presence reference (Holly cycle 1 invariant)", () => {
    const adapter = makeAdapter();
    adapter.updateConfig(makeBotConfig({ contextDepth: 11 }));
    const agentAfter = getAgent(adapter);
    const presenceAfter = getPresence(adapter);
    // agent.presence.discord must be the SAME object as this.presence,
    // not a stale snapshot from construction time.
    expect(agentAfter.presence.discord).toBe(presenceAfter);
    expect(agentAfter.presence.discord?.contextDepth).toBe(11);
  });

  test("agent id + displayName reflect updated botConfig.agent", () => {
    const adapter = makeAdapter();
    adapter.updateConfig(makeBotConfig({ name: "luna-rebranded", displayName: "Luna v2" }));
    const agentAfter = getAgent(adapter);
    expect(agentAfter.id).toBe("luna-rebranded");
    expect(agentAfter.displayName).toBe("Luna v2");
  });
});
