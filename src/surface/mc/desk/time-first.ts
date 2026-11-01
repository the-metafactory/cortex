import type { OutlineNode, TodayItem } from "../../../balance";
import type { CalendarGap } from "./calendar-availability";
import type { MyDayView } from "./my-day";

export type TaskRecommendation =
  | { kind: "fit"; item: TodayItem; minutes: number }
  | { kind: "normal"; item: TodayItem }
  | { kind: "unverified"; item: TodayItem }
  | { kind: "none"; reason: string };

export function nextTask(day: MyDayView, gap: CalendarGap): TaskRecommendation {
  if (day.phase === "closed") return { kind: "none", reason: "Your day is closed. Your wins are below." };
  const eligible = day.items.filter(item => !item.task.done && (!item.task.deferredUntil || item.task.deferredUntil <= day.date));
  const first = eligible[0];
  if (!first) return { kind: "none", reason: "No incomplete task is available in this day." };
  switch (gap.kind) {
    case "busy": return { kind: "none", reason: "A calendar block is in progress. Your priorities stay available to choose." };
    case "unknown": return { kind: "unverified", item: first };
    case "open": return { kind: "normal", item: first };
    case "bounded": {
      const fits = eligible.find(item => item.task.estimateMinutes !== undefined && item.task.estimateMinutes <= gap.minutes);
      return fits ? { kind: "fit", item: fits, minutes: gap.minutes } : { kind: "none", reason: "No task with a known estimate fits this gap. Your overall priorities stay unchanged." };
    }
  }
}

export function reorderVisible(confirmed: string[], visible: string[], id: string, direction: -1 | 1): string[] {
  const index = visible.indexOf(id);
  const other = visible[index + direction];
  if (index < 0 || other === undefined) return [...confirmed];
  return confirmed.map(current => current === id ? other : current === other ? id : current);
}

export function savedTaskContext(outline: OutlineNode, item: TodayItem): string {
  const path = (node: OutlineNode): OutlineNode[] | undefined => {
    if (node.id === item.task.id) return [node];
    for (const child of node.children) { const found = path(child); if (found) return [node, ...found]; }
  };
  return [item.task.note, item.context, path(outline)?.slice(0, -1).reverse().find(node => node.note?.trim())?.note].find(value => value?.trim()) ?? "No additional context is saved for this task.";
}
