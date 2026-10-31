import type { DeskView } from "../../desk/types";

export type SenderListId = "vips" | "unimportant";

export type SenderRow = DeskView["vips"][number];

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type SenderChange = { op: "list" } | { op: "add"; address: string; label?: string | null } | { op: "remove"; address: string };

export type SenderResult = { ok: true; rows: SenderRow[] } | { ok: false; text: string };

function request(list: SenderListId, change: SenderChange): [string, RequestInit] {
  const path = `/api/desk/${list}`;
  if (change.op === "add") {
    return [path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: change.address, label: change.label ?? null }) }];
  }
  if (change.op === "remove") return [`${path}?address=${encodeURIComponent(change.address)}`, { method: "DELETE" }];
  return [path, { method: "GET" }];
}

function isSenderRow(v: unknown): v is { address: string; label?: string | null } {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { address?: unknown; label?: unknown };
  return typeof r.address === "string" && (r.label === null || r.label === undefined || typeof r.label === "string");
}

export async function changeSenders(list: SenderListId, change: SenderChange, fetchImpl: FetchLike = fetch): Promise<SenderResult> {
  const [path, init] = request(list, change);
  let res: Response;
  try {
    res = await fetchImpl(path, init);
  } catch (err) {
    return { ok: false, text: `Mission Control did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const rows = parsed?.[list];
  if (res.ok && Array.isArray(rows)) {
    return { ok: true, rows: rows.filter(isSenderRow).map((v) => ({ address: v.address, label: v.label ?? null })) };
  }
  const error = typeof parsed?.error === "string" ? parsed.error : "";
  return { ok: false, text: error || `Mission Control answered HTTP ${res.status}.` };
}

export const changeVips = (change: SenderChange, fetchImpl: FetchLike = fetch): Promise<SenderResult> => changeSenders("vips", change, fetchImpl);
