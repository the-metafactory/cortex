export const SNOOZE_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_snoozes (
    message_id TEXT PRIMARY KEY,
    source_id TEXT,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    kind TEXT NOT NULL,
    until_at INTEGER,
    event_key TEXT,
    event_title TEXT,
    event_start INTEGER,
    person TEXT,
    person_name TEXT,
    label TEXT NOT NULL,
    state TEXT NOT NULL,
    back_at INTEGER,
    reason TEXT,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_snoozes_state ON desk_mail_snoozes (state, created_at)",
];

export const SNOOZE_TIMES = ["later", "tomorrow", "next-week"] as const;
export type SnoozeTime = (typeof SNOOZE_TIMES)[number];

export type SnoozeChoice =
  | { kind: SnoozeTime }
  | { kind: "date"; date: string }
  | { kind: "meeting"; event: string }
  | { kind: "person"; address: string };

export const SNOOZE_MORNING_HOUR = 8;
const LATER_HOURS = 3;
const QUARTER_MS = 15 * 60_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const morningOf = (d: Date): number => {
  d.setHours(SNOOZE_MORNING_HOUR, 0, 0, 0);
  return d.getTime();
};

/** When a time snooze ends: later today is three hours on (next quarter hour), tomorrow and next week (Monday) are 08:00, a date is 08:00 that day. Null for a date that is not a calendar date. */
export function snoozeAt(choice: { kind: SnoozeTime } | { kind: "date"; date: string }, now: number): number | null {
  if (choice.kind === "later") return Math.ceil((now + LATER_HOURS * 3_600_000) / QUARTER_MS) * QUARTER_MS;
  const d = new Date(now);
  if (choice.kind === "tomorrow") {
    d.setDate(d.getDate() + 1);
    return morningOf(d);
  }
  if (choice.kind === "next-week") {
    d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
    return morningOf(d);
  }
  if (!("date" in choice)) return null;
  const m = DATE_RE.exec(choice.date);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return morningOf(date);
}

const hhmm = (at: number): string => new Date(at).toTimeString().slice(0, 5);

/** A local time said the way the Desk says it: today, tomorrow, a weekday within the week, else the date. */
export function snoozeWhen(at: number, now: number): string {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days === 0) return `today at ${hhmm(at)}`;
  if (days === 1) return `tomorrow at ${hhmm(at)}`;
  const d = new Date(at);
  if (days > 1 && days < 7) return `${d.toLocaleDateString("en-GB", { weekday: "long" })} at ${hhmm(at)}`;
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} at ${hhmm(at)}`;
}
