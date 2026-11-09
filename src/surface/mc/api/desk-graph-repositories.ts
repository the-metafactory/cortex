// glossary-ignore: run
import type { Database } from "bun:sqlite";
import { isGithubRef, isGitlabRef, isGraphRepositoryAllowed, listGraphNodes, listGraphRepositories, setGraphRepositoryEnabled, tickedGraphRepositories, type GraphRepositoryRunner } from "../desk/graph-repositories";
import { runCommand } from "../desk/spawn";
import { GRAPH_NODES_SUFFIX as NODES_SUFFIX, GRAPH_REPOSITORIES_PATH, GRAPH_TICKED_PARAM as TICKED_PARAM } from "../desk/graph-repository-schema";

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ error }, { status, headers: noStore });

export interface DeskGraphRepositoryDeps {
  run?: GraphRepositoryRunner;
  now?: () => number;
}


async function nodes(req: Request, encoded: string, db: Database, run: GraphRepositoryRunner): Promise<Response> {
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  let ref: string;
  try {
    ref = decodeURIComponent(encoded);
  } catch (_err) {
    return fail(400, "The repository reference is not valid.");
  }
  if (!isGraphRepositoryAllowed(db, ref)) return fail(403, `This conversation may not file to ${ref}. Tick it in Desk Settings first.`);
  return Response.json(await listGraphNodes(ref, run), { headers: noStore });
}

/**
 * GET lists the principal's GitHub repositories and GitLab projects with their ticks; PUT /api/desk/graph-repositories/<encoded ref> with
 * {enabled} ticks or unticks one; GET ?ticked=1 lists only the ticked ones without asking a forge; GET /api/desk/graph-repositories/<encoded ref>/nodes lists a ticked repository's open issues as parent
 * candidates. The rebind and identity gates in handleApi run before this handler.
 */
export async function handleDeskGraphRepositories(req: Request, url: URL, db: Database, deps: DeskGraphRepositoryDeps = {}): Promise<Response> {
  const rest = url.pathname.slice(GRAPH_REPOSITORIES_PATH.length);
  if (rest === "") {
    if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    if (url.searchParams.get(TICKED_PARAM) === "1") return Response.json({ repositories: tickedGraphRepositories(db) }, { headers: noStore });
    return Response.json(await listGraphRepositories(db, deps.run ?? runCommand), { headers: noStore });
  }
  if (!rest.startsWith("/") || rest.length === 1) return fail(404, "Unknown route.");
  if (rest.endsWith(NODES_SUFFIX) && rest.length > NODES_SUFFIX.length + 1) return nodes(req, rest.slice(1, -NODES_SUFFIX.length), db, deps.run ?? runCommand);
  if (req.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "PUT" } });
  let ref: string;
  try {
    ref = decodeURIComponent(rest.slice(1));
  } catch (_err) {
    return fail(400, "The repository reference is not valid.");
  }
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") return fail(400, "enabled must be true or false.");
  if (body.enabled && !isGithubRef(ref) && !isGitlabRef(ref)) return fail(400, "Only a GitHub repository such as github:github.com/<owner>/<name> or a GitLab project such as gitlab:<host>/<group>/<name> can be ticked.");
  setGraphRepositoryEnabled(db, ref, body.enabled, (deps.now ?? Date.now)());
  return Response.json({ ref, enabled: body.enabled }, { headers: noStore });
}
