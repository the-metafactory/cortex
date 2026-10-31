import type { DeskView } from "../../desk/types";

export const DESK_VIPS_PATH = "/api/desk/vips";

export type DeskVipRow = DeskView["vips"][number];

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type VipChange = { op: "list" } | { op: "add"; address: string; label?: string | null } | { op: "remove"; address: string };

export type VipResult = { ok: true; vips: DeskVipRow[] } | { ok: false; text: string };

function request(change: VipChange): [string, RequestInit] {
  if (change.op === "add") {
    return [DESK_VIPS_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: change.address, label: change.label ?? null }) }];
  }
  if (change.op === "remove") return [`${DESK_VIPS_PATH}?address=${encodeURIComponent(change.address)}`, { method: "DELETE" }];
  return [DESK_VIPS_PATH, { method: "GET" }];
}

function isVipRow(v: unknown): v is { address: string; label?: string | null } {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { address?: unknown; label?: unknown };
  return typeof r.address === "string" && (r.label === null || r.label === undefined || typeof r.label === "string");
}

export async function changeVips(change: VipChange, fetchImpl: FetchLike = fetch): Promise<VipResult> {
  const [path, init] = request(change);
  let res: Response;
  try {
    res = await fetchImpl(path, init);
  } catch (err) {
    return { ok: false, text: `Mission Control did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = (await res.json().catch(() => null)) as { vips?: unknown; error?: unknown } | null;
  if (res.ok && Array.isArray(parsed?.vips)) {
    return { ok: true, vips: parsed.vips.filter(isVipRow).map((v) => ({ address: v.address, label: v.label ?? null })) };
  }
  const error = typeof parsed?.error === "string" ? parsed.error : "";
  return { ok: false, text: error || `Mission Control answered HTTP ${res.status}.` };
}
