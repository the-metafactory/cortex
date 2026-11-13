import type { Database } from "bun:sqlite";
import { DAY_MS } from "./time";
import { INTERRUPT_REASON_CODES, type InterruptFeedback, type InterruptReasonCode, type InterruptReasonView } from "./types";
import type { InterruptRules } from "./interrupt";
import { removeSender, type DeskVip } from "./vips";

export const INTERRUPT_SWITCHES_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_interrupt_switches (
    code TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    "on" INTEGER NOT NULL,
    set_by TEXT NOT NULL CHECK(set_by IN ('switch','feedback')),
    changed_at INTEGER NOT NULL,
    PRIMARY KEY (code, target)
  )`,
  `CREATE TABLE IF NOT EXISTS desk_interrupt_feedback (
    item_key TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    important INTEGER NOT NULL,
    at INTEGER NOT NULL
  )`,
];

const FEEDBACK_KEEP_MS = 30 * DAY_MS;

export const isReasonCode = (value: unknown): value is InterruptReasonCode => INTERRUPT_REASON_CODES.includes(value as InterruptReasonCode);

export const isMailReason = (code: InterruptReasonCode): boolean => code.startsWith("mail.");

export const PER_VIP: InterruptReasonCode = "mail.vip";

export interface InterruptSwitch {
  on: boolean;
  setBy: "switch" | "feedback";
  changedAt: number;
}

export type InterruptSwitches = ReadonlyMap<string, InterruptSwitch>;

export const switchKey = (code: InterruptReasonCode, target = ""): string => `${code}|${target}`;

interface SwitchRow {
  code: InterruptReasonCode;
  target: string;
  on: number;
  set_by: InterruptSwitch["setBy"];
  changed_at: number;
}

export function readSwitches(db: Database): Map<string, InterruptSwitch> {
  const rows = db.query<SwitchRow, []>(`SELECT code, target, "on", set_by, changed_at FROM desk_interrupt_switches`).all();
  return new Map(rows.map((r) => [switchKey(r.code, r.target), { on: r.on === 1, setBy: r.set_by, changedAt: r.changed_at }]));
}

export function reasonDefault(rules: InterruptRules, code: InterruptReasonCode): boolean {
  if (code === "meeting.soon") return rules.meetingMinutes > 0;
  if (code === "reminder.due") return rules.reminders;
  return true;
}

export function reasonAvailable(rules: InterruptRules, code: InterruptReasonCode): boolean {
  if (code === "meeting.soon") return rules.meetingMinutes > 0;
  return !isMailReason(code) || rules.mail;
}

export function reasonOn(rules: InterruptRules, switches: InterruptSwitches, code: InterruptReasonCode, target?: string): boolean {
  if (!reasonAvailable(rules, code)) return false;
  return switches.get(switchKey(code, target))?.on ?? reasonDefault(rules, code);
}

const LABELS: Record<InterruptReasonCode, string> = {
  "meeting.soon": "A meeting is about to start",
  "reminder.due": "A reminder is due",
  "mail.meeting-today": "Mail about a meeting later today",
  "mail.deadline-today": "Mail with a deadline today",
  "mail.vip": "Mail from a VIP",
  "mail.ranked": "Other mail ranked for today",
};

export function reasonLabel(code: InterruptReasonCode, vip?: Pick<DeskVip, "address" | "label">): string {
  return vip ? `Mail from ${vip.label ?? vip.address}` : LABELS[code];
}

export function listReasons(rules: InterruptRules, switches: InterruptSwitches, vips: readonly Pick<DeskVip, "address" | "label">[], deskOn: boolean): InterruptReasonView[] {
  const view = (code: InterruptReasonCode, vip?: Pick<DeskVip, "address" | "label">): InterruptReasonView => {
    const stored = switches.get(switchKey(code, vip?.address));
    return {
      code,
      ...(vip ? { target: vip.address } : {}),
      label: reasonLabel(code, vip),
      on: stored?.on ?? reasonDefault(rules, code),
      available: deskOn && reasonAvailable(rules, code),
      setBy: stored?.setBy ?? "default",
      ...(stored ? { changedAt: stored.changedAt } : {}),
    };
  };
  return INTERRUPT_REASON_CODES.flatMap((code) => (code === PER_VIP ? vips.map((vip) => view(code, vip)) : [view(code)]));
}

export interface SwitchChange {
  code: InterruptReasonCode;
  target: string;
  on: boolean;
  setBy: InterruptSwitch["setBy"];
}

export function setSwitch(db: Database, rules: InterruptRules, { code, target, on, setBy }: SwitchChange, now: number): void {
  if (setBy === "switch" && on === reasonDefault(rules, code)) {
    clearSwitch(db, code, target);
    return;
  }
  db.query(`INSERT INTO desk_interrupt_switches (code, target, "on", set_by, changed_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(code, target) DO UPDATE SET "on" = excluded."on", set_by = excluded.set_by, changed_at = excluded.changed_at`)
    .run(code, target, on ? 1 : 0, setBy, now);
}

export function clearSwitch(db: Database, code: InterruptReasonCode, target: string): void {
  db.query("DELETE FROM desk_interrupt_switches WHERE code = ? AND target = ?").run(code, target);
}

export interface FeedbackAnswer {
  key: string;
  code: InterruptReasonCode;
  target: string;
  important: boolean;
}

const pruneFeedback = (db: Database, now: number): void => {
  db.query("DELETE FROM desk_interrupt_feedback WHERE at < ?").run(now - FEEDBACK_KEEP_MS);
};

/**
 * Records the answer to "Was that important enough?". A "no" switches the reason off; a later answer for the
 * same item replaces the earlier one, and the switch follows it unless the person switched it away from its default by hand since.
 */
export function recordFeedback(db: Database, rules: InterruptRules, answer: FeedbackAnswer, now: number): void {
  db.transaction(() => {
    pruneFeedback(db, now);
    const previous = db.query<{ important: number; at: number }, [string]>("SELECT important, at FROM desk_interrupt_feedback WHERE item_key = ?").get(answer.key);
    db.query(`INSERT INTO desk_interrupt_feedback (item_key, code, target, important, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET code = excluded.code, target = excluded.target, important = excluded.important, at = excluded.at`)
      .run(answer.key, answer.code, answer.target, answer.important ? 1 : 0, now);
    const current = readSwitches(db).get(switchKey(answer.code, answer.target));
    const switchedByHandSince = previous !== null && current?.setBy === "switch" && current.changedAt > previous.at;
    if (switchedByHandSince) return;
    if (!answer.important) setSwitch(db, rules, { code: answer.code, target: answer.target, on: false, setBy: "feedback" }, now);
    else if (previous?.important === 0 && current?.setBy === "feedback") clearSwitch(db, answer.code, answer.target);
  })();
}

export function readFeedback(db: Database, now: number): Map<string, InterruptFeedback> {
  const rows = db.query<{ item_key: string; important: number }, [number]>("SELECT item_key, important FROM desk_interrupt_feedback WHERE at >= ?").all(now - FEEDBACK_KEEP_MS);
  return new Map(rows.map((r) => [r.item_key, r.important === 1 ? "yes" : "no"]));
}

/** Removes a VIP and the switch kept for their mail. */
export function removeVipWithSwitch(db: Database, address: string): boolean {
  const removed = removeSender(db, "vips", address);
  if (removed) clearSwitch(db, PER_VIP, address);
  return removed;
}
