// glossary-ignore: host
import { GRAPH_SURFACES_DESTINATIONS, graphSurfaceNodePath, type GraphSurfaceCard, type GraphSurfaceDestinations } from "../../desk/graph-surface-schema";
import { getJson } from "./api";

export type { GraphSurfaceCard, GraphSurfaceDestinations };

export const readGraphSurfaceDestinations = (signal?: AbortSignal): Promise<GraphSurfaceDestinations> => getJson(GRAPH_SURFACES_DESTINATIONS, signal ? { signal } : {});
export const readGraphSurfaceCard = (ref: string, repository: string, signal?: AbortSignal): Promise<GraphSurfaceCard> => getJson(graphSurfaceNodePath(ref, repository), signal ? { signal } : {});
