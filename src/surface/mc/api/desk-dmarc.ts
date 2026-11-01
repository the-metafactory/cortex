import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { ackDmarc, dmarcWeek } from "../desk/mail-dmarc";
import { fail, noStore } from "./desk-mail";

const AckSchema = z.object({ op: z.literal("ack"), report: z.string().min(1).max(512) }).strict();

/**
 * GET is the DMARC week so far. POST {op: "ack", report} is "Got it" on a failure card: it hides that report's cards.
 * The rebind and identity gates in handleApi run before this handler.
 */
export async function handleDeskDmarc(req: Request, db: Database, runtime: DeskRuntime | undefined, now: () => number = Date.now): Promise<Response> {
  const desk = runtime?.options;
  if (!desk?.enabled) return fail(409, "The Desk is turned off on this stack.");
  const config = desk.mailDmarc;
  if (!config) return fail(409, "DMARC reports are not set up on this stack (mc.desk.mail.dmarc).");
  if (req.method === "GET") return Response.json({ ok: true, week: dmarcWeek(db, now(), config) }, { headers: noStore });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  const parsed = AckSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "An op (ack) and a report are required.");
  if (!ackDmarc(db, parsed.data.report, now())) return fail(404, "There is no such DMARC report, or you already answered it.");
  return Response.json({ ok: true, message: "Got it. The Desk shows this report's failures only in the weekly line now." }, { headers: noStore });
}
