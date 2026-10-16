import type { Database } from "bun:sqlite";
import { getVigilTextsSpent } from "./db";

export const VIGIL_DAILY_TEXT_LIMIT = 3;

const zurichClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function localParts(now: number | Date): { year: number; month: number; day: number; hour: number } {
  const parts = zurichClock.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) throw new Error(`vigil budget clock: Intl omitted the ${type} part`);
    return Number(value);
  };
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour") };
}

/** Zurich calendar day whose budget began at 07:00, independent of host TZ. */
export function budgetDay(now: number | Date): string {
  const { year, month, day, hour } = localParts(now);
  // Calendar arithmetic on the local date, not 24 hours subtracted from the
  // instant: Zurich days can be 23 or 25 hours long at DST changes.
  return new Date(Date.UTC(year, month - 1, day - (hour < 7 ? 1 : 0))).toISOString().slice(0, 10);
}

/** Quiet from 22:00 inclusive until 07:00 exclusive, Europe/Zurich. */
export function inQuietHours(now: number | Date): boolean {
  const { hour } = localParts(now);
  return hour >= 22 || hour < 7;
}

/** Read-only eligibility. Callers inject their clock's current instant. */
export function canSendVigilText(db: Database, now: number | Date): boolean {
  return !inQuietHours(now) && getVigilTextsSpent(db, budgetDay(now)) < VIGIL_DAILY_TEXT_LIMIT;
}
