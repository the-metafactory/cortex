import { z } from "zod";
import { decisionReceipt, MailDecisionSchema, saveDecisionDraft } from "../desk/mail-yes-filter";
import { readClassifications } from "../desk/classify";
import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { spawnWithStdin, type WriterRunner } from "../desk/create";
import { correctMail, draftReply, findListedMail, MAIL_CORRECTIONS, markUnimportant, reportMail } from "../desk/mail-actions";
import { logMailDecision, mailFeatures } from "../desk/mail-log";
import { blockSenderDomain, MOVE_TARGETS, moveMail, undoMove, type MoveDeps, type MoveResult } from "../desk/mail-move";
import { listSweeps, runSweep, sweepContext, SWEEP_LIMITS, undoSweep } from "../desk/mail-sweep";

const MailRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft"), key: z.string(), body: z.string(), decision: MailDecisionSchema.optional() }).strict(),
  z.object({ action: z.enum(["trash", "unimportant", "report"]), key: z.string() }).strict(),
  z.object({ action: z.literal("move"), key: z.string(), target: z.enum(MOVE_TARGETS) }).strict(),
  z.object({ action: z.literal("correct"), key: z.string(), said: z.enum(MAIL_CORRECTIONS) }).strict(),
  z.object({ action: z.enum(["undo", "block"]), move: z.string().min(1).max(64) }).strict(),
  z.object({ action: z.literal("sweep"), sweep: z.string().min(1).max(200), keys: z.array(z.string().min(1).max(1000)).min(1).max(SWEEP_LIMITS.maxMails) }).strict(),
  z.object({ action: z.literal("sweep.undo"), sweep: z.string().min(1).max(64) }).strict(),
]);

export const SWEEP_WAIT_MS = 8000;
const STILL_MOVING = "Still moving the mails. Done for you shows the result when it is finished.";

export const noStore = { "Cache-Control": "no-store" };
export const fail = (status: number, error: string): Response => Response.json({ ok: false, error }, { status, headers: noStore });

export interface DeskMailDeps {
  run?: WriterRunner;
  now?: () => number;
  newId?: () => string;
  sweepWaitMs?: number;
}

/**
 * POST {action: "move", key, target: "archive" | "junk" | "trash"}, {action: "trash" | "unimportant" | "report", key} or
 * {action: "draft", key, body}: acts on one mail the Desk lists. {action: "correct", key, said} logs a per-mail correction. {action: "undo" | "block", move} undoes a logged move,
 * or blocks the domain of a mail moved to Junk. The rebind and identity gates in
 * handleApi run before this handler; there is no step-up. The account and Message-ID come from the mail source's
 * last reading, never from the page, and a mail already moved or still moving is refused.
 */
export async function handleDeskMail(req: Request, db: Database, runtime: DeskRuntime | undefined, deps: DeskMailDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!runtime?.options?.enabled) return fail(409, "The Desk is turned off on this stack.");
  const parsed = MailRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, parsed.error.issues.some(issue => issue.path.includes("body")) ? "A draft needs the reply text." : "An action, item key and valid commitment choice are required.");
  const body = parsed.data;
  const now = (deps.now ?? Date.now)();
  const moveDeps = { db, config: runtime.options.mailActions, ledger: runtime.ledger, run: deps.run ?? spawnWithStdin, now, ...(deps.newId ? { newId: deps.newId } : {}) };
  if (body.action === "sweep" || body.action === "sweep.undo") return sweepAnswer(body, db, runtime, moveDeps, deps.sweepWaitMs ?? SWEEP_WAIT_MS);
  if ("move" in body) {
    return answer(body.action === "undo" ? await undoMove(body.move, moveDeps) : blockSenderDomain(db, body.move, now));
  }
  const decision = body.action === "draft" ? body.decision : undefined;
  if (decision && body.action === "draft") {
    const receipt = decisionReceipt(db, body.key, body.body, decision);
    if (receipt) return receipt.ok ? Response.json({ ok: true, message: receipt.message }, { headers: noStore }) : fail(receipt.status, receipt.error);
  }
  const mail = findListedMail(runtime.sourceCache?.cached() ?? [], body.key);
  if (!mail) return fail(409, "The Desk no longer lists this mail.");
  if (decision && !["request", "invitation"].includes(readClassifications(db, [mail.id]).get(mail.id)?.commitment ?? "")) return fail(409, "This mail is no longer classified as a request or invitation. Refresh before saving the choice.");
  if (body.action === "draft") {
    const features = mailFeatures(db, mail);
    const saved = decision ? await saveDecisionDraft({ db, desk: runtime.options, mail, body: body.body, decision, now, save: () => draftReply(mail, body.body, moveDeps) }) : await draftReply(mail, body.body, moveDeps);
    if (saved.ok) logMailDecision(db, features, "draft", "desk", now, "Drafts");
    return answer(saved);
  }
  if (body.action === "unimportant") return answer(await markUnimportant(db, mail, moveDeps));
  if (body.action === "report") return answer(await reportMail(mail, runtime.options.mailReport, moveDeps));
  if (body.action === "correct") return answer(correctMail(db, mail, body.said, now));
  return answer(await moveMail(mail, body.action === "move" ? body.target : "trash", moveDeps));
}

type SweepBody = { action: "sweep"; sweep: string; keys: string[] } | { action: "sweep.undo"; sweep: string };

async function sweepAnswer(body: SweepBody, db: Database, runtime: DeskRuntime, moveDeps: MoveDeps, waitMs: number): Promise<Response> {
  if (!moveDeps.config?.move?.length) return fail(409, "Sweeps need the move command (mc.desk.mail.actions.move), and it is not set up on this stack.");
  let work: Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }>;
  if (body.action === "sweep.undo") work = undoSweep(body.sweep, moveDeps);
  else {
    const readings = runtime.sourceCache?.cached() ?? [];
    const group = listSweeps(db, readings, sweepContext(runtime.options ?? { areas: [] }, readings, runtime.ledger), moveDeps.now).find((g) => g.id === body.sweep);
    if (!group) return fail(409, "This group has changed since you opened it. Look at it again.");
    work = runSweep(group, body.keys, moveDeps);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => { resolve(null); }, waitMs); });
  try {
    const result = await Promise.race([work, late]);
    if (result === null) {
      work.catch((err: unknown) => { console.error(`desk: mail sweep: ${err instanceof Error ? err.message : String(err)}`); });
      return Response.json({ ok: true, message: STILL_MOVING }, { status: 202, headers: noStore });
    }
    if (!result.ok) return fail(result.status, result.error);
    return Response.json(result, { headers: noStore });
  } finally {
    clearTimeout(timer);
  }
}

function answer(result: MoveResult): Response {
  if (!result.ok) return fail(result.status, result.error);
  return Response.json(result, { headers: noStore });
}
