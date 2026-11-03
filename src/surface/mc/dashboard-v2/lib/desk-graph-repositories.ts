import type { GraphRepository, GraphRepositoryListing } from "../../desk/graph-repositories";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const GRAPH_REPOSITORIES_URL = "/api/desk/graph-repositories";

export type GraphRepositoriesResult = { ok: true; repositories: GraphRepository[]; listing: GraphRepositoryListing } | { ok: false; text: string };
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

const refusal = (res: Response, body: Record<string, unknown> | null): string => (typeof body?.error === "string" && body.error ? body.error : `Mission Control answered HTTP ${res.status}.`);

export async function loadGraphRepositories(fetchImpl: FetchLike = fetch): Promise<GraphRepositoriesResult> {
  const sent = await send(GRAPH_REPOSITORIES_URL, { method: "GET" }, fetchImpl);
  if (typeof sent === "string") return { ok: false, text: sent };
  const { res, body } = sent;
  if (!res.ok || !Array.isArray(body?.repositories)) return { ok: false, text: refusal(res, body) };
  const listing = body.listing as { ok?: unknown; reason?: unknown } | undefined;
  return {
    ok: true,
    repositories: body.repositories.filter(isRepository),
    listing: listing?.ok === true ? { ok: true } : { ok: false, reason: typeof listing?.reason === "string" ? listing.reason : "" },
  };
}

export async function saveGraphRepository(ref: string, enabled: boolean, fetchImpl: FetchLike = fetch): Promise<GraphRepositoryChange> {
  const sent = await send(`${GRAPH_REPOSITORIES_URL}/${encodeURIComponent(ref)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }, fetchImpl);
  if (typeof sent === "string") return { ok: false, text: sent };
  return sent.res.ok ? { ok: true } : { ok: false, text: refusal(sent.res, sent.body) };
}
