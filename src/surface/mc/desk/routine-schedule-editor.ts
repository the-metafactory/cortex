import type { Database } from "bun:sqlite";
import { z } from "zod";
import { reflexCommand, RoutineRefusal, type RoutineOptions, type RoutineRunner } from "./routine-command";
import { spawnWithStdin } from "./create";
import { ScheduleDetailSchema, SchedulePreviewSchema, type ScheduleAction, type SchedulePreviewRequest } from "./routine-schedule-contract";
import { checkRoutineOperation, claimRoutineOperation, finishRoutineOperation, readRoutineOperation, routineOperationBinding, type RoutineResult } from "./routine-store";

const UNKNOWN = "The routine owner has not confirmed this schedule change. Check this same request again; it will not be sent twice.";
export function scheduleArguments(input: { schedule: string; timezone: string | null }): string[] {
  return ["--schedule", input.schedule, ...(input.timezone === null ? ["--owner-timezone"] : ["--timezone", input.timezone])];
}
export async function inspectRoutineSchedule(options: RoutineOptions, id: string, run?: RoutineRunner) {
  const result = await reflexCommand({ ...options, timeoutSeconds: options.readTimeoutSeconds }, ["routine", "schedule", "inspect", id], ScheduleDetailSchema, run);
  if (result.id !== id) throw new Error("The routine owner returned a different schedule");
  return result;
}
export async function previewRoutineSchedule(options: RoutineOptions, input: SchedulePreviewRequest, run?: RoutineRunner) {
  const result = await reflexCommand({ ...options, timeoutSeconds: options.readTimeoutSeconds }, ["routine", "schedule", "preview", input.id, "--revision", input.revision, ...scheduleArguments(input)], SchedulePreviewSchema, run);
  if (result.id !== input.id || result.revision !== input.revision || result.proposed.schedule !== input.schedule || result.proposed.timezone !== input.timezone) throw new Error("The routine owner returned an inconsistent schedule preview");
  return result;
}
export async function reconcileSchedule(options: RoutineOptions, request: ScheduleAction, run?: RoutineRunner): Promise<RoutineResult | null> {
  const current = await inspectRoutineSchedule(options, request.target, run);
  return current.revision === request.proposedRevision && current.current.schedule === request.schedule && current.current.timezone === request.timezone
    ? { ok: true, message: "Schedule saved and verified." } : null;
}
export async function actOnRoutineSchedule(db: Database, options: RoutineOptions, request: ScheduleAction, run: RoutineRunner = spawnWithStdin): Promise<RoutineResult> {
  const binding = routineOperationBinding(options, request);
  const prior = readRoutineOperation(db, request.requestId);
  if (prior) return checkRoutineOperation(db, request.requestId, binding, prior, () => reconcileSchedule(options, request, run), UNKNOWN);
  let proposed;
  try {
    const current = await inspectRoutineSchedule(options, request.target, run);
    if (!current.writable) return { ok: false, error: current.reason || "This schedule is read-only." };
    proposed = await previewRoutineSchedule(options, { id: request.target, revision: request.revision, schedule: request.schedule, timezone: request.timezone }, run);
    if (current.revision !== request.revision || proposed.proposedRevision !== request.proposedRevision) return { ok: false, error: "The installed routine or confirmed preview changed. Preview again before saving." };
    if (request.revision === request.proposedRevision) return { ok: false, error: "The proposed schedule is unchanged." };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "The routine owner could not prepare this schedule change." }; }
  const claimed = claimRoutineOperation(db, request.requestId, binding, request.target);
  if (!claimed) {
    const raced = readRoutineOperation(db, request.requestId);
    return raced ? checkRoutineOperation(db, request.requestId, binding, raced, () => reconcileSchedule(options, request, run), UNKNOWN) : { ok: false, error: "Another action for this routine is still awaiting confirmation. This schedule was not sent. Check the existing pending change first." };
  }
  try {
    await reflexCommand(options, ["routine", "schedule", "update", request.target, "--revision", request.revision, "--proposed-revision", proposed.proposedRevision, ...scheduleArguments(request)], z.unknown(), run);
    const confirmed = await reconcileSchedule(options, request, run);
    return confirmed ? finishRoutineOperation(db, request.requestId, confirmed) : { ok: false, error: UNKNOWN, uncertain: true };
  } catch (error) {
    const confirmed = await reconcileSchedule(options, request, run).catch(() => null);
    if (confirmed) return finishRoutineOperation(db, request.requestId, confirmed);
    if (error instanceof RoutineRefusal) {
      db.query("DELETE FROM desk_routine_operations WHERE request_id = ? AND result IS NULL").run(request.requestId);
      return { ok: false, error: error.message };
    }
    return { ok: false, error: UNKNOWN, uncertain: true };
  }
}
