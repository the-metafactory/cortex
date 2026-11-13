import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { findNode, type OutlineNode } from "../../../balance";
import { buildDirectTaskPublishSubject } from "../../../bus/dispatch-source-publisher";
import { buildBaseEnvelope } from "../../../bus/envelope-builder";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import { loadMeta, loadMyDayState } from "./balance-sync";
import type { DeskOptions } from "./compose";
import { handoffAction as act, MAX_INSTRUCTION, OPEN_STATES } from "./handoff";
import { changeMyDay, localDay } from "./my-day";
import { ago, type AreaRule } from "./rank";
import { withSyncedBalance } from "./studio-my-day";
import { oneLine } from "./studio/edit";
import { agentLabel, MAX_ERROR, openTaskHandoffs, readTaskHandoff, taskHandoffLine, type DispatchAgent, type DispatchOptions, type TaskHandoffRow } from "./task-handoff-store";
import type { DeskItem } from "./types";

export const DESK_TASK_CAPABILITY = "desk-task";


export const NOT_SET_UP = "Handing tasks to an agent is not set up on this stack: it needs the local bus and at least one agent under mc.desk.dispatch.agents.";
export const TASK_GONE = "This task is no longer open. Refresh the Desk.";
export const STALE_PREVIEW = "The task changed since the preview. Preview it again.";

/** How the Desk reaches the local bus: the stack's subject scope and a publisher that signs with the stack's signer. */
export interface TaskDispatchBus {
  principal: string;
  stack: string;
  dataResidency?: string;
  publish: (envelope: Envelope, subject: string) => Promise<void>;
}

export interface HandoffDeps {
  db: Database;
  desk: DeskOptions & { dispatch: DispatchOptions };
  bus: TaskDispatchBus;
  now: number;
  newId: () => string;
}

export type TaskHandoffResult =
  | { ok: true; message: string; id?: string; receipt?: string }
  | { ok: false; status: number; error: string };

const refuse = (status: number, error: string): TaskHandoffResult => ({ ok: false, status, error });

interface OpenTask {
  node: OutlineNode;
  area: AreaRule;
}

/** An open Balance task under a configured area, read from the Balance store; never from the client. */
export function openTask(db: Database, desk: DeskOptions, taskId: string): OpenTask | null {
  const state = loadMyDayState(db, desk, loadMeta(db));
  for (const area of desk.areas) {
    const root = state.outline.children.find((n) => n.id === `area:${area.id}`);
    const node = root ? findNode(root, taskId) : null;
    if (root && node && node !== root) return node.done || node.children.length > 0 ? null : { node, area };
  }
  return null;
}

const allows = (area: AreaRule, agent: DispatchAgent): boolean => area.policy === "cloud" || agent.policy === "local";

export function taskBrief(task: OpenTask, instruction: string | null): string {
  const { node, area } = task;
  const note = node.note?.trim() ?? "";
  return [
    "The principal handed you one task from their Balance list. Work on it, then answer with what you did or found. The Desk shows your answer to the principal as a card; nothing else is changed for you.",
    "",
    `Task: ${oneLine(node.title)}`,
    `Area: ${oneLine(area.label)}`,
    ...(node.dueDate ? [`Due: ${node.dueDate}`] : []),
    ...(note ? ["Notes:", note] : []),
    ...(instruction ? [`Instruction: ${oneLine(instruction)}`] : []),
  ].join("\n");
}

export const briefHash = (brief: string): string => createHash("sha256").update(brief).digest("hex");

const list = (parts: string[]): string => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`);

function leavesLine(task: OpenTask, instruction: string | null, agent: DispatchAgent): string {
  const fields = ["title", "area", ...(task.node.note?.trim() ? ["notes"] : []), ...(task.node.dueDate ? ["due date"] : []), ...(instruction ? ["your instruction"] : [])];
  return `The ${list(fields)} go to ${agent.label}, which runs on a ${agent.policy} model.`;
}

const cleanInstruction = (instruction: string | undefined): string | null => {
  const asked = instruction?.trim().slice(0, MAX_INSTRUCTION) ?? "";
  return asked === "" ? null : asked;
};

type Chosen = { agent: DispatchAgent; allowed: DispatchAgent[] } | { refused: string };

function chooseAgent(dispatch: DispatchOptions, task: OpenTask, requested: string | undefined): Chosen {
  const allowed = dispatch.agents.filter((a) => allows(task.area, a));
  const named = requested === undefined ? (allowed[0] ?? dispatch.agents[0]) : dispatch.agents.find((a) => a.id === requested);
  if (!named) return { refused: `${requested ?? "That agent"} does not take Desk tasks on this stack.` };
  if (!allows(task.area, named)) return { refused: `This task's area allows only a local model, and ${named.label} runs on a cloud model.` };
  return { agent: named, allowed };
}

export interface TaskPreview {
  task: { id: string; title: string; area: string; dueDate: string | null };
  agent: { id: string; label: string };
  agents: DispatchAgent[];
  brief: string;
  briefHash: string;
  leaves: string;
}

interface Refusal { ok: false; status: number; error: string }
interface ResolvedBrief {
  task: OpenTask;
  chosen: { agent: DispatchAgent; allowed: DispatchAgent[] };
  instruction: string | null;
  brief: string;
}

function resolveBrief(db: Database, desk: DeskOptions & { dispatch: DispatchOptions }, input: { taskId: string; agent?: string; instruction?: string }): ResolvedBrief | Refusal {
  const task = openTask(db, desk, input.taskId);
  if (!task) return { ok: false, status: 409, error: TASK_GONE };
  const chosen = chooseAgent(desk.dispatch, task, input.agent);
  if ("refused" in chosen) return { ok: false, status: 409, error: chosen.refused };
  const instruction = cleanInstruction(input.instruction);
  return { task, chosen, instruction, brief: taskBrief(task, instruction) };
}

/** The exact brief a hand-off would send, its hash and what leaves the Desk. Writes nothing. */
export function previewHandoff(db: Database, desk: DeskOptions & { dispatch: DispatchOptions }, input: { taskId: string; agent?: string; instruction?: string }): { ok: true; preview: TaskPreview } | Refusal {
  const resolved = resolveBrief(db, desk, input);
  if ("ok" in resolved) return resolved;
  const { task, chosen, instruction, brief } = resolved;
  return {
    ok: true,
    preview: {
      task: { id: task.node.id, title: task.node.title, area: task.area.id, dueDate: task.node.dueDate ?? null },
      agent: { id: chosen.agent.id, label: chosen.agent.label },
      agents: chosen.allowed,
      brief,
      briefHash: briefHash(brief),
      leaves: leavesLine(task, instruction, chosen.agent),
    },
  };
}

/** The signed direct task for one attempt: `tasks.@{agent}.desk-task`, with the attempt id as `task_id` and `correlation_id`. */
export function deskTaskEnvelope(bus: Pick<TaskDispatchBus, "principal" | "stack" | "dataResidency">, agent: DispatchAgent, attempt: string, brief: string): { envelope: Envelope; subject: string } {
  const did = `did:mf:${agent.id}`;
  const cloud = agent.policy === "cloud";
  const base = buildBaseEnvelope({
    type: `tasks.${DESK_TASK_CAPABILITY}`,
    source: `${bus.principal}.${bus.stack}.desk`,
    correlationId: attempt,
    sovereignty: { classification: "local", data_residency: bus.dataResidency ?? "NZ", max_hop: 0, frontier_ok: cloud, model_class: cloud ? "any" : "local-only" },
    payload: { task_id: attempt, agent_id: agent.id, agent_name: agent.label, prompt: brief },
  });
  return { envelope: { ...base, distribution_mode: "direct", target_assistant: did }, subject: buildDirectTaskPublishSubject(bus.principal, did, bus.stack, DESK_TASK_CAPABILITY) };
}

const reasonOf = (err: unknown): string => oneLine(err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR) || "no reason given";

async function send(deps: HandoffDeps, row: { id: string; attempt: string; brief: string }, agent: DispatchAgent): Promise<TaskHandoffResult | null> {
  try {
    const { envelope, subject } = deskTaskEnvelope(deps.bus, agent, row.attempt, row.brief);
    await deps.bus.publish(envelope, subject);
    return null;
  } catch (err) {
    const error = `${BUS_REFUSED} ${reasonOf(err)}`;
    deps.db.query("UPDATE desk_task_handoffs SET state = 'failed', error = ?, finished_at = ? WHERE id = ? AND attempt = ?").run(error, deps.now, row.id, row.attempt);
    return busRefusal(error);
  }
}

const BUS_REFUSED = "The task did not reach the bus:";
const busRefusal = (error: string): TaskHandoffResult => refuse(502, `${error}. Nothing started; try again.`);
const refusedByBus = (row: TaskHandoffRow, requestId: string): boolean => row.state === "failed" && row.attemptRequest === requestId && (row.error?.startsWith(BUS_REFUSED) ?? false);

const handedMessage = (label: string): string => `Handed to ${label}. The result comes back here as a card.`;
const retriedMessage = (label: string): string => `${label} tries again. The result comes back here as a card.`;

export interface HandInput {
  requestId: string;
  taskId: string;
  agent: string;
  instruction?: string;
  briefHash: string;
}

/** Records the hand-off and publishes one signed task to the agent. A repeated request id answers the first receipt. */
export async function handTask(input: HandInput, deps: HandoffDeps): Promise<TaskHandoffResult> {
  const { db, desk, now } = deps;
  const replay = readTaskHandoff(db, input.requestId);
  if (replay) {
    if (replay.taskId !== input.taskId) return refuse(409, "That request id belongs to another hand-off.");
    return refusedByBus(replay, input.requestId) ? busRefusal(replay.error ?? BUS_REFUSED) : { ok: true, id: replay.id, message: handedMessage(agentLabel(desk.dispatch, replay.agent)) };
  }
  const resolved = resolveBrief(db, desk, input);
  if ("ok" in resolved) return resolved;
  const { task, chosen, instruction, brief } = resolved;
  const busy = openTaskHandoffs(db).find((r) => r.taskId === input.taskId && r.state !== "failed");
  if (busy) {
    const label = agentLabel(desk.dispatch, busy.agent);
    return refuse(409, busy.state === "working" ? `${label} is already working on this task.` : `${label}'s answer for this task is waiting for you in Catch-up.`);
  }
  if (briefHash(brief) !== input.briefHash) return refuse(409, STALE_PREVIEW);
  const attempt = deps.newId();
  db.transaction(() => {
    db.query(
      `INSERT INTO desk_task_handoffs (id, task_id, title, area, agent, instruction, brief, attempt, attempt_request, state, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?)`,
    ).run(input.requestId, task.node.id, task.node.title, task.area.id, chosen.agent.id, instruction, brief, attempt, input.requestId, now, now);
    db.query("UPDATE desk_task_handoffs SET state = 'discarded', closed_at = ? WHERE task_id = ? AND state = 'failed' AND id != ?").run(now, task.node.id, input.requestId);
  })();
  const failed = await send(deps, { id: input.requestId, attempt, brief }, chosen.agent);
  return failed ?? { ok: true, id: input.requestId, message: handedMessage(chosen.agent.label) };
}

/** Publishes a new attempt with a fresh correlation id on a failed hand-off; a late answer to an older attempt is dropped. */
export async function retryTask(input: { requestId: string; id: string }, deps: HandoffDeps): Promise<TaskHandoffResult> {
  const { db, desk, now } = deps;
  const row = readTaskHandoff(db, input.id);
  if (!row) return refuse(409, "The Desk no longer knows this hand-off.");
  const label = agentLabel(desk.dispatch, row.agent);
  if (row.attemptRequest === input.requestId) return refusedByBus(row, input.requestId) ? busRefusal(row.error ?? BUS_REFUSED) : { ok: true, id: row.id, message: retriedMessage(label) };
  if (row.state !== "failed") return refuse(409, "Only a failed hand-off can be tried again.");
  const task = openTask(db, desk, row.taskId);
  if (!task) return refuse(409, TASK_GONE);
  const chosen = chooseAgent(desk.dispatch, task, row.agent);
  if ("refused" in chosen) return refuse(409, chosen.refused);
  const agent = chosen.agent;
  const attempt = deps.newId();
  db.query("UPDATE desk_task_handoffs SET state = 'working', attempt = ?, attempt_request = ?, sent_at = ?, started_at = NULL, result = NULL, error = NULL, finished_at = NULL WHERE id = ? AND state = 'failed'")
    .run(attempt, input.requestId, now, row.id);
  const failed = await send(deps, { id: row.id, attempt, brief: row.brief }, agent);
  return failed ?? { ok: true, id: row.id, message: retriedMessage(label) };
}

export function discardTask(db: Database, dispatch: DispatchOptions, id: string, now: number): TaskHandoffResult {
  const row = readTaskHandoff(db, id);
  if (!row || !OPEN_STATES.includes(row.state)) return refuse(409, "This hand-off is already closed.");
  db.query("UPDATE desk_task_handoffs SET state = 'discarded', closed_at = ? WHERE id = ?").run(now, id);
  const label = agentLabel(dispatch, row.agent);
  if (row.state === "working") return { ok: true, message: `Stopped waiting. ${label} may still finish; its answer is dropped.` };
  return { ok: true, message: row.state === "ready" ? `Discarded ${label}'s answer. The task stays open.` : "Discarded. The task stays open." };
}

/** Done closes the card and completes the task through `outline-complete`, answering an undo receipt; Keep open only closes the card. */
export async function acceptTask(input: { requestId: string; id: string; done: boolean }, deps: Pick<HandoffDeps, "db" | "desk" | "now">): Promise<TaskHandoffResult> {
  const { db, desk, now } = deps;
  const row = readTaskHandoff(db, input.id);
  if (!row) return refuse(409, "The Desk no longer knows this hand-off.");
  if (row.acceptRequest === input.requestId && row.acceptMessage) return { ok: true, message: row.acceptMessage, ...(row.acceptReceipt ? { receipt: row.acceptReceipt } : {}) };
  if (row.state !== "ready") return refuse(409, row.state === "working" ? `${agentLabel(desk.dispatch, row.agent)} is still working on this task.` : "This hand-off is already closed.");
  let receipt: string | undefined;
  if (input.done) {
    try {
      const changed = await withSyncedBalance(db, desk, now, (studio) => changeMyDay({ db, desk, now, date: localDay(now), requestId: input.requestId, command: { op: "outline-complete", revision: loadMeta(db).revision, id: row.taskId, confirm: true }, reopenable: true, ...(studio ? { studio } : {}) }));
      receipt = changed.undo;
    } catch (err) {
      return refuse(409, `The task was not marked done: ${reasonOf(err)}`);
    }
  }
  const title = oneLine(row.title);
  const message = input.done ? `Marked “${title}” done and closed the card.` : `Closed the card. “${title}” stays open.`;
  db.query("UPDATE desk_task_handoffs SET state = 'approved', closed_at = ?, accept_request = ?, accept_message = ?, accept_receipt = ? WHERE id = ? AND state = 'ready'")
    .run(now, input.requestId, message, receipt ?? null, row.id);
  return { ok: true, message, ...(receipt ? { receipt } : {}) };
}

export const TASK_HANDOFF_KEY_PREFIX = "handoff:";
export const taskHandoffKey = (id: string): string => `${TASK_HANDOFF_KEY_PREFIX}${id}`;

/** The result cards: one per finished hand-off (the answer, Done, Keep open, Discard) and one per failed one (the reason, Retry, Discard). */
export function taskHandoffItems(rows: readonly TaskHandoffRow[], dispatch: DispatchOptions, now: number): DeskItem[] {
  return rows.flatMap((row): DeskItem[] => {
    if (row.state !== "ready" && row.state !== "failed") return [];
    const label = agentLabel(dispatch, row.agent);
    const title = oneLine(row.title);
    const history = [`You handed it to ${label} ${ago(now, row.createdAt)}${row.instruction ? ` and asked: “${oneLine(row.instruction)}”` : ""}.`];
    const handoff = { id: row.id, state: row.state, line: taskHandoffLine(row, label, now), since: row.createdAt, brief: row.brief };
    const base = { kind: "task-handoff" as const, key: taskHandoffKey(row.id), source: "desk", area: row.area, attention: "action" as const, urgency: "today" as const, since: row.finishedAt ?? row.createdAt };
    if (row.state === "failed") {
      const why = row.error ?? "No reason was given.";
      return [{
        ...base, title: `${label} could not finish “${title}”`, why, score: 50,
        actions: [act("task.retry", "Retry", "primary", row.id), act("task.discard", "Discard", "secondary", row.id)],
        detail: { summary: why, history, refs: [row.taskId], links: [] }, handoff,
      }];
    }
    const result = row.result ?? "";
    return [{
      ...base, title: `${label} finished “${title}”`, why: `${label}'s answer is below, as the agent wrote it. Done marks the task done; Keep open leaves it on your list.`, score: 60,
      actions: [act("task.done", "Done", "primary", row.id), act("task.keep", "Keep open", "secondary", row.id), act("task.discard", "Discard", "secondary", row.id)],
      detail: { summary: result, history, refs: [row.taskId], links: [] }, excerpt: result, handoff: { ...handoff, result },
    }];
  });
}

/** Open hand-offs as the agents lane's working entries. */
export function workingHandoffs(rows: readonly TaskHandoffRow[], dispatch: DispatchOptions, now: number): { title: string; note: string; since: number }[] {
  return rows.filter((r) => r.state === "working").map((r) => ({ title: r.title, note: taskHandoffLine(r, agentLabel(dispatch, r.agent), now), since: r.startedAt ?? r.sentAt }));
}
