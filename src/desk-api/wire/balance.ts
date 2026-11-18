export type NodeId = string;

export type Effort = 1 | 2 | 4;

export interface Recurrence {
  unit: "day" | "week" | "month";
  interval: number;
  weekdays?: number[];
  count?: number;
  until?: string;
  timesDone?: number;
  mode?: RecurrenceMode;
  anchor?: string;
  occurrence?: string;
}

export type RecurrenceMode = "calendar" | "completion";

export interface OutlineNode {
  id: NodeId;
  title: string;
  weight: number;
  ordering: "parallel" | "sequential";
  children: OutlineNode[];
  note?: string;
  done?: boolean;
  completedAt?: string;
  createdAt?: string;
  touchedAt?: string;
  effort?: Effort;
  estimateMinutes?: number;
  dueDate?: string;
  leadDays?: number;
  startDate?: string;
  deferredUntil?: string;
  focusMonth?: string;
  repeat?: Recurrence;
  context?: string;
  external?: {
    source: string;
    url?: string;
    syncedAt: string;
  };
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

export interface AreaReview {
  areaId: string;
  areaTitle: string;
  targetShare: number;
  actualShare: number;
  completions: number;
}

export interface CompletionReview {
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

/** When a repeating leaf comes back. `returnsOn` is its next occurrence and `reappearsOn` that date minus its lead days, the day `applyRecurrence` reopens it; both are null while the row is open or once the repeat is finished. */
export interface RecurrenceProjection {
  returnsOn: string | null;
  finished: boolean;
  reappearsOn: string | null;
}

export type BalanceDayHealth = "fresh" | "stale" | "unavailable" | "conflicted";

export interface BalanceProjectedTask {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly dueDate: string | null;
  readonly note?: string;
  readonly effort?: 1 | 2 | 4;
}

export interface BalanceDayProjection {
  readonly status: BalanceDayHealth;
  readonly observedAt: string | null;
  readonly tasks: readonly BalanceProjectedTask[];
}

export interface BalanceDestination {
  id: string;
  label: string;
  title: string;
  area: string;
  project: boolean;
}

export const BALANCE_PROJECT_MISSES = ["none", "ambiguous", "id-shaped"] as const;
export type BalanceProjectMiss = (typeof BALANCE_PROJECT_MISSES)[number];

export type BalanceProjectResolved = { id: string } | { none: true; reason: BalanceProjectMiss };

export interface BalanceDestinationsResponse {
  destinations: BalanceDestination[];
  resolved?: BalanceProjectResolved;
}
