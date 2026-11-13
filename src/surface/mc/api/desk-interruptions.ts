import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { NO_INTERRUPTIONS, type InterruptRules } from "../desk/interrupt";
import { isMailReason, isReasonCode, listReasons, PER_VIP, readSwitches, reasonAvailable, reasonLabel, recordFeedback, setSwitch } from "../desk/interrupt-switches";
import { listVips, type DeskVip } from "../desk/vips";
import type { InterruptReasonCode } from "../desk/types";
import { reply } from "./desk-reply";

export const INTERRUPTIONS_PATH = "/api/desk/interruptions";
export const INTERRUPTION_FEEDBACK_PATH = "/api/desk/interruptions/feedback";

const ERRORS = {
  switchShape: "A reason code and on (true or false) are required.",
  feedbackShape: "A reason code and important (true or false) are required.",
  key: "key is required.",
  target: "Mail from a VIP is switched per address: give the VIP's address as target.",
  notVip: "That address is not a VIP.",
  deskOff: "The Desk is turned off on this stack.",
  mailOff: "Mail interruptions are turned off for this stack (mc.desk.interruptions.mail).",
  meetingsOff: "Meeting interruptions are turned off for this stack (mc.desk.interruptions.meetingMinutes is 0).",
};

const MAIL_KEPT = "Kept. Mail like this still interrupts you.";
const MAIL_SWITCHED_OFF = "Noted. Mail like this now waits in the list without interrupting you. You can switch it back on under Interruptions.";

function feedbackMessage(code: InterruptReasonCode, label: string, important: boolean): string {
  if (isMailReason(code)) return important ? MAIL_KEPT : MAIL_SWITCHED_OFF;
  return important ? `Kept. "${label}" still interrupts you.` : `Noted. "${label}" now waits in the list without interrupting you. You can switch it back on under Interruptions.`;
}

interface DeskState {
  db: Database;
  deskOn: boolean;
  rules: InterruptRules;
  vips: DeskVip[];
}

const deskStateOf = (db: Database, runtime: DeskRuntime | undefined): DeskState => ({
  db,
  deskOn: runtime?.options?.enabled === true,
  rules: runtime?.options?.interruptions ?? NO_INTERRUPTIONS,
  vips: listVips(db),
});

const reasons = (desk: DeskState): object => ({ reasons: listReasons(desk.rules, readSwitches(desk.db), desk.vips, desk.deskOn) });

const fail = (status: number, error: string): Response => reply({ ok: false, error }, status);

type Checked = { code: InterruptReasonCode; target: string; vip?: DeskVip } | Response;

function checkReason(desk: DeskState, code: InterruptReasonCode, target: unknown): Checked {
  const perVip = code === PER_VIP;
  if (perVip !== (typeof target === "string" && target.trim() !== "")) return fail(400, ERRORS.target);
  const vip = perVip ? desk.vips.find((v) => v.address === String(target).trim().toLowerCase()) : undefined;
  if (perVip && !vip) return fail(404, ERRORS.notVip);
  if (!reasonAvailable(desk.rules, code)) return fail(409, code === "meeting.soon" ? ERRORS.meetingsOff : ERRORS.mailOff);
  return { code, target: vip?.address ?? "", ...(vip ? { vip } : {}) };
}

const readBody = async (req: Request): Promise<Record<string, unknown> | null> => (await req.json().catch(() => null)) as Record<string, unknown> | null;

/** GET lists the interruption reasons and their switches; POST {code, target?, on} switches one reason. */
export async function handleDeskInterruptions(req: Request, db: Database, runtime: DeskRuntime | undefined, now: () => number = Date.now): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  const desk = deskStateOf(db, runtime);
  if (req.method === "GET") return reply(reasons(desk));
  if (!desk.deskOn) return fail(409, ERRORS.deskOff);
  const body = await readBody(req);
  if (!isReasonCode(body?.code) || typeof body.on !== "boolean") return fail(400, ERRORS.switchShape);
  const checked = checkReason(desk, body.code, body.target);
  if (checked instanceof Response) return checked;
  setSwitch(db, desk.rules, { code: checked.code, target: checked.target, on: body.on, setBy: "switch" }, now());
  const label = reasonLabel(checked.code, checked.vip);
  const message = body.on ? `"${label}" interrupts you from now on.` : `"${label}" no longer interrupts you; it waits in the list.`;
  return reply({ ok: true, message, ...reasons(desk) });
}

/** POST {key, code, target?, important} records the answer to "Was that important enough?"; a no switches that reason off. */
export async function handleDeskInterruptionFeedback(req: Request, db: Database, runtime: DeskRuntime | undefined, now: () => number = Date.now): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const desk = deskStateOf(db, runtime);
  if (!desk.deskOn) return fail(409, ERRORS.deskOff);
  const body = await readBody(req);
  if (typeof body?.key !== "string" || body.key.trim() === "") return fail(400, ERRORS.key);
  if (!isReasonCode(body.code) || typeof body.important !== "boolean") return fail(400, ERRORS.feedbackShape);
  const checked = checkReason(desk, body.code, body.target);
  if (checked instanceof Response) return checked;
  recordFeedback(db, desk.rules, { key: body.key, code: checked.code, target: checked.target, important: body.important }, now());
  return reply({ ok: true, message: feedbackMessage(checked.code, reasonLabel(checked.code, checked.vip), body.important), ...reasons(desk) });
}
