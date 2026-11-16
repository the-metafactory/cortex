import type { NodeId, Effort, Recurrence, RecurrenceMode, OutlineNode, TodayItem } from "../../desk-api/wire/balance";
export type { NodeId, Effort, Recurrence, RecurrenceMode, OutlineNode, TodayItem };

export interface RecurrenceOutcome {
    taskId: NodeId;
    planned: string;
    status: "completed" | "missed" | "skipped";
    completedOn?: string;
    skippedOn?: string;
    recordedOn: string;
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
    outcomes?: RecurrenceOutcome[];
}
