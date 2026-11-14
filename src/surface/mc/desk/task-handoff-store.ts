import type { Database } from "bun:sqlite";
import type { DeskDispatchConfig, DispatchPolicy } from "../../../common/types/desk-dispatch";
import { handoffWhen, OPEN_STATES, type HandoffState } from "./handoff";
import { oneLine } from "./studio/edit";

export const MAX_RESULT = 4000;
export const MAX_ERROR = 300;

export interface DispatchAgent {
  id: string;
  label: string;
  policy: DispatchPolicy;
}

/** The Desk's view of `mc.desk.dispatch`, with each agent's display name. */
export interface DispatchOptions {
  agents: DispatchAgent[];
  startTimeoutSeconds: number;
  runTimeoutMinutes: number;
}

export interface TaskHandoffRow {
  id: string;
  taskId: string;
  title: string;
  area: string | null;
  agent: string;
  instruction: string | null;
  brief: string;
  attempt: string;
  attemptRequest: string;
  state: HandoffState;
  sentAt: number;
  startedAt: number | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  acceptRequest: string | null;
  acceptMessage: string | null;
  acceptReceipt: string | null;
}

interface RawRow {
  id: string;
  task_id: string;
  title: string;
  area: string | null;
  agent: string;
  instruction: string | null;
  brief: string;
  attempt: string;
  attempt_request: string;
  state: string;
  sent_at: number;
  started_at: number | null;
  result: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  accept_request: string | null;
  accept_message: string | null;
  accept_receipt: string | null;
}

const toRow = (r: RawRow): TaskHandoffRow => ({
  id: r.id, taskId: r.task_id, title: r.title, area: r.area, agent: r.agent, instruction: r.instruction, brief: r.brief,
  attempt: r.attempt, attemptRequest: r.attempt_request, state: r.state as HandoffState, sentAt: r.sent_at, startedAt: r.started_at,
  result: r.result, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at,
  acceptRequest: r.accept_request, acceptMessage: r.accept_message, acceptReceipt: r.accept_receipt,
});

export function readTaskHandoff(db: Database, id: string): TaskHandoffRow | null {
  const r = db.query<RawRow, [string]>("SELECT * FROM desk_task_handoffs WHERE id = ?").get(id);
  return r ? toRow(r) : null;
}

/** Task hand-offs still on the Desk: working, ready or failed; newest first. */
export function openTaskHandoffs(db: Database): TaskHandoffRow[] {
  return db.query<RawRow, string[]>(`SELECT * FROM desk_task_handoffs WHERE state IN (${OPEN_STATES.map(() => "?").join(", ")}) ORDER BY created_at DESC`).all(...OPEN_STATES).map(toRow);
}

/** The agent's display name from the dispatch settings, or its id when it is no longer configured. */
export const agentLabel = (dispatch: DispatchOptions | undefined, id: string): string => dispatch?.agents.find((a) => a.id === id)?.label ?? id;

export function taskHandoffLine(row: TaskHandoffRow, label: string, now: number): string {
  if (row.state === "working") return row.startedAt === null ? `Sent to ${label}, waiting for it to start` : `With ${label} since ${handoffWhen(row.startedAt, now)}`;
  if (row.state === "failed") return `${label} could not finish: ${row.error ?? "no reason given"}`;
  return `${label}'s answer is ready in Catch-up.`;
}

export type TaskHandoffLines = Record<string, { state: HandoffState; line: string }>;

/** The newest open hand-off per Balance task, as the status line My Day and the outline show beside the task. */
export function taskHandoffLines(db: Database, dispatch: DispatchOptions | undefined, now: number): TaskHandoffLines {
  const lines: TaskHandoffLines = {};
  for (const row of openTaskHandoffs(db)) {
    if (!(row.taskId in lines)) lines[row.taskId] = { state: row.state, line: taskHandoffLine(row, agentLabel(dispatch, row.agent), now) };
  }
  return lines;
}

const span = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? "" : "s"}`;
const startSpan = (seconds: number): string => (seconds % 60 === 0 ? span(seconds / 60, "minute") : span(seconds, "second"));

/** Fails working hand-offs that nobody picked up within the start timeout, or that sent no result within the run timeout. */
export function expireTaskHandoffs(db: Database, dispatch: DispatchOptions, now: number): void {
  const working = db.query<RawRow, []>("SELECT * FROM desk_task_handoffs WHERE state = 'working'").all().map(toRow);
  const fail = db.query("UPDATE desk_task_handoffs SET state = 'failed', error = ?, finished_at = ? WHERE id = ? AND attempt = ? AND state = 'working'");
  for (const row of working) {
    if (row.startedAt === null && row.sentAt + dispatch.startTimeoutSeconds * 1000 <= now) {
      fail.run(`Nobody picked it up within ${startSpan(dispatch.startTimeoutSeconds)}. Is ${agentLabel(dispatch, row.agent)} running?`, now, row.id, row.attempt);
    } else if (row.startedAt !== null && row.startedAt + dispatch.runTimeoutMinutes * 60_000 <= now) {
      fail.run(`No result arrived within ${span(dispatch.runTimeoutMinutes, "minute")}.`, now, row.id, row.attempt);
    }
  }
}

/**
 * `mc.desk.dispatch` resolved against the stack's merged agents (inline `agents[]` and agents.d fragments): each target gets its display name, and
 * an id that names no agent is left out and returned in `unknown`. With no target left there is nothing to hand to, so `options` is undefined.
 */
export function deskDispatchOptions(config: DeskDispatchConfig, agents: readonly { id: string; displayName: string }[]): { options: DispatchOptions | undefined; unknown: string[] } {
  const resolved = config.agents.flatMap((a) => {
    const agent = agents.find((candidate) => candidate.id === a.id);
    return agent ? [{ ...a, label: agent.displayName }] : [];
  });
  const unknown = config.agents.filter((a) => !resolved.some((r) => r.id === a.id)).map((a) => a.id);
  return { options: resolved.length > 0 ? { ...config, agents: resolved } : undefined, unknown };
}

interface LifecycleEnvelope {
  type: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

const startedAt = (value: unknown, now: number): number => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : now;
};
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** Moves the hand-off whose current attempt matches the envelope's correlation id; anything else changes nothing. */
export function applyTaskLifecycle(db: Database, envelope: LifecycleEnvelope, now: number): boolean {
  const attempt = envelope.correlation_id;
  if (!attempt) return false;
  const p = envelope.payload;
  const finish = (state: "ready" | "failed", column: "result" | "error", value: string): boolean =>
    db.query(`UPDATE desk_task_handoffs SET state = ?, ${column} = ?, finished_at = ? WHERE attempt = ? AND state = 'working'`).run(state, value, now, attempt).changes > 0;
  switch (envelope.type) {
    case "dispatch.task.started":
      return db.query("UPDATE desk_task_handoffs SET started_at = ? WHERE attempt = ? AND state = 'working' AND started_at IS NULL").run(startedAt(p.started_at, now), attempt).changes > 0;
    case "dispatch.task.completed":
      return finish("ready", "result", (text(p.chat_response) ?? text(p.result_summary) ?? "").slice(0, MAX_RESULT));
    case "dispatch.task.failed":
      return finish("failed", "error", oneLine(text(p.error_summary) ?? "The agent gave no reason.").slice(0, MAX_ERROR));
    case "dispatch.task.aborted":
      return finish("failed", "error", oneLine(text(p.reason) ?? "The agent stopped without a reason.").slice(0, MAX_ERROR));
    default:
      return false;
  }
}

