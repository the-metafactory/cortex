/**
 * cortex#502 — `DiscordAdapter.resolveLogicalTarget` tests.
 *
 * Pins the logical→native seam the review sink relies on:
 *   - `surface !== "discord"` → null (no cross-surface posting)
 *   - resolves `channel` (repo short name) → guild channel snowflake by name
 *   - when `thread` present → reuses `findOrCreateThreadByName` to get the
 *     thread snowflake, returns a thread-scope ResponseTarget
 *   - when `thread` absent → channel-scope ResponseTarget
 *   - unknown channel name → null
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { ChannelType } from "discord.js";
import { DiscordAdapter, type DiscordAdapterInfra, type AdapterAgentIdentity } from "../index";
import type { DiscordPresence } from "../schema";
import { NO_POLICY_PORT, fallbackFormatEnvelope } from "../plugin";

let originalWarn: typeof console.warn;
let originalLog: typeof console.log;
beforeEach(() => {
  originalWarn = console.warn;
  originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};
});
afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
});

const GUILD_ID = "g1";

/** Fake thread channel — only the fields the adapter reads. */
interface FakeThread {
  id: string;
  name: string;
}

/** Fake text channel exposing the `threads` manager surface. */
class FakeTextChannel {
  type = ChannelType.GuildText;
  id: string;
  name: string;
  existingThreads: FakeThread[] = [];
  private nextThreadId = 7000;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  threads = {
    fetchActive: async () => {
      const map = new Map<string, FakeThread>();
      for (const t of this.existingThreads) map.set(t.id, t);
      return { threads: map, members: new Map() };
    },
    create: async (opts: { name: string; autoArchiveDuration?: number; type?: number }) => {
      const thread: FakeThread = { id: `thread-${this.nextThreadId++}`, name: opts.name };
      this.existingThreads.push(thread);
      return thread;
    },
  };
}

/**
 * Fake client exposing BOTH `guilds.cache.get(id).channels.cache.find(...)`
 * (the channel-by-name resolution `resolveLogicalTarget` uses) AND
 * `channels.fetch(id)` (the parent fetch `findOrCreateThreadByName` uses).
 */
class FakeClient {
  private channelsByName = new Map<string, FakeTextChannel>();
  private channelsById = new Map<string, FakeTextChannel>();

  addChannel(channel: FakeTextChannel): void {
    this.channelsByName.set(channel.name, channel);
    this.channelsById.set(channel.id, channel);
  }

  channels = {
    fetch: async (id: string) => this.channelsById.get(id) ?? null,
  };

  guilds = {
    cache: {
      get: (id: string) => {
        if (id !== GUILD_ID) return undefined;
        const channels = this.channelsByName;
        return {
          channels: {
            cache: {
              find: (
                pred: (c: { type: number; name: string; id: string }) => boolean,
              ) => {
                for (const c of channels.values()) {
                  if (pred(c)) return c;
                }
                return undefined;
              },
            },
          },
        };
      },
    },
  };
}

function makeAdapter(): { adapter: DiscordAdapter; client: FakeClient } {
  const presence: DiscordPresence = {
    enabled: true,
    token: "fake-token",
    guildId: GUILD_ID,
    agentChannelId: "c1",
    logChannelId: "c2",
    contextDepth: 0,
    enableAgentLog: false,
    trustedBotIds: [],
    dmOwner: true,
    surfaceSubjects: [],
  };
  const agent: AdapterAgentIdentity = {
    id: "test-agent",
    displayName: "TestAgent",
    presence: { discord: presence },
  };
  const infra: DiscordAdapterInfra = {
    instanceId: "discord-cortex502",
    principal: {},
    policy: NO_POLICY_PORT,
    formatEnvelope: fallbackFormatEnvelope,
  };
  const adapter = new DiscordAdapter(agent, presence, infra);
  const client = new FakeClient();
  (adapter as unknown as { client: FakeClient }).client = client;
  return { adapter, client };
}

describe("DiscordAdapter.resolveLogicalTarget", () => {
  test("returns null for a non-discord surface", async () => {
    const { adapter } = makeAdapter();
    const target = await adapter.resolveLogicalTarget({
      surface: "slack",
      channel: "cortex",
      thread: "cortex/pr/57",
    });
    expect(target).toBeNull();
  });

  test("resolves channel→snowflake + findOrCreateThreadByName for the thread", async () => {
    const { adapter, client } = makeAdapter();
    client.addChannel(new FakeTextChannel("chan-cortex", "cortex"));

    const target = await adapter.resolveLogicalTarget({
      surface: "discord",
      channel: "cortex",
      thread: "cortex/pr/57",
    });
    expect(target).not.toBeNull();
    expect(target!.instanceId).toBe("discord-cortex502");
    expect(target!.channelId).toBe("chan-cortex");
    // Thread was created and its snowflake returned.
    expect(target!.threadId).toMatch(/^thread-/);
  });

  test("reuses an existing thread of the same name (idempotent)", async () => {
    const { adapter, client } = makeAdapter();
    const channel = new FakeTextChannel("chan-cortex", "cortex");
    channel.existingThreads.push({ id: "thread-existing", name: "cortex/pr/57" });
    client.addChannel(channel);

    const target = await adapter.resolveLogicalTarget({
      surface: "discord",
      channel: "cortex",
      thread: "cortex/pr/57",
    });
    expect(target!.threadId).toBe("thread-existing");
  });

  test("channel-scope target when no thread is given", async () => {
    const { adapter, client } = makeAdapter();
    client.addChannel(new FakeTextChannel("chan-cortex", "cortex"));

    const target = await adapter.resolveLogicalTarget({
      surface: "discord",
      channel: "cortex",
    });
    expect(target).toEqual({
      instanceId: "discord-cortex502",
      channelId: "chan-cortex",
    });
  });

  test("returns null when the channel name is unknown", async () => {
    const { adapter } = makeAdapter();
    const target = await adapter.resolveLogicalTarget({
      surface: "discord",
      channel: "does-not-exist",
      thread: "x/pr/1",
    });
    expect(target).toBeNull();
  });
});
