import { z } from "zod";

const KEY = "desk.studio.foreground.v1";
const MeasurementSchema = z.object({
  timeZone: z.string().min(1),
  startedAt: z.number().finite().positive(),
  updatedAt: z.number().finite().positive(),
  days: z.record(z.iso.date(), z.number().finite().min(0).max(90_000_000)),
});
export type StudioMeasurement = z.infer<typeof MeasurementSchema>;
export type ForegroundReading = { kind: "recorded"; measurement: StudioMeasurement } | { kind: "unavailable"; reason: string };
interface BrowserStore { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface Sample { at: number; monotonic: number; active: boolean }
function dateKey(timeZone: string): (at: number) => string {
  const formatter = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return at => {
    const parts = formatter.formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(p => p.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
}
function addInterval(measurement: StudioMeasurement, from: number, through: number, keyAt: (at: number) => string): void {
  let cursor = from;
  while (cursor < through) {
    const key = keyAt(cursor);
    let end = through;
    if (keyAt(through - 1) !== key) {
      let low = cursor;
      let high = through;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (keyAt(middle) === key) low = middle;
        else high = middle;
      }
      end = high;
    }
    measurement.days[key] = (measurement.days[key] ?? 0) + end - cursor;
    cursor = end;
  }
  measurement.updatedAt = through;
}
export class StudioForegroundClock {
  private previous: Sample | null = null;
  private readonly keyAt: ((at: number) => string) | null;
  constructor(private readonly store: BrowserStore | null, private readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    try { this.keyAt = dateKey(timeZone); }
    catch { this.keyAt = null; }
  }
  read(): ForegroundReading {
    if (!this.keyAt) return { kind: "unavailable", reason: "The Desk week timezone is unavailable." };
    if (!this.store) return { kind: "unavailable", reason: "Browser storage is unavailable." };
    try {
      const text = this.store.getItem(KEY);
      if (text === null) return { kind: "unavailable", reason: "Foreground Studio time has not been measured in this browser yet." };
      const raw: unknown = JSON.parse(text);
      const parsed = MeasurementSchema.safeParse(raw);
      if (!parsed.success || parsed.data.updatedAt < parsed.data.startedAt) return { kind: "unavailable", reason: "The browser's Studio time record could not be read." };
      if (parsed.data.timeZone !== this.timeZone) return { kind: "unavailable", reason: "The saved Studio time uses a different Desk timezone. Earlier buckets cannot be reassigned." };
      return { kind: "recorded", measurement: parsed.data };
    } catch {
      return { kind: "unavailable", reason: "Browser storage is unavailable or unreadable." };
    }
  }
  sample(next: Sample): ForegroundReading {
    const previous = this.previous;
    this.previous = next;
    let reading = this.read();
    if (!this.store || !this.keyAt) return reading;
    try {
      if (reading.kind === "unavailable" && this.store.getItem(KEY) === null && next.active) {
        reading = { kind: "recorded", measurement: { timeZone: this.timeZone, startedAt: next.at, updatedAt: next.at, days: {} } };
        this.store.setItem(KEY, JSON.stringify(reading.measurement));
      }
      if (reading.kind !== "recorded" || !previous?.active) return reading;
      const elapsed = next.monotonic - previous.monotonic;
      const wallElapsed = next.at - previous.at;
      if (elapsed <= 0 || wallElapsed <= 0 || elapsed > 10_000 || Math.abs(wallElapsed - elapsed) > 1000 || previous.at < reading.measurement.startedAt) return reading;
      addInterval(reading.measurement, previous.at, next.at, this.keyAt);
      this.store.setItem(KEY, JSON.stringify(reading.measurement));
      return reading;
    } catch {
      return { kind: "unavailable", reason: "Foreground Studio time could not be saved in this browser." };
    }
  }
}
export function foregroundForWeek(reading: ForegroundReading, week: { from: string; through: string; timeZone?: string }): number | null {
  if (reading.kind !== "recorded" || (week.timeZone && reading.measurement.timeZone !== week.timeZone)) return null;
  try { if (dateKey(reading.measurement.timeZone)(reading.measurement.startedAt) > week.through) return null; }
  catch { return null; }
  return Object.entries(reading.measurement.days).filter(([day]) => day >= week.from && day <= week.through).reduce((sum, [, ms]) => sum + ms, 0);
}
