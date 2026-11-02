import { displayEntry, resolveDisplay, RoutineDisplayPageSchema, RoutineDisplayResultSchema, type RoutineDisplayChange, type RoutineDisplayChoice, type RoutineDisplayEntry, type RoutineFrequency, type RoutineDisplayResult } from "../../desk/routine-display-contract";
import { getJson, postJson } from "./api";

export interface DisplayScope { principal: string; stack: string }
export interface DisplayPreferences { scope: DisplayScope; frequency: RoutineFrequency; routines: RoutineDisplayEntry[]; background: ReadonlySet<string>; automatic: ReadonlySet<string> }
export const sameScope = (a: DisplayScope | undefined, b: DisplayScope | undefined): boolean => Boolean(a && b && a.principal === b.principal && a.stack === b.stack);
function preferences(scope: DisplayScope, frequency: RoutineFrequency, routines: RoutineDisplayEntry[]): DisplayPreferences {
  const background = routines.filter((entry) => entry.mode === "background");
  return { scope, frequency, routines, background: new Set(background.map((entry) => entry.routineId)), automatic: new Set(background.filter((entry) => entry.source === "frequency").map((entry) => entry.routineId)) };
}
export async function readDisplay(signal: AbortSignal, read: (path: string, init?: RequestInit) => Promise<unknown> = getJson): Promise<DisplayPreferences> {
  const page = RoutineDisplayPageSchema.parse(await read("/api/desk/routine-display", { signal }));
  return preferences({ principal: page.principal, stack: page.stack }, page.frequency, page.routines);
}
export const routineDisplay = (current: DisplayPreferences, routineId: string): RoutineDisplayEntry => displayEntry(current, routineId);
export const storedChoice = (entry: RoutineDisplayEntry): RoutineDisplayChoice => entry.stored ?? "automatic";
export async function saveDisplay(scope: DisplayScope, routineId: string, mode: RoutineDisplayChoice, post: (path: string, body: RoutineDisplayChange) => Promise<unknown> = postJson): Promise<RoutineDisplayResult> {
  const result = RoutineDisplayResultSchema.parse(await post("/api/desk/routine-display", { principal: scope.principal, stack: scope.stack, routineId, mode }));
  if (result.routineId !== routineId || result.mode !== mode || !sameScope(result, scope)) throw new Error("The display preference answer belongs to a different routine or scope. Refresh the Routines page.");
  return result;
}
export function withDisplay(current: DisplayPreferences, result: RoutineDisplayResult): DisplayPreferences {
  if (!sameScope(current.scope, result)) return current;
  const previous = displayEntry(current, result.routineId);
  const stored = result.mode === "automatic" ? null : result.mode;
  const next = { ...previous, stored, ...resolveDisplay(stored, previous.automatic) };
  return preferences(current.scope, current.frequency, [...current.routines.filter((entry) => entry.routineId !== result.routineId), next]);
}
