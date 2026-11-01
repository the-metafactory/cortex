import { projectStudio, studioLinks, studioOwned, type StudioProjection } from "./studio-outline";
import { DEFAULT_YES_FILTER } from "./yes-filter";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { DEFAULT_SETTINGS, MAX_FOCUS_PER_MONTH, ancestorIndex, applyDayToHistory, applyRecurrence, collectLeaves, findNode, rankAll, selectToday, shiftDays, type AppState, type OutlineNode, type TodayItem } from "../../../balance";
import { loadBalanceState, saveBalanceState } from "./balance-store";
import { MyDayMetaSchema, type MyDayCommand, type MyDayMeta } from "./my-day-schema";
import type { DeskOptions } from "./compose";
import type { DeskItem } from "./types";

const ROOT_ID = "desk:outline";
export const localDay = (now: number): string => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function loadMeta(db: Database): MyDayMeta {
  const row = db.query<{ data: string }, []>("SELECT data FROM desk_my_day WHERE id = 1").get();
  return MyDayMetaSchema.parse(row ? JSON.parse(row.data) : {});
}
function saveMeta(db: Database, meta: MyDayMeta): void {
  db.query("INSERT INTO desk_my_day (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(meta));
}
function initial(desk: DeskOptions): AppState {
  return { outline: { id: ROOT_ID, title: "Outline", weight: 100, ordering: "parallel", children: [
    ...desk.areas.map(a => ({ id: `area:${a.id}`, title: a.label, weight: 50, ordering: "parallel" as const, children: [] })),
  ] }, log: [], settings: { ...DEFAULT_SETTINGS, todayCap: desk.myDay?.cap ?? 5 }, dayState: null, history: { deficits: {}, lastSurfaced: {} } };
}
function stateFor(db: Database, desk: DeskOptions, date: string, meta: MyDayMeta, studio?: StudioProjection): AppState {
  const state = loadBalanceState(db) ?? initial(desk);
  for (const area of desk.areas) {
    const existing = findNode(state.outline, `area:${area.id}`);
    if (existing) existing.title = area.label;
    else state.outline.children.push({ id: `area:${area.id}`, title: area.label, weight: 50, ordering: "parallel", children: [] });
  }
  if (studio) projectStudio(state, meta, studio);
  const completedToday = new Set(state.log.filter(event => event.date === date).map(event => event.taskId));
  for (const task of collectLeaves(state.outline)) if (!completedToday.has(task.id)) applyRecurrence(task, date);
  return state;
}
export interface MyDayView {
  studioStatus: "synced" | "unavailable" | "disabled";
  studioTasks: { id: string; slug: string }[];
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
  sources: MyDayMeta["sources"];
  yesFilter: string[];
  undos: { receipt: string; title: string }[];
}
function configuredState(state: AppState, desk: DeskOptions): AppState {
  const ids = new Set(desk.areas.map(a => `area:${a.id}`));
  return { ...state, outline: { ...state.outline, children: state.outline.children.filter(n => ids.has(n.id)) } };
}
function engineDraft(state: AppState, desk: DeskOptions, date: string, studio?: StudioProjection): NonNullable<MyDayMeta["draft"]> {
  return { date, ids: selectToday(configuredState(state, desk), date).map(i => i.task.id), origin: desk.studio && !studio ? "studio-unavailable" : "engine" };
}
function viewOf(storedState: AppState, meta: MyDayMeta, desk: DeskOptions, date: string, studio?: StudioProjection): MyDayView {
  const state = configuredState(storedState, desk);
  const day = state.dayState?.date === date ? state.dayState : null;
  const all = rankAll(state, date);
  const ids = day?.confirmed ?? (meta.draft?.date === date ? meta.draft.ids : selectToday(state, date).map(i => i.task.id));
  const visibleIds = day ? ids : ids.slice(0, state.settings.todayCap);
  const byId = new Map(all.map(i => [i.task.id, i]));
  return {
    studioStatus: !desk.studio ? "disabled" : studio ? "synced" : "unavailable",
    studioTasks: studioLinks(meta),
    configuredCaps: { cap: desk.myDay?.cap ?? 5, topN: desk.topN }, capsOverridden: meta.caps !== null,
    revision: meta.revision, inbox: meta.inbox,
    date, phase: day ? day.closed ? "closed" : "started" : "proposed", cap: state.settings.todayCap, topN: meta.caps?.topN ?? desk.topN,
    items: visibleIds.flatMap(id => { const item = byId.get(id); return item ? [item] : []; }),
    alternates: all.filter(i => !visibleIds.includes(i.task.id)).slice(0, 3),
    wins: state.log.filter(e => e.date === date).map(({ taskId, title }) => ({ taskId, title })),
    undos: meta.undos.filter(u => !u.used && u.date === date).map(u => ({ receipt: u.receipt, title: findNode(state.outline, u.taskId)?.title ?? "Task" })),
    outline: state.outline, sources: meta.sources, yesFilter: desk.studio?.yesFilter?.length ? [...desk.studio.yesFilter] : [...DEFAULT_YES_FILTER],
  };
}
export function readMyDay(db: Database, desk: DeskOptions, now: number, studio?: StudioProjection): MyDayView {
  return db.transaction(() => {
    const date = localDay(now);
    const meta = loadMeta(db);
    const state = stateFor(db, desk, date, meta, studio);
    state.settings.todayCap = meta.caps?.cap ?? desk.myDay?.cap ?? 5;
    if (state.dayState?.date !== date && (meta.draft?.date !== date || (studio?.namespace && meta.draft.origin === "studio-unavailable" && !meta.draft.ids.length))) meta.draft = engineDraft(state, desk, date, studio);
    saveMeta(db, meta);
    saveBalanceState(db, state);
    return viewOf(state, meta, desk, date, studio);
  }).immediate();
}
export function sourceIdentity(item: DeskItem): string {
  const sourceFacts = [item.key, item.kind, item.source, item.sourceRevision ?? null, item.dueAt ?? null, item.detail.refs];
  const identity = item.kind === "mail" ? sourceFacts : [...sourceFacts, item.title, item.detail.summary];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
export function movedKeys(db: Database): Set<string> {
  return new Set(loadMeta(db).sources.map(s => s.fingerprint));
}
function requiredNode(state: AppState, id: string): OutlineNode {
  const node = findNode(state.outline, id);
  if (!node) throw new Error("That outline item no longer exists.");
  return node;
}
function destination(state: AppState, desk: DeskOptions, id: string): OutlineNode {
  const parent = requiredNode(state, id);
  if (!findNode(configuredState(state, desk).outline, parent.id) || parent.id === state.outline.id || parent.effort || (parent.done && parent.children.length > 0)) throw new Error("Choose an area or open project as the parent.");
  delete parent.done;
  return parent;
}
function validateSelection(state: AppState, date: string, ids: string[]): void {
  const allowed = new Set(rankAll(state, date).map(i => i.task.id));
  if (new Set(ids).size !== ids.length || ids.length > state.settings.todayCap || ids.some(id => !allowed.has(id))) throw new Error("Choose available items within the My day cap.");
}
function todo(meta: MyDayMeta, item: DeskItem): void {
  if (meta.sources.some(s => s.fingerprint === sourceIdentity(item))) return;
  const id = `todo:${crypto.randomUUID()}`;
  const url = item.detail.links[0]?.url;
  meta.inbox.push({ id, title: item.title, weight: 50, ordering: "parallel", children: [], effort: 1,
    note: `From ${item.source}: ${item.key}${url ? `\n${url}` : ""}`,
    ...(item.dueAt ? { dueDate: /^\d{4}-\d{2}-\d{2}$/.test(item.dueAt) ? item.dueAt : localDay(Date.parse(item.dueAt)) } : {}),
  });
  meta.sources.push({ taskId: id, key: item.key, fingerprint: sourceIdentity(item), kind: item.kind, ...(url ? { url } : {}) });
}
function edit(state: AppState, command: Extract<MyDayCommand, { op: "edit" }>, date: string): void {
  const node = requiredNode(state, command.id);
  if (node.id === state.outline.id) throw new Error("Choose an area, project or task.");
  if (node.title !== command.before.title || node.weight !== command.before.weight || (node.dueDate ?? "") !== command.before.dueDate || node.focusMonth !== command.before.focusMonth) throw new Error("This outline item changed in another window. Refresh before saving your draft.");
  const month = date.slice(0, 7);
  const isNewFocus = command.focus && node.focusMonth !== month;
  if (isNewFocus) {
    if (node.children.length === 0 || (ancestorIndex(state.outline).get(node.id)?.length ?? 0) < 2) throw new Error("Focus belongs to a project with tasks.");
    if (!command.yes) throw new Error("Answer the Yes-filter before choosing a new focus project.");
    if (rankFocus(state.outline, month) >= MAX_FOCUS_PER_MONTH) throw new Error("At most three projects can be in focus this month.");
  }
  node.title = command.title;
  node.weight = command.weight;
  if (command.dueDate) node.dueDate = command.dueDate;
  else delete node.dueDate;
  if (command.focus) node.focusMonth = month;
  else delete node.focusMonth;
}
function rankFocus(node: OutlineNode, month: string): number {
  return Number(node.focusMonth === month) + node.children.reduce((n, child) => n + rankFocus(child, month), 0);
}
export function changeMyDay(args: { db: Database; desk: DeskOptions; now: number; date: string; requestId: string; command: MyDayCommand; source?: DeskItem; studio?: StudioProjection }): { view: MyDayView; undo?: string } {
  const { db, desk, now, date, requestId, command, source, studio } = args;
  return db.transaction(() => {
    const meta = loadMeta(db);
    const state = stateFor(db, desk, localDay(now), meta, studio);
    state.settings.todayCap = meta.caps?.cap ?? desk.myDay?.cap ?? 5;
    const payload = JSON.stringify({ date, command });
    const receipt = meta.receipts.find(r => r.id === requestId);
    if (receipt) {
      if (receipt.payload !== payload) throw new Error("This request id was already used for another change.");
      saveBalanceState(db, state);
      saveMeta(db, meta);
      return { view: viewOf(state, meta, desk, localDay(now), studio), ...(receipt.undo ? { undo: receipt.undo } : {}) };
    }
    if (date !== localDay(now)) throw new Error("The date changed. Refresh the Desk before changing your day.");
    state.settings.todayCap = meta.caps?.cap ?? desk.myDay?.cap ?? 5;
    let undo: string | undefined;
    switch (command.op) {
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
        const area = ancestorIndex(state.outline).get(node.id)?.[1];
        if (!area) throw new Error("This task needs an area.");
        node.done = true;
        node.completedAt = date;
        if (node.repeat) node.repeat.timesDone = (node.repeat.timesDone ?? 0) + 1;
        state.log.push({ taskId: node.id, areaId: area.id, effort: node.effort ?? 1, date, title: node.title });
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
      case "undo": {
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
      case "todo":
        if (meta.sources.some(s => s.fingerprint === command.fingerprint)) break;
        if (source?.key !== command.key) throw new Error("This source item is no longer on the Desk.");
        if (sourceIdentity(source) !== command.fingerprint) throw new Error("The source changed since you opened it. Refresh before moving it to your Inbox.");
        todo(meta, source);
        break;
      case "propose":
        if (state.dayState?.date === date) throw new Error("Your day is already started.");
        meta.draft = engineDraft(state, desk, date, studio);
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
        meta.caps = { cap: meta.caps?.cap ?? desk.myDay?.cap ?? 5, topN: command.topN };
        break;
      case "file": {
        const index = meta.inbox.findIndex(n => n.id === command.id);
        const node = meta.inbox[index];
        if (!node) throw new Error("This Inbox item was already filed.");
        const parent = destination(state, desk, command.parent);
        parent.children.push(node);
        meta.inbox.splice(index, 1);
        break;
      }
      case "add": {
        const parent = destination(state, desk, command.parent);
        parent.children.push({ id: crypto.randomUUID(), title: command.title, weight: 50, ordering: "parallel", children: [], ...(command.kind === "task" ? { effort: 1 } : { done: true }) });
        break;
      }
      case "edit":
        if (studioOwned(meta, command.id) && requiredNode(state, command.id).title !== command.title) throw new Error("Edit this title in its Studio thread file.");
        if (!findNode(configuredState(state, desk).outline, command.id)) throw new Error("That area is no longer configured.");
        edit(state, command, date);
        break;
    }
    if ((command.op === "add" || command.op === "file") && !meta.draft?.ids.length && state.dayState?.date !== date) meta.draft = engineDraft(state, desk, date, studio);
    meta.revision += 1;
    meta.receipts.push({ id: requestId, payload, ...(undo ? { undo } : {}) });
    saveBalanceState(db, state);
    saveMeta(db, meta);
    return { view: viewOf(state, meta, desk, date, studio), ...(undo ? { undo } : {}) };
  }).immediate();
}
