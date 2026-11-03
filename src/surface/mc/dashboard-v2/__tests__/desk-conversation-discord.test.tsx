import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiscordStrip } from "../components/desk-conversation";
import type { ConversationDetail } from "../lib/conversations";

const base: ConversationDetail = {
  conversation: { id: "c1", stack: "default", title: "Plan", links: [], policy: "cloud", state: "current", pinned: false, activity: { lastAt: "2026-11-03T10:00:00Z", status: "idle" }, origin: { kind: "web" } },
  models: { cloud: [], chosen: null, using: null }, sources: [], draft: "", pending: [], studio: null,
};
const render = (detail: ConversationDetail): string => renderToStaticMarkup(<DiscordStrip detail={detail} onSaved={() => undefined} />);

describe("the conversation's Discord strip", () => {
  it("offers Continue in Discord only for a current cloud conversation on a stack with Discord threads", () => {
    expect(render({ ...base, discord: { available: true } })).toContain(">Continue in Discord</button>");
    expect(render({ ...base, discord: { available: false, reason: "off" } })).not.toContain("Continue in Discord");
    expect(render({ ...base, conversation: { ...base.conversation, policy: "local" }, discord: { available: true } })).not.toContain("Continue in Discord");
    expect(render({ ...base, conversation: { ...base.conversation, state: "archived" }, discord: { available: true } })).not.toContain("Continue in Discord");
    expect(render(base)).toBe("");
  });

  it("links an attached thread and, once the conversation turns local, says earlier messages stay there and were not recalled", () => {
    const used = { ...base.conversation, discord: { threadId: "t1", usedAt: "2026-11-03T10:00:00Z" } };
    expect(render({ ...base, conversation: used, discord: { available: true, url: "https://discord.com/channels/1/t1" } })).toContain(`href="https://discord.com/channels/1/t1"`);
    const local = render({ ...base, conversation: { ...used, policy: "local" }, discord: { available: true, url: "https://discord.com/channels/1/t1" } });
    expect(local).toContain("Earlier messages stay in the Discord thread; they were not recalled.");
    expect(local).toContain("Discord gets only a link back here.");
    expect(render({ ...base, conversation: used, discord: { available: true, url: "u", blocked: "the thread has members other than the principal and the bot (1)" } })).toContain("Nothing is sent to the Discord thread");
  });
});
