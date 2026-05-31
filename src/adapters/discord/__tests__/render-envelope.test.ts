/**
 * MIG-3b — DiscordAdapter.renderEnvelope unit tests.
 *
 * Tests the bus-envelope rendering side of the Discord adapter (the
 * `surfaceConfig.render()` path). We pre-inject a fake `client` + a fake
 * `connectionHealth` to avoid spinning up a real Discord gateway —
 * matches the pattern already used in `principal-dm-buffer.test.ts`.
 *
 * Covers:
 *   - surfaceConfig: id, subjects, filter, render are all wired correctly
 *   - renderEnvelope: posts to surfaceFallbackChannelId via postResponse
 *   - renderEnvelope: warns + drops when client not ready (no postResponse)
 *   - renderEnvelope: warns + drops when no fallback channel configured
 *   - renderEnvelope: never throws (failure mode is log+drop)
 *   - format: envelope is rendered as **type** + JSON code block
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { DiscordAdapter, type DiscordAdapterInfra } from "../index";
import type { Agent, DiscordPresence } from "../../../common/types/cortex-config";
import type { ConnectionHealth } from "../client";
import type { Envelope } from "../../../bus/myelin/envelope-validator";

// ---------------------------------------------------------------------------
// Console suppression — these tests intentionally exercise log+warn paths.
// ---------------------------------------------------------------------------

let originalWarn: typeof console.warn;
let originalError: typeof console.error;
const warnings: string[] = [];

beforeEach(() => {
  warnings.length = 0;
  originalWarn = console.warn;
  originalError = console.error;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  console.error = () => {};
});

afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
});

// ---------------------------------------------------------------------------
// Fakes — mirror the principal-dm-buffer.test.ts shape
// ---------------------------------------------------------------------------

interface FakeChannel {
  id: string;
  // postToDiscord calls `channel.send({ content, files })` — object form. We
  // pin the object shape here rather than `unknown` so the test fake mirrors
  // the runtime contract literally.
  send: (payload: { content: string; files?: unknown }) => Promise<{ id: string }>;
  sendTyping?: () => Promise<void>;
}
interface FakeChannels {
  fetch: (id: string) => Promise<FakeChannel | null>;
}
interface FakeClient {
  isReady: () => boolean;
  channels: FakeChannels;
}

function makeAdapter(opts: {
  surfaceSubjects?: string[];
  surfaceFallbackChannelId?: string;
  surfaceFilter?: DiscordAdapterInfra["surfaceFilter"];
  ready?: boolean;
  /** If false, the adapter has no client at all (pre-start state). */
  withClient?: boolean;
} = {}) {
  const sends: { channelId: string; text: string }[] = [];
  // MIG-7.2c-discord-flip: constructor now takes (agent, presence, infra).
  // Surface fields live on `infra` for this slice and move to a dedicated
  // Renderer at MIG-7.2d.
  const presence: DiscordPresence = {
    enabled: true,
    token: "test-token",
    guildId: "g1",
    agentChannelId: "c1",
    logChannelId: "c2",
    contextDepth: 0,
    enableAgentLog: false,
    trustedBotIds: [],
    surfaceSubjects: [],
  };
  const agent: Agent = {
    id: "test",
    displayName: "Test",
    persona: "(test)",
    trust: [],
    presence: { discord: presence },
  };
  const infra: DiscordAdapterInfra = {
    instanceId: "discord-renderer",
    principal: {},
    ...(opts.surfaceSubjects !== undefined && { surfaceSubjects: opts.surfaceSubjects }),
    ...(opts.surfaceFallbackChannelId !== undefined && { surfaceFallbackChannelId: opts.surfaceFallbackChannelId }),
    ...(opts.surfaceFilter !== undefined && { surfaceFilter: opts.surfaceFilter }),
  };
  const adapter = new DiscordAdapter(agent, presence, infra);

  if (opts.withClient !== false) {
    const client: FakeClient = {
      isReady: () => opts.ready ?? true,
      channels: {
        fetch: async (id: string) => {
          const channel: FakeChannel = {
            id,
            send: async ({ content }) => {
              sends.push({ channelId: id, text: content });
              return { id: "msg-1" };
            },
            sendTyping: async () => {},
          };
          return channel;
        },
      },
    };
    (adapter as unknown as { client: FakeClient }).client = client;

    const health: ConnectionHealth = {
      reconnectCount: 0,
      lastConnectedAt: new Date(),
      lastDisconnectedAt: null,
      currentlyConnected: opts.ready ?? true,
      degraded: false,
      degradedSince: null,
    };
    (adapter as unknown as { connectionHealth: ConnectionHealth }).connectionHealth = health;
  }

  return { adapter, sends };
}

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    source: "metafactory.pilot.local",
    type: "review.cycle.completed",
    timestamp: "2026-05-09T12:00:00Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: true,
      model_class: "any",
    },
    payload: { repo: "grove", urgency: "normal" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// surfaceConfig getter shape
// ---------------------------------------------------------------------------

describe("DiscordAdapter.surfaceConfig", () => {
  test("returns a SurfaceAdapter with id matching instanceId", () => {
    const { adapter } = makeAdapter();
    expect(adapter.surfaceConfig.id).toBe("discord-renderer");
  });

  test("subjects is empty array when surfaceSubjects is unset", () => {
    const { adapter } = makeAdapter();
    expect(adapter.surfaceConfig.subjects).toEqual([]);
  });

  test("subjects mirrors surfaceSubjects when set", () => {
    const { adapter } = makeAdapter({
      surfaceSubjects: ["local.metafactory.review.>", "local.metafactory.attention.>"],
    });
    expect(adapter.surfaceConfig.subjects).toEqual([
      "local.metafactory.review.>",
      "local.metafactory.attention.>",
    ]);
  });

  test("filter is omitted when surfaceFilter is unset", () => {
    const { adapter } = makeAdapter();
    expect(adapter.surfaceConfig.filter).toBeUndefined();
  });

  test("filter is forwarded when surfaceFilter is set", () => {
    const filter = { payload: { repo: ["grove"] } };
    const { adapter } = makeAdapter({ surfaceFilter: filter });
    expect(adapter.surfaceConfig.filter).toBe(filter);
  });

  test("render is bound to the adapter (this is preserved)", async () => {
    // Sanity-check: pulling render off the surfaceConfig and calling it
    // must still find this.client / this.adapterConfig — i.e. the arrow
    // function in the getter binds `this` correctly.
    const { adapter, sends } = makeAdapter({
      surfaceFallbackChannelId: "channel-X",
    });
    const render = adapter.surfaceConfig.render;
    await render(makeEnvelope());
    expect(sends).toHaveLength(1);
    expect(sends[0]?.channelId).toBe("channel-X");
  });
});

// ---------------------------------------------------------------------------
// renderEnvelope — happy path
// ---------------------------------------------------------------------------

describe("DiscordAdapter.renderEnvelope — happy path", () => {
  test("posts envelope to fallback channel when client ready", async () => {
    const { adapter, sends } = makeAdapter({
      surfaceFallbackChannelId: "channel-A",
    });
    await adapter.surfaceConfig.render(makeEnvelope());
    expect(sends).toHaveLength(1);
    expect(sends[0]?.channelId).toBe("channel-A");
  });

  test("renders agent-scoped envelope for this adapter's agent", async () => {
    const { adapter, sends } = makeAdapter({
      surfaceFallbackChannelId: "channel-A",
    });
    await adapter.surfaceConfig.render(
      makeEnvelope({ payload: { agent_id: "test" } }),
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.channelId).toBe("channel-A");
  });

  test("drops agent-scoped envelope for a different agent", async () => {
    const { adapter, sends } = makeAdapter({
      surfaceFallbackChannelId: "channel-A",
    });
    await adapter.surfaceConfig.render(
      makeEnvelope({ payload: { agent_id: "juniper" } }),
    );
    expect(sends).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test("formatted message contains envelope.type as bold header", async () => {
    const { adapter, sends } = makeAdapter({
      surfaceFallbackChannelId: "channel-A",
    });
    await adapter.surfaceConfig.render(
      makeEnvelope({ type: "attention.item.enqueued" }),
    );
    expect(sends[0]?.text).toContain("**attention.item.enqueued**");
  });

  test("formatted message contains correlation_id when present", async () => {
    const { adapter, sends } = makeAdapter({
      surfaceFallbackChannelId: "channel-A",
    });
    await adapter.surfaceConfig.render(
      makeEnvelope({ correlation_id: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(sends[0]?.text).toContain("[11111111-1111-4111-8111-111111111111]");
  });

  test("formatted message omits correlation bracket when absent", async () => {
    const { adapter, sends } = makeAdapter({
      surfaceFallbackChannelId: "channel-A",
    });
    await adapter.surfaceConfig.render(makeEnvelope());
    // `**review.cycle.completed**` then newline then code block — no `[uuid]`
    expect(sends[0]?.text).not.toMatch(/\[[0-9a-f-]{36}\]/);
  });

  test("formatted message contains payload as JSON code block", async () => {
    const { adapter, sends } = makeAdapter({
      surfaceFallbackChannelId: "channel-A",
    });
    await adapter.surfaceConfig.render(
      makeEnvelope({ payload: { ticket: "G-1111" } }),
    );
    expect(sends[0]?.text).toContain("```json");
    expect(sends[0]?.text).toContain('"ticket": "G-1111"');
    expect(sends[0]?.text).toContain("```");
  });
});

// ---------------------------------------------------------------------------
// renderEnvelope — failure modes (log + drop, never throw)
// ---------------------------------------------------------------------------

describe("DiscordAdapter.renderEnvelope — failure modes", () => {
  test("drops + warns 'shard reconnecting' when client started but not ready", async () => {
    const { adapter, sends } = makeAdapter({
      surfaceFallbackChannelId: "channel-A",
      ready: false,
    });
    await adapter.surfaceConfig.render(makeEnvelope());
    expect(sends).toHaveLength(0);
    expect(warnings.some((w) => w.includes("shard reconnecting"))).toBe(true);
    // Distinguishes from the pre-start case — must NOT log "before start()".
    expect(warnings.some((w) => w.includes("before start()"))).toBe(false);
  });

  test("drops + warns 'before start()' when client is null (adapter not started)", async () => {
    const { adapter, sends } = makeAdapter({
      surfaceFallbackChannelId: "channel-A",
      withClient: false,
    });
    await adapter.surfaceConfig.render(makeEnvelope());
    expect(sends).toHaveLength(0);
    expect(warnings.some((w) => w.includes("before start()"))).toBe(true);
    // Distinguishes from the reconnecting case — must NOT log "shard reconnecting".
    expect(warnings.some((w) => w.includes("shard reconnecting"))).toBe(false);
  });

  test("drops + warns when no surfaceFallbackChannelId is configured", async () => {
    const { adapter, sends } = makeAdapter({
      // no surfaceFallbackChannelId
    });
    await adapter.surfaceConfig.render(makeEnvelope());
    expect(sends).toHaveLength(0);
    expect(warnings.some((w) => w.includes("no surfaceFallbackChannelId configured"))).toBe(true);
  });

  test("never throws even when render is called pre-start", async () => {
    const { adapter } = makeAdapter({
      surfaceFallbackChannelId: "channel-A",
      withClient: false,
    });
    await expect(adapter.surfaceConfig.render(makeEnvelope())).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Empty-surfaceSubjects construction warning
// ---------------------------------------------------------------------------

describe("DiscordAdapter — empty surfaceSubjects warning", () => {
  test("warns at construction when surfaceSubjects is explicitly []", () => {
    makeAdapter({ surfaceSubjects: [] });
    expect(
      warnings.some((w) =>
        w.includes("surfaceSubjects is empty") && w.includes("never render bus envelopes"),
      ),
    ).toBe(true);
  });

  test("does NOT warn when surfaceSubjects is undefined (opted out)", () => {
    makeAdapter({ /* surfaceSubjects: undefined */ });
    expect(warnings.some((w) => w.includes("surfaceSubjects is empty"))).toBe(false);
  });

  test("does NOT warn when surfaceSubjects has entries", () => {
    makeAdapter({ surfaceSubjects: ["local.metafactory.review.>"] });
    expect(warnings.some((w) => w.includes("surfaceSubjects is empty"))).toBe(false);
  });
});
