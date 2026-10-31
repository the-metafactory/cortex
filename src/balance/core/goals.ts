import { required } from "./required";
import { type AppState, type CompletionEvent, type OutlineNode, FOCUS_BOOST, MAX_FOCUS_PER_MONTH, } from "./types";
import { collectLeaves, focusContainment, monthOf } from "./scheduler";
export interface StreakInfo {
    current: number;
    showedUpLast7: number;
    week: {
        date: string;
        showedUp: boolean;
    }[];
}
function shiftDate(iso: string, days: number): string {
    const t = Date.parse(iso + "T00:00:00Z") + days * 86400000;
    return new Date(t).toISOString().slice(0, 10);
}
export function streakInfo(log: CompletionEvent[], today: string): StreakInfo {
    const days = new Set(log.map((e) => e.date));
    let current = 0;
    let cursor = days.has(today) ? today : shiftDate(today, -1);
    while (days.has(cursor)) {
        current += 1;
        cursor = shiftDate(cursor, -1);
    }
    const week: {
        date: string;
        showedUp: boolean;
    }[] = [];
    for (let i = 6; i >= 0; i--) {
        const date = shiftDate(today, -i);
        week.push({ date, showedUp: days.has(date) });
    }
    return {
        current,
        showedUpLast7: week.filter((d) => d.showedUp).length,
        week,
    };
}
export function focusNodes(root: OutlineNode, month: string): OutlineNode[] {
    const out: OutlineNode[] = [];
    const walk = (node: OutlineNode) => {
        if (node.focusMonth === month)
            out.push(node);
        for (const child of node.children)
            walk(child);
    };
    for (const area of root.children)
        walk(area);
    return out;
}
export function validateFocusChange(root: OutlineNode, nodeId: string, month: string, enable: boolean): string | null {
    if (!enable)
        return null;
    const existing = focusNodes(root, month).filter((n) => n.id !== nodeId);
    if (existing.length >= MAX_FOCUS_PER_MONTH) {
        return `A month holds at most ${MAX_FOCUS_PER_MONTH} focus projects — drop one first. (That limit is the feature.)`;
    }
    return null;
}
export interface AreaReview {
    areaId: string;
    areaTitle: string;
    targetShare: number;
    actualShare: number;
    completions: number;
}
export interface MonthReview {
    month: string;
    wins: {
        title: string;
        date: string;
        areaTitle: string;
    }[];
    areas: AreaReview[];
    focus: {
        title: string;
        done: number;
        total: number;
    }[];
    totalCompletions: number;
}
export function monthReview(state: AppState, month: string): MonthReview {
    const { outline, log } = state;
    const events = log.filter((e) => monthOf(e.date) === month);
    const areaTitleById = new Map(outline.children.map((a) => [a.id, a.title]));
    const focusIds = focusContainment(outline, month);
    const active = outline.children.filter((a) => a.weight > 0);
    const staticWeights = active.map((a) => a.weight * (focusIds.has(a.id) ? FOCUS_BOOST : 1));
    const staticTotal = staticWeights.reduce((a, b) => a + b, 0);
    const effortByArea = new Map<string, number>();
    const countByArea = new Map<string, number>();
    for (const e of events) {
        effortByArea.set(e.areaId, (effortByArea.get(e.areaId) ?? 0) + e.effort);
        countByArea.set(e.areaId, (countByArea.get(e.areaId) ?? 0) + 1);
    }
    const effortTotal = [...effortByArea.values()].reduce((a, b) => a + b, 0);
    const areas: AreaReview[] = active.map((area, i) => ({
        areaId: area.id,
        areaTitle: area.title,
        targetShare: staticTotal > 0 ? required(staticWeights[i]) / staticTotal : 0,
        actualShare: effortTotal > 0 ? (effortByArea.get(area.id) ?? 0) / effortTotal : 0,
        completions: countByArea.get(area.id) ?? 0,
    }));
    const focus = focusNodes(outline, month).map((node) => {
        const leaves = collectLeaves(node);
        return {
            title: node.title,
            done: leaves.filter((t) => t.done).length,
            total: leaves.length,
        };
    });
    const wins = [...events]
        .sort((a, b) => a.date === b.date
        ? a.taskId === b.taskId
            ? 0
            : a.taskId < b.taskId
                ? -1
                : 1
        : a.date < b.date
            ? 1
            : -1)
        .map((e) => ({
        title: e.title,
        date: e.date,
        areaTitle: areaTitleById.get(e.areaId) ?? "—",
    }));
    return { month, wins, areas, focus, totalCompletions: events.length };
}
