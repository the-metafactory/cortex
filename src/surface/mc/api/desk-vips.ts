import type { Database } from "bun:sqlite";
import { addSender, listSenders, normalizeVip, removeSender, type SenderList } from "../desk/vips";

const noStore = { headers: { "Cache-Control": "no-store" } };

const NOT_LISTED: Record<SenderList, string> = { vips: "not a VIP", unimportant: "not on the unimportant list" };

/** GET lists, POST {address, label?} adds, DELETE ?address= removes one of the Desk's sender lists (VIPs or unimportant senders). */
export async function handleDeskSenders(req: Request, url: URL, db: Database, list: SenderList, now: number = Date.now()): Promise<Response> {
  const rows = (): Response => Response.json({ [list]: listSenders(db, list) }, noStore);
  if (req.method === "GET") return rows();
  if (req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { address?: unknown; label?: unknown } | null;
    const address = typeof body?.address === "string" ? normalizeVip(body.address) : null;
    if (!address) return Response.json({ error: "address must be an email address or a domain such as @example.ch" }, { status: 400 });
    const label = typeof body?.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : null;
    addSender(db, list, address, label, now);
    return rows();
  }
  if (req.method === "DELETE") {
    const address = normalizeVip(url.searchParams.get("address") ?? "");
    if (!address) return Response.json({ error: "address is required" }, { status: 400 });
    if (!removeSender(db, list, address)) return Response.json({ error: NOT_LISTED[list] }, { status: 404 });
    return rows();
  }
  return new Response(null, { status: 405, headers: { Allow: "GET, POST, DELETE" } });
}

export const handleDeskVips = (req: Request, url: URL, db: Database, now: number = Date.now()): Promise<Response> => handleDeskSenders(req, url, db, "vips", now);
