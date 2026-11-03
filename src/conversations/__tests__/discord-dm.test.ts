import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "../../adapters/types";
import { FakeThreads } from "./fixtures/discord-threads";
import { answering, scratchHosts } from "./fixtures/scratch";
import { DiscordConversations } from "../discord";
import { OFFER_TTL_MS, parseDmCommand } from "../discord-dm";
import { openConversationHost, type ConversationHost } from "../host";
import type { Policy } from "../types";

const LABEL = "ai.meta-factory.cortex.test";
const PRINCIPAL = "111111111111111111";
const STRANGER = "999999999999999999";
const GUILD = "2222222222222222222";
const CHANNEL = "3333333333333333333";
const DM = "4444444444444444444";
const WEB = "http://127.0.0.1:8767";
const config = { channelId: CHANNEL, guildId: GUILD, webUrl: WEB };
const { dirs, hosts } = scratchHosts("conversations-discord-dm-");

async function setup() {
  const dir = await dirs.make();
  const status = await openConversationHost({ dir, stack: "test", label: LABEL, expectedLabel: LABEL, lanes: { local: { provider: "t", model: "l" }, cloud: { provider: "t", model: "c" } }, turns: answering(request => `answer to ${request.prompt.split("\n").at(-1) ?? ""}`) });
  if (status.state !== "ready") throw new Error(status.reason);
  hosts.push(status.host);
  const fake = new FakeThreads();
  const lines: string[] = [];
  const clock = { at: new Date("2026-11-03T10:00:00Z") };
  const bridge = new DiscordConversations({ host: status.host, adapter: () => fake, config, principalId: PRINCIPAL, now: () => clock.at, log: line => { lines.push(line); } });
  let seq = 0;
  const dm = async (content: string, extra: Partial<InboundMessage> = {}): Promise<{ taken: boolean; reply: string | undefined }> => {
    const before = fake.replies.length;
    const msg: InboundMessage = {
      platform: "discord", instanceId: "pilot-discord", authorId: PRINCIPAL, authorName: "someone", content, channelId: DM, threadId: DM, isDM: true,
      authorIsPrincipal: false, attachments: [], timestamp: clock.at, messageId: `dm-msg-${++seq}`, ...extra,
    };
    const taken = await bridge.offer(msg);
    return { taken, reply: fake.replies.length > before ? fake.replies.at(-1)?.text : undefined };
  };
  return { host: status.host, fake, bridge, lines, clock, dm };
}

const start = (host: ConversationHost, title: string, policy: Policy = "cloud") => host.create({ title, links: [], origin: { kind: "web" }, policy }, "local-principal@loopback");
const webLink = (id: string) => `${WEB}/?desk=conversation&conversation=${id}`;

describe("choosing a conversation from the Discord DM", () => {
  test("only picker commands are claimed; any other DM goes on to the normal DM path", async () => {
    const { dm, fake } = await setup();
    expect(await dm("hello Vigil, what is on today?")).toEqual({ taken: false, reply: undefined });
    expect(await dm("1")).toEqual({ taken: false, reply: undefined });
    expect(fake.replies).toHaveLength(0);
    expect(parseDmCommand("Conversations")).toEqual({ kind: "recent" });
    expect(parseDmCommand("search  spring workshop ")).toEqual({ kind: "search", q: "spring workshop" });
    expect(parseDmCommand("restore 3")).toEqual({ kind: "pick", index: 3, restore: true });
    expect(parseDmCommand("search")).toBeNull();
  });

  test("the principal is recognised by Discord id with the adapter's principal flag false, gets recent conversations, and a choice links the private thread and web view", async () => {
    const { host, dm, fake } = await setup();
    const older = await start(host, "Older plan");
    const newer = await start(host, "Plan the spring workshop");
    await host.submit(newer.id, { inputId: "web-1", transport: "web", text: "latest", mode: "queue" });
    await host.waitForIdle(newer.id);
    const offer = await dm("conversations", { authorIsPrincipal: false });
    expect(offer.taken).toBe(true);
    const lines = offer.reply?.split("\n") ?? [];
    expect(lines[0]).toBe("Which conversation shall we continue?");
    expect(lines[1]).toStartWith("1. Plan the spring workshop (");
    expect(lines[2]).toStartWith("2. Older plan (");
    expect(fake.replies[0]?.target).toEqual({ instanceId: "pilot-discord", channelId: DM });
    const chosen = await dm("2");
    expect(chosen.taken).toBe(true);
    expect(chosen.reply).toBe(`**Older plan**\nContinue in its private thread: <https://discord.com/channels/${GUILD}/thread-1>\nFull record on the web: <${webLink(older.id)}>`);
    expect((await host.meta(older.id)).discord?.threadId).toBe("thread-1");
    expect(fake.created).toBe(1);
    expect(await host.latestEntryId(older.id)).toBeNull();
  });

  test("search finds an older archived exchange, which continues only after a deliberate restore", async () => {
    const { host, dm, fake } = await setup();
    const archived = await start(host, "Summer reading");
    await host.submit(archived.id, { inputId: "web-1", transport: "web", text: "the lighthouse novel", mode: "queue" });
    await host.waitForIdle(archived.id);
    await host.organize(archived.id, { state: "archived" });
    await start(host, "Unrelated");
    const found = await dm("search lighthouse");
    expect(found.reply?.split("\n").slice(0, 2)).toEqual(['Conversations matching "lighthouse":', expect.stringMatching(/^1\. Summer reading \(archived, /)]);
    const plain = await dm("1");
    expect(plain.reply).toBe("**Summer reading** is archived. Reply `restore 1` to restore it and continue.");
    expect((await host.meta(archived.id)).state).toBe("archived");
    expect(fake.created).toBe(0);
    const restored = await dm("restore 1");
    expect(restored.reply).toStartWith("**Summer reading** (restored)\nContinue in its private thread: <https://discord.com/channels/");
    expect((await host.meta(archived.id)).state).toBe("current");
    expect((await dm("search nothing-like-this")).reply).toBe('No conversation matches "nothing-like-this".');
  });

  test("a local-only conversation shows no title or snippet and offers only the neutral web path", async () => {
    const { host, dm, fake } = await setup();
    const local = await start(host, "Salary negotiation notes", "local");
    await host.submit(local.id, { inputId: "web-1", transport: "web", text: "private figures", mode: "queue" });
    await host.waitForIdle(local.id);
    const offer = await dm("search private");
    expect(offer.reply).toContain("1. Private conversation, continue on the web");
    const chosen = await dm("1");
    expect(chosen.reply).toBe(`Private conversation, continue on the web: <${webLink(local.id)}>`);
    const all = fake.replies.map(reply => reply.text).join("\n");
    expect(all).not.toContain("Salary");
    expect(all).not.toContain("figures");
    expect(fake.created).toBe(0);
  });

  test("an expired, early or replayed choice changes nothing", async () => {
    const { host, dm, clock, fake } = await setup();
    const conversation = await start(host, "Plan the spring workshop");
    await dm("conversations");
    const sentAt = clock.at;
    clock.at = new Date(sentAt.getTime() + OFFER_TTL_MS + 1);
    expect((await dm("1")).reply).toBe("Nothing changed: that list has expired. Send `conversations` or `search <words>` for a fresh one.");
    clock.at = new Date(sentAt.getTime() + OFFER_TTL_MS * 2);
    await dm("conversations");
    expect((await dm("1", { timestamp: sentAt })).reply).toContain("that list has expired");
    expect((await dm("7")).reply).toBe("Nothing changed: the list has no number 7.");
    expect(fake.created).toBe(0);
    const first = await dm("1", { messageId: "dm-replayed" });
    expect(first.reply).toContain("Continue in its private thread");
    const replay = await dm("1", { messageId: "dm-replayed" });
    expect(replay).toEqual({ taken: true, reply: undefined });
    expect(fake.created).toBe(1);
    expect((await host.meta(conversation.id)).discord?.threadId).toBe("thread-1");
  });

  test("a stranger, or a choice from another DM channel, has no effect and is not answered", async () => {
    const { host, dm, fake, lines } = await setup();
    const archived = await start(host, "Plan the spring workshop");
    await host.organize(archived.id, { state: "archived" });
    expect(await dm("conversations", { authorId: STRANGER, authorIsPrincipal: true, dmType: "principal" })).toEqual({ taken: true, reply: undefined });
    await dm("search spring");
    expect(await dm("restore 1", { authorId: STRANGER, authorIsPrincipal: true })).toEqual({ taken: true, reply: undefined });
    expect(await dm("restore 1", { channelId: "5555555555555555555", threadId: "5555555555555555555" })).toEqual({ taken: false, reply: undefined });
    expect((await host.meta(archived.id)).state).toBe("archived");
    expect(fake.created).toBe(0);
    expect(fake.replies).toHaveLength(1);
    expect(lines.filter(line => line.includes("not this stack's verified principal"))).toHaveLength(2);
  });
});
