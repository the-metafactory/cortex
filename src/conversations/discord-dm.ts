import { z } from "zod";
import type { InboundMessage, NotifyResult, PlatformAdapter } from "../adapters/types";
import { DEFAULT_LOCAL_PRINCIPAL } from "../surface/mc/api/networks-admission";
import { ConversationError, type ConversationHost } from "./host";
import type { AttachmentRef, ConversationEntry, ConversationMeta } from "./types";

export type DmSender = Pick<PlatformAdapter, "notifyPrincipal">;
export interface DmConversationOptions {
  host: ConversationHost;
  sender: () => DmSender | null;
  principalId: string | undefined;
  webPrincipal: () => string | null;
  ingest: (id: string, msg: InboundMessage) => Promise<AttachmentRef[]>;
  render: (entry: ConversationEntry) => string | null;
  split: (text: string) => string[];
  webLink: (id: string) => string;
  now: () => Date;
  log: (line: string) => void;
}

export const OFFER_SIZE = 5;
export const OFFER_TTL_MS = 10 * 60_000;
export const CLAIM_WINDOW_MS = 60 * 60_000;
const TITLE_MAX = 80;
const RETRY_CODES = new Set(["disconnected", "not-started", "buffered"]);

const OfferSchema = z.object({
  kind: z.literal("dm-offer"),
  at: z.string(),
  requestedAt: z.string(),
  rows: z.array(z.object({ id: z.string() })),
});
type Offer = z.infer<typeof OfferSchema>;
const CurrentSchema = z.object({
  kind: z.literal("dm-current"),
  conversationId: z.string().nullable(),
  cursor: z.number().nullable(),
  neutralAt: z.string().optional(),
});
type Current = z.infer<typeof CurrentSchema>;
const SentSchema = z.object({ kind: z.literal("dm-delivery"), state: z.enum(["sent", "uncertain", "failed", "retry"]) }).loose();
const HandledSchema = z.object({ kind: z.literal("dm-handled") }).loose();

type Command = { kind: "new" } | { kind: "list" } | { kind: "pick"; index: number; restore: boolean } | { kind: "text" };
type Sent = "done" | "retry";

const NEW_RE = /^new$/i;
const LIST_RE = /^conversations$/i;
const PICK_RE = /^(restore\s+)?(\d{1,2})$/i;

export function parseDmCommand(content: string): Command {
  const text = content.trim();
  if (NEW_RE.exec(text)) return { kind: "new" };
  if (LIST_RE.exec(text)) return { kind: "list" };
  const pick = PICK_RE.exec(text);
  if (pick?.[2]) return { kind: "pick", index: Number(pick[2]), restore: Boolean(pick[1]) };
  return { kind: "text" };
}

const CURRENT_KEY = "dm:current";
const OFFER_KEY = "dm:offer";
const handledKey = (messageId: string): string => `dm:in:${messageId}`;
const PRIVATE_ROW = "Private conversation, continue on the web";
const LIST_HELP = "Reply with a number to continue that conversation here, or `new` to start a fresh one.";

export class DmConversations {
  constructor(private readonly options: DmConversationOptions) {}

  claims(msg: InboundMessage): boolean {
    const { principalId } = this.options;
    return msg.platform === "discord" && msg.isDM === true && Boolean(principalId) && msg.authorId === principalId;
  }

  async current(): Promise<Current> {
    const parsed = CurrentSchema.safeParse(await this.options.host.delivery(CURRENT_KEY));
    return parsed.success ? parsed.data : { kind: "dm-current", conversationId: null, cursor: null };
  }

  private async setCurrent(next: Current): Promise<void> {
    await this.options.host.recordDelivery(CURRENT_KEY, next);
  }

  async handle(msg: InboundMessage): Promise<void> {
    const { host } = this.options;
    if (!this.claims(msg)) return;
    const messageId = msg.messageId;
    if (!messageId) {
      await this.say(`noid:${msg.timestamp.getTime()}`, "Not sent to Ivy: the installed Discord adapter does not carry message ids, so this message could not be recorded safely.");
      return;
    }
    if (HandledSchema.safeParse(await host.delivery(handledKey(messageId))).success) return;
    const reply = await this.run(msg, messageId).catch((error: unknown) => {
      if (error instanceof ConversationError) return `Not sent to Ivy: ${error.message}`;
      this.options.log(`DM message ${messageId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return "Not sent to Ivy: something went wrong on this stack. Send it again; the daemon log has the details.";
    });
    await host.recordDelivery(handledKey(messageId), { kind: "dm-handled", at: this.options.now().toISOString() });
    if (reply) await this.say(`reply:${messageId}`, reply);
  }

  private async run(msg: InboundMessage, messageId: string): Promise<string | null> {
    const command = parseDmCommand(msg.content);
    if (command.kind === "new") {
      await this.setCurrent({ kind: "dm-current", conversationId: null, cursor: null });
      return "Your next message here starts a new conversation.";
    }
    if (command.kind === "list") return this.offer(msg);
    if (command.kind === "pick") {
      const open = await this.openOffer();
      if (open && within(open.age, CLAIM_WINDOW_MS)) return this.pick(msg, open, command.index, command.restore);
    }
    return this.submit(msg, messageId);
  }

  private async offer(msg: InboundMessage): Promise<string> {
    const { host } = this.options;
    const rows = (await host.overview({ state: "current", q: "", limit: OFFER_SIZE })).rows.map(row => row.conversation);
    const offer: Offer = { kind: "dm-offer", at: this.options.now().toISOString(), requestedAt: msg.timestamp.toISOString(), rows: rows.map(meta => ({ id: meta.id })) };
    await host.recordDelivery(OFFER_KEY, offer);
    if (!rows.length) return "No current conversations yet. Write a message here to start one.";
    const here = (await this.current()).conversationId;
    const lines = rows.map((meta, index) => `${index + 1}. ${line(meta)}${meta.id === here ? " (this DM)" : ""}`);
    return ["Recent conversations:", ...lines, LIST_HELP, `This list expires in ${OFFER_TTL_MS / 60_000} minutes.`].join("\n");
  }

  private async openOffer(): Promise<{ offer: Offer; age: number } | null> {
    const parsed = OfferSchema.safeParse(await this.options.host.delivery(OFFER_KEY));
    if (!parsed.success) return null;
    return { offer: parsed.data, age: this.options.now().getTime() - Date.parse(parsed.data.at) };
  }

  private async pick(msg: InboundMessage, open: { offer: Offer; age: number }, index: number, restore: boolean): Promise<string> {
    const { host } = this.options;
    if (!within(open.age, OFFER_TTL_MS) || msg.timestamp.getTime() <= Date.parse(open.offer.requestedAt)) return "Nothing changed: that list has expired. Send `conversations` for a fresh one.";
    const chosen = open.offer.rows[index - 1];
    if (!chosen) return `Nothing changed: the list has no number ${index}.`;
    const meta = await this.metaOrNull(chosen.id);
    if (!meta) return "Nothing changed: that conversation no longer exists.";
    if (meta.policy === "local") return `${PRIVATE_ROW}: <${this.options.webLink(meta.id)}>`;
    if (meta.state === "archived") {
      if (!restore) return `**${meta.title}** is archived. Reply \`restore ${index}\` to restore it and continue here.`;
      await host.organize(meta.id, { state: "current" });
    }
    await this.setCurrent({ kind: "dm-current", conversationId: meta.id, cursor: await host.latestEntryId(meta.id) });
    return [`Now continuing **${meta.title}**${meta.state === "archived" ? " (restored)" : ""} here.`, `Full record on the web: <${this.options.webLink(meta.id)}>`].join("\n");
  }

  private async submit(msg: InboundMessage, messageId: string): Promise<string | null> {
    const { host } = this.options;
    const id = await this.target(msg);
    const meta = await host.meta(id);
    if (meta.policy === "local") return `This conversation is private, so it continues only on the web: <${this.options.webLink(id)}>. Write \`new\` to start another one here.`;
    const attachments = await this.options.ingest(id, msg).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    if (attachments instanceof Error) return `Not sent to Ivy: ${attachments.message} Send it again.`;
    const text = msg.content.trim() || (attachments.length ? "Attached from Discord." : "");
    if (!text) return null;
    try {
      const result = await host.submit(id, { inputId: messageId, transport: "discord", text, mode: "queue", ...(attachments.length ? { attachments } : {}) });
      if (!result.duplicate && meta.activity.status === "working") return "Queued: Ivy is still working on an earlier message and answers this one next.";
      return null;
    } catch (error) {
      if (error instanceof ConversationError && error.status === 409 && meta.state === "archived") return "Not sent to Ivy: this DM's conversation is archived. Send `conversations` to restore or pick another, or `new` to start a fresh one.";
      throw error;
    }
  }

  private async target(msg: InboundMessage): Promise<string> {
    const { host } = this.options;
    const current = await this.current();
    if (current.conversationId && await this.metaOrNull(current.conversationId)) return current.conversationId;
    const principal = this.options.webPrincipal();
    if (!principal) throw new ConversationError(503, "this stack has more than one web principal, so a conversation started in Discord would have no clear owner. Start it on the web.");
    const title = (msg.content.trim().split("\n")[0] ?? "").slice(0, TITLE_MAX).trim() || "Discord DM";
    const created = await host.create({ title, links: [], origin: { kind: "discord-dm" }, policy: "cloud" }, principal);
    await this.setCurrent({ kind: "dm-current", conversationId: created.id, cursor: null });
    return created.id;
  }

  private async metaOrNull(id: string): Promise<ConversationMeta | null> {
    return this.options.host.meta(id).catch((error: unknown) => {
      if (error instanceof ConversationError && error.status === 404) return null;
      throw error;
    });
  }

  async project(id: string): Promise<void> {
    const { host } = this.options;
    const current = await this.current();
    if (current.conversationId !== id) return;
    const meta = await host.meta(id);
    if (meta.policy === "local") {
      if (current.neutralAt) return;
      if (await this.say(`neutral:${id}`, `This conversation is now private. Earlier messages here stay; nothing new from it is sent to Discord. Continue privately on the web: <${this.options.webLink(id)}>`) === "retry") return;
      await this.advance(id, await host.latestEntryId(id), this.options.now().toISOString());
      return;
    }
    for (const entry of await host.entriesAfter(id, current.cursor)) {
      const text = this.options.render(entry);
      for (const [index, part] of (text ? this.options.split(text) : []).entries()) {
        if (await this.say(`out:${id}:${entry.id}:${index}`, part) === "retry") return;
      }
      if (!await this.advance(id, Number(entry.id))) return;
    }
  }

  private async advance(id: string, cursor: number | null, neutralAt?: string): Promise<boolean> {
    const now = await this.current();
    if (now.conversationId !== id) return false;
    await this.setCurrent({ ...now, cursor, ...(neutralAt ? { neutralAt } : {}) });
    return true;
  }

  private async say(name: string, text: string): Promise<Sent> {
    const { host, log } = this.options;
    const key = `dm:${name}`;
    const prior = SentSchema.safeParse(await host.delivery(key));
    if (prior.success && prior.data.state !== "retry") return "done";
    const sender = this.options.sender();
    if (!sender) {
      log(`DM reply ${key} waits: the Discord adapter cannot send DMs`);
      return "retry";
    }
    const at = this.options.now().toISOString();
    const result: NotifyResult | undefined = await sender.notifyPrincipal(text, { buffer: false }).catch((error: unknown) => ({ delivered: false as const, kind: "transient" as const, code: "threw", detail: error instanceof Error ? error.message : String(error) })) ?? undefined;
    if (result?.delivered) {
      await host.recordDelivery(key, { kind: "dm-delivery", state: "sent", at, ...(result.messageId ? { messageId: result.messageId } : { bestEffort: "the adapter returned no message id" }) });
      return "done";
    }
    if (!result) {
      await host.recordDelivery(key, { kind: "dm-delivery", state: "sent", at, bestEffort: "the adapter reported no result" });
      return "done";
    }
    if (result.kind === "transient" && RETRY_CODES.has(result.code)) {
      await host.recordDelivery(key, { kind: "dm-delivery", state: "retry", at, code: result.code });
      return "retry";
    }
    const state = result.kind === "transient" ? "uncertain" : "failed";
    await host.recordDelivery(key, { kind: "dm-delivery", state, at, code: result.code, ...(result.detail ? { detail: result.detail } : {}) });
    log(`${state} DM delivery ${key}: ${result.code}${result.detail ? ` (${result.detail})` : ""}; not sent again`);
    return "done";
  }
}

export function conversationWebPrincipal(principals: ReadonlySet<string>, localPrincipal: string | undefined): string | null {
  if (principals.size === 0) return localPrincipal ?? DEFAULT_LOCAL_PRINCIPAL;
  if (principals.size === 1) return [...principals][0] ?? null;
  const local = localPrincipal?.trim().toLowerCase();
  return local && principals.has(local) ? local : null;
}

function within(age: number, limit: number): boolean {
  return age >= 0 && age <= limit;
}

function line(meta: ConversationMeta): string {
  if (meta.policy === "local") return PRIVATE_ROW;
  return `${meta.title} (${meta.activity.lastAt.slice(0, 10)})`;
}
