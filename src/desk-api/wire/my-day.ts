import type { OutlineNode, RecurrenceProjection, TodayItem, BalanceDayProjection } from "./balance";
import type { StudioProjectLink } from "./studio";
import type { TaskHandoffLines } from "./handoff";
import type { DeskLinkView } from "./links";

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
