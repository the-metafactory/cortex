import { createHash } from "node:crypto";
import { z } from "zod";
import type { InboundMessage, PlatformAdapter, ThreadMessage } from "../adapters/types";
import { safeAttachmentRefs } from "../bus/brain-consumer";
import type { DeskConversationsDiscord } from "../common/types/desk-conversations";
import { DmPicker, type DmReplier } from "./discord-dm";
import { ConversationError, type ConversationHost, type DiscordLink } from "./host";
import { INPUT_KIND, type AttachmentRef, type ConversationEntry, type ConversationMeta } from "./types";

type ThreadMethods = "createPrivateThread" | "privateThreadMembers" | "postToThread" | "recentThreadMessages" | "deleteThread";
export type ThreadCapable = Pick<PlatformAdapter, "getPlatformUserId" | ThreadMethods> & Partial<DmReplier>;
export type ThreadAdapter = Pick<PlatformAdapter, "getPlatformUserId"> & Required<Pick<PlatformAdapter, ThreadMethods>>;
export interface DiscordConversationOptions {
  host: ConversationHost;
  adapter: () => ThreadCapable | null;
  config: DeskConversationsDiscord;
  principalId: string | undefined;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
  log?: (line: string) => void;
}
export type DiscordCheck =
  | { ok: true; threadId: string; members: string[]; deleted: true }
  | { ok: false; stage: "capability" | "create" | "members" | "delete"; detail: string; threadId?: string; members?: string[] };
export interface DeliveryView { key: string; state: "sending" | "sent" | "uncertain" | "failed"; at: string; messageId?: string; detail?: string }
export type DiscordState = { available: true; url?: string; blocked?: string } | { available: false; reason: string };
type Delivered = "sent" | "uncertain" | "failed";

const CHUNK = 1900;
const THREAD_NAME = 100;
const RECENT = 50;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const SWEEP_MS = 60_000;
const CHECK_NAME = "Ivy capability check";
const CLOCK_SKEW_MS = 10_000;
const DeliverySchema = z.object({ state: z.enum(["sending", "sent", "uncertain", "failed"]), conversationId: z.string(), threadId: z.string(), text: z.string().optional(), nonce: z.string(), at: z.string(), messageId: z.string().optional(), detail: z.string().optional() });
type Delivery = z.infer<typeof DeliverySchema>;
const InputDataSchema = z.object({ transport: z.enum(["web", "discord"]), mode: z.enum(["queue", "steer"]).optional() }).loose();

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const threadIndex = (links: Map<string, DiscordLink>): Map<string, string> => new Map([...links].flatMap(([id, link]) => link.threadId ? [[link.threadId, id] as const] : []));
export const nonceFor = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 25);
export function chunks(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > CHUNK) {
    const cut = rest.lastIndexOf("\n", CHUNK);
    const at = cut > CHUNK / 2 ? cut : CHUNK;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export class DiscordConversations {
  private readonly queues = new Map<string, Promise<unknown>>();
  private threads: Map<string, string> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly dm: DmPicker;

  constructor(private readonly options: DiscordConversationOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (line => { console.log(`conversations: discord: ${line}`); });
    this.dm = new DmPicker({
      host: options.host,
      adapter: () => dmReplier(options.adapter()),
      principalId: options.principalId,
      attach: id => this.attach(id),
      threadUrl: threadId => this.threadUrl(threadId),
      webLink: id => this.webLink(id),
      now: this.now,
      log: this.log,
    });
  }

  start(): void {
    this.unsubscribe = this.options.host.onInput(id => { this.follow(id); });
    this.timer = setInterval(() => { void this.sweep(); }, SWEEP_MS);
    void this.sweep();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  webLink(id: string): string {
    return new URL(`/?desk=conversation&conversation=${encodeURIComponent(id)}`, this.options.config.webUrl).href;
  }

  threadUrl(threadId: string): string {
    return `https://discord.com/channels/${this.options.config.guildId}/${threadId}`;
  }

  capability(): { ok: true; adapter: ThreadAdapter; principal: string } | { ok: false; reason: string } {
    const principal = this.options.principalId;
    if (!principal) return { ok: false, reason: "No principal Discord id is configured on this stack." };
    const adapter = this.options.adapter();
    if (!adapter) return { ok: false, reason: "The Discord adapter is not running on this stack." };
    if (!isThreadAdapter(adapter)) return { ok: false, reason: "The installed Discord adapter cannot create, read and post private threads." };
    return { ok: true, principal, adapter };
  }

  async state(id: string): Promise<DiscordState> {
    const link = await this.options.host.discordLink(id);
    const capability = this.capability();
    if (link?.threadId) return { available: true, url: this.threadUrl(link.threadId), ...(link.blocked ? { blocked: link.blocked } : {}) };
    return capability.ok ? { available: true } : { available: false, reason: capability.reason };
  }

  async deliveries(id: string): Promise<DeliveryView[]> {
    await this.options.host.meta(id);
    const prefix = `${id}:`;
    return Object.entries(await this.options.host.deliveries()).flatMap(([key, raw]) => {
      if (!key.startsWith(prefix)) return [];
      const parsed = DeliverySchema.safeParse(raw);
      if (!parsed.success || parsed.data.conversationId !== id) return [];
      const { state, at, messageId, detail } = parsed.data;
      return [{ key: key.slice(prefix.length), state, at, ...(messageId ? { messageId } : {}), ...(detail ? { detail } : {}) }];
    }).sort((a, b) => a.at.localeCompare(b.at));
  }

  async check(): Promise<DiscordCheck> {
    const capability = this.capability();
    if (!capability.ok) return { ok: false, stage: "capability", detail: capability.reason };
    const { adapter, principal } = capability;
    const created = await adapter.createPrivateThread({ channelId: this.options.config.channelId, name: CHECK_NAME, memberIds: [principal] });
    if (!created.ok) return { ok: false, stage: "create", detail: created.detail };
    const members = await this.privateMembers(adapter, created.threadId, principal);
    const deleted = await adapter.deleteThread(created.threadId);
    if (!members.ok) return { ok: false, stage: "members", detail: members.detail, threadId: created.threadId, ...(members.memberIds ? { members: members.memberIds } : {}) };
    if (!deleted.ok) return { ok: false, stage: "delete", detail: deleted.detail, threadId: created.threadId, members: members.memberIds };
    return { ok: true, threadId: created.threadId, members: members.memberIds, deleted: true };
  }

  private async privateMembers(adapter: ThreadAdapter, threadId: string, principal: string): Promise<{ ok: true; memberIds: string[] } | { ok: false; detail: string; memberIds?: string[] }> {
    const read = await adapter.privateThreadMembers(threadId);
    if (!read.ok) return { ok: false, detail: `the thread members could not be read: ${read.detail}` };
    const bot = await adapter.getPlatformUserId();
    if (!read.memberIds.includes(principal)) return { ok: false, detail: "the principal is not a member of the thread (the member add failed)", memberIds: read.memberIds };
    const others = read.memberIds.filter(member => member !== principal && member !== bot);
    if (others.length) return { ok: false, detail: `the thread has members other than the principal and the bot (${others.length})`, memberIds: read.memberIds };
    return { ok: true, memberIds: read.memberIds };
  }

  private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => undefined);
    return next;
  }

  async attach(id: string, retry = false): Promise<ConversationMeta> {
    return this.serial(id, async () => {
      const { host } = this.options;
      const meta = await host.meta(id);
      const link = await host.discordLink(id);
      if (link?.threadId) return meta;
      if (meta.state === "archived") throw new ConversationError(409, "This conversation is archived. Restore it before continuing in Discord.");
      if (meta.policy === "local") throw new ConversationError(403, "This conversation is local-only, so it continues only on the web. No Discord thread was created.");
      if (link?.pendingAt && !retry) throw new ConversationError(409, "An earlier attempt may have created a Discord thread for this conversation. Check the conversation channel, then send again with retry to create a new thread.");
      const capability = this.capability();
      if (!capability.ok) throw new ConversationError(503, capability.reason);
      const { adapter, principal } = capability;
      await host.setDiscordLink(id, () => ({ cursor: null, open: [], pendingAt: this.now().toISOString() }));
      const created = await adapter.createPrivateThread({ channelId: this.options.config.channelId, name: meta.title.slice(0, THREAD_NAME), memberIds: [principal] });
      if (!created.ok) {
        await host.setDiscordLink(id, () => null);
        throw new ConversationError(503, `Discord did not create the private thread: ${created.detail}`);
      }
      const members = await this.privateMembers(adapter, created.threadId, principal);
      if (!members.ok) {
        const removed = await adapter.deleteThread(created.threadId);
        await host.setDiscordLink(id, () => null);
        throw new ConversationError(503, `The private thread is not usable: ${members.detail}. ${removed.ok ? "It was deleted." : `It could not be deleted (${removed.detail}); remove thread ${created.threadId} by hand.`}`);
      }
      const cursor = await host.latestEntryId(id);
      await host.setDiscordLink(id, () => ({ threadId: created.threadId, attachedAt: this.now().toISOString(), cursor, open: [] }));
      this.threads?.set(created.threadId, id);
      await this.deliver(id, created.threadId, `${id}:intro`, `**${meta.title}**\nThis private thread continues your Ivy conversation. Mention me here to continue; the full record stays on the web: <${this.webLink(id)}>`);
      return host.meta(id);
    });
  }

  private async conversationFor(threadId: string): Promise<string | null> {
    this.threads ??= threadIndex(await this.options.host.discordLinks());
    return this.threads.get(threadId) ?? null;
  }

  async offer(msg: InboundMessage): Promise<boolean> {
    if (msg.platform === "discord" && msg.isDM === true) return this.offerDm(msg);
    if (msg.platform !== "discord" || !msg.threadId) return false;
    const id = await this.conversationFor(msg.threadId).catch(() => null);
    if (!id) return false;
    const threadId = msg.threadId;
    await this.serial(`in:${id}`, () => this.receive(id, threadId, msg)).catch((error: unknown) => {
      this.log(`inbound message in thread ${threadId} failed: ${messageOf(error)}`);
    });
    return true;
  }

  private async offerDm(msg: InboundMessage): Promise<boolean> {
    if (!await this.dm.claims(msg).catch(() => false)) return false;
    await this.serial(`dm:${msg.channelId}`, () => this.dm.handle(msg)).catch((error: unknown) => {
      this.log(`DM conversation choice failed: ${messageOf(error)}`);
    });
    return true;
  }

  private async receive(id: string, threadId: string, msg: InboundMessage): Promise<void> {
    const { host, config, principalId } = this.options;
    if (msg.guildId !== config.guildId || !principalId || msg.authorId !== principalId) {
      this.log(`refused a message in thread ${threadId}: the author is not this stack's verified principal`);
      return;
    }
    const messageId = msg.messageId;
    if (!messageId) {
      await this.note(id, threadId, `noid:${msg.timestamp.getTime()}`, "Not sent to Ivy: the installed Discord adapter does not carry message ids, so this message could not be recorded safely.");
      return;
    }
    const attachments = await this.ingest(id, msg).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    if (attachments instanceof Error) {
      await this.note(id, threadId, `att:${messageId}`, `Not sent to Ivy: ${attachments.message} Send it again.`);
      return;
    }
    const text = msg.content.trim() || (attachments.length ? "Attached from Discord." : "");
    if (!text) return;
    const before = await host.meta(id);
    try {
      const result = await host.submit(id, { inputId: messageId, transport: "discord", text, mode: "queue", ...(attachments.length ? { attachments } : {}) });
      if (!result.duplicate && before.activity.status === "working") await this.note(id, threadId, `queued:${messageId}`, "Queued: Ivy is still working on an earlier message and answers this one next.");
    } catch (error) {
      if (!(error instanceof ConversationError)) throw error;
      await this.note(id, threadId, `refused:${messageId}`, `Not sent to Ivy: ${error.message}`);
    }
  }

  private async ingest(id: string, msg: InboundMessage): Promise<AttachmentRef[]> {
    if (!msg.attachments.length) return [];
    const safe = safeAttachmentRefs("discord", msg.attachments);
    if (safe.length !== msg.attachments.length) throw new Error("an attachment does not come from Discord's file host.");
    const fetcher = this.options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
    const refs: AttachmentRef[] = [];
    for (const [index, attachment] of msg.attachments.entries()) {
      if ((attachment.size ?? 0) > MAX_ATTACHMENT) throw new Error(`the attachment ${attachment.filename} is larger than 10 MB.`);
      const response = await fetcher(attachment.url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`the attachment ${attachment.filename} could not be fetched (HTTP ${response.status}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT) throw new Error(`the attachment ${attachment.filename} is empty or larger than 10 MB.`);
      const name = safe[index]?.name ?? attachment.filename;
      refs.push(await this.options.host.storeAttachment(id, { name: name.trim() ? name.slice(0, 256) : "attachment", mediaType: attachment.contentType?.trim() ? attachment.contentType.slice(0, 128) : "application/octet-stream", base64: bytes.toString("base64") }));
    }
    return refs;
  }

  private follow(id: string): void {
    void this.sync(id).then(async () => {
      await this.options.host.waitForIdle(id);
      await this.sync(id);
    }).catch((error: unknown) => { this.log(`projection of ${id} failed: ${messageOf(error)}`); });
  }

  async sweep(): Promise<void> {
    const links = await this.options.host.discordLinks().catch(() => new Map<string, DiscordLink>());
    this.threads = threadIndex(links);
    for (const [id, link] of links) {
      if (!link.threadId) continue;
      await this.sync(id).catch((error: unknown) => { this.log(`projection of ${id} failed: ${messageOf(error)}`); });
    }
  }

  sync(id: string): Promise<void> {
    return this.serial(id, () => this.project(id));
  }

  private async project(id: string): Promise<void> {
    const { host } = this.options;
    const link = await host.discordLink(id);
    const threadId = link?.threadId;
    if (!link || !threadId) return;
    for (const key of link.open) await this.reconcile(id, key);
    if (!link.neutralAt && (await host.meta(id)).policy === "local") {
      await this.neutral(id, threadId);
      return;
    }
    const entries = await host.entriesAfter(id, link.cursor);
    for (const entry of entries) {
      const meta = await host.meta(id);
      if (meta.policy === "local") {
        await this.neutral(id, threadId);
        return;
      }
      const text = projection(entry);
      const parts = text ? chunks(text) : [];
      for (const [index, part] of parts.entries()) {
        if (await this.deliver(id, threadId, `${id}:${entry.id}:${index}`, part) !== "sent") return;
      }
      await host.setDiscordLink(id, current => current && { ...current, cursor: Number(entry.id) });
    }
  }

  private async neutral(id: string, threadId: string): Promise<void> {
    const { host } = this.options;
    const link = await host.discordLink(id);
    const last = await host.latestEntryId(id);
    if (!link?.neutralAt) {
      const sent = await this.deliver(id, threadId, `${id}:neutral`, `This conversation is now private. Earlier messages in this thread stay here; nothing new from it is sent to Discord. Continue privately on the web: <${this.webLink(id)}>`);
      if (sent !== "sent") return;
    }
    await host.setDiscordLink(id, current => current && { ...current, neutralAt: current.neutralAt ?? this.now().toISOString(), cursor: last ?? current.cursor });
  }

  private async note(id: string, threadId: string, key: string, text: string): Promise<void> {
    await this.deliver(id, threadId, `${id}:note:${key}`, text);
  }

  private async deliver(id: string, threadId: string, key: string, text: string): Promise<Delivered> {
    const { host } = this.options;
    const existing = DeliverySchema.safeParse(await host.delivery(key));
    if (existing.success && existing.data.state === "sent") return "sent";
    if (existing.success && (existing.data.state === "sending" || existing.data.state === "uncertain")) {
      const settled = await this.reconcile(id, key);
      if (settled !== "failed") return settled;
    }
    const capability = this.capability();
    if (!capability.ok) return "failed";
    if (!await this.destination(id, threadId, capability.adapter, capability.principal)) return "failed";
    const record: Delivery = { state: "sending", conversationId: id, threadId, text, nonce: nonceFor(key), at: this.now().toISOString() };
    await this.track(id, key, true);
    await host.recordDelivery(key, record);
    const result = await capability.adapter.postToThread({ threadId, text, nonce: record.nonce }).catch((error: unknown) => ({ ok: false as const, uncertain: true, detail: messageOf(error) }));
    if (result.ok) return this.markSent(id, key, record, result.messageId);
    await host.recordDelivery(key, { ...record, state: result.uncertain ? "uncertain" : "failed", detail: result.detail });
    if (!result.uncertain) await this.track(id, key, false);
    this.log(`${result.uncertain ? "uncertain" : "failed"} delivery ${key} to thread ${threadId}: ${result.detail}`);
    return result.uncertain ? "uncertain" : "failed";
  }

  private async reconcile(id: string, key: string): Promise<Delivered> {
    const { host } = this.options;
    const parsed = DeliverySchema.safeParse(await host.delivery(key));
    if (!parsed.success || parsed.data.state === "sent" || parsed.data.state === "failed") {
      await this.track(id, key, false);
      return parsed.success && parsed.data.state === "sent" ? "sent" : "failed";
    }
    const record = parsed.data;
    const capability = this.capability();
    if (!capability.ok) return "uncertain";
    const recent = await capability.adapter.recentThreadMessages({ threadId: record.threadId, limit: RECENT });
    if (!recent.ok) {
      if (record.state === "sending") await host.recordDelivery(key, { ...record, state: "uncertain", detail: recent.detail });
      return "uncertain";
    }
    const bot = await capability.adapter.getPlatformUserId();
    const bound = new Set(Object.values(await host.deliveries()).flatMap(raw => {
      const other = DeliverySchema.safeParse(raw);
      return other.success && other.data.threadId === record.threadId && other.data.messageId ? [other.data.messageId] : [];
    }));
    const since = Date.parse(record.at) - CLOCK_SKEW_MS;
    const candidates = recent.messages.filter((message: ThreadMessage) => message.authorId === bot && message.content === record.text && !bound.has(message.id));
    const found = candidates.find(message => Date.parse(message.at) >= since);
    if (found) return this.markSent(id, key, record, found.id, "found by thread readback");
    if (candidates.some(message => Number.isNaN(Date.parse(message.at)))) {
      this.log(`delivery ${key} stays uncertain: the adapter returned a message without a usable time`);
      return "uncertain";
    }
    await host.recordDelivery(key, { ...record, state: "failed", detail: "not found by thread readback; sent again" });
    await this.track(id, key, false);
    return "failed";
  }

  private async markSent(id: string, key: string, record: Delivery, messageId: string, detail?: string): Promise<Delivered> {
    await this.options.host.recordDelivery(key, { ...sentRecord(record, messageId), ...(detail ? { detail } : {}) });
    await this.track(id, key, false);
    await this.used(id);
    return "sent";
  }

  private async destination(id: string, threadId: string, adapter: ThreadAdapter, principal: string): Promise<boolean> {
    const { host } = this.options;
    const members = await this.privateMembers(adapter, threadId, principal);
    const link = await host.discordLink(id);
    if (!members.ok) {
      if (link?.blocked !== members.detail) await host.setDiscordLink(id, current => current && { ...current, blocked: members.detail });
      this.log(`nothing sent to thread ${threadId}: ${members.detail}`);
      return false;
    }
    if (link?.blocked) await host.setDiscordLink(id, current => current && withoutBlocked(current));
    return true;
  }

  private async track(id: string, key: string, open: boolean): Promise<void> {
    await this.options.host.setDiscordLink(id, current => {
      if (!current) return current;
      const rest = current.open.filter(k => k !== key);
      return { ...current, open: open ? [...rest, key] : rest };
    });
  }

  private async used(id: string): Promise<void> {
    await this.options.host.setDiscordLink(id, current => current && (current.usedAt ? current : { ...current, usedAt: this.now().toISOString() }));
  }
}

function dmReplier(adapter: ThreadCapable | null): DmReplier | null {
  if (!adapter?.postResponse || adapter.instanceId === undefined) return null;
  const { instanceId, postResponse } = adapter;
  return { instanceId, postResponse: postResponse.bind(adapter) };
}

function isThreadAdapter(adapter: ThreadCapable): adapter is ThreadAdapter {
  return typeof adapter.createPrivateThread === "function" && typeof adapter.privateThreadMembers === "function" && typeof adapter.postToThread === "function" && typeof adapter.recentThreadMessages === "function" && typeof adapter.deleteThread === "function";
}

function sentRecord(record: Delivery, messageId: string): Delivery {
  const sent: Delivery = { ...record, state: "sent", messageId };
  delete sent.text;
  return sent;
}

function withoutBlocked(link: DiscordLink): DiscordLink {
  const copy = { ...link };
  delete copy.blocked;
  return copy;
}

export function projection(entry: ConversationEntry): string | null {
  if (entry.kind === INPUT_KIND && entry.role === "user") {
    const input = InputDataSchema.safeParse(entry.data);
    if (!input.success || input.data.transport === "discord" || !entry.text) return null;
    return `**You, on the web${input.data.mode === "steer" ? " (use this now)" : ""}:**\n${entry.text}`;
  }
  if (entry.role !== "assistant") return null;
  if (entry.error) return "Ivy could not answer this message. The web view shows what happened.";
  return entry.text?.trim() ? entry.text : null;
}
