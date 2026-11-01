import { reflexCommand, runRoutineCommand, type RoutineOptions, type RoutineRunner } from "./routine-command";
import { spawnWithStdin } from "./create";

import { RoutineDetailSchema, RoutineEditProposalSchema, validateRoutinePatches, type RoutineDetail, type RoutinePatch } from "./routine-editor-contract";

export async function inspectRoutine(options: RoutineOptions, id: string, run: RoutineRunner = spawnWithStdin): Promise<RoutineDetail> {
  return reflexCommand(options, ["routine", "inspect", id], RoutineDetailSchema, run);
}

export async function proposeRoutinePatches(options: RoutineOptions, detail: RoutineDetail, text: string, run: RoutineRunner = spawnWithStdin): Promise<RoutinePatch[]> {
  if (!detail.writable || !detail.flow) throw new Error("This routine is read-only.");
  const result = await runRoutineCommand(run, [...options.composer, "--request", text, "--routine-edit", JSON.stringify(detail.flow), "--json"], options.timeoutSeconds * 1000);
  if (result.code !== 0) throw new Error("The configured routine model could not prepare a valid edit. Your routine has not changed.");
  const reply = RoutineEditProposalSchema.parse(JSON.parse(result.stdout));
  validateRoutinePatches(detail, reply.patches);
  return reply.patches;
}
