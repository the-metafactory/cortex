import { z } from "zod";
import type { Database } from "bun:sqlite";
import { failResponse } from "../desk/act-result";
import type { DeskRuntime, DeskVigilSource } from "../desk/compose";
import { putBackMailRound, undoMailRoundPutBack, type MailRoundUndoOutcome } from "../desk/mail-round";
import type { DeskPhrase } from "../desk/phrases";
import type { DeskView } from "../desk/types";
import { composeDeskView } from "./desk";
import { fail, noStore } from "./desk-mail";

export const DESK_MAIL_ROUND_PATH = "/api/desk/mail/round";

const ROUND_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

const RoundRequestSchema = z.union([
  z
    .object({
      action: z.literal("put-back"),
      roundId: z.string().min(1).max(64),
      revision: z.number().int().nonnegative(),
      key: z.string().min(1).max(1000),
      requestId: z.string().regex(ROUND_REQUEST_ID),
    })
    .strict(),
  z.object({ action: z.literal("undo"), token: z.string().min(1).max(64), requestId: z.string().regex(ROUND_REQUEST_ID) }).strict(),
]);

interface DeskMailRoundDeps {
  now?: () => number;
  view?: (db: Database, desk: DeskRuntime, vigil: DeskVigilSource | undefined) => Promise<DeskView>;
}

const undoPhrase = (outcome: MailRoundUndoOutcome): DeskPhrase =>
  outcome === "restored" ? { code: "mail.put-back-undone" } : { code: "mail.put-back-next-round" };

export async function handleDeskMailRound(
  req: Request,
  db: Database,
  desk: DeskRuntime | undefined,
  vigil: DeskVigilSource | undefined,
  deps: DeskMailRoundDeps = {},
): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!desk?.options?.enabled) return fail(409, "The Desk is turned off on this stack.");
  const parsed = RoundRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "A round action, its round id and revision, a mail key and a request id are required.");
  const body = parsed.data;
  if (body.action === "put-back" && !body.key.startsWith("mail:")) return fail(400, "A mail key starts with mail:.");
  const now = (deps.now ?? desk.now ?? Date.now)();
  const viewNow = async (): Promise<DeskView> => (deps.view ?? composeDeskView)(db, desk, vigil);
  if (body.action === "put-back") {
    const put = putBackMailRound(db, { roundId: body.roundId, revision: body.revision, key: body.key, requestId: body.requestId, now });
    if (!put.ok) return failResponse(put.status, put.error);
    const view = await viewNow();
    const messagePhrase: DeskPhrase = { code: "mail.put-back", params: { nextAt: view.mailRound?.nextScheduledAt ?? "" } };
    return Response.json({ ok: true, message: put.message, messagePhrase, mailRound: view.mailRound, undo: put.undo }, { headers: noStore });
  }
  const undone = undoMailRoundPutBack(db, { token: body.token, requestId: body.requestId, now });
  if (!undone.ok) return failResponse(undone.status, undone.error);
  const view = await viewNow();
  return Response.json({ ok: true, message: undone.message, messagePhrase: undoPhrase(undone.outcome), mailRound: view.mailRound, outcome: undone.outcome }, { headers: noStore });
}
