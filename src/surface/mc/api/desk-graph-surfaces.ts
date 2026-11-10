// glossary-ignore: host
import type { GraphSurfaceAccess } from "../desk/graph-surfaces";
import { GRAPH_SURFACES_DESTINATIONS, GRAPH_SURFACES_NODE } from "../desk/graph-surface-schema";

const noStore = { "Cache-Control": "no-store" };
const MAX_REF = 512;

export async function handleDeskGraphSurfaces(req: Request, url: URL, access: GraphSurfaceAccess | undefined): Promise<Response> {
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  const reader = access?.() ?? null;
  if (!reader) return Response.json({ enabled: false }, { headers: noStore });
  try {
    if (url.pathname === GRAPH_SURFACES_DESTINATIONS) return Response.json(await reader.destinations(), { headers: noStore });
    if (url.pathname !== GRAPH_SURFACES_NODE) return Response.json({ error: "Unknown graph surface route." }, { status: 404, headers: noStore });
    const ref = url.searchParams.get("ref") ?? "";
    const repository = url.searchParams.get("repository") ?? "";
    if (!ref.trim() || ref.length > MAX_REF || repository.length > MAX_REF) return Response.json({ error: "A graph reference is required." }, { status: 400, headers: noStore });
    return Response.json(await reader.node(ref, repository || undefined), { headers: noStore });
  } catch (err) {
    process.stderr.write(`desk graph surfaces: ${err instanceof Error ? err.message : String(err)}\n`);
    return Response.json({ error: "The graph connection could not be read." }, { status: 502, headers: noStore });
  }
}
