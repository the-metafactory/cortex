import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "../../adapters/types";
import { BOT, FakeThreads, type PostFault } from "./fixtures/discord-threads";
import { answering, scratchHosts } from "./fixtures/scratch";
import { chunks, DiscordConversations, type ThreadCapable } from "../discord";
import { ConversationError, DISCORD_HISTORY_NOTICE, openConversationHost, type ConversationHost } from "../host";
import type { LinkResolvers, Policy } from "../types";

const LABEL = "ai.meta-factory.cortex.test";
const PRINCIPAL = "111111111111111111";
const STRANGER = "999999999999999999";
const GUILD = "2222222222222222222";
const CHANNEL = "3333333333333333333";
const config = { channelId: CHANNEL, guildId: GUILD, webUrl: "http://127.0.0.1:8767" };
const { dirs, hosts } = scratchHosts("conversations-discord-");

async function setup(options: { resolvers?: LinkResolvers; adapter?: ThreadCapable | null; fetch?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const prompts: string[] = [];
  const dir = await dirs.make();
  const status = await openConversationHost({ dir, stack: "test", label: LABEL, expectedLabel: LABEL, lanes: { local: { provider: "t", model: "l" }, cloud: { provider: "t", model: "c" } }, turns: answering(request => { prompts.push(request.prompt); return `answer to ${request.prompt.split("\n").at(-1) ?? ""}`; }), ...(options.resolvers ? { resolvers: options.resolvers } : {}) });
  if (status.state !== "ready") throw new Error(status.reason);
  hosts.push(status.host);
  const fake = new FakeThreads();
  const adapter = options.adapter === undefined ? fake : options.adapter;
  const lines: string[] = [];
  const bridge = new DiscordConversations({ host: status.host, adapter: () => adapter, config, principalId: PRINCIPAL, log: line => { lines.push(line); }, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return { host: status.host, fake, bridge, prompts, lines };
}

const start = (host: ConversationHost, policy: Policy = "cloud", links: { owner: "studio-thread"; id: string }[] = []) => host.create({ title: "Plan the spring workshop", links, origin: { kind: "web" }, policy }, "local-principal@loopback");
const inbound = (threadId: string, messageId: string | undefined, content: string, author = PRINCIPAL, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  platform: "discord", instanceId: "pilot-discord", authorId: author, authorName: "someone", content, channelId: threadId, threadId, guildId: GUILD, isDM: false,
  authorIsPrincipal: author === PRINCIPAL, attachments: [], timestamp: new Date("2026-11-03T10:00:00Z"), ...(messageId ? { messageId } : {}), ...extra,
});

async function attachedWith(faults: PostFault[]) {
  const ready = await setup();
  const conversation = await start(ready.host);
  await ready.bridge.attach(conversation.id);
  ready.fake.faults = faults;
  return { ...ready, conversation };
}

async function settle(host: ConversationHost, bridge: DiscordConversations, id: string): Promise<void> {
  await host.waitForIdle(id);
  await bridge.sync(id);
}

describe("conversation Discord threads", () => {
  test("the capability check creates a private thread, reads the principal back and deletes it", async () => {
    const { bridge, fake } = await setup();
    const check = await bridge.check();
    expect(check).toEqual({ ok: true, threadId: "thread-1", members: [BOT, PRINCIPAL], deleted: true });
    expect(fake.deleted).toEqual(["thread-1"]);
  });

  test("a failed member add is a capability error, and the check thread is still deleted", async () => {
    const { bridge, fake } = await setup();
    fake.failMemberAdd = true;
    const check = await bridge.check();
    expect(check).toMatchObject({ ok: false, stage: "members", threadId: "thread-1" });
    expect(fake.deleted).toEqual(["thread-1"]);
  });

  test("attach creates one private thread titled like the conversation, posts the web link once and records the use", async () => {
    const { host, bridge, fake } = await setup();
    const conversation = await start(host);
    const meta = await bridge.attach(conversation.id);
    expect(fake.created).toBe(1);
    const thread = fake.threads.get("thread-1");
    expect(thread).toMatchObject({ name: "Plan the spring workshop", parent: CHANNEL, members: [BOT, PRINCIPAL] });
    expect(fake.texts("thread-1")).toEqual([`**Plan the spring workshop**\nThis private thread continues your Ivy conversation. Mention me here to continue; the full record stays on the web: <http://127.0.0.1:8767/?desk=conversation&conversation=${conversation.id}>`]);
    expect(meta.discord?.threadId).toBe("thread-1");
    const again = await bridge.attach(conversation.id);
    expect(again.discord?.threadId).toBe("thread-1");
    expect(fake.created).toBe(1);
    expect(await bridge.state(conversation.id)).toEqual({ available: true, url: `https://discord.com/channels/${GUILD}/thread-1` });
  });

  test("attach refuses local-only conversations and a failed member add, and never leaves a thread or mapping", async () => {
    const { host, bridge, fake } = await setup();
    const local = await start(host, "local");
    await expect(bridge.attach(local.id)).rejects.toMatchObject({ status: 403 });
    expect(fake.created).toBe(0);
    const cloud = await start(host);
    fake.failMemberAdd = true;
    const refused = await bridge.attach(cloud.id).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConversationError);
    expect((refused as ConversationError).status).toBe(503);
    expect((refused as ConversationError).message).toContain("principal is not a member");
    expect(fake.deleted).toEqual(["thread-1"]);
    expect(await host.discordLink(cloud.id)).toBeNull();
  });

  test("an adapter without the private-thread primitives is reported, not worked around", async () => {
    const bare: ThreadCapable = { getPlatformUserId: () => Promise.resolve(BOT) };
    const { host, bridge } = await setup({ adapter: bare });
    const conversation = await start(host);
    expect(await bridge.state(conversation.id)).toEqual({ available: false, reason: "The installed Discord adapter cannot create, read and post private threads." });
    await expect(bridge.attach(conversation.id)).rejects.toMatchObject({ status: 503 });
    expect(await bridge.check()).toMatchObject({ ok: false, stage: "capability" });
  });

  test("web and Discord share one record: the Discord message id is the input id, and redelivery adds nothing", async () => {
    const { host, bridge, fake, prompts } = await setup();
    const conversation = await start(host);
    await host.submit(conversation.id, { inputId: "web-1", transport: "web", text: "first from the web", mode: "queue" });
    await host.waitForIdle(conversation.id);
    await bridge.attach(conversation.id);
    expect(await bridge.offer(inbound("thread-1", "discord-msg-1", "then from Discord"))).toBe(true);
    await settle(host, bridge, conversation.id);
    expect(await bridge.offer(inbound("thread-1", "discord-msg-1", "then from Discord"))).toBe(true);
    await host.submit(conversation.id, { inputId: "web-2", transport: "web", text: "back on the web", mode: "queue" });
    await settle(host, bridge, conversation.id);
    expect(prompts.filter(prompt => prompt.includes("then from Discord"))).toHaveLength(1);
    const inputs = (await host.entriesAfter(conversation.id, null)).filter(entry => entry.kind === "cortex.input").map(entry => entry.data as { inputId: string; transport: string });
    expect(inputs.map(input => [input.inputId, input.transport])).toEqual([["web-1", "web"], ["discord-msg-1", "discord"], ["web-2", "web"]]);
    const texts = fake.texts("thread-1");
    expect(texts.slice(1)).toEqual(["answer to then from Discord", "**You, on the web:**\nback on the web", "answer to back on the web"]);
    expect(texts.join("\n")).not.toContain("first from the web");
    await bridge.sync(conversation.id);
    expect(fake.texts("thread-1")).toHaveLength(4);
  });

  test("the principal's message is accepted by Discord id when the adapter does not flag the author as principal", async () => {
    const { host, bridge, prompts, lines } = await setup();
    const conversation = await start(host);
    await bridge.attach(conversation.id);
    expect(await bridge.offer(inbound("thread-1", "discord-msg-5", "flag false", PRINCIPAL, { authorIsPrincipal: false }))).toBe(true);
    const { authorIsPrincipal: _flag, ...unflagged } = inbound("thread-1", "discord-msg-6", "flag absent");
    expect(await bridge.offer(unflagged)).toBe(true);
    await host.waitForIdle(conversation.id);
    expect(lines.filter(line => line.includes("not this stack's verified principal"))).toHaveLength(0);
    expect(prompts.filter(prompt => prompt.includes("flag false"))).toHaveLength(1);
    const inputs = (await host.entriesAfter(conversation.id, null)).filter(entry => entry.kind === "cortex.input").map(entry => entry.data as { inputId: string; transport: string });
    expect(inputs.map(input => [input.inputId, input.transport])).toEqual([["discord-msg-5", "discord"], ["discord-msg-6", "discord"]]);
  });

  test("messages from anyone but the principal, or without a message id, never reach Ivy", async () => {
    const { host, bridge, fake, prompts, lines } = await setup();
    const conversation = await start(host);
    await bridge.attach(conversation.id);
    expect(await bridge.offer(inbound("thread-1", "discord-msg-2", "let me in", STRANGER))).toBe(true);
    expect(await bridge.offer(inbound("thread-1", "discord-msg-7", "flagged stranger", STRANGER, { authorIsPrincipal: true }))).toBe(true);
    expect(await bridge.offer(inbound("thread-1", "discord-msg-3", "spoofed", PRINCIPAL, { guildId: "999" }))).toBe(true);
    expect(await bridge.offer(inbound("thread-1", "discord-msg-8", "unflagged other guild", PRINCIPAL, { guildId: "999", authorIsPrincipal: false }))).toBe(true);
    expect(await bridge.offer(inbound("thread-1", undefined, "no id"))).toBe(true);
    expect(await bridge.offer(inbound("thread-9", "discord-msg-4", "not a conversation thread"))).toBe(false);
    await host.waitForIdle(conversation.id);
    expect(prompts).toHaveLength(0);
    expect(lines.filter(line => line.includes("not this stack's verified principal"))).toHaveLength(4);
    expect(fake.texts("thread-1").at(-1)).toContain("does not carry message ids");
  });

  test("Discord attachments are fetched once from Discord's file host and stored by digest; other hosts are refused", async () => {
    const fetched: string[] = [];
    const { host, bridge, fake, prompts } = await setup({ fetch: url => { fetched.push(url); return Promise.resolve(new Response("notes")); } });
    const conversation = await start(host);
    await bridge.attach(conversation.id);
    const file = (url: string) => ({ attachments: [{ url, filename: "notes.txt", contentType: "text/plain", size: 5 }] });
    await bridge.offer(inbound("thread-1", "discord-msg-5", "see file", PRINCIPAL, file("https://cdn.discordapp.com/attachments/1/2/notes.txt")));
    await bridge.offer(inbound("thread-1", "discord-msg-6", "see this", PRINCIPAL, file("https://evil.example/notes.txt")));
    await settle(host, bridge, conversation.id);
    expect(fetched).toEqual(["https://cdn.discordapp.com/attachments/1/2/notes.txt"]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/\[attachment notes\.txt: text\/plain, 5 bytes, sha256 [0-9a-f]{64}\]/);
    expect(fake.texts("thread-1").join("\n")).toContain("Not sent to Ivy: an attachment does not come from Discord's file host.");
  });

  test("an uncertain send is reconciled by thread readback: found means no second copy, lost means one resend", async () => {
    const { host, bridge, fake, conversation } = await attachedWith(["uncertain-landed"]);
    await host.submit(conversation.id, { inputId: "web-1", transport: "web", text: "one", mode: "queue" });
    await settle(host, bridge, conversation.id);
    await bridge.sync(conversation.id);
    expect(fake.texts("thread-1").filter(text => text.endsWith("\none"))).toHaveLength(1);
    fake.faults = ["uncertain-lost"];
    await host.submit(conversation.id, { inputId: "web-2", transport: "web", text: "two", mode: "queue" });
    await settle(host, bridge, conversation.id);
    expect(fake.texts("thread-1").filter(text => text.endsWith("\ntwo"))).toHaveLength(0);
    await bridge.sync(conversation.id);
    expect(fake.texts("thread-1").filter(text => text.endsWith("\ntwo"))).toHaveLength(1);
    expect(fake.texts("thread-1").at(-1)).toBe("answer to two");
  });

  test("while thread readback is down an uncertain send stays uncertain and is not repeated", async () => {
    const { host, bridge, fake } = await setup();
    const conversation = await start(host);
    await bridge.attach(conversation.id);
    fake.faults = ["uncertain-lost"];
    fake.readFails = true;
    await host.submit(conversation.id, { inputId: "web-1", transport: "web", text: "held", mode: "queue" });
    await settle(host, bridge, conversation.id);
    await bridge.sync(conversation.id);
    expect(fake.posts.filter(post => post.text.endsWith("\nheld"))).toHaveLength(0);
    fake.readFails = false;
    await bridge.sync(conversation.id);
    expect(fake.posts.filter(post => post.text.endsWith("\nheld"))).toHaveLength(1);
  });

  test("when linked material turns local-only, Discord gets one neutral link and no later content", async () => {
    let policy: Policy = "cloud";
    const resolvers: LinkResolvers = { "studio-thread": () => Promise.resolve({ state: "available", policy, title: "Workshop thread" }) };
    const { host, bridge, fake } = await setup({ resolvers });
    const conversation = await start(host, "cloud", [{ owner: "studio-thread", id: "workshop" }]);
    await bridge.attach(conversation.id);
    await host.submit(conversation.id, { inputId: "web-1", transport: "web", text: "cloud era", mode: "queue" });
    await settle(host, bridge, conversation.id);
    const before = fake.texts("thread-1").length;
    policy = "local";
    await bridge.offer(inbound("thread-1", "discord-msg-7", "secret plan"));
    await settle(host, bridge, conversation.id);
    await host.submit(conversation.id, { inputId: "web-2", transport: "web", text: "more secrets", mode: "queue" });
    await settle(host, bridge, conversation.id);
    const after = fake.texts("thread-1").slice(before);
    expect(after).toEqual([`This conversation is now private. Earlier messages in this thread stay here; nothing new from it is sent to Discord. Continue privately on the web: <http://127.0.0.1:8767/?desk=conversation&conversation=${conversation.id}>`]);
    expect((await host.meta(conversation.id)).policy).toBe("local");
  });

  test("a thread with anyone besides the principal and the bot is not written to", async () => {
    const { host, bridge, fake, lines } = await setup();
    const conversation = await start(host);
    await bridge.attach(conversation.id);
    fake.intruder = STRANGER;
    await host.submit(conversation.id, { inputId: "web-1", transport: "web", text: "private", mode: "queue" });
    await settle(host, bridge, conversation.id);
    expect(fake.texts("thread-1")).toHaveLength(1);
    expect((await host.discordLink(conversation.id))?.blocked).toContain("members other than the principal");
    expect(lines.some(line => line.includes("nothing sent to thread thread-1"))).toBe(true);
    expect(await bridge.state(conversation.id)).toMatchObject({ blocked: expect.stringContaining("members other") as unknown as string });
  });

  test("a definite send failure keeps the cursor so the entry is sent later, once", async () => {
    const { host, bridge, fake } = await setup();
    const conversation = await start(host);
    await bridge.attach(conversation.id);
    fake.faults = ["failed"];
    await host.submit(conversation.id, { inputId: "web-1", transport: "web", text: "retry me", mode: "queue" });
    await settle(host, bridge, conversation.id);
    await bridge.sync(conversation.id);
    expect(fake.texts("thread-1").filter(text => text.endsWith("\nretry me"))).toHaveLength(1);
    expect(fake.texts("thread-1").at(-1)).toBe("answer to retry me");
  });

  test("readback never claims an earlier identical message for a lost send", async () => {
    const { host, bridge, fake } = await setup();
    const conversation = await start(host);
    await bridge.attach(conversation.id);
    await host.submit(conversation.id, { inputId: "web-1", transport: "web", text: "same", mode: "queue" });
    await settle(host, bridge, conversation.id);
    fake.faults = ["uncertain-lost"];
    await host.submit(conversation.id, { inputId: "web-2", transport: "web", text: "same", mode: "queue" });
    await settle(host, bridge, conversation.id);
    expect(fake.texts("thread-1").filter(text => text === "**You, on the web:**\nsame")).toHaveLength(1);
    await bridge.sync(conversation.id);
    expect(fake.texts("thread-1").filter(text => text === "**You, on the web:**\nsame")).toHaveLength(2);
    expect((await host.discordLink(conversation.id))?.open).toEqual([]);
  });

  test("a readback message without a usable time leaves the send uncertain instead of resending", async () => {
    const { host, bridge, fake, conversation } = await attachedWith(["uncertain-landed"]);
    await host.submit(conversation.id, { inputId: "web-1", transport: "web", text: "timeless", mode: "queue" });
    await host.waitForIdle(conversation.id);
    await bridge.sync(conversation.id);
    const landed = fake.threads.get("thread-1")?.messages.at(-1);
    if (landed) landed.at = "not a time";
    await bridge.sync(conversation.id);
    expect(fake.texts("thread-1").filter(text => text.endsWith("\ntimeless"))).toHaveLength(1);
    expect((await host.discordLink(conversation.id))?.open).toHaveLength(1);
  });

  test("an inbound note is not posted into a thread that gained another member", async () => {
    const { host, bridge, fake } = await setup();
    const conversation = await start(host);
    await bridge.attach(conversation.id);
    fake.intruder = STRANGER;
    await bridge.offer(inbound("thread-1", undefined, "no id"));
    expect(fake.texts("thread-1")).toHaveLength(1);
  });

  test("linking local-only material to a Discord-used conversation needs the notice acknowledged, then Discord gets only the neutral link", async () => {
    const resolvers: LinkResolvers = {
      "studio-thread": ref => Promise.resolve(ref.id === "gone" ? { state: "unavailable", reason: "gone" } : { state: "available", policy: ref.id === "private" ? "local" : "cloud", title: "Thread" }),
    };
    const { host, bridge, fake } = await setup({ resolvers });
    const conversation = await start(host);
    await bridge.attach(conversation.id);
    const local = { owner: "studio-thread" as const, id: "private" };
    const refused = await host.link(conversation.id, local, false).catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 409, message: DISCORD_HISTORY_NOTICE });
    expect((await host.meta(conversation.id)).links).toEqual([]);
    await expect(host.link(conversation.id, { owner: "studio-thread", id: "gone" }, true)).rejects.toMatchObject({ status: 403 });
    const linked = await host.link(conversation.id, local, true);
    expect(linked).toMatchObject({ policy: "local", links: [local] });
    expect((await host.link(conversation.id, local, true)).links).toEqual([local]);
    await bridge.sync(conversation.id);
    const neutral = `This conversation is now private. Earlier messages in this thread stay here; nothing new from it is sent to Discord. Continue privately on the web: <http://127.0.0.1:8767/?desk=conversation&conversation=${conversation.id}>`;
    expect(fake.texts("thread-1").at(-1)).toBe(neutral);
    await host.submit(conversation.id, { inputId: "web-1", transport: "web", text: "private content", mode: "queue" });
    await settle(host, bridge, conversation.id);
    expect(fake.texts("thread-1")).toHaveLength(2);
    expect((await bridge.deliveries(conversation.id)).map(d => [d.key, d.state])).toEqual([["intro", "sent"], ["neutral", "sent"]]);
  });

  test("a conversation never used in Discord links local-only material without the notice", async () => {
    const resolvers: LinkResolvers = { "studio-thread": () => Promise.resolve({ state: "available", policy: "local", title: "Thread" }) };
    const { host } = await setup({ resolvers });
    const conversation = await start(host);
    expect(await host.link(conversation.id, { owner: "studio-thread", id: "private" }, false)).toMatchObject({ policy: "local" });
    await host.organize(conversation.id, { state: "archived" });
    await expect(host.link(conversation.id, { owner: "studio-thread", id: "other" }, true)).rejects.toMatchObject({ status: 409 });
  });

  test("long answers are split under Discord's message limit", () => {
    const parts = chunks(`${"a".repeat(1500)}\n${"b".repeat(1500)}`);
    expect(parts).toEqual(["a".repeat(1500), "b".repeat(1500)]);
    expect(chunks("x".repeat(4000)).every(part => part.length <= 1900)).toBe(true);
  });
});
