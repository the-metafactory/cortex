import { reflexCommand, type RoutineOptions, type RoutineRunner } from "./routine-command";
import { createRoutineOccurrencePageSchema, RoutineOccurrenceQuerySchema, type RoutineOccurrencePage, type RoutineOccurrenceQuery } from "./routine-occurrence-contract";
export * from "./routine-occurrence-contract";

export async function readRoutineOccurrences(options: RoutineOptions, input: RoutineOccurrenceQuery, scope: { principal: string; stack: string }, run?: RoutineRunner): Promise<RoutineOccurrencePage> {
  const query = RoutineOccurrenceQuerySchema.parse(input);
  const page = await reflexCommand({ ...options, timeoutSeconds: options.readTimeoutSeconds }, [
    "routine", "occurrences", "--principal", scope.principal, "--stack", scope.stack, "--start", query.start, "--end", query.end, "--timezone", query.timezone,
    "--limit", String(query.limit), ...(query.cursor ? ["--cursor", query.cursor] : []),
  ], createRoutineOccurrencePageSchema(), run);
  const records = page.occurrences;
  const active = records.filter((r) => r.lifecycle === "active").length;
  const disabled = records.filter((r) => r.lifecycle !== "active").length;
  if (page.principal !== scope.principal || page.stack !== scope.stack || page.start !== query.start || page.end !== query.end || page.timezone !== query.timezone || records.length > query.limit || page.complete !== (page.nextCursor === null) || (!page.complete && !records.length) || page.counts.total !== records.length || page.counts.active !== active || page.counts.disabled !== disabled) throw new Error("The routine owner returned an inconsistent calendar page.");
  const seen = new Set<string>();
  let previous = "";
  for (const record of records) {
    const time = Date.parse(record.scheduledFor);
    const key = `${new Date(time).toISOString()}\0${record.routineId}`;
    if (time < Date.parse(query.start) || time >= Date.parse(query.end) || seen.has(key) || key < previous || (record.readOnly && Object.values(record.capabilities).some(Boolean))) throw new Error("The routine owner returned an invalid calendar occurrence.");
    seen.add(key);
    previous = key;
  }
  return page;
}
