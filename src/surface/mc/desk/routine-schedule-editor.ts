import type { Database } from "bun:sqlite";
import { z } from "zod";
import { reflexCommand, type RoutineOptions, type RoutineRunner } from "./routine-command";
import { spawnWithStdin } from "./create";
import { ScheduleDetailSchema, SchedulePreviewSchema, type ScheduleAction, type SchedulePreviewRequest } from "./routine-schedule-contract";
import type { RoutineResult } from "./routine-store";
import { actOnRevisionedRoutine } from "./routine-revisioned-operation";

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
export function actOnRoutineSchedule(db: Database, options: RoutineOptions, request: ScheduleAction, run: RoutineRunner = spawnWithStdin): Promise<RoutineResult> {
  return actOnRevisionedRoutine({ db, config: options, request, unknown: UNKNOWN,
    reconcile: () => reconcileSchedule(options, request, run),
    prepare: async () => {
      const current = await inspectRoutineSchedule(options, request.target, run);
      if (!current.writable) throw new Error(current.reason || "This schedule is read-only.");
      const proposed = await previewRoutineSchedule(options, { id: request.target, revision: request.revision, schedule: request.schedule, timezone: request.timezone }, run);
      if (current.revision !== request.revision || proposed.proposedRevision !== request.proposedRevision) throw new Error("The installed routine or confirmed preview changed. Preview again before saving.");
      if (request.revision === request.proposedRevision) throw new Error("The proposed schedule is unchanged.");
      return async () => { await reflexCommand(options, ["routine", "schedule", "update", request.target, "--revision", request.revision, "--proposed-revision", proposed.proposedRevision, ...scheduleArguments(request)], z.unknown(), run); };
    },
  });
}
