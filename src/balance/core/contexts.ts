import type { ContextDef } from "./types";
export interface ContextOpenState {
    openNow: boolean;
    opensLaterToday: boolean;
    openToday: boolean;
}
const ALWAYS_OPEN: ContextOpenState = {
    openNow: true,
    opensLaterToday: false,
    openToday: true,
};
function weekdayOf(iso: string): number {
    return new Date(iso + "T00:00:00Z").getUTCDay();
}
export function sameContext(a: string | undefined, b: string | null | undefined): boolean {
    if (!a || !b)
        return false;
    return a.toLowerCase() === b.toLowerCase();
}
export function contextOpen(def: ContextDef | undefined, today: string, timeNow?: string): ContextOpenState {
    const windows = def?.windows ?? [];
    if (windows.length === 0)
        return ALWAYS_OPEN;
    const weekday = weekdayOf(today);
    let openNow = false;
    let opensLaterToday = false;
    let openToday = false;
    for (const { days, from, to } of windows) {
        if (!days.includes(weekday))
            continue;
        openToday = true;
        if (!timeNow) {
            openNow = true;
            continue;
        }
        if (from <= timeNow && timeNow < to)
            openNow = true;
        else if (timeNow < from)
            opensLaterToday = true;
    }
    return { openNow, opensLaterToday, openToday };
}
export function nextOpeningToday(def: ContextDef | undefined, today: string, timeNow: string): string | null {
    const weekday = weekdayOf(today);
    const upcoming = (def?.windows ?? [])
        .filter((w) => w.days.includes(weekday) && timeNow < w.from)
        .map((w) => w.from)
        .sort();
    return upcoming[0] ?? null;
}
export function contextDefMap(contexts: ContextDef[]): Map<string, ContextDef> {
    return new Map(contexts.map((c) => [c.name.toLowerCase(), c]));
}
export function contextAllows(ctx: string | undefined, activeContext: string | null | undefined, defs: Map<string, ContextDef>, today: string, timeNow?: string): boolean {
    if (!ctx)
        return true;
    if (activeContext && sameContext(ctx, activeContext))
        return true;
    const state = contextOpen(defs.get(ctx.toLowerCase()), today, timeNow);
    return state.openNow || state.opensLaterToday;
}
