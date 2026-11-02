import { findNode, type AppState, type TodayItem } from "../../../balance";
import type { MyDayMeta } from "./my-day-schema";
import { studioOwned } from "./studio-outline";

export type Placement =
  | { kind: "joined"; ids: string[] }
  | { kind: "replaced"; ids: string[]; displaced: string }
  | { kind: "full" };

export interface PlacementInput {
  ids: string[];
  rank: string[];
  id: string;
  cap: number;
  locked: ReadonlySet<string>;
  replace?: string;
}

export function placeInDay({ ids, rank, id, cap, locked, replace }: PlacementInput): Placement {
  const order = new Map(rank.map((value, index) => [value, index]));
  const own = order.get(id) ?? Infinity;
  const open = ids.filter(value => order.has(value));
  if (ids.length < cap) {
    const before = ids.findIndex(value => (order.get(value) ?? -Infinity) > own);
    return { kind: "joined", ids: before < 0 ? [...ids, id] : [...ids.slice(0, before), id, ...ids.slice(before)] };
  }
  const displaced = replace ?? open.filter(value => !locked.has(value)).reduce<string | undefined>((lowest, value) => lowest === undefined || (order.get(value) ?? 0) > (order.get(lowest) ?? 0) ? value : lowest, undefined);
  if (displaced === undefined || !open.includes(displaced)) return { kind: "full" };
  if (replace === undefined && (order.get(displaced) ?? 0) <= own) return { kind: "full" };
  return { kind: "replaced", ids: ids.map(value => value === displaced ? id : value), displaced };
}

export interface TodayContext {
  state: AppState;
  meta: MyDayMeta;
  date: string;
  rank: TodayItem[];
  requestId: string;
}

export interface TodayOutcome { notice: string; undo?: string }

const titleOf = (state: AppState, id: string): string => findNode(state.outline, id)?.title ?? "Task";

function lockedIds(ctx: TodayContext, ids: string[]): Set<string> {
  const { meta, date, rank } = ctx;
  const ranked = new Set(rank.map(item => item.task.id));
  const selected = meta.selection?.date === date ? meta.selection.id : ids.find(value => ranked.has(value));
  const manual = meta.manualToday?.date === date ? meta.manualToday.ids : [];
  return new Set([...(selected ? [selected] : []), ...manual]);
}

function noticeFor(state: AppState, id: string, placement: Exclude<Placement, { kind: "full" }>): string {
  return placement.kind === "joined" ? `Added ${titleOf(state, id)} to today's priorities.` : `Added ${titleOf(state, id)}; ${titleOf(state, placement.displaced)} moved out of today.`;
}

function record(ctx: TodayContext, before: string[], after: string[], notice: string): TodayOutcome {
  const { state, meta, date, requestId } = ctx;
  if (state.dayState?.date !== date) {
    meta.draft = { date, ids: after, origin: "person" };
    return { notice };
  }
  state.dayState.confirmed = after;
  meta.dayUndos = [...meta.dayUndos.filter(entry => entry.date === date), { receipt: requestId, date, before, after, text: notice, used: false }];
  return { notice, undo: requestId };
}

function fullNotice(cap: number): string {
  return `Saved to Balance. Today's priorities are full (${cap} of ${cap}) and no open task ranks below this one. Use Add to today to choose a task to swap out.`;
}

export function joinToday(ctx: TodayContext, ids: string[], id: string, cap: number): TodayOutcome {
  const { state, meta, date, rank } = ctx;
  if (state.dayState?.date === date && state.dayState.closed) return { notice: "Saved to Balance. Today is closed, so today's priorities are unchanged." };
  const node = findNode(state.outline, id);
  if (!node || node.children.length > 0 || node.done || node.weight === 0 || studioOwned(meta, id) || !rank.some(item => item.task.id === id)) return { notice: "Saved to Balance. It is not actionable today, so today's priorities are unchanged." };
  const placement = placeInDay({ ids, rank: rank.map(item => item.task.id), id, cap, locked: lockedIds(ctx, ids) });
  if (placement.kind === "full") return { notice: fullNotice(cap) };
  return record(ctx, ids, placement.ids, noticeFor(state, id, placement));
}

export function addToToday(ctx: TodayContext, ids: string[], id: string, cap: number, replace: string | null): TodayOutcome {
  const { state, meta, date, rank } = ctx;
  if (state.dayState?.date === date && state.dayState.closed) throw new Error("Today is closed. This task stays in Balance.");
  const node = findNode(state.outline, id);
  if (!node || node.children.length > 0 || node.done || !rank.some(item => item.task.id === id)) throw new Error("Only an actionable task without subtasks can join today.");
  if (ids.includes(id)) throw new Error("This task is already in today's priorities.");
  if (ids.length >= cap && replace === null) throw new Error(`Today is full (${cap} of ${cap}). Choose a task to move out.`);
  const placement = placeInDay({ ids, rank: rank.map(item => item.task.id), id, cap, locked: new Set(), ...(ids.length >= cap && replace !== null ? { replace } : {}) });
  if (placement.kind === "full") throw new Error("Choose an open task in today's priorities to move out.");
  if (state.dayState?.date === date) meta.manualToday = { date, ids: [...(meta.manualToday?.date === date ? meta.manualToday.ids : []), id] };
  return record(ctx, ids, placement.ids, noticeFor(state, id, placement));
}

export function removeFromToday(ctx: TodayContext, ids: string[], id: string): TodayOutcome {
  const { state, date } = ctx;
  if (state.dayState?.date === date && state.dayState.closed) throw new Error("Today is closed.");
  if (!ids.includes(id)) throw new Error("This task is not in today's priorities.");
  const node = findNode(state.outline, id);
  if (node?.done || state.log.some(event => event.taskId === id && event.date === date)) throw new Error("A completed task stays in today's wins.");
  return record(ctx, ids, ids.filter(value => value !== id), `${titleOf(state, id)} moved out of today. It stays in Balance.`);
}

export function undoToday(ctx: TodayContext, receipt: string): string | null {
  const { state, meta, date } = ctx;
  const previous = meta.dayUndos.find(entry => entry.receipt === receipt);
  if (!previous) return null;
  if (previous.used) return "Today's priorities are already restored.";
  if (previous.date !== date) throw new Error("This Undo belongs to a previous day.");
  const day = state.dayState;
  if (day?.date !== date || day.closed) throw new Error("Today is closed. Its priorities are kept.");
  if (JSON.stringify(day.confirmed) !== JSON.stringify(previous.after)) throw new Error("Today's priorities changed since this change. Your newer order is kept.");
  day.confirmed = [...previous.before];
  previous.used = true;
  if (meta.manualToday?.date === date) meta.manualToday = { date, ids: meta.manualToday.ids.filter(value => previous.before.includes(value)) };
  return "Today's priorities are restored.";
}
