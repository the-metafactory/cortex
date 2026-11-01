import { balanceNodeSnapshot } from "./balance-store-schema";
import {
  findNode,
  findParent,
  type AppState,
  type OutlineNode,
} from "../../../balance";
import type { DeskOptions } from "./compose";
import type { MyDayCommand, MyDayMeta } from "./my-day-schema";
import type { DeskItem } from "./types";
import { outlineDestination } from "./balance-outline";
import { sourceIdentity, todo } from "./source-task";

export function planSource({
  state,
  meta,
  desk,
  command,
  source,
  requestId,
  date,
}: {
  state: AppState;
  meta: MyDayMeta;
  desk: DeskOptions;
  command: Extract<MyDayCommand, { op: "source-plan" }>;
  source?: DeskItem;
  requestId: string;
  date: string;
}): string {
  if (command.revision !== meta.revision)
    throw new Error(
      "The outline changed. Your plan is kept; refresh the proposal before confirming again.",
    );
  if (source?.key !== command.key)
    throw new Error(
      "This source item is no longer on the Desk. Your plan is kept.",
    );
  if (sourceIdentity(source) !== command.fingerprint)
    throw new Error(
      "The source changed. Your plan is kept; open its latest version before confirming.",
    );
  if (meta.sources.some((s) => s.fingerprint === command.fingerprint))
    throw new Error(
      "This source already has a planned task. Refresh to open it.",
    );
  const parent =
    command.parent === null
      ? null
      : outlineDestination(state, desk, command.parent);
  if (parent?.children.length === 0 && parent.focusMonth === date.slice(0, 7))
    throw new Error(
      "This focus project is no longer available. Refresh the proposal.",
    );
  const taskId = todo(meta, source);
  const node = meta.inbox.find((n) => n.id === taskId);
  const link = meta.sources.find((s) => s.taskId === taskId);
  if (!node || !link)
    throw new Error("The source could not be filed. Your plan is kept.");
  if (parent) {
    parent.children.push(node);
    meta.inbox = meta.inbox.filter((n) => n.id !== taskId);
  }
  meta.planned.push({
    filing: requestId,
    taskId,
    parent: command.parent,
    snapshot: balanceNodeSnapshot(node),
    sourceSnapshot: JSON.stringify(link),
    reversed: false,
  });
  return taskId;
}
export function unplanSource({
  state,
  meta,
  command,
  date,
}: {
  state: AppState;
  meta: MyDayMeta;
  command: Extract<MyDayCommand, { op: "source-unplan" }>;
  date: string;
}): string {
  const filing = meta.planned.find(
    (p) => p.filing === command.filing && p.taskId === command.id,
  );
  if (!filing)
    throw new Error("Choose the original planning receipt for this task.");
  if (filing.reversed) return filing.taskId;
  const parent = findParent(state.outline, filing.taskId);
  const inbox = meta.inbox.find((n) => n.id === filing.taskId);
  const node: OutlineNode | undefined =
    inbox ?? findNode(state.outline, filing.taskId) ?? undefined;
  const link = meta.sources.find((s) => s.taskId === filing.taskId);
  if (
    !node ||
    balanceNodeSnapshot(node) !== filing.snapshot ||
    JSON.stringify(link) !== filing.sourceSnapshot ||
    (inbox ? null : parent?.id) !== filing.parent
  )
    throw new Error(
      "This planned task changed or moved. Its newer state is kept.",
    );
  if (
    node.children.length ||
    state.log.some((e) => e.taskId === node.id) ||
    state.dayState?.confirmed.includes(node.id) ||
    meta.draft?.ids.includes(node.id)
  )
    throw new Error(
      "This task has work history or belongs to your day. Its state is kept.",
    );
  if (parent?.children.length === 1 && parent.focusMonth === date.slice(0, 7))
    throw new Error(
      "Remove monthly focus before undoing this project's last task.",
    );
  if (parent) parent.children = parent.children.filter((n) => n.id !== node.id);
  else meta.inbox = meta.inbox.filter((n) => n.id !== node.id);
  meta.sources = meta.sources.filter((s) => s.taskId !== node.id);
  filing.reversed = true;
  return node.id;
}
