/**
 * Tests for `MattermostAdapter.updateConfig` (F-092 hot-reload).
 *
 * MIG-7.2c-mattermost reworked the implementation three ways at once,
 * mirroring the Discord adapter changes pinned in
 * `src/adapters/discord/__tests__/update-config.test.ts` (#47 cycle 2
 * warning):
 *
 *   1. instance matching key flipped to raw `presence.apiUrl` (Mattermost
 *      has no `guildId` equivalent — the server URL is the immutable
 *      disambiguator).
 *   2. hot-reload-safe fields apply via immutable spread on `this.presence`
 *      (not in-place mutation of a legacy `adapterConfig` shape).
 *   3. `this.agent` is rebuilt with the fresh presence + new
 *      `botConfig.agent.{name,displayName}` so PresenceBinding /
 *      TrustResolver see live values (Holly #46 cycle 1 invariant).
 *
 * Holly cycle 1 W4: the Discord/Mattermost asymmetry on updateConfig
 * coverage was a regression risk. This suite closes the gap.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { MattermostAdapter, type MattermostAdapterInfra } from "../index";
import type { AgentConfig } from "../../../common/types/config";
import type { Agent, MattermostPresence } from "../../../common/types/cortex-config";

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

function makePresence(overrides: Partial<MattermostPresence> = {}): MattermostPresence {
  return {
    enabled: true,
    callbackPort: 8080,
    apiUrl: "https://mm-a.example",
    apiToken: "initial-token",
    channels: ["c-initial"],
    pollIntervalMs: 3000,
    allowedUsers: [],
    ...overrides,
  };
}

function makeAgent(presence: MattermostPresence): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "(test)",
    trust: [],
    presence: { mattermost: presence },
  };
}

function makeAgentConfig(overrides: Partial<{
  name: string;
  displayName: string;
  apiUrl: string;
  apiToken: string;
  channels: string[];
  pollIntervalMs: number;
  defaultRole: string;
  allowedUsers: string[];
  triggerWord: string;
}> = {}): AgentConfig {
  return {
    agent: {
      name: overrides.name ?? "luna",
      displayName: overrides.displayName ?? "Luna",
    },
    mattermost: [
      {
        apiUrl: overrides.apiUrl ?? "https://mm-a.example",
        apiToken: overrides.apiToken ?? "initial-token",
        channels: overrides.channels ?? ["c-initial"],
        pollIntervalMs: overrides.pollIntervalMs ?? 3000,
        allowedUsers: overrides.allowedUsers ?? [],
        defaultRole: overrides.defaultRole ?? "allow-all",
        ...(overrides.triggerWord !== undefined && { triggerWord: overrides.triggerWord }),
      },
    ],
  } as unknown as AgentConfig;
}

function makeAdapter(overrides: { presence?: Partial<MattermostPresence> } = {}) {
  const presence = makePresence(overrides.presence);
  const agent = makeAgent(presence);
  const infra: MattermostAdapterInfra = {
    instanceId: "luna-mattermost",
    operator: {},
  };
  return new MattermostAdapter(agent, presence, infra);
}

function getPresence(adapter: MattermostAdapter): MattermostPresence {
  return (adapter as unknown as { presence: MattermostPresence }).presence;
}
function getAgent(adapter: MattermostAdapter): Agent {
  return (adapter as unknown as { agent: Agent }).agent;
}

describe("MattermostAdapter.updateConfig", () => {
  test("matches the live presence by apiUrl (the immutable disambiguator)", () => {
    const adapter = makeAdapter();
    adapter.updateConfig(makeAgentConfig({ channels: ["c-new"] }));
    expect(getPresence(adapter).channels).toEqual(["c-new"]);
  });

  test("skips update when no mattermost entry matches the live apiUrl", () => {
    const adapter = makeAdapter();
    const before = getPresence(adapter);
    adapter.updateConfig(makeAgentConfig({ apiUrl: "https://OTHER.example", channels: ["c-new"] }));
    expect(getPresence(adapter)).toBe(before);
    expect(getPresence(adapter).channels).toEqual(["c-initial"]);
  });

  test("applies only hot-reload-safe fields to presence (apiToken reconnect-only stays)", () => {
    const adapter = makeAdapter();
    adapter.updateConfig(makeAgentConfig({ apiToken: "rotated-token", channels: ["c-new"] }));
    expect(getPresence(adapter).channels).toEqual(["c-new"]);
    // apiToken is reconnect-only — the presence still holds the initial value.
    expect(getPresence(adapter).apiToken).toBe("initial-token");
  });

  test("rebuilds presence via immutable spread (new object reference)", () => {
    const adapter = makeAdapter();
    const before = getPresence(adapter);
    adapter.updateConfig(makeAgentConfig({ pollIntervalMs: 5000 }));
    const after = getPresence(adapter);
    expect(after).not.toBe(before);
    expect(after.apiUrl).toBe(before.apiUrl);
    expect(after.apiToken).toBe(before.apiToken);
  });

  test("rebuilds agent with fresh presence reference (Holly #46 cycle 1 invariant)", () => {
    const adapter = makeAdapter();
    adapter.updateConfig(makeAgentConfig({ pollIntervalMs: 7000 }));
    const agentAfter = getAgent(adapter);
    const presenceAfter = getPresence(adapter);
    expect(agentAfter.presence.mattermost).toBe(presenceAfter);
    expect(agentAfter.presence.mattermost?.pollIntervalMs).toBe(7000);
  });

  test("agent id + displayName reflect updated botConfig.agent", () => {
    const adapter = makeAdapter();
    adapter.updateConfig(makeAgentConfig({ name: "luna-rebranded", displayName: "Luna v2" }));
    const agentAfter = getAgent(adapter);
    expect(agentAfter.id).toBe("luna-rebranded");
    expect(agentAfter.displayName).toBe("Luna v2");
  });

  test("triggerWord update propagates when set", () => {
    const adapter = makeAdapter();
    adapter.updateConfig(makeAgentConfig({ triggerWord: "@luna" }));
    expect(getPresence(adapter).triggerWord).toBe("@luna");
  });
});
