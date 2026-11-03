import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "../../adapters/types";
import { BOT } from "./fixtures/discord-threads";
import { bridgeRig, RIG } from "./fixtures/discord-rig";
import { answering, scratchHosts } from "./fixtures/scratch";

const { principal: PRINCIPAL, guild: GUILD, channel: CHANNEL, owner: OWNER } = RIG;
const STRANGER = "999999999999999999";
const OTHER_CHANNEL = "5555555555555555555";
const { dirs, hosts } = scratchHosts("conversations-discord-start-");

async function setup() {
  const turns = answering(request => `answer to ${request.prompt.split("\n").at(-1) ?? ""}`);
  const { host, fake, lines, bridge } = await bridgeRig(hosts, await dirs.make(), { turns });
  const post = (content: string, extra: Partial<InboundMessage> = {}): Promise<boolean> => bridge.offer({
    platform: "discord", instanceId: "pilot-discord", authorId: PRINCIPAL, authorName: "someone", content, channelId: CHANNEL, guildId: GUILD, isDM: false,
    authorIsPrincipal: false, attachments: [], timestamp: new Date("2026-11-03T10:00:00Z"), messageId: "chan-msg-1", ...extra,
  });
  const settle = async (): Promise<void> => {
    for (const id of (await host.discordLinks()).keys()) {
      await host.waitForIdle(id);
      await bridge.sync(id);
    }
  };
  return { host, fake, bridge, lines, post, settle };
}

describe("an @bot message in the conversation channel starts a conversation", () => {
  test("the principal's top-level message, with the adapter's principal flag false, opens a private thread and Ivy answers there", async () => {
    const { host, fake, post, settle } = await setup();
    expect(await post("Plan the spring workshop\nwith two breakout rooms")).toBe(true);
    await settle();
    const [id] = [...(await host.discordLinks()).keys()];
    if (!id) throw new Error("no conversation");
    const meta = await host.meta(id);
    expect(meta).toMatchObject({ title: "Plan the spring workshop", origin: { kind: "discord-thread", ref: "chan-msg-1" }, policy: "cloud", state: "current", discord: { threadId: "thread-1" } });
    expect(await host.principalOf(id)).toBe(OWNER);
    expect(fake.threads.get("thread-1")).toMatchObject({ parent: CHANNEL, members: [BOT, PRINCIPAL] });
    const inputs = (await host.entriesAfter(id, null)).filter(entry => entry.kind === "cortex.input").map(entry => entry.data as { inputId: string; transport: string });
    expect(inputs).toEqual([expect.objectContaining({ inputId: "chan-msg-1", transport: "discord" })]);
    const texts = fake.texts("thread-1");
    expect(texts[0]).toStartWith("**Plan the spring workshop**\nThis private thread continues your Ivy conversation.");
    expect(texts.at(-1)).toBe("answer to with two breakout rooms");
  });

  test("a redelivered message starts nothing new", async () => {
    const { host, fake, post, settle } = await setup();
    await post("one start");
    await settle();
    await post("one start");
    await settle();
    expect((await host.list()).length).toBe(1);
    expect(fake.created).toBe(1);
    expect(fake.texts("thread-1").filter(text => text === "answer to one start")).toHaveLength(1);
  });

  test("a conversation created before its journal record was written is found by its message id, not created twice", async () => {
    const { host, fake, post, settle } = await setup();
    const orphan = await host.create({ title: "Half started", links: [], origin: { kind: "discord-thread", ref: "chan-msg-3" }, policy: "cloud" }, OWNER);
    await post("Half started", { messageId: "chan-msg-3" });
    await settle();
    expect((await host.list()).map(meta => meta.id)).toEqual([orphan.id]);
    expect((await host.meta(orphan.id)).discord?.threadId).toBe("thread-1");
    expect(fake.texts("thread-1").at(-1)).toBe("answer to Half started");
  });

  test("other authors, other channels, other guilds and messages inside threads are not taken", async () => {
    const { host, fake, post } = await setup();
    expect(await post("let me in", { authorId: STRANGER, authorIsPrincipal: true })).toBe(false);
    expect(await post("elsewhere", { channelId: OTHER_CHANNEL })).toBe(false);
    expect(await post("spoofed guild", { guildId: "999" })).toBe(false);
    expect(await post("in some thread", { threadId: "thread-9" })).toBe(false);
    expect(await host.list()).toHaveLength(0);
    expect(fake.created).toBe(0);
  });

  test("with no clear web principal nothing is created, and a failed thread is logged and retried on redelivery", async () => {
    const { host, fake, bridge, post, lines, settle } = await setup();
    bridge.setWebPrincipal(null);
    expect(await post("no owner")).toBe(true);
    expect(await host.list()).toHaveLength(0);
    expect(lines.at(-1)).toContain("more than one web principal");
    bridge.setWebPrincipal(OWNER);
    fake.failMemberAdd = true;
    expect(await post("thread fails", { messageId: "chan-msg-2" })).toBe(true);
    expect(lines.at(-1)).toContain("conversation start from message chan-msg-2 failed");
    expect(await host.list()).toHaveLength(1);
    fake.failMemberAdd = false;
    expect(await post("thread fails", { messageId: "chan-msg-2" })).toBe(true);
    await settle();
    expect(await host.list()).toHaveLength(1);
    const thread = [...fake.threads.keys()].at(-1) ?? "";
    expect(fake.texts(thread).at(-1)).toBe("answer to thread fails");
  });
});
