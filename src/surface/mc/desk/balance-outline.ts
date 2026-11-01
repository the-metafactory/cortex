import { ancestorIndex, findNode, findParent, MAX_FOCUS_PER_MONTH, type AppState, type OutlineNode } from "../../../balance";
import type { BalanceCommand } from "./balance-command";
import type { DeskOptions } from "./compose";
import type { MyDayMeta } from "./my-day-schema";
import { studioOwned } from "./studio-outline";

function focusCount(node: OutlineNode, month: string): number {
  return Number(node.focusMonth === month) + node.children.reduce((sum, child) => sum + focusCount(child, month), 0);
}
export function setOutlineFocus(state: AppState, node: OutlineNode, focus: boolean, yes: boolean, date: string): void {
  const month = date.slice(0, 7);
  if (focus && node.focusMonth !== month) {
    if (node.children.length === 0 || (ancestorIndex(state.outline).get(node.id)?.length ?? 0) < 2) throw new Error("Focus belongs to a project with tasks.");
    if (!yes) throw new Error("Answer the Yes-filter before choosing a new focus project.");
    if (focusCount(state.outline, month) >= MAX_FOCUS_PER_MONTH) throw new Error("At most three projects can be in focus this month.");
  }
  if (focus) node.focusMonth = month;
  else delete node.focusMonth;
}
export function completeOutlineLeaf(state: AppState, node: OutlineNode, date: string): void {
  if (node.children.length > 0) throw new Error("Only a task without subtasks can receive completion credit. Refresh My day to see its current state.");
  const area = ancestorIndex(state.outline).get(node.id)?.[1];
  if (!area) throw new Error("This task needs an area.");
  node.done = true;
  node.completedAt = date;
  if (state.log.some(event => event.taskId === node.id && event.date === date)) return;
  if (node.repeat) node.repeat.timesDone = (node.repeat.timesDone ?? 0) + 1;
  state.log.push({ taskId: node.id, areaId: area.id, effort: node.effort ?? 1, date, title: node.title });
}
function configuredNode(state: AppState, desk: DeskOptions, id: string, target: "item" | "parent" = "item"): OutlineNode {
  for (const area of state.outline.children) {
    if (!desk.areas.some(a => area.id === `area:${a.id}`)) continue;
    const found = findNode(area, id);
    if (found) return found;
  }
  throw new Error(`That outline ${target} is unavailable or its area is no longer configured.`);
}
function isArea(state: AppState, node: OutlineNode): boolean {
  return state.outline.children.includes(node);
}
export function outlineDestination(state: AppState, desk: DeskOptions, id: string): OutlineNode {
  const parent = configuredNode(state, desk, id, "parent");
  if ((parent.effort && parent.children.length === 0) || (parent.done && parent.children.length > 0)) throw new Error("Choose an area or open project as the parent.");
  delete parent.done;
  return parent;
}
export function fileBalanceInbox(state: AppState, meta: MyDayMeta, desk: DeskOptions, id: string, parentId: string): void {
  const index = meta.inbox.findIndex(node => node.id === id);
  const node = meta.inbox[index];
  if (!node) throw new Error("This Inbox item was already filed.");
  const parent = outlineDestination(state, desk, parentId);
  parent.children.push(node);
  meta.inbox.splice(index, 1);
}
function hasStudioOwner(node: OutlineNode, meta: MyDayMeta): boolean {
  return studioOwned(meta, node.id) || node.children.some(child => hasStudioOwner(child, meta));
}
function preserveFocusProject(parent: OutlineNode, date: string): void {
  if (parent.children.length === 1 && parent.focusMonth === date.slice(0, 7)) throw new Error("Remove monthly focus first, then move or remove this project's last child.");
}
function openParent(state: AppState, desk: DeskOptions, meta: MyDayMeta, id: string): OutlineNode {
  const node = configuredNode(state, desk, id, "parent");
  if (node.id.startsWith("studio-response:") || (node.done && (node.children.length > 0 || node.effort !== undefined || studioOwned(meta, node.id)))) throw new Error("Choose an available area or open project, or reopen the task first.");
  return node;
}
export function applyBalanceCommand(state: AppState, meta: MyDayMeta, desk: DeskOptions, date: string, command: BalanceCommand): string {
  if (command.revision !== meta.revision) throw new Error("The outline changed in another window or source. Your draft is kept; reload the latest outline before saving again.");
  if (command.op === "outline-file") {
    fileBalanceInbox(state, meta, desk, command.id, command.parent);
    return command.id;
  }
  if (command.op === "outline-add") {
    const parent = openParent(state, desk, meta, command.parent);
    delete parent.done;
    const node: OutlineNode = { id: crypto.randomUUID(), title: command.title, weight: 50, ordering: "parallel", children: [], effort: 1 };
    parent.children.push(node);
    return node.id;
  }
  const node = configuredNode(state, desk, command.id);
  if (command.op === "outline-edit") {
    const details = command.details;
    if ((isArea(state, node) || studioOwned(meta, node.id)) && details.title !== node.title) throw new Error("This title belongs to its configured area or Studio source. Edit it there.");
    setOutlineFocus(state, node, details.focus, command.yes, date);
    node.title = details.title;
    node.weight = details.weight;
    node.ordering = details.ordering;
    node.note = details.note;
    if (details.context) node.context = details.context;
    else delete node.context;
    if (details.dueDate) node.dueDate = details.dueDate;
    else delete node.dueDate;
    if (!isArea(state, node) && node.children.length === 0) node.effort = details.effort;
    if (details.estimateMinutes !== null) node.estimateMinutes = details.estimateMinutes;
    else delete node.estimateMinutes;
    return node.id;
  }
  if (isArea(state, node)) throw new Error("Configured areas stay at the root. Pause their importance instead.");
  if (hasStudioOwner(node, meta)) throw new Error("This item belongs to Studio. Change its state or location in Studio.");
  if (command.op === "outline-complete") {
    if (node.done) return node.id;
    if (node.children.length > 0) node.done = true;
    else completeOutlineLeaf(state, node, date);
    return node.id;
  }
  if (command.op === "outline-reopen") {
    delete node.done;
    delete node.completedAt;
    return node.id;
  }
  const parent = findParent(state.outline, node.id);
  if (!parent) throw new Error("The parent is no longer available.");
  if (command.op === "outline-remove") {
    if (node.children.length || meta.sources.some(source => source.taskId === node.id) || state.log.some(event => event.taskId === node.id)) throw new Error("Only empty items without source links or completion history can be removed.");
    preserveFocusProject(parent, date);
    parent.children = parent.children.filter(child => child.id !== node.id);
    return node.id;
  }
  const next = openParent(state, desk, meta, command.parent);
  if (findNode(node, next.id)) throw new Error("An item cannot move below itself or one of its descendants.");
  if (parent === next) return node.id;
  preserveFocusProject(parent, date);
  parent.children = parent.children.filter(child => child.id !== node.id);
  delete next.done;
  next.children.push(node);
  return node.id;
}
