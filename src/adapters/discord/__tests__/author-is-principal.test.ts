/**
 * cortex#729 — the home-principal trust signal (`authorIsPrincipal`) is
 * computed for EVERY inbound Discord message, not just DMs.
 *
 * Background:
 *   #724 trust-scoped the dispatch-handler's prompt filter so the home
 *   principal's own messages aren't hard-blocked by the prompt-injection
 *   scanner (live FP: PI-002 "act as a jumphost"). But it read `msg.dmType`,
 *   which the adapter sets only inside its `if (isDM)` branch. For a CHANNEL
 *   @mention, `dmType` is undefined → the home principal's channel message
 *   stayed hard-blocked (live: #halden-observe, where Luna has dmOwner:false so
 *   a channel @mention is the only path).
 *
 * Fix:
 *   The adapter now calls `isOperatorPrincipal(...)` UNCONDITIONALLY and stamps
 *   `authorIsPrincipal` on the inbound message — DM and channel alike — via the
 *   same non-spoofable PolicyEngine principal-role check. `dmType` stays
 *   DM-only.
 *
 * This suite pins:
 *   1. The home principal's CHANNEL @mention → authorIsPrincipal === true (and
 *      dmType stays undefined — it's a channel, not a DM).
 *   2. A non-principal's CHANNEL @mention → authorIsPrincipal === false.
 *   3. The home principal's DM → authorIsPrincipal === true AND dmType === "principal".
 *
 * Harness mirrors guild-filter.test.ts / dm-ownership.test.ts: a FakeClient
 * EventEmitter drives the real handler; a duck-typed policyEngine + policyLookup
 * resolve exactly one author id as the home principal.
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
// Fakes
// ---------------------------------------------------------------------------

const SELF_BOT_ID = "self-bot-id";
const PRINCIPAL_AUTHOR_ID = "principal-author";
const STRANGER_AUTHOR_ID = "stranger-author";
const GUILD_ID = "1487023327791808592";

class FakeClient extends EventEmitter {
  public user = { id: SELF_BOT_ID };
  isReady() {
    return true;
  }
  channels = { fetch: async () => null };
}

/**
 * Duck-typed policy stack consumed by `isOperatorPrincipal`:
 *   index.resolve(platform, platformId) → principalId | undefined
 *   engine.check(principalId, intent) → { allow }
 * Exactly the PRINCIPAL_AUTHOR_ID resolves and is granted the capability the
 * PolicyEngine keys the home-principal role on; everyone else is a
 * non-principal.
 */
function makePrincipalPolicy(): Pick<DiscordAdapterInfra, "policyEngine" | "policyLookup"> {
  const policyLookup = {
    resolve: (_platform: string, platformId: string): string | undefined =>
      platformId === PRINCIPAL_AUTHOR_ID ? "home-principal" : undefined,
  };
  const policyEngine = {
    check: (principalId: string): { allow: boolean } => ({
      allow: principalId === "home-principal",
    }),
  };
  return {
    policyEngine: policyEngine as unknown as DiscordAdapterInfra["policyEngine"],
    policyLookup: policyLookup as unknown as DiscordAdapterInfra["policyLookup"],
  };
}

/** A DM (guildId null) or guild @mention, authored by `authorId`, mentioning self. */
function makeMessage(opts: {
  id: string;
  guildId: string | null;
  authorId: string;
}): unknown {
  const isDM = opts.guildId === null;
  return {
    id: opts.id,
    guildId: opts.guildId,
    content: `<@${SELF_BOT_ID}> ping`,
    createdAt: new Date(),
    author: { id: opts.authorId, displayName: "Author", bot: false },
    mentions: { has: (u: { id: string }) => u.id === SELF_BOT_ID },
    attachments: new Map(),
    channel: {
      id: isDM ? "dm-channel" : "guild-channel",
      type: isDM ? ChannelType.DM : ChannelType.GuildText,
      name: isDM ? undefined : "halden-observe",
    },
  };
}

function makeAdapter(): {
  fakeClient: FakeClient;
  dispatched: InboundMessage[];
} {
  const presence: DiscordPresence = {
    enabled: true,
    token: "shared-bot-token",
    guildId: GUILD_ID,
    agentChannelId: "c1",
    logChannelId: "c2",
    contextDepth: 0,
    enableAgentLog: false,
    trustedBotIds: [],
    dmOwner: true,
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
    instanceId: "discord-A",
    principal: {},
    ...makePrincipalPolicy(),
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

  return { fakeClient, dispatched };
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

describe("DiscordAdapter: authorIsPrincipal trust signal (cortex#729)", () => {
  test("home-principal CHANNEL @mention → authorIsPrincipal=true (dmType stays undefined)", async () => {
    const { fakeClient, dispatched } = makeAdapter();

    await fireMessageCreate(
      fakeClient,
      makeMessage({ id: "ch-1", guildId: GUILD_ID, authorId: PRINCIPAL_AUTHOR_ID }),
    );

    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.isDM).toBe(false);
    expect(dispatched[0]?.authorIsPrincipal).toBe(true);
    // dmType is DM-only — a channel message must not set it.
    expect(dispatched[0]?.dmType).toBeUndefined();
  });

  test("non-principal CHANNEL @mention → authorIsPrincipal=false", async () => {
    const { fakeClient, dispatched } = makeAdapter();

    await fireMessageCreate(
      fakeClient,
      makeMessage({ id: "ch-2", guildId: GUILD_ID, authorId: STRANGER_AUTHOR_ID }),
    );

    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.isDM).toBe(false);
    expect(dispatched[0]?.authorIsPrincipal).toBe(false);
    expect(dispatched[0]?.dmType).toBeUndefined();
  });

  test("home-principal DM → authorIsPrincipal=true AND dmType=principal (DM path unchanged)", async () => {
    const { fakeClient, dispatched } = makeAdapter();

    await fireMessageCreate(
      fakeClient,
      makeMessage({ id: "dm-1", guildId: null, authorId: PRINCIPAL_AUTHOR_ID }),
    );

    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.isDM).toBe(true);
    expect(dispatched[0]?.authorIsPrincipal).toBe(true);
    expect(dispatched[0]?.dmType).toBe("principal");
  });
});
