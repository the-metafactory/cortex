import { z } from "zod";
import type { InboundMessage, PlatformAdapter } from "../adapters/types";
import { ConversationError, type ConversationHost } from "./host";
import type { ConversationMeta, OverviewRow } from "./types";

export type DmReplier = Pick<PlatformAdapter, "instanceId" | "postResponse">;
export interface DmPickerOptions {
  host: ConversationHost;
  adapter: () => DmReplier | null;
  principalId: string | undefined;
  attach: (id: string) => Promise<ConversationMeta>;
  threadUrl: (threadId: string) => string;
  webLink: (id: string) => string;
  now: () => Date;
  log: (line: string) => void;
}

export const OFFER_SIZE = 5;
export const OFFER_TTL_MS = 10 * 60_000;
export const CLAIM_WINDOW_MS = 60 * 60_000;
const SEARCH_MAX = 200;

const OfferSchema = z.object({
  kind: z.literal("dm-offer"),
  principal: z.string(),
  channelId: z.string(),
  offerId: z.string(),
  at: z.string(),
  requestedAt: z.string(),
  rows: z.array(z.object({ id: z.string(), archived: z.boolean() })),
});
type Offer = z.infer<typeof OfferSchema>;
const HandledSchema = z.object({ kind: z.literal("dm-handled"), reply: z.string() });

type Command =
  | { kind: "recent" }
  | { kind: "search"; q: string }
  | { kind: "pick"; index: number; restore: boolean };

const RECENT_RE = /^conversations$/i;
const SEARCH_RE = /^search\s+(\S[\s\S]*)$/i;
const PICK_RE = /^(restore\s+)?(\d{1,2})$/i;

export function parseDmCommand(content: string): Command | null {
  const text = content.trim();
  if (RECENT_RE.exec(text)) return { kind: "recent" };
  const search = SEARCH_RE.exec(text);
  if (search?.[1]) return { kind: "search", q: search[1].trim().slice(0, SEARCH_MAX) };
  const pick = PICK_RE.exec(text);
  if (pick?.[2]) return { kind: "pick", index: Number(pick[2]), restore: Boolean(pick[1]) };
  return null;
}

const offerKey = (channelId: string): string => `dm:offer:${channelId}`;
const handledKey = (messageId: string): string => `dm:in:${messageId}`;
const PRIVATE_ROW = "Private conversation, continue on the web";
const HELP = "Reply with a number to continue that conversation, `search <words>` to find an older one, or `conversations` for the recent list.";

export class DmPicker {
  constructor(private readonly options: DmPickerOptions) {}

  async claims(msg: InboundMessage): Promise<boolean> {
    if (msg.platform !== "discord" || msg.isDM !== true) return false;
    const command = parseDmCommand(msg.content);
    if (!command) return false;
    if (command.kind !== "pick") return true;
    const open = await this.openOffer(msg.channelId);
    return open !== null && within(open.age, CLAIM_WINDOW_MS);
  }

  private async openOffer(channelId: string): Promise<{ offer: Offer; age: number } | null> {
    const parsed = OfferSchema.safeParse(await this.options.host.delivery(offerKey(channelId)));
    if (!parsed.success) return null;
    return { offer: parsed.data, age: this.options.now().getTime() - Date.parse(parsed.data.at) };
  }

  async handle(msg: InboundMessage): Promise<void> {
    const { principalId, host } = this.options;
    const command = parseDmCommand(msg.content);
    if (!command) return;
    if (!principalId || msg.authorId !== principalId) {
      this.options.log(`refused a DM conversation ${command.kind}: the author is not this stack's verified principal`);
      return;
    }
    const messageId = msg.messageId;
    if (!messageId) {
      await this.reply(msg, "Not handled: the installed Discord adapter does not carry message ids, so this choice could not be checked safely.");
      return;
    }
    const handled = HandledSchema.safeParse(await host.delivery(handledKey(messageId)));
    if (handled.success) return;
    const text = await this.run(msg, messageId, command).catch((error: unknown) => {
      if (error instanceof ConversationError) return `Not continued: ${error.message}`;
      throw error;
    });
    await host.recordDelivery(handledKey(messageId), { kind: "dm-handled", reply: text });
    await this.reply(msg, text);
  }

  private async run(msg: InboundMessage, messageId: string, command: Command): Promise<string> {
    if (command.kind === "recent") return this.offer(msg, messageId, await this.recent(), "Which conversation shall we continue?", "No current conversations. Start one on the web, or `search <words>` to find an archived one.");
    if (command.kind === "search") return this.offer(msg, messageId, await this.search(command.q), `Conversations matching "${command.q}":`, `No conversation matches "${command.q}".`);
    return this.pick(msg, command.index, command.restore);
  }

  private async recent(): Promise<OverviewRow[]> {
    return (await this.options.host.overview({ state: "current", q: "", limit: OFFER_SIZE })).rows;
  }

  private async search(q: string): Promise<OverviewRow[]> {
    const { host } = this.options;
    const current = (await host.overview({ state: "current", q, limit: OFFER_SIZE })).rows;
    if (current.length >= OFFER_SIZE) return current;
    const archived = (await host.overview({ state: "archived", q, limit: OFFER_SIZE - current.length })).rows;
    return [...current, ...archived];
  }

  private async offer(msg: InboundMessage, messageId: string, rows: OverviewRow[], heading: string, empty: string): Promise<string> {
    const { host, principalId } = this.options;
    const offer: Offer = { kind: "dm-offer", principal: principalId ?? "", channelId: msg.channelId, offerId: messageId, at: this.options.now().toISOString(), requestedAt: msg.timestamp.toISOString(), rows: rows.map(row => ({ id: row.conversation.id, archived: row.conversation.state === "archived" })) };
    await host.recordDelivery(offerKey(msg.channelId), offer);
    if (!rows.length) return empty;
    const lines = rows.map((row, index) => `${index + 1}. ${line(row)}`);
    return [heading, ...lines, HELP, `This list expires in ${OFFER_TTL_MS / 60_000} minutes.`].join("\n");
  }

  private async pick(msg: InboundMessage, index: number, restore: boolean): Promise<string> {
    const { host, principalId } = this.options;
    const open = await this.openOffer(msg.channelId);
    if (!open || open.offer.principal !== principalId || open.offer.channelId !== msg.channelId) return `Nothing changed: there is no open list to choose from. ${HELP}`;
    const { offer } = open;
    if (!within(open.age, OFFER_TTL_MS) || msg.timestamp.getTime() <= Date.parse(offer.requestedAt)) return "Nothing changed: that list has expired. Send `conversations` or `search <words>` for a fresh one.";
    const chosen = offer.rows[index - 1];
    if (!chosen) return `Nothing changed: the list has no number ${index}.`;
    const meta = await host.meta(chosen.id).catch((error: unknown) => {
      if (error instanceof ConversationError && error.status === 404) return null;
      throw error;
    });
    if (!meta) return "Nothing changed: that conversation no longer exists.";
    if (meta.policy === "local") return `${PRIVATE_ROW}: <${this.options.webLink(meta.id)}>`;
    if (meta.state === "archived") {
      if (!restore) return `**${meta.title}** is archived. Reply \`restore ${index}\` to restore it and continue.`;
      await host.organize(meta.id, { state: "current" });
    }
    const attached = await this.options.attach(meta.id);
    const threadId = attached.discord?.threadId;
    const thread = threadId ? `Continue in its private thread: <${this.options.threadUrl(threadId)}>` : "Its private thread is not available.";
    return [`**${attached.title}**${restore && meta.state === "archived" ? " (restored)" : ""}`, thread, `Full record on the web: <${this.options.webLink(meta.id)}>`].join("\n");
  }

  private async reply(msg: InboundMessage, text: string): Promise<void> {
    const adapter = this.options.adapter();
    if (!adapter) {
      this.options.log("a DM conversation reply was not sent: the Discord adapter is not running");
      return;
    }
    await adapter.postResponse({ instanceId: msg.instanceId, channelId: msg.channelId }, text);
  }
}

function within(age: number, limit: number): boolean {
  return age >= 0 && age <= limit;
}

function line(row: OverviewRow): string {
  const meta = row.conversation;
  if (meta.policy === "local") return PRIVATE_ROW;
  const day = meta.activity.lastAt.slice(0, 10);
  return `${meta.title} (${meta.state === "archived" ? "archived, " : ""}${day})`;
}
