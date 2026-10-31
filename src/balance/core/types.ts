export type NodeId = string;
export type Effort = 1 | 2 | 4;
export interface Recurrence {
    unit: "day" | "week" | "month";
    interval: number;
    weekdays?: number[];
    count?: number;
    until?: string;
    timesDone?: number;
}
export interface OutlineNode {
    id: NodeId;
    title: string;
    weight: number;
    ordering: "parallel" | "sequential";
    children: OutlineNode[];
    note?: string;
    done?: boolean;
    completedAt?: string;
    effort?: Effort;
    dueDate?: string;
    leadDays?: number;
    startDate?: string;
    deferredUntil?: string;
    focusMonth?: string;
    repeat?: Recurrence;
    context?: string;
    external?: {
        source: "jira" | "tana";
        url?: string;
        syncedAt: string;
    };
}
export interface CompletionEvent {
    taskId: NodeId;
    areaId: NodeId;
    effort: number;
    date: string;
    title: string;
}
export interface Settings {
    todayCap: number;
    balanceBeta: number;
    halfLifeDays: number;
    emergencyMode: boolean;
    activeContext?: string | null;
}
export const MAX_TODAY_CAP = 7;
export const MAX_FOCUS_PER_MONTH = 3;
export const FOCUS_BOOST = 1.5;
export const DEFAULT_SETTINGS: Settings = {
    todayCap: 5,
    balanceBeta: 0.5,
    halfLifeDays: 7,
    emergencyMode: false,
};
export interface SchedHistory {
    startDate?: string;
    deficits: Record<string, number>;
    lastSurfaced: Record<string, string>;
    lastAppliedDate?: string;
}
export const EMPTY_HISTORY: SchedHistory = { deficits: {}, lastSurfaced: {} };
export interface DayState {
    date: string;
    confirmed: NodeId[];
    closed: boolean;
}
export interface TodayItem {
    task: OutlineNode;
    areaId: NodeId;
    areaTitle: string;
    path: string[];
    context?: string;
    score: number;
    urgency: number;
    reason: "due" | "balance" | "focus";
    trace: string;
}
export interface ContextHours {
    days: number[];
    from: string;
    to: string;
}
export interface ContextDef {
    name: string;
    windows?: ContextHours[];
}
export interface AppState {
    outline: OutlineNode;
    log: CompletionEvent[];
    settings: Settings;
    dayState: DayState | null;
    history: SchedHistory;
    contexts?: ContextDef[];
}
