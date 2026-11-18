import type { Database } from "bun:sqlite";
import { URGENT_NOW_REASON, backLine, resolveSnoozeChoice, wakeOf, type SnoozeChoice, type SnoozeEvent, type SnoozeRow, type WakeFacts } from "./mail-snooze";
import { snoozeWhen } from "./mail-snooze-schema";
import type { SnoozeResult as WireSnoozeResult } from "../../../desk-api/wire/mail";
import { DAY_MS } from "./time";
import type { DeferredItem, DeskItem, DeskItemKind } from "./types";

export const DEFERRABLE_ITEM_KINDS = ["reminder", "decision", "grilling", "mail-rule", "dmarc", "mail-waiting", "mail-handoff"] as const satisfies readonly DeskItemKind[];

const ENDS_BY_ITSELF = "a meeting ends by itself";
const ALARM_STAYS = "an alarm stays on the Desk";
const REFUSAL_REASONS: Partial<Record<DeskItemKind, string>> = {
  meeting: ENDS_BY_ITSELF,
  "agent-failed": ALARM_STAYS,
  "agent-blocked": ALARM_STAYS,
  escalation: ALARM_STAYS,
  sensor: ALARM_STAYS,
  adapter: ALARM_STAYS,
  goal: ALARM_STAYS,
};

export const isRefusedKind = (kind: string): boolean => kind in REFUSAL_REASONS;

export const isDeferrableKind = (kind: DeskItemKind): boolean => (DEFERRABLE_ITEM_KINDS as readonly string[]).includes(kind);

/** Why the Desk will not put an item of this kind away. A kind that is neither accepted nor listed is refused until someone adds it to the allowlist. */
export function deferRefusal(kind: string): string {
  return `The Desk cannot defer an item of kind ${kind}: ${REFUSAL_REASONS[kind as DeskItemKind] ?? "only work items can wait"}.`;
}

export const ONLY_MAIL_WAITS_FOR_A_PERSON = "Only mail can wait for a person.";

const BACK_KEEP_DAYS = 14;
const BACK_SHOWN_MS = DAY_MS;
const DEFER_KEEP_DAYS = 400;

type DeferWait = "time" | "meeting";
type DeferState = "snoozed" | "back";

interface Raw {
  item_key: string;
  kind: string;
  title: string;
  wait: DeferWait;
  until_at: number | null;
  event_key: string | null;
  event_title: string | null;
  event_start: number | null;
  label: string;
  state: DeferState;
  back_at: number | null;
  reason: string | null;
  created_at: number;
  urgent_at_defer: number;
}

const wakeRowOf = (r: Raw): SnoozeRow => ({
  messageId: r.item_key, sourceId: null, sender: "", subject: r.title, kind: r.wait, untilAt: r.until_at,
  eventKey: r.event_key, eventTitle: r.event_title, eventStart: r.event_start, person: null, personName: null,
  label: r.label, state: r.state, backAt: r.back_at, reason: r.reason, createdAt: r.created_at,
});

const readRows = (db: Database, state: DeferState): Raw[] => db.query<Raw, [string]>("SELECT * FROM desk_item_defers WHERE state = ? ORDER BY created_at").all(state);

function readItemDefer(db: Database, key: string): Raw | null {
  return db.query<Raw, [string]>("SELECT * FROM desk_item_defers WHERE item_key = ?").get(key);
}

type DeferResult = WireSnoozeResult | { ok: false; status: number; error: string };

export function deferItem(db: Database, item: DeskItem, choice: Exclude<SnoozeChoice, { kind: "person" }>, ctx: { now: number; events: ReadonlyMap<string, SnoozeEvent> }): DeferResult {
  const resolved = resolveSnoozeChoice(choice, { now: ctx.now, events: ctx.events, names: new Map() });
  if (typeof resolved === "string") return { ok: false, status: 409, error: resolved };
  const wait: DeferWait = resolved.kind === "meeting" ? "meeting" : "time";
  db.query(
    `INSERT INTO desk_item_defers (item_key, kind, title, wait, until_at, event_key, event_title, event_start, label, state, back_at, reason, created_at, urgent_at_defer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'snoozed', NULL, NULL, ?, ?)
     ON CONFLICT(item_key) DO UPDATE SET kind = excluded.kind, title = excluded.title, wait = excluded.wait, until_at = excluded.until_at, event_key = excluded.event_key,
       event_title = excluded.event_title, event_start = excluded.event_start, label = excluded.label, state = 'snoozed', back_at = NULL, reason = NULL, created_at = excluded.created_at, urgent_at_defer = excluded.urgent_at_defer`,
  ).run(item.key, item.kind, item.title.slice(0, 300), wait, resolved.untilAt, resolved.eventKey, resolved.eventTitle, resolved.eventStart, resolved.label, ctx.now, item.urgency === "now" ? 1 : 0);
  return { ok: true, message: `Put away “${item.title}” ${resolved.label}.`, until: resolved.label, untilIso: resolved.untilAt === null ? null : new Date(resolved.untilAt).toISOString() };
}

/** Ends a deferral now: the item is back as it was, without a reason line. Null when the key is not deferred. */
export function cancelItemDefer(db: Database, key: string): { message: string } | null {
  const row = readItemDefer(db, key);
  if (row?.state !== "snoozed") return null;
  db.query("DELETE FROM desk_item_defers WHERE item_key = ?").run(key);
  return { message: `“${row.title}” is back on the Desk.` };
}

function wakeItemDefers(db: Database, facts: WakeFacts, produced: ReadonlySet<string>, unreadable: ReadonlySet<DeskItemKind>, now: number): void {
  db.transaction(() => {
    for (const row of readRows(db, "snoozed")) {
      const decision = wakeOf(wakeRowOf(row), row.urgent_at_defer === 1 ? { ...facts, urgentNow: new Set() } : facts, now, row.item_key);
      if (decision.kind === "back") db.query("UPDATE desk_item_defers SET state = 'back', back_at = ?, reason = ? WHERE item_key = ? AND state = 'snoozed'").run(now, decision.reason, row.item_key);
      else if (decision.kind === "moved") db.query("UPDATE desk_item_defers SET event_title = ?, event_start = ?, until_at = ?, label = ? WHERE item_key = ?").run(decision.event.title, decision.event.at, decision.event.end, `until “${decision.event.title}” ends`, row.item_key);
    }
    for (const row of db.query<{ item_key: string; kind: string }, []>("SELECT item_key, kind FROM desk_item_defers").all()) {
      if (!produced.has(row.item_key) && !unreadable.has(row.kind as DeskItemKind)) db.query("DELETE FROM desk_item_defers WHERE item_key = ?").run(row.item_key);
    }
    db.query("DELETE FROM desk_item_defers WHERE state = 'back' AND back_at < ?").run(now - BACK_KEEP_DAYS * DAY_MS);
    db.query("DELETE FROM desk_item_defers WHERE created_at < ?").run(now - DEFER_KEEP_DAYS * DAY_MS);
  })();
}

/** Applies deferrals to the produced items (a deferral whose kind is in `unreadable` survives an absent item, since its source failed to answer): a waiting item leaves, a returned one leads with why for a day at urgency today or higher, and is an interruption only when it returned because it is rated urgency now. */
export function applyItemDefers(db: Database, items: DeskItem[], facts: WakeFacts, now: number, unreadable: ReadonlySet<DeskItemKind> = new Set()): DeskItem[] {
  const produced = new Set(items.map((item) => item.key));
  const rated: WakeFacts = { ...facts, urgentNow: new Set([...facts.urgentNow, ...items.filter((item) => item.urgency === "now").map((item) => item.key)]) };
  wakeItemDefers(db, rated, produced, unreadable, now);
  const waiting = new Set(readRows(db, "snoozed").map((r) => r.item_key));
  const back = new Map(readRows(db, "back").flatMap((r): [string, { line: string; at: number }][] => (r.back_at !== null && now - r.back_at < BACK_SHOWN_MS ? [[r.item_key, { line: backLine(wakeRowOf(r), now), at: r.back_at }]] : [])));
  const urgentReturns = new Set(readRows(db, "back").filter((r) => r.reason === URGENT_NOW_REASON).map((r) => r.item_key));
  return items.filter((item) => !waiting.has(item.key)).map((item) => {
    const returned = back.get(item.key);
    if (!returned) return item;
    if (item.urgency === "now" && urgentReturns.has(item.key)) return { ...item, why: `${returned.line} ${item.why}`, back: returned };
    const { interrupt: _interrupt, interruptRequested: _requested, ...rest } = item;
    return { ...rest, urgency: "today", why: `${returned.line} ${item.why}`, back: returned };
  });
}

export function deferredItems(db: Database, now: number): DeferredItem[] {
  return readRows(db, "snoozed")
    .sort((a, b) => (a.until_at ?? Infinity) - (b.until_at ?? Infinity) || a.created_at - b.created_at)
    .map((row) => ({ key: row.item_key, title: row.title, until: row.wait === "time" && row.until_at !== null ? `until ${snoozeWhen(row.until_at, now)}` : row.label }));
}
