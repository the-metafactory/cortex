import type { Database } from "bun:sqlite";
import { clock } from "./time";
import type { DeskAction, DeskEvent, DeskInterrupt, DeskItem } from "./types";

export const TRANSPORTS = ["none", "discord"] as const;
export type TransportId = (typeof TRANSPORTS)[number];

export interface InterruptRules {
  transport: TransportId;
  meetingMinutes: number;
  mail: boolean;
  reminders: boolean;
  maxAgeMinutes: number;
  everySeconds: number;
  chime: boolean;
}

export const NO_INTERRUPTIONS: InterruptRules = {
  transport: "none",
  meetingMinutes: 0,
  mail: false,
  reminders: false,
  maxAgeMinutes: 60,
  everySeconds: 60,
  chime: false,
};

export interface DeskPush {
  key: string;
  title: string;
  why: string;
  action?: { label: string; url: string };
}

export type PushResult = { ok: true; ref?: string } | { ok: false; error: string };

export interface DeskTransport {
  id: TransportId;
  send(push: DeskPush): Promise<PushResult>;
}

export interface Delivery {
  key: string;
  transport: string;
  status: "sending" | "sent" | "failed";
  error: string | null;
  ref: string | null;
  createdAt: number;
}

const MINUTE = 60_000;
const KEEP_MS = 7 * 86_400_000;

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

export function interrupts(item: DeskItem, rules: InterruptRules, now: number): boolean {
  const fresh = item.since !== undefined && now - item.since <= rules.maxAgeMinutes * MINUTE;
  if (item.kind === "meeting") return rules.meetingMinutes > 0;
  if (item.kind === "reminder") return rules.reminders && fresh;
  if (item.kind === "mail") return rules.mail && item.urgency !== "waiting" && fresh;
  return false;
}

export function markInterrupts(items: DeskItem[], rules: InterruptRules, deliveries: ReadonlyMap<string, Delivery>, now: number): DeskItem[] {
  return items.map((item) => {
    const sent = deliveries.get(item.key);
    if (sent?.status === "failed") {
      const interrupt: DeskInterrupt = { delivery: "failed", error: sent.error ?? "The transport gave no reason." };
      return { ...item, urgency: "now", score: Math.max(item.score, 99), interrupt };
    }
    if (!interrupts(item, rules, now)) return item;
    const delivery: DeskInterrupt["delivery"] = rules.transport === "none" ? "off" : sent?.status ?? "pending";
    return { ...item, interrupt: { delivery } };
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

export function toPush(item: DeskItem): DeskPush {
  const primary = item.actions.find((a) => a.role === "primary" && a.url);
  return { key: item.key, title: item.title, why: item.why, ...(primary?.url ? { action: { label: primary.label, url: primary.url } } : {}) };
}

async function sendSafely(transport: DeskTransport, push: DeskPush): Promise<PushResult> {
  try {
    return await transport.send(push);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function pushInterrupts(
  db: Database,
  items: DeskItem[],
  transportId: TransportId,
  transport: DeskTransport | null,
  now: number,
): Promise<{ key: string; ok: boolean }[]> {
  db.query("DELETE FROM desk_deliveries WHERE created_at < ?").run(now - KEEP_MS);
  const results: { key: string; ok: boolean }[] = [];
  if (transportId === "none") return results;
  for (const item of items) {
    if (item.interrupt?.delivery !== "pending") continue;
    const claimed = db
      .query("INSERT INTO desk_deliveries (item_key, transport, status, title, created_at, updated_at) VALUES (?, ?, 'sending', ?, ?, ?) ON CONFLICT(item_key) DO NOTHING")
      .run(item.key, transportId, item.title, now, now).changes > 0;
    if (!claimed) continue;
    const result = transport ? await sendSafely(transport, toPush(item)) : { ok: false as const, error: `No ${transportId} transport is running on this stack.` };
    db.query("UPDATE desk_deliveries SET status = ?, error = ?, ref = ?, updated_at = ? WHERE item_key = ?").run(
      result.ok ? "sent" : "failed",
      result.ok ? null : result.error,
      result.ok ? result.ref ?? null : null,
      Date.now(),
      item.key,
    );
    results.push({ key: item.key, ok: result.ok });
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
