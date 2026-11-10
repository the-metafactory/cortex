// glossary-ignore: host
export const GRAPH_SURFACES_PATH = "/api/desk/graph-surfaces";
export const GRAPH_SURFACES_DESTINATIONS = `${GRAPH_SURFACES_PATH}/destinations`;
export const GRAPH_SURFACES_NODE = `${GRAPH_SURFACES_PATH}/node`;
export const graphSurfaceNodePath = (ref: string, repository: string): string =>
  `${GRAPH_SURFACES_NODE}?ref=${encodeURIComponent(ref)}${repository ? `&repository=${encodeURIComponent(repository)}` : ""}`;

export interface GraphSurfaceRepository { ref: string; label: string }
export interface GraphSurfaceParent { ref: string; label: string; kind: "map" | "node"; repository: string }
export type GraphSurfaceDestinations = { enabled: false } | { enabled: true; repositories: GraphSurfaceRepository[]; parents: GraphSurfaceParent[] };
export interface GraphSurfaceFacts { title: string; status: string | null; kind: string | null; url: string | null }
export type GraphSurfaceCard = { enabled: false } | ({ enabled: true; state: "available" } & GraphSurfaceFacts) | { enabled: true; state: "unavailable" } | { enabled: true; state: "withheld" };
