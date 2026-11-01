import { createHash } from "node:crypto";
import { findNode, type AppState, type OutlineNode } from "../../../balance";
import type { MyDayMeta } from "./my-day-schema";
import { responseCoverage, lastResponseCoverage } from "./studio/response";
import type { StudioThread } from "./studio/format";

export interface StudioProjection {
  namespace: string;
  areas?: string[];
  threads: StudioThread[];
}
export const studioNamespace = (directory: string): string => createHash("sha256").update(directory).digest("hex");
export function studioOwned(meta: MyDayMeta, id: string): boolean {
  return meta.studio.some(s => s.projectId === id || s.pending?.id === id) || id.startsWith("studio-response:");
}
function move(root: OutlineNode, id: string, parent: OutlineNode): void {
  const remove = (node: OutlineNode): OutlineNode | undefined => {
    const index = node.children.findIndex(c => c.id === id);
    if (index >= 0) return node.children.splice(index, 1)[0];
    for (const child of node.children) { const found = remove(child); if (found) return found; }
    return undefined;
  };
  if (parent.children.some(c => c.id === id)) return;
  const node = remove(root);
  if (node) parent.children.push(node);
}
type ProjectionEntry = MyDayMeta["studio"][number];
function responseTask(project: OutlineNode, entry: ProjectionEntry, thread: StudioThread, at: number): OutlineNode {
  entry.pending ??= { id: `studio-response:${crypto.randomUUID()}`, at };
  let task = findNode(project, entry.pending.id);
  if (!task) {
    task = { id: entry.pending.id, title: `Respond to Ivy on ${thread.question}`, weight: 50, ordering: "parallel", children: [], effort: 1 };
    project.children.push(task);
  }
  return task;
}
function completion(state: AppState, entry: ProjectionEntry, thread: StudioThread, project: OutlineNode, area: OutlineNode): void {
  const responses = thread.responses.filter(r => r.text.trim() && responseCoverage(thread, r) > entry.response).sort((a, b) => responseCoverage(thread, a) - responseCoverage(thread, b));
  for (const response of responses) {
    const time = responseCoverage(thread, response);
    const note = thread.notes.find(n => !n.sample && Date.parse(n.at) > entry.response && Date.parse(n.at) <= time);
    if ((entry.pending && entry.pending.at <= time) || note) {
      const task = responseTask(project, entry, thread, note ? Date.parse(note.at) : time);
      const at = new Date(response.at);
      const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
      task.done = true;
      task.completedAt = date;
      if (!state.log.some(e => e.taskId === task.id)) state.log.push({ taskId: task.id, areaId: area.id, effort: task.effort ?? 1, date, title: task.title });
      entry.pending = null;
    }
    entry.response = time;
  }
}
export function projectStudio(state: AppState, meta: MyDayMeta, input: StudioProjection): void {
  for (const entry of meta.studio) {
    const project = findNode(state.outline, entry.projectId);
    if (project) project.done = true;
  }
  const counts = new Map<string, number>();
  for (const thread of input.threads) if (thread.id) counts.set(thread.id, (counts.get(thread.id) ?? 0) + 1);
  for (const thread of input.threads) {
    if (thread.id && counts.get(thread.id) !== 1) continue;
    const source = thread.id ? `id:${thread.id}` : `path:${thread.path}`;
    const latestResponse = lastResponseCoverage(thread);
    let entry = meta.studio.find(s => s.namespace === input.namespace && s.source === source);
    if (!entry) {
      entry = { namespace: input.namespace, source, slug: thread.slug, projectId: `studio-thread:${crypto.randomUUID()}`, response: latestResponse, pending: null };
      meta.studio.push(entry);
    }
    entry.slug = thread.slug;
    const area = findNode(state.outline, `area:${thread.areas[0] ?? ""}`);
    const configured = area && state.outline.children.includes(area) && (!input.areas || input.areas.includes(thread.areas[0] ?? ""));
    let project = findNode(state.outline, entry.projectId);
    if (!project && configured) {
      project = { id: entry.projectId, title: thread.question, weight: 50, ordering: "parallel", children: [], done: true };
      area.children.push(project);
    }
    if (project && configured) {
      if (entry.pending) move(state.outline, entry.pending.id, project);
      completion(state, entry, thread, project, area);
    }
    if (thread.state !== "active" || !configured) continue;
    if (!project) continue;
    const current = project;
    move(state.outline, current.id, area);
    current.title = thread.question;
    const unanswered = thread.notes.filter(n => !n.sample && Date.parse(n.at) > entry.response).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const first = unanswered[0];
    if (first) {
      if (entry.pending) move(state.outline, entry.pending.id, current);
      const task = responseTask(current, entry, thread, Date.parse(first.at));
      task.title = `Respond to Ivy on ${thread.question}`;
      task.done = false;
      delete task.completedAt;
    } else if (entry.pending) {
      const task = findNode(current, entry.pending.id);
      if (task) task.done = true;
      entry.pending = null;
    }
    current.done = current.children.length === 0;
  }
}
export function studioLinks(meta: MyDayMeta): { id: string; slug: string }[] {
  return meta.studio.flatMap(s => s.pending ? [{ id: s.pending.id, slug: s.slug }] : []);
}
