import type { Database } from "bun:sqlite";
import { addVip, listVips, normalizeVip, removeVip } from "../desk/vips";

const noStore = { headers: { "Cache-Control": "no-store" } };

/** GET lists, POST {address, label?} adds, DELETE ?address= removes the Desk's VIP senders. */
export async function handleDeskVips(req: Request, url: URL, db: Database, now: number = Date.now()): Promise<Response> {
  if (req.method === "GET") return Response.json({ vips: listVips(db) }, noStore);
  if (req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { address?: unknown; label?: unknown } | null;
    const address = typeof body?.address === "string" ? normalizeVip(body.address) : null;
    if (!address) return Response.json({ error: "address must be an email address or a domain such as @example.ch" }, { status: 400 });
    const label = typeof body?.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : null;
    addVip(db, address, label, now);
    return Response.json({ vips: listVips(db) }, noStore);
  }
  if (req.method === "DELETE") {
    const address = normalizeVip(url.searchParams.get("address") ?? "");
    if (!address) return Response.json({ error: "address is required" }, { status: 400 });
    if (!removeVip(db, address)) return Response.json({ error: "not a VIP" }, { status: 404 });
    return Response.json({ vips: listVips(db) }, noStore);
  }
  return new Response(null, { status: 405, headers: { Allow: "GET, POST, DELETE" } });
}
