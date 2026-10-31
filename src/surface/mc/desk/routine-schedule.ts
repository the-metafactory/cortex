export interface RoutineSchedule {
  expression: string;
  words: string;
  request: string;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function routineRequest(text: string): boolean {
  return /\bevery\s+(?:\d+\s+)?(?:minutes?|hours?|day|morning|evening|weekdays?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text);
}

export function routineSchedule(text: string): RoutineSchedule | string {
  const match = /^every\s+(?:(?<count>\d+)\s+)?(?<unit>minutes?|hours?|day|morning|evening|weekdays?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<ampm>am|pm)?)?\s*[,;:]?\s+(?<request>.+)$/i.exec(text.trim());
  if (!match?.groups) return "Start with a schedule such as ‘every Friday at 17:00, …’ or ‘every minute, …’.";
  const { unit = "", count, hour, minute = "0", ampm, request = "" } = match.groups;
  const u = unit.toLowerCase();
  const n = Number(count ?? 1);
  if (/^(minute|hour)/.test(u)) {
    const max = u.startsWith("minute") ? 59 : 23;
    if (!Number.isInteger(n) || n < 1 || n > max || hour) return "Choose a minute or hour interval within one day.";
    const expression = u.startsWith("minute") ? `*/${n} * * * *` : `0 */${n} * * *`;
    return { expression, words: `Every ${n === 1 ? u.replace(/s$/, "") : `${n} ${u.replace(/s$/, "")}s`}`, request };
  }
  if (count || hour === undefined) return "Include a time, for example ‘every Friday at 17:00, …’.";
  let h = Number(hour);
  const m = Number(minute);
  if (ampm && (h < 1 || h > 12)) return "Use a valid time for this routine.";
  if (ampm?.toLowerCase() === "pm" && h < 12) h += 12;
  if (ampm?.toLowerCase() === "am" && h === 12) h = 0;
  if (h > 23 || m > 59) return "Use a valid time for this routine.";
  const day = DAYS.indexOf(u);
  const weekday = u.startsWith("weekday");
  return {
    expression: `${m} ${h} * * ${day >= 0 ? day : weekday ? "1-5" : "*"}`,
    words: `Every ${day >= 0 ? u.charAt(0).toUpperCase() + u.slice(1) : weekday ? "weekday" : "day"} at ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
    request,
  };
}
