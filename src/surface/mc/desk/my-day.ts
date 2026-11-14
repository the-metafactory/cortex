import { localDay } from "./time";
export { localDay } from "./time";
import { sourceIdentity, todo } from "./source-task";
export { sourceIdentity } from "./source-task";
import { balanceParents } from "./balance-parent";
import { planSource, unplanSource } from "./source-plan";
import { studioLinks, studioOwned, type StudioProjection } from "./studio-outline";
import { DEFAULT_YES_FILTER } from "./yes-filter";
import { applyBalanceCommand, completeOutlineLeaf, fileBalanceInbox, outlineDestination, setOutlineFocus } from "./balance-outline";
import { applyBalanceDayProjection, type BalanceDayProjection } from "./balance-day";
import type { Database } from "bun:sqlite";
import { applyDayToHistory, findNode, rankAll, selectToday, shiftDays, todayPlanIds, type AppState, type OutlineNode, type TodayItem } from "../../../balance";
import { saveBalanceState } from "./balance-store";
import { taskHandoffLines, type TaskHandoffLines } from "./task-handoff-store";
import type { MyDayCommand, MyDayMeta } from "./my-day-schema";
import { addToToday, joinToday, liveDayUndo, removeFromToday, undoToday, type TodayContext } from "./my-day-today";
import type { DeskOptions } from "./compose";
import type { DeskItem } from "./types";
import { taskLinks, type DeskLinkView } from "./links";
import { configuredState, isPersonDraft, loadMeta, loadMyDayState, retireStaleDraft, saveMeta, todayCap } from "./balance-sync";
export { loadMeta } from "./balance-sync";

export interface MyDayView {
  work: {
    confirmedIds: string[];
    selection: { kind: "automatic" } | { kind: "manual"; id: string } | { kind: "unavailable"; id: string; reason: string };
  };
  studioStatus: "synced" | "unavailable" | "disabled";
  studioTasks: { id: string; slug: string }[];
  studioProjects: { id: string; slug: string }[];
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
  outline: OutlineNode;
  observation: Pick<BalanceDayProjection, "status" | "observedAt"> | null;
  sources: MyDayMeta["sources"];
  yesFilter: string[];
  undos: { receipt: string; title: string }[];
  dayUndo: { receipt: string; text: string } | null;
  handoffs?: TaskHandoffLines;
  links: DeskLinkView[];
}
const withHandoffs = (view: MyDayView, db: Database, desk: DeskOptions, now: number): MyDayView => (desk.dispatch ? { ...view, handoffs: taskHandoffLines(db, desk.dispatch, now) } : view);
function viewOf(storedState: AppState, meta: MyDayMeta, desk: DeskOptions, date: string, studio?: StudioProjection, projection?: BalanceDayProjection): Omit<MyDayView, "links"> {
  const state = configuredState(storedState, desk);
  if (projection) applyBalanceDayProjection(state.outline, projection.tasks);
  const day = state.dayState?.date === date ? state.dayState : null;
  const all = rankAll(state, date);
  const visibleIds = todayPlanIds(state, date, meta.draft);
  const byId = new Map(all.map(i => [i.task.id, i]));
  const selected = meta.selection?.date === date ? meta.selection : null;
  const available = selected && visibleIds.includes(selected.id) && byId.has(selected.id);
  const dayUndo = liveDayUndo({ state, meta, date });
  return {
    work: {
      confirmedIds: day?.confirmed ?? [],
      selection: !selected ? { kind: "automatic" } : available ? { kind: "manual", id: selected.id } : { kind: "unavailable", id: selected.id, reason: "Your chosen task is no longer actionable in this day. Choose another task or return to the recommendation." },
    },
    studioStatus: !desk.studio ? "disabled" : studio ? "synced" : "unavailable",
    studioTasks: studioLinks(meta),
    studioProjects: meta.studio.map(project => ({ id: project.projectId, slug: project.slug })),
    configuredCaps: { cap: desk.myDay?.cap ?? 5, topN: desk.topN }, capsOverridden: meta.caps !== null,
    revision: meta.revision, inbox: meta.inbox,
    date, phase: day ? day.closed ? "closed" : "started" : "proposed", cap: state.settings.todayCap, topN: meta.caps?.topN ?? desk.topN,
    items: visibleIds.flatMap(id => { const item = byId.get(id); return item ? [item] : []; }),
    alternates: all.filter(i => !visibleIds.includes(i.task.id)).slice(0, 3),
    wins: state.log.filter(e => e.date === date).map(({ taskId, title }) => ({ taskId, title })),
    undos: meta.undos.filter(u => !u.used && u.date === date).map(u => ({ receipt: u.receipt, title: findNode(state.outline, u.taskId)?.title ?? "Task" })),
    dayUndo: dayUndo ? { receipt: dayUndo.receipt, text: dayUndo.text } : null,
    outline: state.outline, observation: projection ? { status: projection.status, observedAt: projection.observedAt } : null, sources: meta.sources, yesFilter: desk.studio?.yesFilter?.length ? [...desk.studio.yesFilter] : [...DEFAULT_YES_FILTER],
  };
}
const withLinks = (db: Database, view: Omit<MyDayView, "links">): MyDayView => ({ ...view, links: taskLinks(db, view) });
export function readMyDay(db: Database, desk: DeskOptions, now: number, studio?: StudioProjection, projection?: BalanceDayProjection): MyDayView {
  return db.transaction(() => {
    const meta = loadMeta(db);
    return withHandoffs(withLinks(db, viewOf(loadMyDayState(db, desk, meta), meta, desk, localDay(now), studio, projection)), db, desk, now);
  }).deferred();
}
export function movedKeys(db: Database): Set<string> {
  return new Set(loadMeta(db).sources.map(s => s.fingerprint));
}
function requiredNode(state: AppState, id: string): OutlineNode {
  const node = findNode(state.outline, id);
  if (!node) throw new Error("That outline item no longer exists.");
  return node;
}
function validateSelection(state: AppState, date: string, ids: string[]): void {
  const allowed = new Set(rankAll(state, date).map(i => i.task.id));
  if (new Set(ids).size !== ids.length || ids.length > state.settings.todayCap || ids.some(id => !allowed.has(id))) throw new Error("Choose available items within the My day cap.");
}
function edit(state: AppState, command: Extract<MyDayCommand, { op: "edit" }>, date: string): void {
  const node = requiredNode(state, command.id);
  if (node.id === state.outline.id) throw new Error("Choose an area, project or task.");
  if (node.title !== command.before.title || node.weight !== command.before.weight || (node.dueDate ?? "") !== command.before.dueDate || node.focusMonth !== command.before.focusMonth) throw new Error("This outline item changed in another window. Refresh before saving your draft.");
  setOutlineFocus(state, node, command.focus, command.yes, date);
  node.title = command.title;
  node.weight = command.weight;
  if (command.dueDate) node.dueDate = command.dueDate;
  else delete node.dueDate;
}
/** `reopenable` makes an `outline-complete` of an open task return an undo receipt that My Day `undo` turns into a reopen. */
export function changeMyDay(args: { db: Database; desk: DeskOptions; now: number; date: string; requestId: string; command: MyDayCommand; source?: DeskItem; studio?: StudioProjection; reopenable?: boolean }): { view: MyDayView; undo?: string; notice?: string; outlineId?: string; location?: string } {
  const { db, desk, now, date, requestId, command, source, studio } = args;
  return db.transaction(() => {
    const meta = loadMeta(db);
    const state = loadMyDayState(db, desk, meta);
    const payload = JSON.stringify({ date, command });
    const receipt = meta.receipts.find(r => r.id === requestId);
    if (receipt) {
      if (receipt.payload !== payload) throw new Error("This request id was already used for another change.");
      if (command.op === "source-plan" && meta.planned.some(p => p.filing === requestId && p.reversed)) throw new Error("This planning was undone. The source is back in Catch-up; start a new plan if needed.");
      saveBalanceState(db, state);
      saveMeta(db, meta);
      return { view: withHandoffs(withLinks(db, viewOf(state, meta, desk, localDay(now), studio)), db, desk, now), ...(receipt.undo ? { undo: receipt.undo } : {}), ...(receipt.outlineId ? { outlineId: receipt.outlineId } : {}), ...(receipt.notice ? { notice: receipt.notice } : {}), ...(receipt.location ? { location: receipt.location } : {}) };
    }
    if (date !== localDay(now)) throw new Error("The date changed. Refresh the Desk before changing your day.");
    let undo: string | undefined;
    let outlineBefore: TodayItem[] | undefined;
    let outlineId: string | undefined;
    let location: string | undefined;
    let joined: string | undefined;
    let todayNotice: string | undefined;
    let unavailable: string[] = [];
    const today = (): TodayContext => ({ state, meta, date, rank: rankAll(configuredState(state, desk), date), requestId });
    const dayIds = (): string[] => state.dayState?.date === date ? [...state.dayState.confirmed] : viewOf(state, meta, desk, date, studio).items.map(item => item.task.id);
    const reopenable = args.reopenable === true && command.op === "outline-complete" && findNode(state.outline, command.id)?.done !== true;
    switch (command.op) {
      case "select": {
        if (command.revision !== meta.revision) throw new Error("Your day changed. Refresh before choosing a task.");
        const current = viewOf(state, meta, desk, date, studio);
        if (current.phase === "closed") throw new Error("This day is closed.");
        if (command.id !== null && !current.items.some(item => item.task.id === command.id)) throw new Error("That task is no longer actionable in this day.");
        meta.selection = command.id === null ? null : { date, id: command.id };
        break;
      }
      case "reorder": {
        if (command.revision !== meta.revision) throw new Error("Your day changed. Refresh before reshuffling.");
        const day = state.dayState;
        if (day?.date !== date || day.closed) throw new Error("Reshuffle an active confirmed day.");
        if (command.ids.length !== day.confirmed.length || new Set(command.ids).size !== command.ids.length || command.ids.some(id => !day.confirmed.includes(id))) throw new Error("Keep exactly the same tasks when reshuffling your day.");
        day.confirmed = [...command.ids];
        break;
      }
      case "source-plan":
        location = command.parent === null ? "Inbox" : balanceParents({ outline: state.outline }, desk.areas).find(p => p.id === command.parent)?.path;
        if (!location) throw new Error("Choose a currently configured area or open project. Your plan is kept.");
        outlineId = planSource({ state, meta, desk, command, source, requestId, date });
        break;
      case "source-unplan":
        outlineId = unplanSource({ state, meta, command, date });
        break;
      case "outline-add":
      case "outline-edit":
      case "outline-move":
      case "outline-file":
      case "outline-complete":
      case "outline-reopen":
      case "outline-remove": {
        outlineBefore = viewOf(state, meta, desk, date, studio).items;
        outlineId = applyBalanceCommand(state, meta, desk, date, command);
        const outlineAfter = viewOf(state, meta, desk, date, studio).items;
        unavailable = outlineBefore.filter(item => !outlineAfter.some(current => current.task.id === item.task.id)).map(item => item.task.title);
        if (command.op === "outline-add" && command.kind !== "project") joined = outlineId;
        break;
      }
      case "draft":
      case "start": {
        if (state.dayState?.date === date) throw new Error("Your day is already started.");
        validateSelection(configuredState(state, desk), date, command.ids);
        meta.draft = { date, ids: command.ids, origin: "person" };
        if (command.op === "start") {
          state.history = applyDayToHistory(configuredState(state, desk), date, command.ids);
          state.dayState = { date, confirmed: command.ids, closed: false };
        }
        break;
      }
      case "close": {
        if (state.dayState?.date !== date) throw new Error("Start the day first.");
        state.dayState.closed = true;
        break;
      }
      case "done": {
        if (studioOwned(meta, command.id)) throw new Error("Respond in the Studio to complete this task.");
        if (state.dayState?.date !== date || state.dayState.closed || !state.dayState.confirmed.includes(command.id)) throw new Error("Choose an item in your active day.");
        const node = requiredNode(state, command.id);
        if (node.done || state.log.some(event => event.taskId === node.id && event.date === date)) break;
        completeOutlineLeaf(state, node, date);
        break;
      }
      case "defer": {
        const current = viewOf(state, meta, desk, date, studio);
        if (current.phase === "closed" || !current.items.some(i => i.task.id === command.id)) throw new Error("Choose an item in My day.");
        const node = requiredNode(state, command.id);
        const after = shiftDays(date, 1);
        undo = requestId;
        meta.undos.push({ receipt: undo, taskId: node.id, date, ...(node.deferredUntil ? { before: node.deferredUntil } : {}), after, used: false });
        node.deferredUntil = after;
        break;
      }
      case "today-add":
      case "today-remove": {
        if (command.revision !== meta.revision) throw new Error("Your day changed. Refresh before changing today's priorities.");
        const outcome = command.op === "today-add" ? addToToday(today(), dayIds(), command.id, state.settings.todayCap, command.replace) : removeFromToday(today(), dayIds(), command.id);
        todayNotice = outcome.notice;
        undo = outcome.undo;
        break;
      }
      case "undo": {
        const restored = undoToday(today(), command.receipt);
        if (restored !== null) {
          todayNotice = restored;
          break;
        }
        const reopen = meta.reopens.find(r => r.receipt === command.receipt);
        if (reopen) {
          if (reopen.used) break;
          if (reopen.date !== date) throw new Error("This Undo belongs to a previous day.");
          const node = requiredNode(state, reopen.taskId);
          delete node.done;
          delete node.completedAt;
          reopen.used = true;
          todayNotice = `Reopened ${node.title}.`;
          break;
        }
        const previous = meta.undos.find(u => u.receipt === command.receipt);
        if (!previous || previous.used) break;
        if (previous.date !== date) throw new Error("This Undo belongs to a previous day.");
        const node = requiredNode(state, previous.taskId);
        if (node.deferredUntil !== previous.after) throw new Error("The task changed since Not today. Your newer edit is kept.");
        if (previous.before) node.deferredUntil = previous.before;
        else delete node.deferredUntil;
        previous.used = true;
        break;
      }
      case "todo": {
        const moved = meta.sources.find(s => s.fingerprint === command.fingerprint);
        if (moved) {
          outlineId = moved.taskId;
          break;
        }
        if (source?.key !== command.key) throw new Error("This source item is no longer on the Desk.");
        if (sourceIdentity(source) !== command.fingerprint) throw new Error("The source changed since you opened it. Refresh before moving it to your Inbox.");
        outlineId = todo(meta, source);
        break;
      }
      case "propose":
        if (state.dayState?.date === date) throw new Error("Your day is already started.");
        meta.draft = null;
        break;
      case "reset-caps":
        meta.caps = null;
        state.settings.todayCap = desk.myDay?.cap ?? 5;
        if (meta.draft?.date === date && state.dayState?.date !== date) meta.draft.ids = meta.draft.ids.slice(0, state.settings.todayCap);
        break;
      case "cap":
        meta.caps = { cap: command.cap, topN: meta.caps?.topN ?? desk.topN };
        state.settings.todayCap = command.cap;
        if (meta.draft?.date === date && state.dayState?.date !== date) meta.draft.ids = meta.draft.ids.slice(0, command.cap);
        break;
      case "topN":
        meta.caps = { cap: todayCap(meta, desk), topN: command.topN };
        break;
      case "file": {
        fileBalanceInbox(state, meta, desk, command.id, command.parent);
        break;
      }
      case "add": {
        const parent = outlineDestination(state, desk, command.parent);
        const added: OutlineNode = { id: crypto.randomUUID(), title: command.title, weight: 50, ordering: "parallel", children: [], ...(command.kind === "task" ? { effort: 1 } : { done: true }) };
        parent.children.push(added);
        if (command.kind === "task") joined = added.id;
        break;
      }
      case "edit":
        if (studioOwned(meta, command.id) && requiredNode(state, command.id).title !== command.title) throw new Error("Edit this title in its Studio thread file.");
        if (!findNode(configuredState(state, desk).outline, command.id)) throw new Error("That area is no longer configured.");
        edit(state, command, date);
        break;
    }
    if (reopenable) {
      undo = requestId;
      meta.reopens.push({ receipt: requestId, taskId: command.id, date, used: false });
    }
    if (joined && state.dayState?.date !== date && !isPersonDraft(meta, date)) {
      if (selectToday(configuredState(state, desk), date).some(item => item.task.id === joined)) todayNotice = `Added ${requiredNode(state, joined).title} to today's proposal.`;
    } else if (joined) {
      const outcome = joinToday(today(), dayIds(), joined, state.settings.todayCap);
      todayNotice = outcome.notice;
      undo = outcome.undo;
    }
    retireStaleDraft(meta, date);
    meta.revision += 1;
    const view = withHandoffs(withLinks(db, viewOf(state, meta, desk, date, studio)), db, desk, now);
    const notice = [unavailable.length ? `${unavailable.join(", ")} ${unavailable.length === 1 ? "is" : "are"} no longer actionable in today's list.` : undefined, todayNotice].filter(Boolean).join(" ") || undefined;
    meta.receipts.push({ id: requestId, payload, ...(location ? { location } : {}), ...(undo ? { undo } : {}), ...(outlineId ? { outlineId } : {}), ...(notice ? { notice } : {}) });
    saveBalanceState(db, state);
    saveMeta(db, meta);
    return { view, ...(location ? { location } : {}), ...(undo ? { undo } : {}), ...(outlineId ? { outlineId } : {}), ...(notice ? { notice } : {}) };
  }).immediate();
}
