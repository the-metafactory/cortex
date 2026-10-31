import type { DeskProposal } from "../../desk/ask";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const post = async <T>(path: string, body: unknown, fetchImpl: FetchLike): Promise<{ ok: true; body: T } | { ok: false; text: string; uncertain?: true }> => {
  let res: Response;
  try {
    res = await fetchImpl(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    return { ok: false, text: `Mission Control did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = (await res.json().catch(() => null)) as (T & { error?: unknown; detail?: unknown; uncertain?: unknown }) | null;
  if (res.ok && parsed) return { ok: true, body: parsed };
  const line = typeof parsed?.detail === "string" ? parsed.detail : typeof parsed?.error === "string" ? parsed.error : "";
  return { ok: false, text: line || `The request failed (HTTP ${res.status}).`, ...(parsed?.uncertain === true ? { uncertain: true as const } : {}) };
};

export async function askDesk(text: string, fetchImpl: FetchLike = fetch, area?: string): Promise<{ ok: true; proposal: DeskProposal } | { ok: false; text: string }> {
  const r = await post<{ proposal: DeskProposal }>("/api/desk/ask", { text, ...(area ? { area } : {}) }, fetchImpl);
  return r.ok ? { ok: true, proposal: r.body.proposal } : r;
}

export async function createFromProposal(
  requestId: string,
  kind: DeskProposal["kind"],
  fields: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; text: string; uncertain?: true }> {
  const r = await post<{ message?: string }>("/api/desk/create", { requestId, kind, fields }, fetchImpl);
  return r.ok ? { ok: true, text: r.body.message ?? "Done." } : r;
}
