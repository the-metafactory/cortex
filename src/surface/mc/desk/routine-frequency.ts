import type { RoutineOptions, RoutineRunner } from "./routine-command";
import { ROUTINE_FREQUENCY_LOOKAHEAD_MS, maxStartsInWindow, type RoutineFrequency } from "./routine-display-contract";
import { readRoutineOccurrences } from "./routine-occurrences";

const maxPages = 20;
export interface FrequencyRead { frequency: RoutineFrequency; maxDailyStarts: Map<string, number> }

export async function readRoutineFrequency(options: RoutineOptions, scope: { principal: string; stack: string }, now: number, run?: RoutineRunner): Promise<FrequencyRead> {
  const start = new Date(now).toISOString(); const end = new Date(now + ROUTINE_FREQUENCY_LOOKAHEAD_MS).toISOString();
  const unknown = (reason: string): FrequencyRead => ({ frequency: { status: "unknown", start, end, reason }, maxDailyStarts: new Map() });
  const starts = new Map<string, number[]>(); const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < maxPages; page++) {
      const result = await readRoutineOccurrences(options, { start, end, timezone: "UTC", limit: 1000, cursor }, scope, run);
      for (const occurrence of result.occurrences) { const list = starts.get(occurrence.routineId) ?? []; list.push(Date.parse(occurrence.scheduledFor)); starts.set(occurrence.routineId, list); }
      if (result.complete) return { frequency: { status: "known", start, end }, maxDailyStarts: new Map([...starts].map(([id, times]) => [id, maxStartsInWindow(times)])) };
      const next = result.nextCursor;
      if (!next || cursors.has(next)) return unknown("The routine owner repeated a page of planned starts.");
      cursor = next; cursors.add(next);
    }
  } catch {
    return unknown("The routine owner could not list the planned starts for the next 7 days.");
  }
  return unknown("The planned starts for the next 7 days exceed the read limit, so the list is incomplete.");
}
