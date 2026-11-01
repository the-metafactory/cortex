import type { Database } from "bun:sqlite";
import { z } from "zod";
import { reflexCommand, type RoutineOptions, type RoutineRunner } from "./routine-command";
import { spawnWithStdin } from "./create";
import { LifecycleDetailSchema, LifecyclePreviewSchema, type LifecycleAction, type LifecyclePreviewRequest } from "./routine-lifecycle-contract";
import { actOnRevisionedRoutine } from "./routine-revisioned-operation";
import type { RoutineResult } from "./routine-store";

const UNKNOWN = "The owner has not confirmed this lifecycle change in its live scheduler. Check this same change again; it will not be sent twice.";
export async function inspectRoutineLifecycle(options: RoutineOptions, id: string, run?: RoutineRunner) {
  const result = await reflexCommand({ ...options, timeoutSeconds: options.readTimeoutSeconds }, ["routine", "lifecycle", "inspect", id], LifecycleDetailSchema, run);
  if (result.id !== id) throw new Error("The owner returned a different routine lifecycle");
  return result;
}
export async function previewRoutineLifecycle(options: RoutineOptions, input: LifecyclePreviewRequest, run?: RoutineRunner) {
  const result = await reflexCommand({ ...options, timeoutSeconds: options.readTimeoutSeconds }, ["routine", "lifecycle", "preview", input.id, "--revision", input.revision, "--paused", String(input.paused)], LifecyclePreviewSchema, run);
  if (result.id !== input.id || result.revision !== input.revision || result.paused !== input.paused || !result.runtimeConfirmed) throw new Error("The owner returned an inconsistent lifecycle preview");
  return result;
}
export async function reconcileLifecycle(options: RoutineOptions, request: LifecycleAction, run?: RoutineRunner): Promise<RoutineResult | null> {
  const current = await inspectRoutineLifecycle(options, request.target, run);
  return current.runtimeConfirmed && current.revision === request.proposedRevision && current.current.paused === (request.action === "pause")
    ? { ok: true, message: request.action === "pause" ? "Routine paused and verified. Existing requests and executions are unchanged." : "Routine resumed and verified with its saved handling policy." } : null;
}
export function actOnRoutineLifecycle(db: Database, options: RoutineOptions, request: LifecycleAction, run: RoutineRunner = spawnWithStdin): Promise<RoutineResult> {
  return actOnRevisionedRoutine({ db, config: options, request, unknown: UNKNOWN,
    reconcile: () => reconcileLifecycle(options, request, run),
    prepare: async () => {
      const current = await inspectRoutineLifecycle(options, request.target, run);
      if (!current.writable) throw new Error(current.reason || "This lifecycle is read-only.");
      if (!current.runtimeConfirmed) throw new Error("The live scheduling state is not confirmed. Refresh before changing it.");
      if (current.current.paused === (request.action === "pause")) throw new Error("The routine is already in that lifecycle state. Refresh before changing it.");
      const proposed = await previewRoutineLifecycle(options, { id: request.target, revision: request.revision, paused: request.action === "pause" }, run);
      if (current.revision !== request.revision || proposed.proposedRevision !== request.proposedRevision) throw new Error("The installed routine or confirmed lifecycle preview changed. Preview again before applying it.");
      return async () => { await reflexCommand(options, ["routine", "lifecycle", "update", request.target, "--revision", request.revision, "--proposed-revision", proposed.proposedRevision, "--paused", String(request.action === "pause")], z.unknown(), run); };
    },
  });
}
