import type { Database } from "bun:sqlite";
import { reflexCommand, type RoutineOptions, type RoutineRunner } from "./routine-command";
import { RemovalDetailSchema, RemovalStatusSchema, type RemovalAction } from "./routine-removal-contract";
import { actOnRevisionedRoutine } from "./routine-revisioned-operation";
import { readRoutineOperation, routineOperationBinding } from "./routine-store";
import type { RoutineResult } from "./routine-store";
export async function inspectRoutineRemoval(options: RoutineOptions, id: string, run?: RoutineRunner) {
  const result = await reflexCommand({ ...options, timeoutSeconds: options.readTimeoutSeconds }, ["routine", "removal", "inspect", id], RemovalDetailSchema, run);
  if (result.id !== id || result.target !== options.target) throw new Error("The owner returned a different routine or target.");
  return result;
}
const args = (request: RemovalAction) => [request.target, "--revision", request.revision, "--request-id", request.requestId];
export async function reconcileRemoval(options: RoutineOptions, request: RemovalAction, run?: RoutineRunner): Promise<RoutineResult | null> {
  const read = async (operation: "status" | "reconcile") => {
    const result = await reflexCommand(options, ["routine", "removal", operation, ...args(request)], RemovalStatusSchema, run);
    if (result.id !== request.target || result.revision !== request.revision || result.requestId !== request.requestId) throw new Error("The owner returned a different removal intent.");
    return result;
  };
  let result = await read("status");
  if (result.status === "pending") result = await read("reconcile");
  return result.status === "removed" ? { ok: true, message: "Routine deleted and verified. Execution evidence remains in Activity." } : null;
}
export async function actOnRoutineRemoval(db: Database, options: RoutineOptions, request: RemovalAction, run?: RoutineRunner): Promise<RoutineResult> {
  const prior = readRoutineOperation(db, request.requestId);
  if (prior?.result && prior.binding === routineOperationBinding(options, request)) {
    try { return await reconcileRemoval(options, request, run) ?? { ok: false, error: "The owner cannot verify absence for this completed deletion." }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : "This removal cannot confirm the current routine." }; }
  }
  return actOnRevisionedRoutine({ db, config: options, request,
    unknown: "Deletion is unconfirmed. Check this same deletion again; its saved intent cannot target another routine.",
    reconcile: () => reconcileRemoval(options, request, run),
    prepare: async () => {
      const current = await inspectRoutineRemoval(options, request.target, run);
      if (!current.writable) throw new Error(current.reason || "The owner cannot remove this routine.");
      if (current.revision !== request.revision) throw new Error("The routine changed after confirmation. Refresh before deleting it.");
      return async () => { await reflexCommand(options, ["routine", "remove", ...args(request)], RemovalStatusSchema, run); };
    },
  });
}
