import type { Database } from "bun:sqlite";
import { clock } from "./time";
import type { DeskAction, DeskEvent, DeskInterrupt, DeskInterruptReason, DeskItem, InterruptFeedback, MeetingHold } from "./types";
import type { DESK_TRANSPORTS } from "../../../common/types/config";
import { reasonOn, type InterruptSwitches } from "./interrupt-switches";
import { listedEntry } from "./vips";

export type TransportId = (typeof DESK_TRANSPORTS)[number];

export interface InterruptRules {
  transport: TransportId;
  command?: string[];
  timeoutSeconds?: number;
  meetingMinutes: number;
  mail: boolean;
  reminders: boolean;
  maxAgeMinutes: number;
  everySeconds: number;
  chime: boolean;
  notifications: boolean;
  holdDuringMeetings: boolean;
}

export const NO_INTERRUPTIONS: InterruptRules = {
  transport: "none",
  meetingMinutes: 0,
  mail: false,
  reminders: false,
  maxAgeMinutes: 60,
  everySeconds: 60,
  chime: false,
  notifications: false,
  holdDuringMeetings: false,
};

export interface DeskPush {
  key: string;
  title: string;
  why: string;
  action?: { label: string; url: string };
  reason?: DeskInterruptReason;
  held?: MeetingHold;
}

export type PushResult = { status: "sent"; ref?: string } | { status: "buffered" } | { status: "failed"; error: string };

export interface PushOutcome {
  key: string;
  status: PushResult["status"];
}

export interface DeskTransport {
  id: TransportId;
  send(push: DeskPush): Promise<PushResult>;
}

export interface Delivery {
  key: string;
  transport: string;
  status: "sending" | "sent" | "buffered" | "failed";
  error: string | null;
  ref: string | null;
  createdAt: number;
}

const MINUTE = 60_000;
const KEEP_MS = 7 * 86_400_000;
const STUCK_MS = 5 * MINUTE;
const STUCK = "The push was interrupted before it finished; it may have arrived.";

export function meetingItems(events: DeskEvent[], now: number, minutes: number): DeskItem[] {
  if (minutes <= 0) return [];
  return events
    .filter((e) => e.kind === "meeting" && e.at > now && e.at - now <= minutes * MINUTE)
    .map((e): DeskItem => {
      const left = Math.max(1, Math.round((e.at - now) / MINUTE));
      const join: DeskAction[] = e.url ? [{ id: "open", label: e.online ? "Join" : "Open", role: "primary", wired: true, url: e.url }] : [];
      const look: DeskAction = { id: "detail", label: "Look first", role: join.length > 0 ? "secondary" : "primary", wired: true };
      return {
        key: `meeting:${e.key}@${e.at}`,
        kind: "meeting",
        source: e.source ?? "calendar",
        area: e.area,
        urgency: "now",
        title: `"${e.title}" starts at ${clock(e.at)}.`,
        why: `It starts in ${left} ${left === 1 ? "minute" : "minutes"}.`,
        score: 95,
        actions: [...join, look].slice(0, 2),
        detail: {
          summary: e.title,
          history: [`Starts ${clock(e.at)}${e.end ? `, ends ${clock(e.end)}` : ""}${e.note ? `, ${e.note}` : ""}`],
          refs: [e.key],
          links: e.url ? [{ label: e.online ? "Join" : "Open", url: e.url }] : [],
        },
        eventKey: e.key,
        since: e.at,
      };
    });
}

const rankedForToday = (item: DeskItem): boolean => item.urgency !== "waiting";

export interface InterruptContext {
  switches: InterruptSwitches;
  vips: ReadonlySet<string>;
  today: readonly DeskEvent[];
  feedback: ReadonlyMap<string, InterruptFeedback>;
}

export const NO_SWITCHES: InterruptContext = { switches: new Map(), vips: new Set(), today: [], feedback: new Map() };

const senderOf = (mail: DeskItem): string => mail.detail.refs[0] ?? "";

function meetingLaterToday(eventKey: string, today: readonly DeskEvent[], now: number): boolean {
  return today.some((e) => e.key === eventKey && e.kind === "meeting" && e.at > now);
}

function mailReasons(item: DeskItem, context: InterruptContext, now: number): DeskInterruptReason[] {
  const vip = item.suspicious ? null : listedEntry(context.vips, senderOf(item));
  return [
    ...(item.eventKey && meetingLaterToday(item.eventKey, context.today, now) ? [{ code: "mail.meeting-today" as const, eventKey: item.eventKey }] : []),
    ...(vip ? [{ code: "mail.vip" as const, target: vip }] : []),
    ...(rankedForToday(item) ? [{ code: "mail.ranked" as const }] : []),
  ];
}

function firingReasons(item: DeskItem, rules: InterruptRules, context: InterruptContext, now: number, freshFrom: number | undefined): DeskInterruptReason[] {
  const fresh = freshFrom !== undefined && now - freshFrom <= rules.maxAgeMinutes * MINUTE;
  if (item.kind === "meeting") return [{ code: "meeting.soon" }];
  if (!fresh) return [];
  if (item.kind === "reminder") return [{ code: "reminder.due" }];
  if (item.kind === "mail") return mailReasons(item, context, now);
  return [];
}

/** The item's interruption reason: the first reason that fires and is switched on, or null when it does not interrupt. */
export function interrupts(item: DeskItem, rules: InterruptRules, now: number, context: InterruptContext = NO_SWITCHES, freshFrom: number | undefined = item.since): DeskInterruptReason | null {
  return firingReasons(item, rules, context, now, freshFrom).find((r) => reasonOn(rules, context.switches, r.code, r.target)) ?? null;
}

const holdsInterruptions = (e: DeskEvent): e is DeskEvent & { end: number } => e.kind === "meeting" && e.end !== undefined && e.availability?.status !== "free";

export interface MeetingChain extends MeetingHold {
  keys: ReadonlySet<string>;
}

/** The meeting running at `at`, with `until` stretched over meetings that follow back to back; null when none runs then. */
export function runningMeeting(events: readonly DeskEvent[], at: number): MeetingChain | null {
  const holding = events.filter(holdsInterruptions).sort((a, b) => a.at - b.at);
  const running = holding.filter((e) => e.at <= at && at < e.end);
  const first = running[0];
  if (!first) return null;
  const keys = new Set(running.map((e) => e.key));
  let until = Math.max(...running.map((e) => e.end));
  for (const next of holding) {
    if (next.at > until || next.end <= at) continue;
    keys.add(next.key);
    until = Math.max(until, next.end);
  }
  return { eventKey: first.key, title: first.title, until, keys };
}

const HELD_KINDS: ReadonlySet<DeskItem["kind"]> = new Set(["mail", "reminder"]);

function holdFor(item: DeskItem, rules: InterruptRules, today: readonly DeskEvent[]): MeetingHold | null {
  if (!rules.holdDuringMeetings || item.since === undefined || !HELD_KINDS.has(item.kind)) return null;
  const chain = runningMeeting(today, item.since);
  if (!chain || (item.eventKey !== undefined && chain.keys.has(item.eventKey))) return null;
  return { eventKey: chain.eventKey, title: chain.title, until: chain.until };
}

function failure(sent: Delivery | undefined, now: number): string | null {
  if (sent?.status === "failed") return sent.error ?? "The transport gave no reason.";
  if (sent?.status === "sending" && now - sent.createdAt > STUCK_MS) return STUCK;
  return null;
}

export function markInterrupts(items: DeskItem[], rules: InterruptRules, deliveries: ReadonlyMap<string, Delivery>, now: number, context: InterruptContext): DeskItem[] {
  return items.map((item) => {
    const sent = deliveries.get(item.key);
    const error = failure(sent, now);
    if (error !== null) {
      const interrupt: DeskInterrupt = { delivery: "failed", error };
      return { ...item, urgency: "now", score: Math.max(item.score, 99), interrupt };
    }
    const held = holdFor(item, rules, context.today);
    const reason = interrupts(item, rules, now, context, held?.until ?? item.since);
    if (reason === null) return item;
    const holding = held !== null && sent === undefined && now < held.until;
    const delivery: DeskInterrupt["delivery"] = holding ? "held" : rules.transport === "none" ? "off" : sent?.status ?? "pending";
    const feedback = context.feedback.get(item.key);
    return { ...item, interrupt: { delivery, reason, ...(held ? { held } : {}), ...(feedback ? { feedback } : {}) } };
  });
}

interface Row {
  item_key: string;
  transport: string;
  status: Delivery["status"];
  error: string | null;
  ref: string | null;
  created_at: number;
}

export function readDeliveries(db: Database): Map<string, Delivery> {
  const rows = db.query<Row, []>("SELECT item_key, transport, status, error, ref, created_at FROM desk_deliveries").all();
  return new Map(rows.map((r) => [r.item_key, { key: r.item_key, transport: r.transport, status: r.status, error: r.error, ref: r.ref, createdAt: r.created_at }]));
}

const waitedSentence = (arrived: number, held: MeetingHold): string => `It arrived at ${clock(arrived)} during "${held.title}" and waited until the meeting ended.`;

export function toPush(item: DeskItem): DeskPush {
  const primary = item.actions.find((a) => a.role === "primary" && a.url);
  const reason = item.interrupt?.reason;
  const held = item.interrupt?.held;
  const why = held && item.since !== undefined ? `${item.why} ${waitedSentence(item.since, held)}` : item.why;
  return { key: item.key, title: item.title, why, ...(primary?.url ? { action: { label: primary.label, url: primary.url } } : {}), ...(reason ? { reason } : {}), ...(held ? { held } : {}) };
}

async function sendSafely(transport: DeskTransport, push: DeskPush): Promise<PushResult> {
  try {
    return await transport.send(push);
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function pushInterrupts(
  db: Database,
  items: DeskItem[],
  transportId: TransportId,
  transport: DeskTransport | null,
  now: number,
): Promise<PushOutcome[]> {
  db.query("DELETE FROM desk_deliveries WHERE created_at < ?").run(now - KEEP_MS);
  const results: PushOutcome[] = [];
  if (transportId === "none") return results;
  for (const item of items) {
    if (item.interrupt?.delivery !== "pending") continue;
    const claimed = db
      .query("INSERT INTO desk_deliveries (item_key, transport, status, title, created_at, updated_at) VALUES (?, ?, 'sending', ?, ?, ?) ON CONFLICT(item_key) DO NOTHING")
      .run(item.key, transportId, item.title, now, now).changes > 0;
    if (!claimed) continue;
    const result: PushResult = transport ? await sendSafely(transport, toPush(item)) : { status: "failed", error: `No ${transportId} transport is running on this stack.` };
    db.query("UPDATE desk_deliveries SET status = ?, error = ?, ref = ?, updated_at = ? WHERE item_key = ?").run(
      result.status,
      result.status === "failed" ? result.error : null,
      result.status === "sent" ? result.ref ?? null : null,
      Date.now(),
      item.key,
    );
    results.push({ key: item.key, status: result.status });
  }
  return results;
}

export interface InterruptLoop {
  tick(): Promise<void>;
  stop(): void;
}

export function startInterruptLoop(everyMs: number, tick: () => Promise<void>, log: (message: string) => void = console.error): InterruptLoop {
  let running = false;
  const guarded = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      log(`desk: interruption tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void guarded(), everyMs);
  return {
    tick: guarded,
    stop: () => {
      clearInterval(timer);
    },
  };
}
