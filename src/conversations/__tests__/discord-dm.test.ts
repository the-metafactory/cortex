import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "../../adapters/types";
import { bridgeRig, RIG } from "./fixtures/discord-rig";
import { answering, scratchHosts } from "./fixtures/scratch";
import { CLAIM_WINDOW_MS, conversationWebPrincipal, OFFER_TTL_MS, parseDmCommand } from "../discord-dm";
import type { ConversationHost } from "../host";
import type { LinkResolvers, Policy } from "../types";

const { principal: PRINCIPAL, web: WEB, owner: OWNER } = RIG;
const STRANGER = "999999999999999999";
const DM = "4444444444444444444";
const { dirs, hosts } = scratchHosts("conversations-discord-dm-");

async function setup(resolvers?: LinkResolvers) {
  const prompts: string[] = [];
  const clock = { at: new Date("2026-11-03T10:00:00Z") };
  const turns = answering(request => { const last = request.prompt.split("\n").at(-1) ?? ""; prompts.push(last); return `answer to ${last}`; });
  const { host, fake, lines, bridge } = await bridgeRig(hosts, await dirs.make(), { turns, ...(resolvers ? { resolvers } : {}) }, () => clock.at);
  let seq = 0;
  const dm = async (content: string, extra: Partial<InboundMessage> = {}): Promise<boolean> => {
    const msg: InboundMessage = {
      platform: "discord", instanceId: "pilot-discord", authorId: PRINCIPAL, authorName: "someone", content, channelId: DM, threadId: DM, isDM: true,
      authorIsPrincipal: false, attachments: [], timestamp: new Date(clock.at.getTime() + ++seq), messageId: `dm-msg-${seq}`, ...extra,
    };
    return bridge.offer(msg);
  };
  const settle = async (): Promise<void> => {
    const id = (await bridge.dmConversation()) ?? "";
    if (!id) return;
    await host.waitForIdle(id);
    await bridge.sync(id);
  };
  const inputs = async (id: string) => (await host.entriesAfter(id, null)).filter(entry => entry.kind === "cortex.input").map(entry => entry.data as { inputId: string; transport: string });
  return { host, fake, bridge, lines, clock, dm, settle, inputs, prompts };
}

const start = (host: ConversationHost, title: string, policy: Policy = "cloud") => host.create({ title, links: [], origin: { kind: "web" }, policy }, OWNER);
const webLink = (id: string) => `${WEB}/?desk=conversation&conversation=${id}`;

describe("the principal's Discord DM is a running conversation", () => {
  test("commands are recognised and everything else is conversation text", () => {
    expect(parseDmCommand(" New ")).toEqual({ kind: "new" });
    expect(parseDmCommand("conversations")).toEqual({ kind: "list" });
    expect(parseDmCommand("restore 3")).toEqual({ kind: "pick", index: 3, restore: true });
    expect(parseDmCommand("what is on today?")).toEqual({ kind: "text" });
  });

  test("a principal DM with the adapter's principal flag false is claimed, starts a DM conversation owned by the web principal, and Ivy answers in the DM", async () => {
    const { host, fake, bridge, dm, settle, inputs } = await setup();
    expect(await dm("plan the spring workshop", { authorIsPrincipal: false })).toBe(true);
    await settle();
    const id = await bridge.dmConversation();
    if (!id) throw new Error("no DM conversation");
    const meta = await host.meta(id);
    expect(meta).toMatchObject({ title: "plan the spring workshop", origin: { kind: "discord-dm" }, policy: "cloud", state: "current" });
    expect(await host.principalOf(id)).toBe(OWNER);
    expect(await inputs(id)).toEqual([expect.objectContaining({ inputId: "dm-msg-1", transport: "discord" })]);
    expect(fake.dms).toEqual(["answer to plan the spring workshop"]);
    expect(await dm("and the venue?")).toBe(true);
    await settle();
    expect(await bridge.dmConversation()).toBe(id);
    expect(fake.dms).toEqual(["answer to plan the spring workshop", "answer to and the venue?"]);
    expect(fake.created).toBe(0);
  });

  test("`new` starts a fresh conversation with the next message", async () => {
    const { bridge, dm, settle, fake } = await setup();
    await dm("first topic");
    await settle();
    const first = await bridge.dmConversation();
    await dm("new");
    expect(fake.dms.at(-1)).toBe("Your next message here starts a new conversation.");
    await dm("second topic");
    await settle();
    const second = await bridge.dmConversation();
    expect(second).not.toBe(first);
    expect(fake.dms.at(-1)).toBe("answer to second topic");
  });

  test("`conversations` lists five recent ones and a number switches the DM; local-only gets the web link only; archived needs restore", async () => {
    const { host, bridge, dm, settle, fake, inputs } = await setup();
    const older = await start(host, "Older plan");
    for (let i = 0; i < 4; i += 1) await start(host, `Filler ${i}`);
    const local = await start(host, "Salary notes", "local");
    await dm("conversations");
    const list = fake.dms.at(-1)?.split("\n") ?? [];
    expect(list[0]).toBe("Recent conversations:");
    expect(list.slice(1, 6)).toHaveLength(5);
    expect(list.slice(1, 6).every(row => /^\d\. /.exec(row))).toBe(true);
    await host.submit(older.id, { inputId: "web-0", transport: "web", text: "bump", mode: "queue" });
    await host.waitForIdle(older.id);
    await host.submit(local.id, { inputId: "web-0", transport: "web", text: "private bump", mode: "queue" });
    await host.waitForIdle(local.id);
    await dm("conversations");
    const rows = fake.dms.at(-1)?.split("\n") ?? [];
    const olderAt = rows.findIndex(row => row.includes("Older plan"));
    const localAt = rows.findIndex(row => row.includes("Private conversation, continue on the web"));
    expect(olderAt).toBeGreaterThan(0);
    expect(fake.dms.join("\n")).not.toContain("Salary");
    expect(localAt).toBeGreaterThan(0);
    await dm(String(localAt));
    expect(fake.dms.at(-1)).toBe(`Private conversation, continue on the web: <${webLink(local.id)}>`);
    expect(await bridge.dmConversation()).toBeNull();
    await host.organize(older.id, { state: "archived" });
    await dm(String(olderAt));
    expect(fake.dms.at(-1)).toBe(`**Older plan** is archived. Reply \`restore ${olderAt}\` to restore it and continue here.`);
    expect(await bridge.dmConversation()).toBeNull();
    await dm(`restore ${olderAt}`);
    expect(fake.dms.at(-1)).toBe(`Now continuing **Older plan** (restored) here.\nFull record on the web: <${webLink(older.id)}>`);
    expect((await host.meta(older.id)).state).toBe("current");
    await dm("picking this up again");
    await settle();
    expect(await bridge.dmConversation()).toBe(older.id);
    expect((await inputs(older.id)).map(input => input.transport)).toEqual(["web", "discord"]);
    expect(fake.dms.at(-1)).toBe("answer to picking this up again");
    expect(fake.dms.join("\n")).not.toContain("answer to bump");
  });

  test("an expired list refuses a number; after an hour a number is ordinary text", async () => {
    const { host, bridge, dm, clock, fake, settle } = await setup();
    await start(host, "Plan the spring workshop");
    await dm("conversations");
    clock.at = new Date(clock.at.getTime() + OFFER_TTL_MS + 1);
    await dm("1");
    expect(fake.dms.at(-1)).toBe("Nothing changed: that list has expired. Send `conversations` for a fresh one.");
    expect(await bridge.dmConversation()).toBeNull();
    await dm("conversations");
    await dm("7");
    expect(fake.dms.at(-1)).toBe("Nothing changed: the list has no number 7.");
    clock.at = new Date(clock.at.getTime() + CLAIM_WINDOW_MS + 1);
    await dm("1");
    await settle();
    expect(fake.dms.at(-1)).toBe("answer to 1");
  });

  test("a stranger's DM is not claimed, a DM without a message id is not recorded, and a redelivered message is handled once", async () => {
    const { bridge, dm, settle, fake, prompts, inputs } = await setup();
    expect(await dm("let me in", { authorId: STRANGER, authorIsPrincipal: true, dmType: "principal" })).toBe(false);
    expect(await bridge.dmConversation()).toBeNull();
    expect(await dm("no id", { messageId: undefined })).toBe(true);
    expect(fake.dms.at(-1)).toContain("does not carry message ids");
    expect(await bridge.dmConversation()).toBeNull();
    await dm("once only", { messageId: "dm-replayed" });
    await settle();
    await dm("once only", { messageId: "dm-replayed" });
    await settle();
    const id = await bridge.dmConversation();
    if (!id) throw new Error("no DM conversation");
    expect(await inputs(id)).toHaveLength(1);
    expect(prompts.filter(prompt => prompt === "once only")).toHaveLength(1);
    expect(fake.dms.filter(text => text === "answer to once only")).toHaveLength(1);
  });

  test("a web message is mirrored to the DM, and a conversation turned local sends one neutral link and nothing more", async () => {
    let policy: Policy = "cloud";
    const { host, bridge, dm, settle, fake } = await setup({ "studio-thread": () => Promise.resolve({ state: "available", policy, title: "Workshop thread" }) });
    await dm("start here");
    await settle();
    const id = await bridge.dmConversation();
    if (!id) throw new Error("no DM conversation");
    await host.submit(id, { inputId: "web-1", transport: "web", text: "from the web", mode: "queue" });
    await settle();
    expect(fake.dms.slice(-2)).toEqual(["**You, on the web:**\nfrom the web", "answer to from the web"]);
    await host.link(id, { owner: "studio-thread", id: "workshop" }, true);
    policy = "local";
    await host.submit(id, { inputId: "web-2", transport: "web", text: "secret", mode: "queue" });
    await settle();
    await bridge.sync(id);
    expect(fake.dms.at(-1)).toBe(`This conversation is now private. Earlier messages here stay; nothing new from it is sent to Discord. Continue privately on the web: <${webLink(id)}>`);
    expect(fake.dms.join("\n")).not.toContain("secret");
    await dm("more from Discord");
    expect(fake.dms.at(-1)).toBe(`This conversation is private, so it continues only on the web: <${webLink(id)}>. Write \`new\` to start another one here.`);
  });

  test("the web principal owning DM conversations is the only one configured, else none", async () => {
    expect(conversationWebPrincipal(new Set(), undefined)).toBe("local-principal@loopback");
    expect(conversationWebPrincipal(new Set(), "me@example.org")).toBe("me@example.org");
    expect(conversationWebPrincipal(new Set(["a@example.org"]), undefined)).toBe("a@example.org");
    expect(conversationWebPrincipal(new Set(["a@example.org", "b@example.org"]), "B@example.org")).toBe("b@example.org");
    expect(conversationWebPrincipal(new Set(["a@example.org", "b@example.org"]), undefined)).toBeNull();
    const { bridge, dm, fake, lines } = await setup();
    bridge.setWebPrincipal(null);
    expect(await dm("hello")).toBe(true);
    expect(fake.dms.at(-1)).toBe("Not sent to Ivy: this stack has more than one web principal, so a conversation started in Discord would have no clear owner. Start it on the web.");
    expect(await bridge.dmConversation()).toBeNull();
    bridge.setWebPrincipal(OWNER);
    expect(lines).toHaveLength(0);
  });

  test("an unexpected failure is answered in the DM and logged, never dropped silently", async () => {
    const { host, dm, fake, lines } = await setup();
    host.submit = () => Promise.reject(new Error("disk full"));
    expect(await dm("hello")).toBe(true);
    expect(fake.dms.at(-1)).toBe("Not sent to Ivy: something went wrong on this stack. Send it again; the daemon log has the details.");
    expect(lines.filter(line => line.includes("disk full"))).toHaveLength(1);
  });

  test("a send before the adapter connects is retried; an uncertain one is not repeated; no id is recorded as best-effort", async () => {
    const { host, bridge, dm, settle, fake } = await setup();
    fake.dmFaults = [{ delivered: false, kind: "transient", code: "disconnected" }];
    await dm("first");
    await settle();
    const id = await bridge.dmConversation();
    if (!id) throw new Error("no DM conversation");
    expect(fake.dms).toEqual([]);
    await bridge.sync(id);
    expect(fake.dms).toEqual(["answer to first"]);
    fake.dmFaults = [{ delivered: false, kind: "transient", code: "threw", detail: "socket hang up" }];
    await dm("second");
    await settle();
    await bridge.sync(id);
    expect(fake.dms).toEqual(["answer to first"]);
    fake.dmFaults = [{ delivered: true }];
    await dm("third");
    await settle();
    const records = Object.entries(await host.deliveries()).filter(([key]) => key.startsWith(`dm:out:${id}:`)).map(([, value]) => value as { state: string; messageId?: string; bestEffort?: string });
    expect(records.map(record => record.state)).toEqual(["sent", "uncertain", "sent"]);
    expect(records[0]?.messageId).toBeString();
    expect(records[2]?.bestEffort).toBe("the adapter returned no message id");
  });
});
