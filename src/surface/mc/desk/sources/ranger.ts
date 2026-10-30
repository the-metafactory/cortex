/** Ranger's dashboard state (`GET <ranger>/api/state`), reduced to what the Desk reads. */

export interface RangerNeedsYou {
  key: string;
  repo: string;
  nodeId: string;
  title: string;
  url?: string;
  status: string;
  endedAt?: string;
  reason?: { class?: string; detail?: string };
}

export interface RangerCurrent {
  repo: string;
  nodeId: string;
  title: string;
  status: string;
  phase?: string;
  prLabel?: string;
  reviewRound?: number;
  startedAt?: string;
}

export interface RangerMapNode {
  id: string;
  title: string;
  kind?: string;
  url?: string;
}

export interface RangerMap {
  key: string;
  repo: string;
  grillings?: RangerMapNode[];
  decisions?: RangerMapNode[];
}

export interface RangerState {
  generatedAt?: string;
  refreshError?: string | null;
  current: RangerCurrent[];
  needsYou: RangerNeedsYou[];
  maps: RangerMap[];
}

export type RangerFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function readRangerState(
  baseUrl: string,
  fetchImpl: RangerFetch = fetch,
  timeoutMs = 3000,
): Promise<RangerState> {
  const res = await fetchImpl(new URL("/api/state", baseUrl).toString(), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ranger answered HTTP ${res.status}`);
  const body = (await res.json()) as Partial<RangerState>;
  return {
    generatedAt: body.generatedAt,
    refreshError: body.refreshError ?? null,
    current: Array.isArray(body.current) ? body.current : [],
    needsYou: Array.isArray(body.needsYou) ? body.needsYou : [],
    maps: Array.isArray(body.maps) ? body.maps : [],
  };
}

/** Titles for `owner/repo#n` refs, so Vigil escalations can be named in words. */
export function rangerTitles(state: RangerState): Map<string, { title: string; url?: string }> {
  const titles = new Map<string, { title: string; url?: string }>();
  for (const map of state.maps) {
    for (const node of [...(map.grillings ?? []), ...(map.decisions ?? [])]) {
      titles.set(`${map.repo}#${node.id}`, { title: node.title, url: node.url });
    }
  }
  for (const n of state.needsYou) titles.set(`${n.repo}#${n.nodeId}`, { title: n.title, url: n.url });
  for (const c of state.current) titles.set(`${c.repo}#${c.nodeId}`, { title: c.title });
  return titles;
}
