import type { Database } from "bun:sqlite";
import { findNode } from "../../../balance";
import type { OutlineNode } from "../../../balance/core/types";
import type { WorkKind, WorkObject, WorkRead, WorkReader, WorkReaders } from "../../../conversations/tools/work-context";
import type { Policy } from "../../../conversations/types";
import { loadBalanceState } from "./balance-store";
import type { DeskOptions } from "./compose";
import type { StudioView } from "./studio/view";
import type { DeskItem } from "./types";

export interface WorkReaderDeps {
  db: Database;
  desk: () => DeskOptions | undefined;
  studioView: (desk: DeskOptions) => Promise<StudioView> | null;
  deskItems?: () => Promise<DeskItem[]>;
  now: () => number;
}

const NOT_AUTHORIZED: WorkRead = { state: "unavailable", reason: "unauthorized" };
const GONE: WorkRead = { state: "unavailable", reason: "gone" };
const matches = (query: string, object: WorkObject): boolean => {
  const haystack = `${object.title}\n${object.summary}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(term => haystack.includes(term));
};
const page = (all: WorkObject[], query: string, limit: number, offset: number) => {
  const hits = all.filter(object => matches(query, object));
  return { items: hits.slice(offset, offset + limit), more: hits.length > offset + limit };
};
const reader = (all: () => Promise<WorkObject[]>, one: (id: string) => Promise<WorkRead>): WorkReader => ({
  search: async (query, limit, offset) => page(await all(), query, limit, offset),
  read: one,
});

export function workReaders(deps: WorkReaderDeps): WorkReaders {
  const studio = async (): Promise<WorkObject[]> => {
    const desk = deps.desk();
    const view = desk ? deps.studioView(desk) : null;
    if (!desk || !view) return [];
    const { active, parked, closed } = await view;
    const at = deps.now();
    return [...active, ...parked, ...closed].map(t => ({
      kind: "studio-thread" as const, id: t.slug, title: t.question, status: t.state, policy: t.policy,
      area: t.areas.join(", ") || null, url: `?desk=studio&thread=${encodeURIComponent(t.slug)}`, observedAt: at,
      summary: [`Where I stand: ${t.stand}`, t.outcomeText].filter(Boolean).join("\n"),
    }));
  };
  const balance = (kind: "balance-task" | "balance-project"): (() => WorkObject[]) => () => {
    const desk = deps.desk();
    const state = desk?.enabled ? loadBalanceState(deps.db) : null;
    if (!desk || !state) return [];
    const at = deps.now();
    const found: WorkObject[] = [];
    const walk = (node: OutlineNode, area: { id: string; label: string; policy?: Policy }): void => {
      for (const child of node.children) {
        if ((child.children.length ? "balance-project" : "balance-task") === kind) found.push(balanceObject(kind, child, area, at));
        walk(child, area);
      }
    };
    for (const root of state.outline.children) {
      const area = desk.areas.find(a => root.id === `area:${a.id}`);
      if (area) walk(root, area);
    }
    return found;
  };
  const balanceOne = (kind: "balance-task" | "balance-project") => (id: string): Promise<WorkRead> => {
    const desk = deps.desk();
    if (!desk?.enabled) return Promise.resolve(NOT_AUTHORIZED);
    const state = loadBalanceState(deps.db);
    if (!state) return Promise.resolve(GONE);
    for (const root of state.outline.children) {
      const node = findNode(root, id);
      if (!node || node === root) continue;
      const area = desk.areas.find(a => root.id === `area:${a.id}`);
      if (!area) return Promise.resolve(NOT_AUTHORIZED);
      if ((node.children.length ? "balance-project" : "balance-task") !== kind) return Promise.resolve(GONE);
      return Promise.resolve({ state: "available", object: balanceObject(kind, node, area, deps.now()) });
    }
    return Promise.resolve(GONE);
  };
  const items = async (): Promise<WorkObject[]> => {
    const desk = deps.desk();
    if (!desk?.enabled || !deps.deskItems) return [];
    const at = deps.now();
    return (await deps.deskItems()).map(item => {
      const area = desk.areas.find(a => a.id === item.area);
      return {
        kind: "desk-item" as const, id: item.key, title: item.title, status: item.dueAt ? `${item.urgency}, due ${item.dueAt}` : item.urgency,
        policy: area?.policy ?? (area ? "cloud" : "local"), area: area?.label ?? null, url: `?desk=day&item=${encodeURIComponent(item.key)}`, observedAt: at,
        summary: [item.why, item.detail.summary].filter(Boolean).join("\n"),
      };
    });
  };
  const readers: WorkReaders = {};
  const studioOne = async (id: string): Promise<WorkRead> => {
    const desk = deps.desk();
    if (!desk || !deps.studioView(desk)) return NOT_AUTHORIZED;
    const object = (await studio()).find(o => o.id === id);
    return object ? { state: "available", object } : GONE;
  };
  const itemOne = async (id: string): Promise<WorkRead> => {
    const desk = deps.desk();
    if (!desk?.enabled) return NOT_AUTHORIZED;
    const object = (await items()).find(o => o.id === id);
    return object ? { state: "available", object } : GONE;
  };
  if (deps.desk()?.studio) readers["studio-thread"] = reader(studio, studioOne);
  readers["balance-task"] = reader(() => Promise.resolve(balance("balance-task")()), balanceOne("balance-task"));
  readers["balance-project"] = reader(() => Promise.resolve(balance("balance-project")()), balanceOne("balance-project"));
  if (deps.deskItems) readers["desk-item"] = reader(items, itemOne);
  return readers;
}

function balanceObject(kind: WorkKind, node: OutlineNode, area: { id: string; label: string; policy?: Policy }, at: number): WorkObject {
  const facts = [node.note, node.dueDate ? `Due ${node.dueDate}` : "", `${node.children.length ? "Project" : "Task"} in ${area.label}`].filter(Boolean);
  return { kind, id: node.id, title: node.title, status: node.done ? "done" : "open", policy: area.policy ?? "cloud", area: area.label, url: `?desk=balance&node=${encodeURIComponent(node.id)}`, observedAt: at, summary: facts.join("\n") };
}
