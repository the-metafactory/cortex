import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { WriterRunner } from "./create";
import { CommandTimeout } from "./spawn";
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

interface PendingRow {
  id: string;
  task_id: string;
  state: string;
}

/** Marks the tasks of these decided hand-offs for closing. Approve and Discard call it; so does a superseded failure. */
export function queueTaskClose(db: Database, ids: readonly string[]): void {
  for (const id of ids) db.query("UPDATE desk_mail_handoffs SET task_close = 'pending', task_close_error = NULL WHERE id = ? AND state IN ('approved', 'discarded') AND task_close IS NULL").run(id);
}

async function runCloser(row: PendingRow, closer: TaskCloser): Promise<string | null> {
  const request = { action: "close", task: row.task_id, outcome: row.state === "approved" ? "approved" : "discarded", receipt: `ivy:${row.id}` };
  try {
    const out = await closer.run([...closer.argv], JSON.stringify(request), closer.timeoutMs);
    if (out.code !== 0) return oneLine(out.stderr || out.stdout, `The task closer exited with code ${out.code}.`);
    return CloseAnswer.safeParse(JSON.parse(out.stdout)).success ? null : "The task closer answered in a form the Desk cannot read.";
  } catch (err) {
    if (err instanceof CommandTimeout) return `The task closer ${err.message}.`;
    return err instanceof SyntaxError ? "The task closer answered in a form the Desk cannot read." : `The task closer did not run: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Closes one decided hand-off's task: completed when approved, not planned when discarded. Answers null when the task
 * is closed or nothing was pending, else one plain sentence for the Desk receipt; the task stays pending for a later pass.
 */
export async function closeHandoffTask(db: Database, id: string, closer: TaskCloser | undefined, now: number): Promise<string | null> {
  if (!closer) return null;
  const row = db.query<PendingRow, [string]>("SELECT id, task_id, state FROM desk_mail_handoffs WHERE id = ? AND task_close = 'pending' AND state IN ('approved', 'discarded')").get(id);
  if (!row) return null;
  const error = await runCloser(row, closer);
  if (error === null) {
    db.query("UPDATE desk_mail_handoffs SET task_close = 'closed', task_close_error = NULL, task_close_tried_at = ? WHERE id = ?").run(now, id);
    return null;
  }
  db.query("UPDATE desk_mail_handoffs SET task_close_error = ?, task_close_tries = task_close_tries + 1, task_close_tried_at = ? WHERE id = ?").run(error.slice(0, MAX_ERROR), now, id);
  return `The task ${row.task_id} is still open; the Desk closes it later.`;
}

/** The retry pass: every pending close not tried in the last ten minutes, until it has failed twelve times. */
export async function closePendingTasks(db: Database, closer: TaskCloser, now: number): Promise<void> {
  const due = db.query<{ id: string }, [number, number]>(
    "SELECT id FROM desk_mail_handoffs WHERE task_close = 'pending' AND state IN ('approved', 'discarded') AND task_close_tries < ? AND (task_close_tried_at IS NULL OR task_close_tried_at <= ?) ORDER BY closed_at",
  ).all(MAX_CLOSE_TRIES, now - CLOSE_RETRY_MS);
  for (const { id } of due) await closeHandoffTask(db, id, closer, now);
}
