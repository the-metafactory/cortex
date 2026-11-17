import type { OutlineNode, RecurrenceProjection, TodayItem, BalanceDayProjection } from "./balance";
import type { StudioProjectLink } from "./studio";
import type { TaskHandoffLines } from "./handoff";
import type { DeskLinkView } from "./links";
import type { CalendarGap } from "./calendar";

export type TaskRecommendation =
  | { kind: "fit"; item: TodayItem; minutes: number; reason: { code: "day.task-fits" } }
  | { kind: "normal"; item: TodayItem; reason: { code: "day.first-task" } }
  | { kind: "unverified"; item: TodayItem; reason: { code: "day.fit-unverified" } }
  | { kind: "none"; reason: { code: "day.closed" | "day.no-task" | "day.calendar-busy" | "day.no-task-fits" } };

export type TaskRecommendationReason = TaskRecommendation["reason"];

export interface MyDayResponse extends MyDayView {
  now: { at: number; gap: CalendarGap; next: TaskRecommendation };
}

interface MyDaySource {
  taskId: string;
  key: string;
  fingerprint: string;
  kind: string;
  url?: string;
}

/** An outline row as My day serves it: a row with a `repeat` rule also carries `recurrence`, computed by the Balance engine's recurrence rule. */
export type MyDayOutlineNode = Omit<OutlineNode, "children"> & { children: MyDayOutlineNode[]; recurrence?: RecurrenceProjection };

export interface MyDayView {
  work: {
    confirmedIds: string[];
    selection: { kind: "automatic" } | { kind: "manual"; id: string } | { kind: "unavailable"; id: string; reason: string };
  };
  studioStatus: "synced" | "unavailable" | "disabled";
  studioTasks: { id: string; slug: string }[];
  studioProjects: StudioProjectLink[];
  revision: number;
  configuredCaps: { cap: number; topN: number };
  capsOverridden: boolean;
  inbox: OutlineNode[];
  date: string;
  phase: "proposed" | "started" | "closed";
  cap: number;
  topN: number;
  items: TodayItem[];
  alternates: TodayItem[];
  wins: { taskId: string; title: string }[];
  outline: MyDayOutlineNode;
  observation: Pick<BalanceDayProjection, "status" | "observedAt"> | null;
  sources: MyDaySource[];
  touchTrackingSince: string | null;
  yesFilter: string[];
  undos: { receipt: string; title: string }[];
  dayUndo: { receipt: string; text: string } | null;
  handoffs?: TaskHandoffLines;
  links: DeskLinkView[];
}
