import { newRecurrence, scheduledAfter, validateRecurrence, type OutlineNode, type Recurrence } from "../../../balance";
import type { OutlineRepeatInput } from "./balance-command";

interface OutlineTimeFields {
  startDate?: string;
  deferredUntil?: string;
  repeat?: OutlineRepeatInput | null;
}
interface TimePlan {
  startDate: string | null | undefined;
  deferredUntil: string | null | undefined;
  repeat: Recurrence | null | undefined;
}
const clearable = (value: string | undefined): string | null | undefined => (value === "" ? null : value);
function sameSchedule(a: Recurrence, b: OutlineRepeatInput): boolean {
  return a.unit === b.unit && a.interval === b.interval && [...(a.weekdays ?? [])].sort().join() === [...(b.weekdays ?? [])].sort().join();
}
function buildRepeat(node: OutlineNode, input: OutlineRepeatInput, anchorDate: string): Recurrence {
  const weekdays = input.weekdays?.length ? [...new Set(input.weekdays)].sort((a, b) => a - b) : undefined;
  const rest = { unit: input.unit, interval: input.interval, ...(weekdays ? { weekdays } : {}), ...(input.count ? { count: input.count } : {}), ...(input.until ? { until: input.until } : {}) };
  const existing = node.repeat;
  const timesDone = existing?.timesDone === undefined ? {} : { timesDone: existing.timesDone };
  const stated = input.mode ?? existing?.mode;
  const effective = stated ?? (existing ? "completion" : "calendar");
  if (effective === "completion") {
    const repeat: Recurrence = { ...rest, ...(stated ? { mode: stated } : {}), ...timesDone };
    validateRecurrence(repeat);
    return repeat;
  }
  if (existing?.mode === "calendar" && existing.anchor && sameSchedule(existing, input)) {
    const repeat: Recurrence = { ...rest, mode: "calendar", anchor: existing.anchor, ...(existing.occurrence ? { occurrence: existing.occurrence } : {}), ...timesDone };
    validateRecurrence(repeat);
    return repeat;
  }
  const fresh: Recurrence = { ...newRecurrence({ ...rest, mode: "calendar" }, anchorDate), ...timesDone };
  if (node.done === true && node.completedAt) fresh.occurrence = scheduledAfter(fresh, node.completedAt);
  return fresh;
}
export function planOutlineTimeFields(node: OutlineNode, fields: OutlineTimeFields, context: { date: string; dueDate: string | undefined; clears: boolean; canRepeat: boolean }): TimePlan {
  const startDate = context.clears ? clearable(fields.startDate) : fields.startDate;
  const deferredUntil = context.clears ? clearable(fields.deferredUntil) : fields.deferredUntil;
  const effectiveStart = startDate === undefined ? node.startDate : startDate ?? undefined;
  if (effectiveStart && context.dueDate && effectiveStart > context.dueDate) throw new Error("A task cannot start after its due date.");
  if (fields.repeat && !context.canRepeat) throw new Error("Only a task without subtasks can repeat.");
  const repeat = fields.repeat ? buildRepeat(node, fields.repeat, context.dueDate ?? effectiveStart ?? context.date) : fields.repeat;
  return { startDate, deferredUntil, repeat };
}
export function applyOutlineTimeFields(node: OutlineNode, plan: TimePlan): void {
  if (plan.startDate === null) delete node.startDate;
  else if (plan.startDate) node.startDate = plan.startDate;
  if (plan.deferredUntil === null) delete node.deferredUntil;
  else if (plan.deferredUntil) node.deferredUntil = plan.deferredUntil;
  if (plan.repeat === null) delete node.repeat;
  else if (plan.repeat) node.repeat = plan.repeat;
}
