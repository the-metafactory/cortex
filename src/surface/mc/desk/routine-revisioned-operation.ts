import type { Database } from "bun:sqlite";
import { RoutineRefusal, type RoutineOptions } from "./routine-command";
import { checkRoutineOperation, claimRoutineOperation, finishRoutineOperation, readRoutineOperation, routineOperationBinding, type RoutineAction, type RoutineResult } from "./routine-store";

type RevisionedAction = Extract<RoutineAction, { revision: string }>;
export async function actOnRevisionedRoutine(options: {
  db: Database; config: RoutineOptions; request: RevisionedAction; unknown: string;
  prepare: () => Promise<() => Promise<void>>; reconcile: () => Promise<RoutineResult | null>;
}): Promise<RoutineResult> {
  const { db, config, request, unknown, reconcile } = options;
  const binding = routineOperationBinding(config, request);
  const prior = readRoutineOperation(db, request.requestId);
  if (prior) return checkRoutineOperation(db, request.requestId, binding, prior, reconcile, unknown);
  let write: () => Promise<void>;
  try { write = await options.prepare(); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "The routine owner could not prepare this change." }; }
  if (!claimRoutineOperation(db, request.requestId, binding, request.target)) {
    const raced = readRoutineOperation(db, request.requestId);
    return raced ? checkRoutineOperation(db, request.requestId, binding, raced, reconcile, unknown) : { ok: false, error: "Another action for this routine is still awaiting confirmation. This change was not sent. Check the existing pending change first." };
  }
  try {
    await write();
    const confirmed = await reconcile();
    return confirmed ? finishRoutineOperation(db, request.requestId, confirmed) : { ok: false, error: unknown, uncertain: true };
  } catch (error) {
    const confirmed = await reconcile().catch(() => null);
    if (confirmed) return finishRoutineOperation(db, request.requestId, confirmed);
    if (error instanceof RoutineRefusal) {
      db.query("DELETE FROM desk_routine_operations WHERE request_id = ? AND result IS NULL").run(request.requestId);
      return { ok: false, error: error.message };
    }
    return { ok: false, error: unknown, uncertain: true };
  }
}
