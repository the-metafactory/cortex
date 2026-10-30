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

/** Keeps only http(s) links, so a Ranger value cannot become a script link on the Desk. */
export function safeHttpUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

const withSafeUrl = <T extends { url?: string }>(x: T): T => ({ ...x, url: safeHttpUrl(x.url) });

export type RangerFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Reads Ranger's dashboard state over loopback HTTP. Transitional: docs/architecture.md §6.2 wants a bus path
 * between apps, so the Desk's write actions (cortex#2773) must not be built on this channel.
 */
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
    needsYou: Array.isArray(body.needsYou) ? body.needsYou.map(withSafeUrl) : [],
    maps: Array.isArray(body.maps)
      ? body.maps.map((m) => ({ ...m, grillings: m.grillings?.map(withSafeUrl), decisions: m.decisions?.map(withSafeUrl) }))
      : [],
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
