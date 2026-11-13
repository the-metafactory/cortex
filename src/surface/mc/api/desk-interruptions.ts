import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { NO_INTERRUPTIONS, type InterruptRules } from "../desk/interrupt";
import { isReasonCode, listReasons, PER_VIP, readSwitches, reasonAvailable, reasonLabel, recordFeedback, setSwitch } from "../desk/interrupt-switches";
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
};

const KEPT = "Kept. Mail like this still interrupts you.";
const SWITCHED_BY_FEEDBACK = "Noted. Mail like this now waits in the list without interrupting you. You can switch it back on under Interruptions.";

interface Stack {
  db: Database;
  deskOn: boolean;
  rules: InterruptRules;
  vips: DeskVip[];
}

const stackOf = (db: Database, runtime: DeskRuntime | undefined): Stack => ({
  db,
  deskOn: runtime?.options?.enabled === true,
  rules: runtime?.options?.interruptions ?? NO_INTERRUPTIONS,
  vips: listVips(db),
});

const reasons = (stack: Stack): object => ({ reasons: listReasons(stack.rules, readSwitches(stack.db), stack.vips, stack.deskOn) });

const fail = (status: number, error: string): Response => reply({ ok: false, error }, status);

type Checked = { code: InterruptReasonCode; target: string; vip?: DeskVip } | Response;

function checkReason(stack: Stack, code: InterruptReasonCode, target: unknown): Checked {
  const perVip = code === PER_VIP;
  if (perVip !== (typeof target === "string" && target.trim() !== "")) return fail(400, ERRORS.target);
  const vip = perVip ? stack.vips.find((v) => v.address === String(target).trim().toLowerCase()) : undefined;
  if (perVip && !vip) return fail(404, ERRORS.notVip);
  if (!reasonAvailable(stack.rules, code)) return fail(409, ERRORS.mailOff);
  return { code, target: vip?.address ?? "", ...(vip ? { vip } : {}) };
}

const readBody = async (req: Request): Promise<Record<string, unknown> | null> => (await req.json().catch(() => null)) as Record<string, unknown> | null;

/** GET lists the interruption reasons and their switches; POST {code, target?, on} switches one reason. */
export async function handleDeskInterruptions(req: Request, db: Database, runtime: DeskRuntime | undefined, now: () => number = Date.now): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  const stack = stackOf(db, runtime);
  if (req.method === "GET") return reply(reasons(stack));
  if (!stack.deskOn) return fail(409, ERRORS.deskOff);
  const body = await readBody(req);
  if (!isReasonCode(body?.code) || typeof body.on !== "boolean") return fail(400, ERRORS.switchShape);
  const checked = checkReason(stack, body.code, body.target);
  if (checked instanceof Response) return checked;
  setSwitch(db, stack.rules, checked.code, checked.target, body.on, "switch", now());
  const label = reasonLabel(checked.code, checked.vip);
  const message = body.on ? `"${label}" interrupts you from now on.` : `"${label}" no longer interrupts you; it waits in the list.`;
  return reply({ ok: true, message, ...reasons(stack) });
}

/** POST {key, code, target?, important} records the answer to "Was that important enough?"; a no switches that reason off. */
export async function handleDeskInterruptionFeedback(req: Request, db: Database, runtime: DeskRuntime | undefined, now: () => number = Date.now): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const stack = stackOf(db, runtime);
  if (!stack.deskOn) return fail(409, ERRORS.deskOff);
  const body = await readBody(req);
  if (typeof body?.key !== "string" || body.key.trim() === "") return fail(400, ERRORS.key);
  if (!isReasonCode(body.code) || typeof body.important !== "boolean") return fail(400, ERRORS.feedbackShape);
  const checked = checkReason(stack, body.code, body.target);
  if (checked instanceof Response) return checked;
  recordFeedback(db, stack.rules, { key: body.key, code: checked.code, target: checked.target, important: body.important }, now());
  return reply({ ok: true, message: body.important ? KEPT : SWITCHED_BY_FEEDBACK, ...reasons(stack) });
}
