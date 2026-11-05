import { DESK_FLOWS_PATH, SavedFlowDefinitionSchema, SavedFlowsSchema, type SavedFlow, type SavedFlowDefinition } from "../../desk/saved-flow-contract";
import { ApiFailure, getJson } from "./api";

export type SavedFlowsState = { status: "checking" } | { status: "unconfigured" } | { status: "ready"; flows: SavedFlow[] } | { status: "error"; error: string };
export const flowReadError = (error: unknown): string => error instanceof Error ? error.message : "Mission Control could not read the saved flows.";

export async function loadSavedFlows(signal: AbortSignal, read = getJson): Promise<SavedFlowsState> {
  try { return { status: "ready", flows: SavedFlowsSchema.parse(await read(DESK_FLOWS_PATH, { signal })).flows }; }
  catch (error) {
    if (error instanceof ApiFailure && error.info.status === 404) return { status: "unconfigured" };
    return { status: "error", error: flowReadError(error) };
  }
}

export async function loadSavedFlowDefinition(name: string, signal: AbortSignal, read = getJson): Promise<SavedFlowDefinition> {
  const definition = SavedFlowDefinitionSchema.parse(await read(`${DESK_FLOWS_PATH}/${encodeURIComponent(name)}`, { signal }));
  if (definition.name !== name) throw new Error("Mission Control returned a different saved flow.");
  return definition;
}
