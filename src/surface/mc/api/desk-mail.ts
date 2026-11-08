import { sourceBoundary } from "../desk/source-boundary";
import { z } from "zod";
import { CommitmentSchema, decisionReceipt, MailDecisionSchema, mailYesFilter, saveDecisionDraft } from "../desk/mail-yes-filter";
import { calendarsOnly, freeSlots, INVITE_REPLIES, proposalBody, replyToInvitation } from "../desk/mail-invitation";
import { calendarAvailability } from "../desk/calendar-availability";
import { listCalendars } from "../desk/calendars";
import { readClassifications } from "../desk/classify";
import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { spawnWithStdin, type WriterRunner } from "../desk/create";
import { correctMail, draftReply, MAIL_CORRECTIONS, markUnimportant, reportMail, resolveListedMail, type ListedMail } from "../desk/mail-actions";
import { logMailDecision, mailFeatures, recordMailOpened } from "../desk/mail-log";
import { blockSenderDomain, MOVE_TARGETS, moveMail, undoMove, type MoveDeps } from "../desk/mail-move";
import { runSweep, SWEEP_LIMITS, undoSweep } from "../desk/mail-sweep";
import { keepFromDigest, listMailGroups } from "../desk/mail-digest";
import { suspicionContext, suspicionOf, type SuspicionReason } from "../desk/mail-suspicion";
import { dismissSuspicion, removeTrustedSender, undoDismissal } from "../desk/mail-trust";
import { archiveWhatArrives, offerContext, unsubscribeMail, type OneClickPost } from "../desk/mail-unsubscribe";
import { addMailToStudio, mailForStudio, MAX_MAIL_REASON, proposeMailThread } from "../desk/mail-studio";
import type { CaptureModel } from "../desk/studio/capture";
import { STUDIO_SLUG } from "../desk/studio/format";
import { STUDIO_REQUEST_ID } from "../desk/studio/writer";
import { approveHandoff, discardHandoff, handMailToIvy, HANDOFF_OPS, handoffIdOf, isHandoffOp, MAX_INSTRUCTION, retryHandoff, type HandoffOp } from "../desk/mail-handoff";
import { handoffReady } from "../desk/compose";
import { closeHandoffTask } from "../desk/mail-handoff-close";
import { cancelSnooze, snoozeMail, SNOOZE_TIMES } from "../desk/mail-snooze";
import { actOnWaiting, nudgeMail, readWaiting, waitingFeatures, waitingIdOf, WAITING_OPS, type WaitingOp } from "../desk/mail-waiting";

const WaitingActionSchema = z.enum(WAITING_OPS.map((op) => `waiting.${op}` as const));
const waitingOp = (action: string): WaitingOp | null => {
  const op = action.slice("waiting.".length);
  return action.startsWith("waiting.") && WAITING_OPS.includes(op as WaitingOp) ? (op as WaitingOp) : null;
};

const HANDOFF_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

const SnoozeChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(SNOOZE_TIMES) }).strict(),
  z.object({ kind: z.literal("date"), date: z.string().max(10) }).strict(),
  z.object({ kind: z.literal("meeting"), event: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal("person"), address: z.string().min(3).max(320) }).strict(),
]);

const MailRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft"), key: z.string(), body: z.string(), decision: MailDecisionSchema.optional() }).strict(),
  z.object({ action: z.enum(["trash", "unimportant", "report", "digest.keep", "unsubscribe", "unsubscribe.rule"]), key: z.string() }).strict(),
  z.object({ action: z.literal("move"), key: z.string(), target: z.enum(MOVE_TARGETS) }).strict(),
  z.object({ action: z.literal("correct"), key: z.string(), said: z.enum(MAIL_CORRECTIONS), correction: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.enum(["undo", "block"]), move: z.string().min(1).max(64) }).strict(),
  z.object({ action: z.literal("sweep"), sweep: z.string().min(1).max(200), keys: z.array(z.string().min(1).max(1000)).min(1).max(SWEEP_LIMITS.maxMails), target: z.enum(MOVE_TARGETS).optional() }).strict(),
  z.object({ action: z.literal("sweep.undo"), sweep: z.string().min(1).max(64) }).strict(),
  z.object({ action: WaitingActionSchema, key: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal("ivy.hand"), key: z.string().min(1).max(1000), requestId: z.string().regex(HANDOFF_REQUEST_ID), instruction: z.string().max(MAX_INSTRUCTION).optional() }).strict(),
  z.object({ action: z.enum(HANDOFF_OPS), key: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal("studio.propose"), key: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal("snooze"), key: z.string().min(1).max(1000), until: SnoozeChoiceSchema }).strict(),
  z.object({ action: z.literal("snooze.cancel"), key: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal("opened"), key: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal("not-phishing"), key: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal("not-phishing.undo"), trust: z.string().min(1).max(64) }).strict(),
  z.object({ action: z.literal("not-phishing.remove"), sender: z.string().min(3).max(320) }).strict(),
  z.object({ action: z.literal("invite.propose"), key: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal("invite.reply"), key: z.string().min(1).max(1000), reply: z.enum(INVITE_REPLIES), requestId: z.uuid(), commitment: CommitmentSchema.nullable(), confirmed: z.boolean() }).strict(),
  z.object({ action: z.literal("studio.add"), key: z.string().min(1).max(1000), requestId: z.string().regex(STUDIO_REQUEST_ID), thread: z.string().regex(STUDIO_SLUG).nullable(), reason: z.string().trim().min(1).max(MAX_MAIL_REASON).optional(), includeText: z.boolean() }).strict(),
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
  post?: OneClickPost;
  captureModel?: CaptureModel;
}

/**
 * POST {action: "move", key, target: "archive" | "junk" | "trash"}, {action: "trash" | "unimportant" | "report", key} or
 * {action: "draft", key, body}: acts on one mail the Desk lists. {action: "unsubscribe", key} sends the list's One-Click
 * unsubscribe after the principal confirmed it; {action: "unsubscribe.rule", key} then adds an archive rule for the list. {action: "digest.keep", key} takes one mail out of the newsletter digest. {action: "correct", key, said, correction?} logs a per-mail correction and, for archive, spam and delete, moves the mail; with `correction` it retries only the move of that logged correction. {action: "undo" | "block", move} undoes a logged move,
 * or blocks the domain of a mail moved to Junk. {action: "snooze", key, until} hides one mail until a time, a meeting or a
 * person writes; {action: "snooze.cancel", key} ends the snooze. {action: "not-phishing", key} waives a flagged mail's
 * suspicion reasons (see mail-trust.ts); {action: "not-phishing.undo", trust} takes that back, and
 * {action: "not-phishing.remove", sender} forgets every dismissal for one sender address. {action: "opened", key} logs that
 * the principal opened the mail on the Desk (once until the next decision on it). The rebind and identity gates in
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
  const handoffBody = handoffBodyOf(body);
  if (handoffBody) return answer(await actOnHandoff(db, runtime, handoffBody, moveDeps));
  const op = waitingOp(body.action);
  if (op && "key" in body) return answer(actOnWaiting(db, body.key, op, now, runtime.options.mailWaiting));
  if (body.action === "draft" && waitingIdOf(body.key) !== null) return answer(await draftNudge(db, body.key, body.body, moveDeps));
  const decision = body.action === "draft" ? body.decision : undefined;
  if (decision && body.action === "draft") {
    const receipt = decisionReceipt(db, body.key, body.body, decision);
    if (receipt) return receipt.ok ? Response.json({ ok: true, message: receipt.message }, { headers: noStore }) : fail(receipt.status, receipt.error);
  }
  if (body.action === "not-phishing.undo") return answer(undoDismissal(db, body.trust, now));
  if (body.action === "not-phishing.remove") return answer(removeTrustedSender(db, body.sender, now));
  if (body.action === "snooze.cancel") return answer(body.key.startsWith("mail:") ? cancelSnooze(db, body.key.slice("mail:".length)) : { ok: false, status: 400, error: "A snooze key starts with mail:." });
  const listed = resolveListedMail(runtime.sourceCache?.cached() ?? [], body.key);
  if (!listed.ok) return fail(409, listed.error);
  const mail = listed.mail;
  if (body.action === "opened") return Response.json({ ok: true, recorded: recordMailOpened(db, mail, now) }, { headers: noStore });
  if (body.action === "not-phishing") return answer(dismissSuspicion(db, mail, mailSuspicion(db, mail, runtime.options.mailOwnDomains), now, deps.newId));
  if (body.action === "snooze") return answer(snoozeMail(db, mail, body.until, { now, readings: runtime.sourceCache?.cached() ?? [] }));
  if (decision && !mail.invitation && !["request", "invitation"].includes(readClassifications(db, [mail.id]).get(mail.id)?.commitment ?? "")) return fail(409, "This mail is no longer classified as a request or invitation. Refresh before saving the choice.");
  if (body.action === "ivy.hand") {
    const worker = runtime.mailHandoff;
    const ask = runtime.options.ask;
    if (!worker || !ask || !runtime.options.mailHandoff || !handoffReady(runtime.options, worker)) return fail(409, "Handing mail to Ivy is not set up on this stack: it needs the task writer, a task map, the draft command and a model lane.");
    const readings = runtime.sourceCache?.cached() ?? [];
    const suspicious = mailSuspicion(db, mail, runtime.options.mailOwnDomains).length > 0;
    const handed = await handMailToIvy(mailForStudio(db, readings, mail), { requestId: body.requestId, instruction: body.instruction ?? null, suspicious }, {
      localSources: sourceBoundary(runtime.options), db, writers: ask.writers, maps: ask.taskMaps, lanes: runtime.options.mailHandoff.lanes, run: deps.run ?? spawnWithStdin, now, timeoutMs: ask.timeoutSeconds * 1000,
    });
    if (handed.ok) void worker.kick(db, deps.now ?? Date.now);
    return answer(handed);
  }
  if (body.action === "invite.propose" || body.action === "invite.reply") return answerInvitation(db, runtime, mail, body, now, deps.run ?? spawnWithStdin);
  if (body.action === "studio.propose" || body.action === "studio.add") {
    const studio = runtime.options.studio;
    if (!studio) return fail(409, "The Studio is not set up on this stack.");
    const item = mailForStudio(db, runtime.sourceCache?.cached() ?? [], mail);
    const studioDeps = { localSources: sourceBoundary(runtime.options), options: studio, areas: runtime.options.areas, db, now: new Date(now), ...(deps.captureModel ? { model: deps.captureModel } : {}) };
    if (body.action === "studio.propose") return Response.json({ ok: true, proposal: await proposeMailThread(item, studioDeps) }, { headers: noStore });
    const { requestId, thread, reason, includeText } = body;
    const added = await addMailToStudio(item, { requestId, thread, includeText, ...(reason ? { reason } : {}) }, studioDeps);
    return added.ok ? Response.json({ ok: true, message: added.message }, { headers: noStore }) : fail(added.status, added.error);
  }
  if (body.action === "draft") {
    const features = mailFeatures(db, mail);
    const saved = decision ? await saveDecisionDraft({ db, desk: runtime.options, mail, body: body.body, decision, now, save: () => draftReply(mail, body.body, moveDeps) }) : await draftReply(mail, body.body, moveDeps);
    if (!saved.ok) return answer(saved);
    logMailDecision(db, features, "draft", "desk", now, "Drafts");
    return Response.json({ ok: true, message: saved.message }, { headers: noStore });
  }
  if (body.action === "unimportant") return answer(await markUnimportant(db, mail, moveDeps));
  if (body.action === "report") return answer(await reportMail(mail, runtime.options.mailReport, moveDeps));
  if (body.action === "digest.keep") return answer(keepFromDigest(db, mail, now));
  if (body.action === "correct") {
    const corrected = await correctMail(mail, body.said, moveDeps, body.correction);
    if (!("recorded" in corrected)) return answer(corrected);
    return Response.json({ ok: false, error: corrected.error, recorded: true, correction: corrected.correction }, { status: corrected.status, headers: noStore });
  }
  if (body.action === "unsubscribe.rule") return answer(archiveWhatArrives(db, mail, now));
  if (body.action === "unsubscribe") {
    const flagged = readClassifications(db, [mail.id]).get(mail.id)?.suspicious === true ? new Set([mail.id]) : undefined;
    const ctx = offerContext(db, runtime.options.mailUnsubscribe, suspicionContext(db, runtime.options.mailOwnDomains), flagged);
    return answer(await unsubscribeMail(mail, ctx, { db, ledger: runtime.ledger, now, ...(deps.post ? { post: deps.post } : {}) }));
  }
  return answer(await moveMail(mail, body.action === "move" ? body.target : "trash", moveDeps));
}

const mailSuspicion = (db: Database, mail: ListedMail, ownDomains: readonly string[] | undefined): SuspicionReason[] =>
  suspicionOf(mail, suspicionContext(db, ownDomains), readClassifications(db, [mail.id]).get(mail.id)?.suspicious === true);

type InviteBody = Extract<z.infer<typeof MailRequestSchema>, { action: "invite.propose" | "invite.reply" }>;

async function answerInvitation(db: Database, runtime: DeskRuntime, mail: ListedMail, body: InviteBody, now: number, run: WriterRunner): Promise<Response> {
  const desk = runtime.options;
  const invitation = mail.invitation;
  if (!desk) return fail(409, "The Desk is turned off on this stack.");
  if (!invitation) return fail(409, "This mail carries no calendar invitation.");
  const suspicious = mailSuspicion(db, mail, desk.mailOwnDomains).length > 0;
  if (body.action === "invite.propose") {
    if (suspicious) return fail(409, "This mail may be phishing, so the Desk does not answer its invitation.");
    const readings = runtime.sourceCache?.cached() ?? [];
    const calendar = calendarsOnly(calendarAvailability({ sources: desk.sources, readings, calendars: listCalendars(db), now }), readings);
    const found = freeSlots(invitation, calendar, now, desk.mailInvitations?.slots);
    return Response.json({ ok: true, body: found.slots.length > 0 ? proposalBody(invitation, found.slots) : "", slots: found.slots.length, ...(found.reason ? { note: found.reason } : {}) }, { headers: noStore });
  }
  const selected = body.commitment;
  if (selected && !(await mailYesFilter(db, desk, now)).commitments.some((c) => c.kind === selected.kind && c.id === selected.id && c.label === selected.label)) return fail(409, "That commitment is no longer current. Refresh and choose again.");
  return answer(await replyToInvitation(mail, { reply: body.reply, requestId: body.requestId, commitment: selected, confirmed: body.confirmed, suspicious }, {
    db, config: desk.mailInvitations, writers: desk.ask?.writers ?? {}, run, now, writerTimeoutMs: (desk.ask?.timeoutSeconds ?? 30) * 1000,
  }));
}

type HandoffBody = Extract<z.infer<typeof MailRequestSchema>, { action: HandoffOp | "draft" }>;

function handoffBodyOf(body: z.infer<typeof MailRequestSchema>): HandoffBody | null {
  if (body.action === "draft") return handoffIdOf(body.key) !== null ? body : null;
  return "key" in body && isHandoffOp(body.action) ? { action: body.action, key: body.key } : null;
}

async function actOnHandoff(db: Database, runtime: DeskRuntime, body: HandoffBody, moveDeps: MoveDeps): Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }> {
  const id = handoffIdOf(body.key);
  if (!id) return { ok: false, status: 400, error: "A hand-off key starts with ivy:." };
  if (body.action === "ivy.retry") {
    const retried = retryHandoff(db, id);
    if (retried.ok) void runtime.mailHandoff?.kick(db);
    return retried;
  }
  const decided = body.action === "ivy.discard" ? discardHandoff(db, id, moveDeps.now) : await approveHandoff(db, id, body.action === "draft" ? body.body : undefined, (mail, text) => draftReply(mail, text, moveDeps), moveDeps.now);
  if (!decided.ok) return decided;
  const note = await closeHandoffTask(db, id, runtime.mailHandoff?.closer, moveDeps.now);
  return note ? { ok: true, message: `${decided.message} ${note}` } : { ok: true, message: decided.message };
}

async function draftNudge(db: Database, key: string, text: string, moveDeps: MoveDeps): Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }> {
  const id = waitingIdOf(key);
  const waiting = id ? readWaiting(db, id) : null;
  const mail = waiting ? nudgeMail(waiting) : null;
  if (!waiting || !mail) return { ok: false, status: 409, error: "The Desk no longer tracks this sent mail, or it names no account to draft from." };
  const saved = await draftReply(mail, text, moveDeps);
  if (!saved.ok) return saved;
  logMailDecision(db, waitingFeatures(waiting), "draft", "desk", moveDeps.now, "Drafts");
  return { ok: true, message: `Nudge saved in your ${mail.account ?? "mail"} Drafts. Send it from there; the Desk keeps waiting for the answer.` };
}

type SweepBody = Extract<z.infer<typeof MailRequestSchema>, { action: "sweep" | "sweep.undo" }>;

async function sweepAnswer(body: SweepBody, db: Database, runtime: DeskRuntime, moveDeps: MoveDeps, waitMs: number): Promise<Response> {
  if (!moveDeps.config?.move?.length) return fail(409, "Sweeps need the move command (mc.desk.mail.actions.move), and it is not set up on this stack.");
  let work: Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }>;
  if (body.action === "sweep.undo") work = undoSweep(body.sweep, moveDeps);
  else {
    const readings = runtime.sourceCache?.cached() ?? [];
    const groups = listMailGroups(db, readings, runtime.options ?? {}, runtime.ledger, moveDeps.now);
    const group = [...groups.digests.groups, ...groups.sweeps].find((g) => g.id === body.sweep);
    if (!group) return fail(409, "This group has changed since you opened it. Look at it again.");
    work = runSweep(group, body.keys, moveDeps, body.target);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => { resolve(null); }, waitMs); });
  try {
    const result = await Promise.race([work, late]);
    if (result === null) {
      work.catch((err: unknown) => { console.error(`desk: mail sweep: ${err instanceof Error ? err.message : String(err)}`); });
      return Response.json({ ok: true, message: STILL_MOVING }, { status: 202, headers: noStore });
    }
    return answer(result);
  } finally {
    clearTimeout(timer);
  }
}

function answer(result: { ok: true } | { ok: false; status: number; error: string }): Response {
  if (!result.ok) return fail(result.status, result.error);
  return Response.json(result, { headers: noStore });
}
