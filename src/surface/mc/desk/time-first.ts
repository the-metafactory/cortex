import type { OutlineNode } from "../../../balance";
import type { TaskRecommendation } from "../../../desk-api/wire/my-day";
import type { CalendarGap } from "./calendar-availability";
import type { MyDayView } from "./my-day";

export function nextTask(day: MyDayView, gap: CalendarGap): TaskRecommendation {
  if (day.phase === "closed") return { kind: "none", reason: { code: "day.closed" } };
  const eligible = day.items.filter(item => !item.task.done && (!item.task.deferredUntil || item.task.deferredUntil <= day.date));
  const first = eligible[0];
  if (!first) return { kind: "none", reason: { code: "day.no-task" } };
  switch (gap.kind) {
    case "busy": return { kind: "none", reason: { code: "day.calendar-busy" } };
    case "unknown": return { kind: "unverified", item: first, reason: { code: "day.fit-unverified" } };
    case "open": return { kind: "normal", item: first, reason: { code: "day.first-task" } };
    case "bounded": {
      const fits = eligible.find(item => item.task.estimateMinutes !== undefined && item.task.estimateMinutes <= gap.minutes);
      return fits ? { kind: "fit", item: fits, minutes: gap.minutes, reason: { code: "day.task-fits" } } : { kind: "none", reason: { code: "day.no-task-fits" } };
    }
  }
}

export function reorderVisible(confirmed: string[], visible: string[], id: string, direction: -1 | 1): string[] {
  const index = visible.indexOf(id);
  const other = visible[index + direction];
  if (index < 0 || other === undefined) return [...confirmed];
  return confirmed.map(current => current === id ? other : current === other ? id : current);
}

export function projectContext(outline: OutlineNode, id: string): string | null {
  const path = (node: OutlineNode): OutlineNode[] | undefined => {
    if (node.id === id) return [node];
    for (const child of node.children) { const found = path(child); if (found) return [node, ...found]; }
  };
  return path(outline)?.slice(0, -1).reverse().find(node => node.note?.trim())?.note ?? null;
}
