import { flowCardPath, type FlowSavedCard } from "../../desk/flow-surface-schema";
import { DESK_FLOWS_PATH, type FlowRoutine, SavedFlowDefinitionSchema, SavedFlowsSchema, type SavedFlow, type SavedFlowDefinition } from "../../../../conversations/saved-flow-contract";
import { ApiFailure, getJson, postJson } from "./api";

export type SavedFlowsState = { status: "checking" } | { status: "unconfigured" } | { status: "ready"; flows: SavedFlow[]; routine?: FlowRoutine } | { status: "error"; error: string };
export const flowReadError = (error: unknown): string => error instanceof ApiFailure ? error.message : "Mission Control could not read the saved flows.";

export async function loadSavedFlows(signal: AbortSignal, read = getJson): Promise<SavedFlowsState> {
  try {
    const listed = SavedFlowsSchema.parse(await read(DESK_FLOWS_PATH, { signal }));
    return { status: "ready", flows: listed.flows, ...(listed.routine ? { routine: listed.routine } : {}) };
  }
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

export const loadSavedFlowCard = (name: string, operation: string, signal: AbortSignal, read = getJson): Promise<FlowSavedCard> =>
  read<FlowSavedCard>(flowCardPath(name, operation), { signal });

export type ShownFlowsState = Extract<SavedFlowsState, { status: "ready" | "error" }>;
export const flowsShown = (flows: SavedFlowsState): flows is ShownFlowsState => flows.status === "ready" || flows.status === "error";

export function routinePageTabs(flows: SavedFlowsState): { flowsAvailable: boolean; tabs: Array<"schedule" | "workspace" | "flows"> } {
  const flowsAvailable = flowsShown(flows);
  return { flowsAvailable, tabs: flowsAvailable ? ["schedule", "workspace", "flows"] : ["schedule", "workspace"] };
}

export const routineNameFromFlow = (flow: string): string => {
  const words = flow.replace(/^F_/, "").split("_").filter(Boolean).join(" ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export interface RoutineStart { conversationId: string; proposalId: string; requestId: string }
export const newRoutineStart = (): RoutineStart => ({ conversationId: "", proposalId: crypto.randomUUID(), requestId: crypto.randomUUID() });

export type RoutineFromFlow = { status: "opened"; conversationId: string } | { status: "failed"; error: string; conversationId?: string };
type Post = <TRes>(path: string, body: unknown) => Promise<TRes>;
const post: Post = (path, body) => postJson(path, body);

export async function makeRoutineFromFlow(flow: string, routine: FlowRoutine, start: RoutineStart, send: Post = post): Promise<RoutineFromFlow> {
  const name = routineNameFromFlow(flow);
  let conversationId: string;
  try {
    const created = await send<{ conversation: { id: string } }>("/api/conversations", { title: `Routine from ${name}`, origin: { kind: "web", ref: "desk-saved-flow" }, requestId: start.requestId });
    conversationId = created.conversation.id;
  } catch (error) { return { status: "failed", error: flowReadError(error) }; }
  try {
    await send(`/api/conversations/${conversationId}/proposals`, { proposalId: start.proposalId, type: "routine", fields: { flow, name, target: routine.target, timezone: routine.timeZone } });
  } catch (error) { return { status: "failed", error: flowReadError(error), conversationId }; }
  return { status: "opened", conversationId };
}
