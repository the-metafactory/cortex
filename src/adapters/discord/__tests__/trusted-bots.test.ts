/**
 * cortex#84 — bot-to-bot trust allowlist.
 *
 * Holly silently dropped Ivy's @-mentions because `isMentionForBot`
 * rejected every bot-authored message via a blanket
 * `message.author.bot` check. This suite pins the new behaviour:
 *
 *   - Default (no allowlist): all bot authors still dropped.
 *   - Allowlist entry present: that bot's mentions pass through.
 *   - Self-id never allowed, even if accidentally listed
 *     (anti-self-loop guard, the original reason the bot filter exists).
 *
 * The function is pure — no discord.js client init needed. We hand-roll
 * the minimal `Message` / `Client` shapes the function actually reads.
 */

import { describe, expect, test } from "bun:test";
import type { Client, Message } from "discord.js";
import { isMentionForBot } from "../client";
import { DiscordPresenceSchema } from "../schema";

const SELF_ID = "1111";
const PEER_BOT_ID = "4444444444444444444"; // peer bot (placeholder snowflake)
const UNTRUSTED_BOT_ID = "9999";
const HUMAN_ID = "555555555555555555";

function makeClient(): Client {
  // isMentionForBot reads `client.user.id` and `message.mentions.has(client.user)`.
  // The minimal stub is a user object with a stable identity reference so
  // mentions.has can identity-check.
  const user = { id: SELF_ID } as Client["user"];
  return { user } as Client;
}

function makeMessage(opts: {
  authorId: string;
  bot: boolean;
  mentionsSelf: boolean;
  client: Client;
}): Message {
  // `mentions.has` is called with the client.user object; return true iff
  // the test marked this message as mentioning self.
  return {
    author: { id: opts.authorId, bot: opts.bot },
    mentions: {
      has: (user: { id: string }) => opts.mentionsSelf && user.id === opts.client.user!.id,
    },
  } as unknown as Message;
}

describe("isMentionForBot — default (no allowlist)", () => {
  const client = makeClient();

  test("human @-mention passes", () => {
    const msg = makeMessage({ authorId: HUMAN_ID, bot: false, mentionsSelf: true, client });
    expect(isMentionForBot(msg, client)).toBe(true);
  });

  test("human without @-mention is rejected", () => {
    const msg = makeMessage({ authorId: HUMAN_ID, bot: false, mentionsSelf: false, client });
    expect(isMentionForBot(msg, client)).toBe(false);
  });

  test("bot @-mention dropped when no allowlist supplied (pre-cortex#84 behaviour preserved)", () => {
    const msg = makeMessage({ authorId: PEER_BOT_ID, bot: true, mentionsSelf: true, client });
    expect(isMentionForBot(msg, client)).toBe(false);
  });

  test("own message never mentions self (self-loop guard)", () => {
    const msg = makeMessage({ authorId: SELF_ID, bot: true, mentionsSelf: true, client });
    expect(isMentionForBot(msg, client)).toBe(false);
  });
});

describe("isMentionForBot — trustedBotIds allowlist (cortex#84)", () => {
  const client = makeClient();
  const trusted = new Set<string>([PEER_BOT_ID]);

  test("trusted peer bot @-mention passes", () => {
    const msg = makeMessage({ authorId: PEER_BOT_ID, bot: true, mentionsSelf: true, client });
    expect(isMentionForBot(msg, client, trusted)).toBe(true);
  });

  test("untrusted bot @-mention still dropped", () => {
    const msg = makeMessage({ authorId: UNTRUSTED_BOT_ID, bot: true, mentionsSelf: true, client });
    expect(isMentionForBot(msg, client, trusted)).toBe(false);
  });

  test("self id NEVER allowed even when explicitly listed (anti-self-loop regression)", () => {
    const selfListed = new Set<string>([SELF_ID, PEER_BOT_ID]);
    const msg = makeMessage({ authorId: SELF_ID, bot: true, mentionsSelf: true, client });
    expect(isMentionForBot(msg, client, selfListed)).toBe(false);
  });

  test("trusted peer bot without @-mention is still rejected (mention-required path)", () => {
    const msg = makeMessage({ authorId: PEER_BOT_ID, bot: true, mentionsSelf: false, client });
    expect(isMentionForBot(msg, client, trusted)).toBe(false);
  });

  test("human @-mention still passes when allowlist is non-empty (no regression on humans)", () => {
    const msg = makeMessage({ authorId: HUMAN_ID, bot: false, mentionsSelf: true, client });
    expect(isMentionForBot(msg, client, trusted)).toBe(true);
  });

  test("empty allowlist matches default behaviour (bots dropped)", () => {
    const empty = new Set<string>();
    const msg = makeMessage({ authorId: PEER_BOT_ID, bot: true, mentionsSelf: true, client });
    expect(isMentionForBot(msg, client, empty)).toBe(false);
  });
});

describe("DiscordPresenceSchema.trustedBotIds (cortex#84)", () => {
  // cortex#1797 (S12) — this suite pinned cortex's `DiscordInstanceSchema`
  // (`common/types/config.ts`), a config-composition type this bundle has no
  // reason to depend on. `DiscordPresenceSchema` (`../schema`) is the
  // plugin-owned duplicate with the byte-identical `trustedBotIds` field
  // (same regex-free `z.array(z.coerce.string()).default([])`), so the
  // assertions carry over unchanged.
  const minInstance = {
    token: "x",
    guildId: "g",
    agentChannelId: "a",
    logChannelId: "l",
  };

  test("defaults to empty array when omitted", () => {
    const parsed = DiscordPresenceSchema.parse(minInstance);
    expect(parsed.trustedBotIds).toEqual([]);
  });

  test("accepts a populated array of Discord user ids", () => {
    const parsed = DiscordPresenceSchema.parse({
      ...minInstance,
      trustedBotIds: [PEER_BOT_ID, "2222222222222222222"],
    });
    expect(parsed.trustedBotIds).toEqual([PEER_BOT_ID, "2222222222222222222"]);
  });

  test("coerces numeric ids to strings (snowflakes-as-numbers in YAML)", () => {
    const parsed = DiscordPresenceSchema.parse({
      ...minInstance,
      trustedBotIds: [4444444444444444444n.toString(), 2222222222222222222n.toString()],
    });
    expect(parsed.trustedBotIds.every((id) => typeof id === "string")).toBe(true);
  });

  test("rejects a non-array value", () => {
    expect(() =>
      DiscordPresenceSchema.parse({ ...minInstance, trustedBotIds: PEER_BOT_ID }),
    ).toThrow();
  });
});
