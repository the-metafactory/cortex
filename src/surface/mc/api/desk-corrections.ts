import type { Database } from "bun:sqlite";
import { correctionLabel, isCorrectionMode, isItemKind, isSource, listCorrections, removeCorrection, setCorrection } from "../desk/corrections";

const noStore = { "Cache-Control": "no-store" };
const reply = (body: object, status = 200): Response => Response.json(body, { status, headers: noStore });

export const MAIL_IS_PER_MAIL = "Mail is corrected one mail at a time: use the card's menu (This isn't bulk, This matters, Wrong suggestion).";

const DONE = {
  less: (label: string) => `"${label}" rank lower from now on. You can undo this under Ranking in the margin.`,
  always: (label: string) => `"${label}" rank first from now on. You can undo this under Ranking in the margin.`,
};

export async function handleDeskCorrections(req: Request, url: URL, db: Database, now: () => number = Date.now): Promise<Response> {
  if (req.method === "GET") return reply({ corrections: listCorrections(db) });
  if (req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { kind?: unknown; source?: unknown; mode?: unknown } | null;
    if (!isItemKind(body?.kind) || !isSource(body.source) || !isCorrectionMode(body.mode)) {
      return reply({ ok: false, error: "A kind, a source and a mode (less or always) are required." }, 400);
    }
    if (body.kind === "mail") return reply({ ok: false, error: MAIL_IS_PER_MAIL }, 400);
    setCorrection(db, body.kind, body.source, body.mode, now());
    return reply({ ok: true, message: DONE[body.mode](correctionLabel(body.kind, body.source)), corrections: listCorrections(db) });
  }
  if (req.method === "DELETE") {
    const kind = url.searchParams.get("kind");
    const source = url.searchParams.get("source");
    if (!isItemKind(kind) || !isSource(source)) return reply({ ok: false, error: "A kind and a source are required." }, 400);
    if (!removeCorrection(db, kind, source)) return reply({ ok: false, error: "There is no such correction." }, 404);
    return reply({ ok: true, message: "The Desk ranks those items by its base rules again.", corrections: listCorrections(db) });
  }
  return new Response(null, { status: 405, headers: { Allow: "GET, POST, DELETE" } });
}
