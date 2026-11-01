import { useCallback, useEffect, useState } from "react";

export type WorkspaceTab = "overview" | "schedule" | "flow" | "executions";
export type RoutineTab = "schedule" | "workspace";
export type CalendarView = "day" | "week" | "month";
export interface RoutinesLocation {
  tab: RoutineTab; workspace?: WorkspaceTab; routine: string | null; view: CalendarView; date: string; timezone: string;
  policy: "all" | "approval" | "auto"; showPaused: boolean;
}
const keys = ["routines", "routine", "routine-view", "routine-date", "routine-timezone", "routine-policy", "routine-paused", "routine-workspace"];
export const localDate = (now = new Date()): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
export function calendarDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.exec(value) || value < "1970-01-01" || value > "2100-12-31") return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
export function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}
export function defaultRoutinesLocation(): RoutinesLocation {
  return { tab: "schedule", workspace: "overview", routine: null, view: "week", date: localDate(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, policy: "all", showPaused: false };
}
export function readRoutinesLocation(search: string): RoutinesLocation | null {
  const p = new URLSearchParams(search);
  if (!p.has("routines")) return null;
  const defaults = defaultRoutinesLocation();
  const view = p.get("routine-view");
  const policy = p.get("routine-policy");
  const timezone = p.get("routine-timezone") ?? defaults.timezone;
  const workspace = p.get("routine-workspace");
  return { workspace: workspace === "schedule" || workspace === "flow" || workspace === "executions" ? workspace : "overview", tab: p.get("routines") === "workspace" ? "workspace" : "schedule", routine: p.get("routine") ?? null,
    view: view === "day" || view === "month" ? view : "week", date: calendarDate(p.get("routine-date")) ?? defaults.date,
    timezone: validTimezone(timezone) ? timezone : defaults.timezone, policy: policy === "approval" || policy === "auto" ? policy : "all", showPaused: p.get("routine-paused") === "1" };
}
export function routinesSearch(search: string, next: RoutinesLocation | null): string {
  const p = new URLSearchParams(search);
  for (const key of keys) p.delete(key);
  if (next) {
    p.delete("settings"); p.set("routines", next.tab); p.set("routine-view", next.view); p.set("routine-date", next.date); p.set("routine-timezone", next.timezone);
    if (next.workspace && next.workspace !== "overview") p.set("routine-workspace", next.workspace);
    if (next.routine) p.set("routine", next.routine);
    if (next.policy !== "all") p.set("routine-policy", next.policy);
    if (next.showPaused) p.set("routine-paused", "1");
  }
  const value = p.toString(); return value ? `?${value}` : "";
}
export function useRoutinesLocation(): [RoutinesLocation | null, (next: RoutinesLocation | null) => void] {
  const [location, setLocation] = useState(() => readRoutinesLocation(typeof window === "undefined" ? "" : window.location.search));
  useEffect(() => {
    const pop = (): void => { setLocation(readRoutinesLocation(window.location.search)); };
    window.addEventListener("popstate", pop); return () => { window.removeEventListener("popstate", pop); };
  }, []);
  const go = useCallback((next: RoutinesLocation | null): void => {
    window.history.pushState(null, "", `${window.location.pathname}${routinesSearch(window.location.search, next)}${window.location.hash}`); setLocation(next);
  }, []);
  return [location, go];
}
