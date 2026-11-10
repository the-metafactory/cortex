import type { GraphSurfaceAccess } from "../desk/graph-surfaces";
import { GRAPH_SURFACES_DESTINATIONS, GRAPH_SURFACES_NODE } from "../desk/graph-surface-schema";
import { handleDeskSurface } from "./desk-surface";

const MAX_REF = 512;

export async function handleDeskGraphSurfaces(req: Request, url: URL, access: GraphSurfaceAccess | undefined): Promise<Response> {
  return handleDeskSurface(req, url, access, {
    label: "desk graph surfaces",
    destinations: GRAPH_SURFACES_DESTINATIONS,
    item: GRAPH_SURFACES_NODE,
    unknown: "Unknown graph surface route.",
    invalid: "A graph reference is required.",
    failure: "The graph connection could not be read.",
    items: candidate => {
      const ref = candidate.searchParams.get("ref") ?? "";
      const repository = candidate.searchParams.get("repository") ?? "";
      return ref.trim().length === 0 || ref.length > MAX_REF || repository.length > MAX_REF ? null : { ref, repository };
    },
    destinationsOf: reader => reader.destinations(),
    itemOf: (reader, input) => reader.node(input.ref, input.repository || undefined),
  });
}
