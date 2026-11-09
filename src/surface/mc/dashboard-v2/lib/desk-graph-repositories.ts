// glossary-ignore: host
import type { GitlabHostListing, GitlabListing, GraphNodeOption, GraphRepository, GraphRepositoryListing } from "../../desk/graph-repositories";
import { GRAPH_REPOSITORIES_PATH, GRAPH_TICKED_PARAM, graphNodesPath } from "../../desk/graph-repository-schema";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type GraphRepositoriesResult = { ok: true; repositories: GraphRepository[]; listing: GraphRepositoryListing; gitlab: GitlabListing } | { ok: false; text: string };
export type GraphRepositoryChange = { ok: true } | { ok: false; text: string };

const isRepository = (v: unknown): v is GraphRepository => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.ref === "string" && typeof r.label === "string" && typeof r.forge === "string" && typeof r.enabled === "boolean";
};

async function send(path: string, init: RequestInit, fetchImpl: FetchLike): Promise<{ res: Response; body: Record<string, unknown> | null } | string> {
  try {
    const res = await fetchImpl(path, init);
    return { res, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch (err) {
    return `Mission Control did not answer: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;

const readGitlabHost = (v: unknown): GitlabHostListing[] => {
  const h = record(v);
  if (typeof h.host !== "string" || h.host === "") return [];
  return [h.ok === true ? { host: h.host, ok: true } : { host: h.host, ok: false, reason: typeof h.reason === "string" ? h.reason : "" }];
};

const readGitlab = (v: unknown): GitlabListing => {
  const g = record(v);
  if (g.ok === true && Array.isArray(g.hosts)) return { ok: true, hosts: g.hosts.flatMap(readGitlabHost) };
  return { ok: false, reason: typeof g.reason === "string" ? g.reason : "" };
};

const refusal = (res: Response, body: Record<string, unknown> | null): string => (typeof body?.error === "string" && body.error ? body.error : `Mission Control answered HTTP ${res.status}.`);

export async function loadGraphRepositories(fetchImpl: FetchLike = fetch): Promise<GraphRepositoriesResult> {
  const sent = await send(GRAPH_REPOSITORIES_PATH, { method: "GET" }, fetchImpl);
  if (typeof sent === "string") return { ok: false, text: sent };
  const { res, body } = sent;
  if (!res.ok || !Array.isArray(body?.repositories)) return { ok: false, text: refusal(res, body) };
  const listing = body.listing as { ok?: unknown; reason?: unknown } | undefined;
  return {
    ok: true,
    repositories: body.repositories.filter(isRepository),
    listing: listing?.ok === true ? { ok: true } : { ok: false, reason: typeof listing?.reason === "string" ? listing.reason : "" },
    gitlab: readGitlab(body.gitlab),
  };
}

export async function saveGraphRepository(ref: string, enabled: boolean, fetchImpl: FetchLike = fetch): Promise<GraphRepositoryChange> {
  const sent = await send(`${GRAPH_REPOSITORIES_PATH}/${encodeURIComponent(ref)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }, fetchImpl);
  if (typeof sent === "string") return { ok: false, text: sent };
  return sent.res.ok ? { ok: true } : { ok: false, text: refusal(sent.res, sent.body) };
}

export async function saveGraphRepositories(refs: readonly string[], enabled: boolean, onSaved: (ref: string) => void, fetchImpl: FetchLike = fetch): Promise<GraphRepositoryChange> {
  const unique = [...new Set(refs)];
  const failures: string[] = [];
  for (const ref of unique) {
    const result = await saveGraphRepository(ref, enabled, fetchImpl);
    if (result.ok) onSaved(ref);
    else failures.push(`${ref}: ${result.text}`);
  }
  return failures.length ? { ok: false, text: `${failures.length} of ${unique.length} repository changes could not be saved. ${failures.join(" ")}` } : { ok: true };
}

export type GraphChoiceResult<T> = { ok: true; items: T[] } | { ok: false; text: string };

const isNode = (v: unknown): v is GraphNodeOption => typeof (v as Record<string, unknown> | null)?.id === "string" && typeof (v as Record<string, unknown>).title === "string";

export async function loadTickedGraphRepositories(fetchImpl: FetchLike = fetch): Promise<GraphChoiceResult<GraphRepository>> {
  const sent = await send(`${GRAPH_REPOSITORIES_PATH}?${GRAPH_TICKED_PARAM}=1`, { method: "GET" }, fetchImpl);
  if (typeof sent === "string") return { ok: false, text: sent };
  return sent.res.ok && Array.isArray(sent.body?.repositories) ? { ok: true, items: sent.body.repositories.filter(isRepository) } : { ok: false, text: refusal(sent.res, sent.body) };
}

export async function loadGraphNodes(ref: string, fetchImpl: FetchLike = fetch): Promise<GraphChoiceResult<GraphNodeOption>> {
  const sent = await send(graphNodesPath(ref), { method: "GET" }, fetchImpl);
  if (typeof sent === "string") return { ok: false, text: sent };
  const { res, body } = sent;
  if (!res.ok) return { ok: false, text: refusal(res, body) };
  if (body?.ok === true && Array.isArray(body.nodes)) return { ok: true, items: body.nodes.filter(isNode) };
  return { ok: false, text: typeof body?.reason === "string" && body.reason ? `The open nodes could not be listed: ${body.reason}.` : "The open nodes could not be listed." };
}
