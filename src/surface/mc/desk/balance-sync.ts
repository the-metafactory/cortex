import type { Database } from "bun:sqlite";
import { DEFAULT_SETTINGS, applyRecurrence, collectLeaves, findNode, type AppState } from "../../../balance";
import { loadBalanceState, saveBalanceState } from "./balance-store";
import { MyDayMetaSchema, type MyDayMeta } from "./my-day-schema";
import { projectStudio, type StudioProjection } from "./studio-outline";
import { localDay } from "./time";
import type { DeskOptions } from "./compose";

const ROOT_ID = "desk:outline";
export function loadMeta(db: Database): MyDayMeta {
  const row = db.query<{ data: string }, []>("SELECT data FROM desk_my_day WHERE id = 1").get();
  return MyDayMetaSchema.parse(row ? JSON.parse(row.data) : {});
}
export function saveMeta(db: Database, meta: MyDayMeta): void {
  db.query("INSERT INTO desk_my_day (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(meta));
}
function initial(desk: DeskOptions): AppState {
  return { outline: { id: ROOT_ID, title: "Outline", weight: 100, ordering: "parallel", children: [
    ...desk.areas.map(a => ({ id: `area:${a.id}`, title: a.label, weight: 50, ordering: "parallel" as const, children: [] })),
  ] }, log: [], settings: { ...DEFAULT_SETTINGS, todayCap: desk.myDay?.cap ?? 5 }, dayState: null, history: { deficits: {}, lastSurfaced: {} } };
}
export function todayCap(meta: MyDayMeta, desk: DeskOptions): number {
  return meta.caps?.cap ?? desk.myDay?.cap ?? 5;
}
export function isPersonDraft(meta: MyDayMeta, date: string): meta is MyDayMeta & { draft: NonNullable<MyDayMeta["draft"]> } {
  return meta.draft?.date === date && meta.draft.origin === "person";
}
export function retireStaleDraft(meta: MyDayMeta, date: string): void {
  if (meta.draft && !isPersonDraft(meta, date)) meta.draft = null;
}
export function loadMyDayState(db: Database, desk: DeskOptions, meta: MyDayMeta): AppState {
  const state = loadBalanceState(db) ?? initial(desk);
  state.settings.todayCap = todayCap(meta, desk);
  return state;
}
export function configuredState(state: AppState, desk: DeskOptions): AppState {
  const ids = new Set(desk.areas.map(a => `area:${a.id}`));
  return { ...state, outline: { ...state.outline, children: state.outline.children.filter(n => ids.has(n.id)) } };
}
export function syncBalance(db: Database, desk: DeskOptions, now: number, studio?: StudioProjection): void {
  db.transaction(() => {
    const date = localDay(now);
    const meta = loadMeta(db);
    const saved = loadBalanceState(db);
    const state = saved ?? initial(desk);
    const beforeState = JSON.stringify(state);
    const beforeMeta = JSON.stringify(meta);
    for (const area of desk.areas) {
      const existing = findNode(state.outline, `area:${area.id}`);
      if (existing) existing.title = area.label;
      else state.outline.children.push({ id: `area:${area.id}`, title: area.label, weight: 50, ordering: "parallel", children: [] });
    }
    if (studio) projectStudio(state, meta, studio);
    const completedToday = new Set(state.log.filter(event => event.date === date).map(event => event.taskId));
    for (const task of collectLeaves(state.outline)) if (!completedToday.has(task.id)) applyRecurrence(task, date);
    retireStaleDraft(meta, date);
    state.settings.todayCap = todayCap(meta, desk);
    const stateChanged = JSON.stringify(state) !== beforeState;
    const metaChanged = JSON.stringify(meta) !== beforeMeta;
    if (stateChanged || metaChanged) meta.revision += 1;
    if (!saved || stateChanged) saveBalanceState(db, state);
    if (stateChanged || metaChanged) saveMeta(db, meta);
  }).immediate();
}
