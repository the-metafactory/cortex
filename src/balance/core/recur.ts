import { required } from "./required";
import type { AppState, OutlineNode, Recurrence, RecurrenceOutcome } from "./types";
export function shiftDays(iso: string, days: number): string {
    const t = Date.parse(iso + "T00:00:00Z") + days * 86400000;
    return new Date(t).toISOString().slice(0, 10);
}
function weekdayOf(iso: string): number {
    return new Date(iso + "T00:00:00Z").getUTCDay();
}
export function addMonths(iso: string, months: number): string {
    const [y, m, d] = iso.split("-").map(Number);
    const total = (required(y) * 12 + (required(m) - 1)) + months;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = Math.min(required(d), lastDay);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
export function nextOccurrence(after: string, repeat: Recurrence): string {
    const interval = Math.max(1, Math.floor(repeat.interval || 1));
    if (repeat.unit === "day")
        return shiftDays(after, interval);
    if (repeat.unit === "week") {
        if (repeat.weekdays && repeat.weekdays.length > 0) {
            for (let i = 1; i <= 7; i++) {
                const candidate = shiftDays(after, i);
                if (repeat.weekdays.includes(weekdayOf(candidate)))
                    return candidate;
            }
        }
        return shiftDays(after, 7 * interval);
    }
    return addMonths(after, interval);
}
const DAY_MS = 86400000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function dayNumber(iso: string): number {
    return Math.floor(Date.parse(iso + "T00:00:00Z") / DAY_MS);
}
function mondayWeek(iso: string): number {
    return Math.floor((dayNumber(iso) + 3) / 7);
}
export function isCalendarRepeat(repeat: Recurrence): boolean {
    return repeat.mode === "calendar";
}
export function validateRecurrence(repeat: Recurrence): void {
    const mode: string | undefined = repeat.mode;
    if (mode !== undefined && mode !== "calendar" && mode !== "completion")
        throw new Error("A repeat counts from the planned date or from completion.");
    if (!Number.isInteger(repeat.interval) || repeat.interval < 1)
        throw new Error("A repeat interval is a whole number of at least 1.");
    if (!["day", "week", "month"].includes(repeat.unit))
        throw new Error("A repeat unit is day, week or month.");
    if (repeat.weekdays?.some(day => !Number.isInteger(day) || day < 0 || day > 6))
        throw new Error("Repeat weekdays are numbers from 0 (Sunday) to 6 (Saturday).");
    if (repeat.mode === "calendar" && !(repeat.anchor && ISO_DAY.test(repeat.anchor)))
        throw new Error("A calendar repeat needs an explicit anchor date.");
}
export function newRecurrence(input: Omit<Recurrence, "mode" | "anchor" | "occurrence" | "timesDone"> & { mode?: Recurrence["mode"] }, anchor: string): Recurrence {
    const repeat: Recurrence = { ...input, mode: input.mode ?? "calendar" };
    if (repeat.mode === "calendar")
        repeat.anchor = anchor;
    validateRecurrence(repeat);
    return repeat;
}
export function scheduledAfter(repeat: Recurrence, after: string): string {
    const anchor = repeat.anchor;
    if (!anchor)
        throw new Error("A calendar repeat needs an explicit anchor date.");
    const interval = repeat.interval;
    const floor = after < anchor ? shiftDays(anchor, -1) : after;
    if (repeat.unit === "day") {
        const steps = Math.floor((dayNumber(floor) - dayNumber(anchor)) / interval) + 1;
        return shiftDays(anchor, steps * interval);
    }
    if (repeat.unit === "week") {
        const days = repeat.weekdays && repeat.weekdays.length > 0 ? repeat.weekdays : [weekdayOf(anchor)];
        for (let i = 1; i <= 7 * interval + 7; i++) {
            const candidate = shiftDays(floor, i);
            if (days.includes(weekdayOf(candidate)) && (mondayWeek(candidate) - mondayWeek(anchor)) % interval === 0)
                return candidate;
        }
        throw new Error("The weekly repeat has no scheduled date.");
    }
    for (let k = 1;; k++) {
        const candidate = addMonths(anchor, k * interval);
        if (candidate > floor)
            return candidate;
    }
}
export function currentOccurrence(repeat: Recurrence): string | undefined {
    return repeat.occurrence ?? repeat.anchor;
}
export function completeCalendarOccurrence(state: AppState, taskId: string, repeat: Recurrence, date: string): void {
    const planned = currentOccurrence(repeat);
    if (!planned)
        throw new Error("A calendar repeat needs an explicit anchor date.");
    const outcomes = (state.outcomes ??= []);
    const recordedPlanned = new Set(outcomes.filter(o => o.taskId === taskId).map(o => o.planned));
    const record = (outcome: RecurrenceOutcome) => {
        if (recordedPlanned.has(outcome.planned))
            return;
        recordedPlanned.add(outcome.planned);
        outcomes.push(outcome);
    };
    record({ taskId, planned, status: "completed", completedOn: date, recordedOn: date });
    let next = scheduledAfter(repeat, planned);
    while (next <= date && (repeat.until === undefined || next <= repeat.until)) {
        record({ taskId, planned: next, status: "missed", recordedOn: date });
        next = scheduledAfter(repeat, next);
    }
    repeat.occurrence = next;
}
export function reopenCalendarOccurrence(state: AppState, taskId: string, repeat: Recurrence, completedOn: string): void {
    const outcomes = state.outcomes ?? [];
    const planned = outcomes
        .filter(o => o.taskId === taskId && o.status === "completed" && o.completedOn === completedOn)
        .map(o => o.planned)
        .sort()
        .at(-1);
    if (planned === undefined)
        return;
    state.outcomes = outcomes.filter(o => !(o.taskId === taskId && o.recordedOn === completedOn && o.planned >= planned));
    repeat.occurrence = planned;
}
export function recurrenceFinished(repeat: Recurrence, next: string): boolean {
    if (repeat.count !== undefined && (repeat.timesDone ?? 0) >= repeat.count)
        return true;
    if (repeat.until !== undefined && next > repeat.until)
        return true;
    return false;
}
/** When a repeating leaf comes back. `returnsOn` is its next occurrence and `reappearsOn` that date minus its lead days, the day `applyRecurrence` reopens it; both are null while the row is open or once the repeat is finished. */
export interface RecurrenceProjection {
    returnsOn: string | null;
    finished: boolean;
    reappearsOn: string | null;
}
export function recurrenceProjection(node: OutlineNode): RecurrenceProjection | null {
    if (!node.repeat)
        return null;
    if (node.children.length > 0 || node.done !== true || !node.completedAt)
        return { returnsOn: null, finished: false, reappearsOn: null };
    const next = isCalendarRepeat(node.repeat) && node.repeat.occurrence ? node.repeat.occurrence : nextOccurrence(node.completedAt, node.repeat);
    if (recurrenceFinished(node.repeat, next))
        return { returnsOn: null, finished: true, reappearsOn: null };
    return { returnsOn: next, finished: false, reappearsOn: shiftDays(next, -Math.floor(node.leadDays ?? 0)) };
}
export interface RespawnResult {
    changed: boolean;
    respawned: string[];
}
export function applyRecurrence(outline: OutlineNode, today: string): RespawnResult {
    const result: RespawnResult = { changed: false, respawned: [] };
    const walk = (node: OutlineNode) => {
        for (const child of node.children)
            walk(child);
        if (node.children.length > 0 || !node.repeat || node.done !== true)
            return;
        if (!node.completedAt) {
            node.done = false;
            result.changed = true;
            result.respawned.push(node.id);
            return;
        }
        const { returnsOn, reappearsOn } = required(recurrenceProjection(node));
        if (returnsOn === null || reappearsOn === null)
            return;
        if (today >= reappearsOn) {
            node.done = false;
            delete node.completedAt;
            node.dueDate = returnsOn;
            if (node.deferredUntil && node.deferredUntil <= today)
                delete node.deferredUntil;
            result.changed = true;
            result.respawned.push(node.id);
        }
    };
    walk(outline);
    return result;
}
