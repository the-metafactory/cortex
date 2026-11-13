import { DAY_MS, startOfDay } from "./time";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export type DeadlineSource = "source" | "classifier";

/** The local day a deadline falls on (its midnight), or null when the value is neither a date nor a date-time with an offset. */
export function deadlineDay(dueAt: string): number | null {
  const date = DATE_ONLY.exec(dueAt);
  if (date) {
    const day = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime();
    return Number.isFinite(day) ? day : null;
  }
  const at = Date.parse(dueAt);
  return Number.isFinite(at) ? startOfDay(at) : null;
}

export const isDeadlineForm = (value: unknown): value is string => typeof value === "string" && (DATE_ONLY.test(value) || DATE_TIME.test(value)) && deadlineDay(value) !== null;

export const deadlineToday = (dueAt: string | undefined, now: number): boolean => dueAt !== undefined && deadlineDay(dueAt) === startOfDay(now);

const MAX_BEFORE_RECEIVED_MS = DAY_MS;
const MAX_AFTER_RECEIVED_MS = 365 * DAY_MS;

/** A deadline the classifier read from the mail, kept only when it parses and lies near the mail's arrival. */
export function classifierDeadline(value: unknown, receivedAt: string): string | undefined {
  if (!isDeadlineForm(value)) return undefined;
  const at = Date.parse(value);
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(at) || !Number.isFinite(received)) return undefined;
  return at >= received - MAX_BEFORE_RECEIVED_MS && at <= received + MAX_AFTER_RECEIVED_MS ? value : undefined;
}

const dayLabel = (day: number): string => new Date(day).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

export function deadlineLine(dueAt: string, from: DeadlineSource): string | null {
  const day = deadlineDay(dueAt);
  if (day === null) return null;
  return from === "source" ? `The mail is flagged due ${dayLabel(day)}.` : `The mail asks for this by ${dayLabel(day)}.`;
}
