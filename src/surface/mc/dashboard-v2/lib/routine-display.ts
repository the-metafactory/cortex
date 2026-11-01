import { RoutineDisplayPageSchema, RoutineDisplayResultSchema, type RoutineDisplayChange, type RoutineDisplayMode, type RoutineDisplayResult } from "../../desk/routine-display-contract";
import { getJson, postJson } from "./api";

export interface DisplayScope { principal: string; stack: string }
export interface DisplayPreferences { scope: DisplayScope; background: ReadonlySet<string> }
export const sameScope = (a: DisplayScope | undefined, b: DisplayScope | undefined): boolean => Boolean(a && b && a.principal === b.principal && a.stack === b.stack);
export async function readDisplay(signal: AbortSignal, read: (path: string, init?: RequestInit) => Promise<unknown> = getJson): Promise<DisplayPreferences> {
  const page = RoutineDisplayPageSchema.parse(await read("/api/desk/routine-display", { signal }));
  return { scope: { principal: page.principal, stack: page.stack }, background: new Set(page.preferences.map((entry) => entry.routineId)) };
}
export async function saveDisplay(scope: DisplayScope, routineId: string, mode: RoutineDisplayMode, post: (path: string, body: RoutineDisplayChange) => Promise<unknown> = postJson): Promise<RoutineDisplayResult> {
  const result = RoutineDisplayResultSchema.parse(await post("/api/desk/routine-display", { principal: scope.principal, stack: scope.stack, routineId, mode }));
  if (result.routineId !== routineId || result.mode !== mode || !sameScope(result, scope)) throw new Error("The display preference answer belongs to a different routine or scope. Refresh the Routines page.");
  return result;
}
export function withDisplay(preferences: DisplayPreferences, result: RoutineDisplayResult): DisplayPreferences {
  if (!sameScope(preferences.scope, result)) return preferences;
  const background = new Set(preferences.background);
  if (result.mode === "background") background.add(result.routineId); else background.delete(result.routineId);
  return { scope: preferences.scope, background };
}
