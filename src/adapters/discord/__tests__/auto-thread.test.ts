/**
 * cortex#120 — Auto-thread on inbound review wire format.
 *
 * Covers the messageCreate hot-path branch that auto-creates (or reuses)
 * a `{repo}/pr/<N>` thread when a channel-level message matches
 * `<@bot> review <repo>#<N>`. The agent's reply then posts to the
 * thread instead of the channel (per the SOP at
 * CLAUDE.md `## Discord Channel Routing` step 3).
 *
 * Test approach: same fake-Discord pattern as
 * `start-attach-separation.test.ts`. We bypass `client.login()` by
 * injecting a `FakeClient` and drive `messageCreate` directly. The fake
 * exposes a `threads.fetchActive` + `threads.create` pair so we can
 * assert on the find-or-create lookup without a live Discord guild.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { ChannelType } from "discord.js";
import { DiscordAdapter, type DiscordAdapterInfra } from "../index";
import { DMConfigSchema } from "../../../common/types/config";
import type { Agent, DiscordPresence } from "../../../common/types/cortex-config";
import type { InboundMessage } from "../../types";

// ---------------------------------------------------------------------------
// Console suppression — the adapter emits a normal "channel=..." log and the
// auto-thread "auto-threaded ..." log on the hot path; not relevant to the
// assertions and very noisy.
// ---------------------------------------------------------------------------

let originalWarn: typeof console.warn;
let originalError: typeof console.error;
let originalLog: typeof console.log;

beforeEach(() => {
  originalWarn = console.warn;
  originalError = console.error;
  originalLog = console.log;
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
});

afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
  console.log = originalLog;
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const BOT_ID = "999000111";
const HUMAN_ID = "285727653603049472";
const CHANNEL_ID = "ch-cortex-1";
const PARENT_NAME = "cortex";

/** Fake thread channel — only the fields the adapter reads. */
interface FakeThread {
  id: string;
  name: string;
}

/**
 * Fake TextChannel exposing the `threads` manager surface the adapter
 * uses: `fetchActive()` + `create()`. Tests configure `existingThreads`
 * to control what `fetchActive` reports and `createCalls` to record
 * what was created.
 */
class FakeTextChannel {
  type = ChannelType.GuildText;
  id: string;
  name: string;
  existingThreads: FakeThread[] = [];
  createCalls: { name: string; autoArchiveDuration: number; type: number }[] = [];
  /** When set, `threads.create` throws this error — exercises the
   *  create-failure fallback path. */
  createError: Error | null = null;
  /** When set, `threads.fetchActive` throws — exercises the
   *  fetchActive-failure path (create should still run). */
  fetchActiveError: Error | null = null;
  /** Auto-increment counter for synthetic thread ids on create. */
  private nextThreadId = 1000;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  threads = {
    fetchActive: async () => {
      if (this.fetchActiveError) throw this.fetchActiveError;
      const map = new Map<string, FakeThread>();
      for (const t of this.existingThreads) map.set(t.id, t);
      return { threads: map, members: new Map() };
    },
    create: async (opts: { name: string; autoArchiveDuration?: number; type?: number }) => {
      if (this.createError) throw this.createError;
      this.createCalls.push({
        name: opts.name,
        autoArchiveDuration: opts.autoArchiveDuration ?? 0,
        type: opts.type ?? 0,
      });
      const thread: FakeThread = {
        id: `thread-${this.nextThreadId++}`,
        name: opts.name,
      };
      this.existingThreads.push(thread);
      return thread;
    },
  };
}

/**
 * Fake Client. Inherits EventEmitter so the adapter's `client.on` works.
 * `channels.fetch` resolves channel ids to fake channels registered via
 * `addChannel`.
 */
class FakeClient extends EventEmitter {
  user = { id: BOT_ID };
  private byId = new Map<string, FakeTextChannel>();

  channels = {
    fetch: async (id: string) => this.byId.get(id) ?? null,
  };

  addChannel(channel: FakeTextChannel): void {
    this.byId.set(channel.id, channel);
  }

  isReady() {
    return true;
  }
}

/**
 * Fake Discord Message. Only the fields the adapter's messageCreate
 * handler reads. `mentions.has` returns true when the message tagged
 * the bot user (which the adapter uses for `isMentionForBot`).
 */
function makeMessage(opts: {
  id?: string;
  content: string;
  authorId: string;
  channelId: string;
  channelType?: number;
  channelName?: string;
  guildId?: string;
  bot?: boolean;
  mentionsSelf?: boolean;
  channel?: FakeTextChannel;
}): unknown {
  const channel = opts.channel ?? {
    id: opts.channelId,
    type: opts.channelType ?? ChannelType.GuildText,
    name: opts.channelName ?? PARENT_NAME,
    sendTyping: async () => {},
  };
  return {
    id: opts.id ?? `msg-${Math.floor(Math.random() * 1_000_000)}`,
    content: opts.content,
    author: {
      id: opts.authorId,
      bot: opts.bot ?? false,
      displayName: "Luna",
      username: "luna",
    },
    channel,
    channelId: opts.channelId,
    guildId: opts.guildId ?? "g1",
    createdAt: new Date(),
    attachments: new Map(),
    mentions: {
      has: (user: { id: string }) => (opts.mentionsSelf ?? true) && user.id === BOT_ID,
    },
  };
}

function makeAdapter(): { adapter: DiscordAdapter; client: FakeClient } {
  const presence: DiscordPresence = {
    enabled: true,
    token: "fake-token",
    guildId: "g1",
    agentChannelId: "c1",
    logChannelId: "c2",
    contextDepth: 0,
    enableAgentLog: false,
    roles: [],
    defaultRole: "allow-all",
    dm: DMConfigSchema.parse({}),
    trustedBotIds: [],
    surfaceSubjects: [],
  };
  const agent: Agent = {
    id: "test-agent",
    displayName: "TestAgent",
    persona: "(test)",
    roles: [],
    trust: [],
    presence: { discord: presence },
  };
  const infra: DiscordAdapterInfra = {
    instanceId: "discord-cortex120",
    operator: {},
  };
  const adapter = new DiscordAdapter(agent, presence, infra);
  const client = new FakeClient();
  (adapter as unknown as { client: FakeClient }).client = client;
  return { adapter, client };
}

/**
 * Build an adapter with onMessage stashed + messageCreate attached,
 * and capture every InboundMessage seen by the dispatch callback.
 */
function makeWiredAdapter(): {
  adapter: DiscordAdapter;
  client: FakeClient;
  channel: FakeTextChannel;
  inbound: InboundMessage[];
} {
  const { adapter, client } = makeAdapter();
  const channel = new FakeTextChannel(CHANNEL_ID, PARENT_NAME);
  client.addChannel(channel);
  const inbound: InboundMessage[] = [];
  (adapter as unknown as {
    onMessage: (msg: InboundMessage) => Promise<void>;
  }).onMessage = async (msg) => {
    inbound.push(msg);
  };
  adapter.attachInboundDispatch();
  return { adapter, client, channel, inbound };
}

// ---------------------------------------------------------------------------
// findOrCreateThreadByName — the primitive
// ---------------------------------------------------------------------------

describe("findOrCreateThreadByName", () => {
  test("returns existing thread when name matches an active thread", async () => {
    const { adapter, client } = makeAdapter();
    const channel = new FakeTextChannel(CHANNEL_ID, PARENT_NAME);
    channel.existingThreads.push({ id: "thread-existing", name: "cortex/pr/118" });
    client.addChannel(channel);

    const result = await adapter.findOrCreateThreadByName(CHANNEL_ID, "cortex/pr/118");
    expect(result).not.toBeNull();
    expect(result?.threadId).toBe("thread-existing");
    // Critical: no create call when an existing thread matched.
    expect(channel.createCalls).toEqual([]);
  });

  test("creates new thread when no name matches", async () => {
    const { adapter, client } = makeAdapter();
    const channel = new FakeTextChannel(CHANNEL_ID, PARENT_NAME);
    channel.existingThreads.push({ id: "thread-other", name: "some-unrelated-thread" });
    client.addChannel(channel);

    const result = await adapter.findOrCreateThreadByName(CHANNEL_ID, "cortex/pr/118");
    expect(result).not.toBeNull();
    expect(result?.threadId).toMatch(/^thread-\d+$/);
    expect(channel.createCalls).toHaveLength(1);
    const created = channel.createCalls[0];
    expect(created).toBeDefined();
    expect(created!.name).toBe("cortex/pr/118");
    // Auto-archive duration matches worklog-manager convention (24h).
    expect(created!.autoArchiveDuration).toBe(1440);
    // Public thread per the SOP — review threads are visible to the channel.
    expect(created!.type).toBe(ChannelType.PublicThread);
  });

  test("returns null when parent channel cannot be fetched", async () => {
    const { adapter } = makeAdapter();
    // No channel registered → channels.fetch returns null.
    const result = await adapter.findOrCreateThreadByName(
      "non-existent-channel",
      "cortex/pr/118",
    );
    expect(result).toBeNull();
  });

  test("returns null when parent channel is not GuildText (forum, voice, etc.)", async () => {
    const { adapter, client } = makeAdapter();
    const nonText = new FakeTextChannel(CHANNEL_ID, PARENT_NAME);
    // Forum channels have a different thread model; we explicitly skip them.
    (nonText as unknown as { type: number }).type = ChannelType.GuildForum;
    client.addChannel(nonText);

    const result = await adapter.findOrCreateThreadByName(CHANNEL_ID, "cortex/pr/118");
    expect(result).toBeNull();
  });

  test("creates when fetchActive throws (lookup failure doesn't block create)", async () => {
    const { adapter, client } = makeAdapter();
    const channel = new FakeTextChannel(CHANNEL_ID, PARENT_NAME);
    channel.fetchActiveError = new Error("transient fetch error");
    client.addChannel(channel);

    const result = await adapter.findOrCreateThreadByName(CHANNEL_ID, "cortex/pr/118");
    expect(result).not.toBeNull();
    expect(channel.createCalls).toHaveLength(1);
  });

  test("returns null when create fails", async () => {
    const { adapter, client } = makeAdapter();
    const channel = new FakeTextChannel(CHANNEL_ID, PARENT_NAME);
    channel.createError = new Error("missing permissions");
    client.addChannel(channel);

    const result = await adapter.findOrCreateThreadByName(CHANNEL_ID, "cortex/pr/118");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// messageCreate → auto-thread integration
// ---------------------------------------------------------------------------

describe("messageCreate auto-thread (cortex#120)", () => {
  test("channel message matching wire format gets threaded", async () => {
    const { client, channel, inbound } = makeWiredAdapter();

    const msg = makeMessage({
      content: `<@${BOT_ID}> review cortex#118 -- look at the dispatch path`,
      authorId: HUMAN_ID,
      channelId: CHANNEL_ID,
      channel,
    });
    client.emit("messageCreate", msg);
    // Give the async messageCreate handler a chance to run.
    await new Promise((r) => setTimeout(r, 10));

    expect(inbound).toHaveLength(1);
    const captured = inbound[0]!;
    // The InboundMessage now carries a threadId pointing at the newly-created
    // thread — downstream dispatch-handler routes responses there.
    expect(captured.threadId).toBeDefined();
    expect(captured.threadName).toBe("cortex/pr/118");
    expect(captured.channelId).toBe(CHANNEL_ID);
    // _native MUST still be the original message (not the thread channel) so
    // dispatch-handler's inboundMessageId derivation stays correct.
    expect((captured._native as { id: string }).id).toBe((msg as { id: string }).id);

    // A new thread was created with the expected name.
    expect(channel.createCalls).toHaveLength(1);
    expect(channel.createCalls[0]!.name).toBe("cortex/pr/118");
  });

  test("idempotent: second ping reuses the same thread", async () => {
    const { client, channel, inbound } = makeWiredAdapter();

    // Seed: first ping creates the thread.
    client.emit(
      "messageCreate",
      makeMessage({
        id: "msg-a",
        content: `<@${BOT_ID}> review cortex#118`,
        authorId: HUMAN_ID,
        channelId: CHANNEL_ID,
        channel,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(channel.createCalls).toHaveLength(1);
    const firstThreadId = inbound[0]!.threadId;

    // Second ping for the same PR — adapter should reuse the existing thread.
    client.emit(
      "messageCreate",
      makeMessage({
        id: "msg-b",
        content: `<@${BOT_ID}> review cortex#118 follow-up please`,
        authorId: HUMAN_ID,
        channelId: CHANNEL_ID,
        channel,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(inbound).toHaveLength(2);
    expect(inbound[1]!.threadId).toBe(firstThreadId);
    // No second create call — the existing-thread branch fired.
    expect(channel.createCalls).toHaveLength(1);
  });

  test("non-matching content does not create a thread", async () => {
    const { client, channel, inbound } = makeWiredAdapter();

    client.emit(
      "messageCreate",
      makeMessage({
        content: `<@${BOT_ID}> hello, how are you`,
        authorId: HUMAN_ID,
        channelId: CHANNEL_ID,
        channel,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.threadId).toBeUndefined();
    expect(channel.createCalls).toEqual([]);
  });

  test("review request mentioning a different bot id is not auto-threaded", async () => {
    // Even if a peer-bot mention reached this adapter (via trustedBotIds),
    // adapter A must NOT auto-thread on a wire format aimed at adapter B.
    const { client, channel, inbound } = makeWiredAdapter();

    client.emit(
      "messageCreate",
      makeMessage({
        content: `<@77777777> review cortex#118`,
        authorId: HUMAN_ID,
        channelId: CHANNEL_ID,
        channel,
        // Still passes the adapter's `isMentionForBot` filter because the
        // mocked `mentions.has` returns true for SELF_ID; in practice an
        // operator could @-mention multiple bots in one message and only
        // one of them should auto-thread.
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.threadId).toBeUndefined();
    expect(channel.createCalls).toEqual([]);
  });

  test("message already in a thread is left alone (no double-threading)", async () => {
    const { client, inbound } = makeWiredAdapter();

    // Build a "message in a thread" by switching the channel type.
    const threadChannel = {
      id: "in-thread-id",
      type: ChannelType.PublicThread,
      name: "cortex/pr/118",
      parentId: CHANNEL_ID,
      parent: { id: CHANNEL_ID, name: PARENT_NAME },
      sendTyping: async () => {},
    };
    const msg = makeMessage({
      content: `<@${BOT_ID}> review cortex#118 (follow-up)`,
      authorId: HUMAN_ID,
      channelId: "in-thread-id",
      channel: threadChannel as unknown as FakeTextChannel,
    });

    client.emit("messageCreate", msg);
    await new Promise((r) => setTimeout(r, 10));

    expect(inbound).toHaveLength(1);
    // The thread context comes from the inbound thread channel itself (the
    // standard already-in-a-thread path), NOT from the auto-thread branch.
    // threadId is already set to the thread id by the existing isThread
    // resolution; threadName resolves to the thread's name.
    expect(inbound[0]!.threadId).toBe("in-thread-id");
    expect(inbound[0]!.threadName).toBe("cortex/pr/118");
  });

  test("auto-thread failure falls back to channel reply (graceful degradation)", async () => {
    const { client, channel, inbound } = makeWiredAdapter();
    channel.createError = new Error("missing permissions");

    client.emit(
      "messageCreate",
      makeMessage({
        content: `<@${BOT_ID}> review cortex#118`,
        authorId: HUMAN_ID,
        channelId: CHANNEL_ID,
        channel,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    // Inbound message still flows through — the user's request isn't dropped.
    // It just routes to the channel (no threadId set), so the agent's reply
    // posts at channel level.
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.threadId).toBeUndefined();
  });

  test("case-insensitive verb still triggers auto-thread", async () => {
    const { client, channel, inbound } = makeWiredAdapter();

    client.emit(
      "messageCreate",
      makeMessage({
        content: `<@${BOT_ID}> Review cortex#118`,
        authorId: HUMAN_ID,
        channelId: CHANNEL_ID,
        channel,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(channel.createCalls).toHaveLength(1);
    expect(inbound[0]!.threadName).toBe("cortex/pr/118");
  });

  test("multi-repo guild: arc#42 creates arc/pr/42, not cortex/pr/42", async () => {
    const { client, channel, inbound } = makeWiredAdapter();

    client.emit(
      "messageCreate",
      makeMessage({
        content: `<@${BOT_ID}> review arc#42`,
        authorId: HUMAN_ID,
        channelId: CHANNEL_ID,
        channel,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(channel.createCalls).toHaveLength(1);
    expect(channel.createCalls[0]!.name).toBe("arc/pr/42");
    expect(inbound[0]!.threadName).toBe("arc/pr/42");
  });

  test("cortex#123 item 2: non-review GroupDM-shaped ping sets threadId=channelId (isGroupDM consumer at line 410)", async () => {
    // Discriminating regression-lock for the cortex#123 item-1 rename.
    //
    // The `isGroupDM` variable feeds the InboundMessage routing at
    // index.ts:410 (formerly `isPrivateChannel`):
    //
    //   threadId: isDM ? channel.id : (isThread || isGroupDM ? channel.id : undefined)
    //
    // For a regular guild text channel that does NOT match the `review`
    // wire format, `threadId` must be `undefined`. For a GroupDM-typed
    // channel (still not auto-threaded — Item 3 blocks that via guildId
    // gate), `threadId` must be `channel.id` so the dispatch downstream
    // treats it as a "we're already in a thread/private context" message.
    //
    // Mutation: revert the rename to `isPrivateChannel = members.size === 2`
    // and this test still passes (because the consumer at line 410 reads
    // the same boolean regardless of name). The discriminator is the
    // semantic of `isGroupDM === true` for a real GroupDM channel — which
    // the OLD heuristic did NOT detect (a GroupDM with one human + the
    // bot has `members.size` typically larger than 2 on Discord, and the
    // old code never inspected `channel.type`).
    const { client, channel, inbound } = makeWiredAdapter();

    // Override the channel type to GroupDM. ChannelType.GroupDM === 3 in
    // discord.js v14 — `as unknown` because the test fake doesn't pull
    // the full discord.js type tree.
    (channel as unknown as { type: number }).type = ChannelType.GroupDM;

    // A NON-review message — auto-thread block must skip (no createCall),
    // and `threadId` must be set to the channel id by the new isGroupDM
    // routing branch. The Item 3 `guildId !== null` gate prevents the
    // auto-thread create from running on guild-less channels anyway,
    // so the auto-thread side of the if-check stays inert here.
    const groupDmMsg = makeMessage({
      content: `<@${BOT_ID}> hello, how are you`,
      authorId: HUMAN_ID,
      channelId: CHANNEL_ID,
      channel,
    }) as { guildId: string | null };
    groupDmMsg.guildId = null;
    client.emit("messageCreate", groupDmMsg);
    await new Promise((r) => setTimeout(r, 10));

    expect(inbound).toHaveLength(1);
    // The DISCRIMINATING assertion: isGroupDM === true causes the
    // line-410 ternary to route threadId to channel.id. If the rename
    // regressed back to the `members.size === 2` heuristic, `isGroupDM`
    // would NOT detect this GroupDM-typed channel (members map is
    // empty/absent on the fake) and threadId would be `undefined`.
    expect(inbound[0]!.threadId).toBe(CHANNEL_ID);
    // No thread create called — message wasn't a review.
    expect(channel.createCalls).toEqual([]);
  });

  test("cortex#123 item 3: review wire format in a guild-less channel (GroupDM-shaped) does not call threads.create", async () => {
    // Group DMs lack a `guildId`. Discord rejects `threads.create()` on
    // guild-less channels — letting auto-thread run on a GroupDM-shaped
    // message would surface as a hot-path throw out of
    // `findOrCreateThreadByName`. The cortex#123 item 3 fix gates the
    // auto-thread block on `message.guildId !== null` so the dispatch
    // is delivered as a channel-level inbound (no thread).
    const { client, channel, inbound } = makeWiredAdapter();

    // `guildId: null` simulates a Group-DM-shaped message. `makeMessage`
    // coalesces undefined → "g1", so we override post-construction.
    const groupDmMsg = makeMessage({
      content: `<@${BOT_ID}> review cortex#118`,
      authorId: HUMAN_ID,
      channelId: CHANNEL_ID,
      channel,
    }) as { guildId: string | null };
    groupDmMsg.guildId = null;
    client.emit("messageCreate", groupDmMsg);
    await new Promise((r) => setTimeout(r, 10));

    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.threadName).toBeUndefined();
    expect(channel.createCalls).toEqual([]);
  });
});
