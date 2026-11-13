import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { WriterRunner } from "./create";
import { CommandTimeout } from "../common/spawn";
import { oneLine } from "./actions";

export interface TaskCloser {
  argv: readonly string[];
  run: WriterRunner;
  timeoutMs: number;
}

/** The task closer from `mc.desk.ask.taskCloser`, run like a writer; none when it is not set. */
export function taskCloser(ask: { taskCloser?: string[]; timeoutSeconds: number } | undefined, run: WriterRunner): TaskCloser | undefined {
  return ask?.taskCloser?.length ? { argv: ask.taskCloser, run, timeoutMs: ask.timeoutSeconds * 1000 } : undefined;
}

export const CLOSE_RETRY_MS = 10 * 60_000;
export const MAX_CLOSE_TRIES = 12;
const MAX_ERROR = 300;

const CloseAnswer = z.object({ id: z.string().min(1), message: z.string().max(300).optional() });
const UNREADABLE = "The task closer answered in a form the Desk cannot read.";
const DECIDED = "state IN ('approved', 'discarded')";

interface PendingRow {
  id: string;
  task_id: string;
  state: string;
  task_close_tries: number;
}

/** Marks the tasks of these decided hand-offs for closing. Approve and Discard call it; so does a superseded failure. */
export function queueTaskClose(db: Database, ids: readonly string[]): void {
  for (const id of ids) db.query(`UPDATE desk_mail_handoffs SET task_close = 'pending', task_close_error = NULL WHERE id = ? AND ${DECIDED} AND task_close IS NULL`).run(id);
}

async function runCloser(row: PendingRow, closer: TaskCloser): Promise<string | null> {
  const request = { action: "close", task: row.task_id, outcome: row.state === "approved" ? "approved" : "discarded", receipt: `ivy:${row.id}` };
  try {
    const out = await closer.run([...closer.argv], JSON.stringify(request), closer.timeoutMs);
    if (out.code !== 0) return oneLine(out.stderr || out.stdout, `The task closer exited with code ${out.code}.`);
    return CloseAnswer.safeParse(JSON.parse(out.stdout)).success ? null : UNREADABLE;
  } catch (err) {
    if (err instanceof CommandTimeout) return `The task closer ${err.message}.`;
    return err instanceof SyntaxError ? UNREADABLE : `The task closer did not run: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export type CloseOutcome = { closed: true } | { closed: false; task: string; error: string; gaveUp: boolean } | null;

/**
 * Closes one decided hand-off's task: completed when approved, not planned when discarded. The row is claimed first, so
 * an immediate close and a retry pass never both run the closer. Null when nothing was pending or another try holds it.
 */
export async function closeTask(db: Database, id: string, closer: TaskCloser, now: number): Promise<CloseOutcome> {
  const claimed = db.query(`UPDATE desk_mail_handoffs SET task_close_tried_at = ? WHERE id = ? AND task_close = 'pending' AND ${DECIDED} AND task_close_tries < ? AND (task_close_tried_at IS NULL OR task_close_tried_at <= ?)`)
    .run(now, id, MAX_CLOSE_TRIES, now - CLOSE_RETRY_MS);
  if (claimed.changes !== 1) return null;
  const row = db.query<PendingRow, [string]>("SELECT id, task_id, state, task_close_tries FROM desk_mail_handoffs WHERE id = ?").get(id);
  if (!row) return null;
  const error = await runCloser(row, closer);
  if (error === null) {
    db.query("UPDATE desk_mail_handoffs SET task_close = 'closed', task_close_error = NULL WHERE id = ?").run(id);
    return { closed: true };
  }
  const gaveUp = row.task_close_tries + 1 >= MAX_CLOSE_TRIES;
  db.query("UPDATE desk_mail_handoffs SET task_close = ?, task_close_error = ?, task_close_tries = task_close_tries + 1 WHERE id = ?").run(gaveUp ? "failed" : "pending", error.slice(0, MAX_ERROR), id);
  return { closed: false, task: row.task_id, error, gaveUp };
}

/** Closes the task right after Approve or Discard. Null when it closed or nothing ran, else one plain sentence for the Desk receipt. */
export async function closeHandoffTask(db: Database, id: string, closer: TaskCloser | undefined, now: number): Promise<string | null> {
  const outcome = closer ? await closeTask(db, id, closer, now) : null;
  return outcome && !outcome.closed ? `The task ${outcome.task} is still open; the Desk closes it later.` : null;
}

/** The retry pass: every pending close not tried in the last ten minutes. After twelve failures it gives up and says so in the log. */
export async function closePendingTasks(db: Database, closer: TaskCloser, now: number, log: (message: string) => void): Promise<void> {
  const due = db.query<{ id: string }, [number, number]>(
    `SELECT id FROM desk_mail_handoffs WHERE task_close = 'pending' AND ${DECIDED} AND task_close_tries < ? AND (task_close_tried_at IS NULL OR task_close_tried_at <= ?) ORDER BY closed_at`,
  ).all(MAX_CLOSE_TRIES, now - CLOSE_RETRY_MS);
  for (const { id } of due) {
    const outcome = await closeTask(db, id, closer, now);
    if (outcome && !outcome.closed && outcome.gaveUp) log(`desk: mail hand-off ${id}: gave up closing ${outcome.task} after ${MAX_CLOSE_TRIES} tries: ${outcome.error}`);
  }
}
