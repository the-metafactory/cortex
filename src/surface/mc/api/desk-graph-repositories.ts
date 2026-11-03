import type { Database } from "bun:sqlite";
import { isGithubRef, listGraphRepositories, setGraphRepositoryEnabled, type GraphRepositoryRunner } from "../desk/graph-repositories";
import { runCommand } from "../desk/spawn";
import { GRAPH_REPOSITORIES_PATH } from "../desk/graph-repository-schema";

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ error }, { status, headers: noStore });

export interface DeskGraphRepositoryDeps {
  run?: GraphRepositoryRunner;
  now?: () => number;
}

/**
 * GET lists the principal's GitHub repositories with their ticks; PUT /api/desk/graph-repositories/<encoded ref> with
 * {enabled} ticks or unticks one. The rebind and identity gates in handleApi run before this handler.
 */
export async function handleDeskGraphRepositories(req: Request, url: URL, db: Database, deps: DeskGraphRepositoryDeps = {}): Promise<Response> {
  const rest = url.pathname.slice(GRAPH_REPOSITORIES_PATH.length);
  if (rest === "") {
    if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    return Response.json(await listGraphRepositories(db, deps.run ?? runCommand), { headers: noStore });
  }
  if (!rest.startsWith("/") || rest.length === 1) return fail(404, "Unknown route.");
  if (req.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "PUT" } });
  let ref: string;
  try {
    ref = decodeURIComponent(rest.slice(1));
  } catch (_err) {
    return fail(400, "The repository reference is not valid.");
  }
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") return fail(400, "enabled must be true or false.");
  if (body.enabled && !isGithubRef(ref)) return fail(400, "Only a GitHub repository such as github:github.com/<owner>/<name> can be ticked.");
  setGraphRepositoryEnabled(db, ref, body.enabled, (deps.now ?? Date.now)());
  return Response.json({ ref, enabled: body.enabled }, { headers: noStore });
}
