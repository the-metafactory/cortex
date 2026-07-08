/**
 * cortex#709 — DM stack-OWNERSHIP gate.
 *
 * Background:
 *   The "one bot token per assistant across stacks" model logs the SAME
 *   Discord bot token into N cortex processes, each bound to a different
 *   `guildId`. The C-704 guild filter gates GUILD traffic by `guildId`, but
 *   `message.guildId` is `null` for DMs (#537), so the guild filter cannot
 *   gate them — every process receives every DM and runs a full CC session,
 *   producing N duplicate replies. The per-process `recentMessageIds` dedup
 *   can't help: it's a local Set per adapter instance and never sees the
 *   sibling process's delivery.
 *
 * cortex#709 fix:
 *   A config-driven DM stack-ownership rule (NOT a first-to-respond race).
 *   `presence.dmOwner` (default `true`) declares whether THIS stack owns the
 *   principal's DMs. Exactly one stack sets it `true`; the rest set `false`
 *   and drop DM-scoped `messageCreate` early, symmetric to the guild gate.
 *
 * This suite pins the contract:
 *   1. Two adapters, SAME token, one `dmOwner: true` + one `dmOwner: false`.
 *      A DM dispatches ONLY on the owner; the non-owner drops it.
 *   2. The guild filter (C-704) is unchanged — a guild message still gates on
 *      `guildId`, independent of `dmOwner`.
 *   3. Default (`dmOwner: true`) preserves the pre-#709 behaviour (DM answered).
 *
 * Same fake-client harness as guild-filter.test.ts: FakeClient extends
 * EventEmitter so `client.emit("messageCreate", msg)` drives the real handler;
 * we observe dispatch by counting calls to the stashed `onMessage`.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { ChannelType } from "discord.js";
import { DiscordAdapter, type DiscordAdapterInfra } from "../index";
import type { Agent, DiscordPresence } from "../../../common/types/cortex-config";
import type { InboundMessage } from "../../types";

// ---------------------------------------------------------------------------
// Console suppression
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
// Fakes (mirrors guild-filter.test.ts)
// ---------------------------------------------------------------------------

const SELF_BOT_ID = "self-bot-id";

class FakeClient extends EventEmitter {
  public user = { id: SELF_BOT_ID };
  isReady() {
    return true;
  }
  channels = { fetch: async () => null };
}

/** A DM (guildId null) or guild message authored by a human, mentioning self. */
function makeMessage(opts: { id: string; guildId: string | null }): unknown {
  const isDM = opts.guildId === null;
  return {
    id: opts.id,
    guildId: opts.guildId,
    content: `<@${SELF_BOT_ID}> ping`,
    createdAt: new Date(),
    author: { id: "human-author", displayName: "Human", bot: false },
    mentions: { has: (u: { id: string }) => u.id === SELF_BOT_ID },
    attachments: new Map(),
    channel: {
      id: isDM ? "dm-channel" : "guild-channel",
      type: isDM ? ChannelType.DM : ChannelType.GuildText,
      name: isDM ? undefined : "general",
    },
  };
}

function makeAdapter(opts: {
  instanceId: string;
  guildId: string;
  dmOwner: boolean;
}): {
  adapter: DiscordAdapter;
  fakeClient: FakeClient;
  dispatched: InboundMessage[];
} {
  const presence: DiscordPresence = {
    enabled: true,
    // SAME token across both adapters — the crux of the multi-stack model.
    token: "shared-bot-token",
    guildId: opts.guildId,
    agentChannelId: "c1",
    logChannelId: "c2",
    contextDepth: 0,
    enableAgentLog: false,
    trustedBotIds: [],
    dmOwner: opts.dmOwner,
    surfaceSubjects: [],
  };
  const agent: Agent = {
    id: "test-agent",
    displayName: "TestAgent",
    persona: "(test)",
    trust: [],
    presence: { discord: presence },
  };
  const infra: DiscordAdapterInfra = {
    instanceId: opts.instanceId,
    principal: {},
  };
  const adapter = new DiscordAdapter(agent, presence, infra);

  const fakeClient = new FakeClient();
  (adapter as unknown as { client: FakeClient }).client = fakeClient;

  const dispatched: InboundMessage[] = [];
  (adapter as unknown as {
    onMessage: (msg: InboundMessage) => Promise<void>;
  }).onMessage = async (msg) => {
    dispatched.push(msg);
  };

  adapter.attachInboundDispatch();

  return { adapter, fakeClient, dispatched };
}

async function fireMessageCreate(
  fakeClient: FakeClient,
  message: unknown,
): Promise<void> {
  fakeClient.emit("messageCreate", message);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscordAdapter: DM stack-ownership (cortex#709)", () => {
  const GUILD_A = "111111111111111111";
  const GUILD_B = "444444444444444444";

  test("same token, one owner + one non-owner: a DM dispatches ONLY on the owner", async () => {
    const owner = makeAdapter({ instanceId: "discord-A", guildId: GUILD_A, dmOwner: true });
    const nonOwner = makeAdapter({ instanceId: "discord-B", guildId: GUILD_B, dmOwner: false });

    // One DM. Because the token is logged into both stacks, the gateway
    // delivers it to BOTH process connections.
    const dm = makeMessage({ id: "dm-1", guildId: null });
    await fireMessageCreate(owner.fakeClient, dm);
    await fireMessageCreate(nonOwner.fakeClient, dm);

    // Answered exactly once — on the owning stack.
    expect(owner.dispatched.length).toBe(1);
    expect(owner.dispatched[0]?.isDM).toBe(true);
    expect(nonOwner.dispatched.length).toBe(0);
  });

  test("default dmOwner (true) keeps answering DMs (pre-#709 / single-stack behaviour)", async () => {
    // No dmOwner override here — but the schema default is true and the fake
    // sets it true explicitly to mirror a default-parsed config.
    const a = makeAdapter({ instanceId: "discord-A", guildId: GUILD_A, dmOwner: true });

    const dm = makeMessage({ id: "dm-2", guildId: null });
    await fireMessageCreate(a.fakeClient, dm);

    expect(a.dispatched.length).toBe(1);
    expect(a.dispatched[0]?.isDM).toBe(true);
  });

  test("guild routing (C-704) is unchanged by dmOwner — guild gate still works", async () => {
    // The DM non-owner is still the guild-B owner. A guild-A message must
    // dispatch only on the guild-A adapter regardless of dmOwner values.
    const a = makeAdapter({ instanceId: "discord-A", guildId: GUILD_A, dmOwner: true });
    const b = makeAdapter({ instanceId: "discord-B", guildId: GUILD_B, dmOwner: false });

    const msgA = makeMessage({ id: "g-1", guildId: GUILD_A });
    await fireMessageCreate(a.fakeClient, msgA);
    await fireMessageCreate(b.fakeClient, msgA);

    expect(a.dispatched.length).toBe(1);
    expect(a.dispatched[0]?.guildId).toBe(GUILD_A);
    // b drops it as a foreign-guild event — the guild gate, not dmOwner.
    expect(b.dispatched.length).toBe(0);

    // And a guild-B message dispatches on b even though b is a DM non-owner.
    const msgB = makeMessage({ id: "g-2", guildId: GUILD_B });
    await fireMessageCreate(b.fakeClient, msgB);
    expect(b.dispatched.length).toBe(1);
    expect(b.dispatched[0]?.guildId).toBe(GUILD_B);
  });

  test("a non-owner stack drops DMs even when it owns its own guild", async () => {
    const nonOwner = makeAdapter({ instanceId: "discord-B", guildId: GUILD_B, dmOwner: false });

    const dm = makeMessage({ id: "dm-3", guildId: null });
    await fireMessageCreate(nonOwner.fakeClient, dm);

    expect(nonOwner.dispatched.length).toBe(0);
  });
});
