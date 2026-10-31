import { required } from "./required";
import type { OutlineNode, Recurrence } from "./types";
import { daysBetween } from "./scheduler";
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
export function recurrenceFinished(repeat: Recurrence, next: string): boolean {
    if (repeat.count !== undefined && (repeat.timesDone ?? 0) >= repeat.count)
        return true;
    if (repeat.until !== undefined && next > repeat.until)
        return true;
    return false;
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
        const next = nextOccurrence(node.completedAt, node.repeat);
        if (recurrenceFinished(node.repeat, next))
            return;
        const lead = node.leadDays ?? 0;
        if (daysBetween(today, next) <= lead) {
            node.done = false;
            delete node.completedAt;
            node.dueDate = next;
            if (node.deferredUntil && node.deferredUntil <= today)
                delete node.deferredUntil;
            result.changed = true;
            result.respawned.push(node.id);
        }
    };
    walk(outline);
    return result;
}
