import type { StudioAct } from "../../desk/studio/acts";
import type { StudioView } from "../../desk/studio/view";
import type { MailRuleView } from "../../desk/mail-rules";

export const DESK_ACTION_PATH = "/api/desk/action";
export const DESK_GOAL_PATH = "/api/desk/goal";
export const DESK_MAIL_PATH = "/api/desk/mail";
export const DESK_RULING_PATH = "/api/desk/ruling";
export const DESK_MAIL_RULES_PATH = "/api/desk/mail/rules";
export const DESK_DMARC_PATH = "/api/desk/mail/dmarc";
export const DESK_ADAPTER_PATH = "/api/desk/adapter";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type Outcome = { ok: boolean; text: string; recorded?: boolean; correction?: number; uncertain?: boolean; undo?: string; undoKind?: "move" | "snooze" | "trust"; block?: string; restored?: string; rule?: MailRuleView };

const isRuleView = (v: unknown): v is MailRuleView => typeof v === "object" && v !== null && "id" in v && typeof v.id === "string" && "sentence" in v && typeof v.sentence === "string";

async function postDesk(path: string, body: unknown, fetchImpl: FetchLike): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetchImpl(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, uncertain: true, text: `Mission Control did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown; detail?: unknown; recorded?: unknown; correction?: unknown; undo?: unknown; block?: unknown; restored?: unknown; rule?: unknown } | null;
  if (res.ok) {
    return {
      ok: true, text: typeof parsed?.message === "string" ? parsed.message : "Done.",
      ...(typeof parsed?.undo === "string" ? { undo: parsed.undo } : {}), ...(typeof parsed?.block === "string" ? { block: parsed.block } : {}),
      ...(typeof parsed?.restored === "string" ? { restored: parsed.restored } : {}),
      ...(isRuleView(parsed?.rule) ? { rule: parsed.rule } : {}),
    };
  }
  const error = typeof parsed?.error === "string" ? parsed.error : "";
  const line = typeof parsed?.detail === "string" ? parsed.detail : error;
  return { ok: false, text: line || `The action failed (HTTP ${res.status}).`, ...(parsed?.recorded === true ? { recorded: true } : {}), ...(typeof parsed?.correction === "number" ? { correction: parsed.correction } : {}) };
}

/** Asks the Cortex runtime's authority for one change a connected row declares, and returns one line for the page. Never throws. */
export const submitAdapterAction = (body: { key: string; capability: string }, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_ADAPTER_PATH, body, fetchImpl);

/** Sends one Desk action and returns one line for the page. Never throws. */
export const submitDeskAction = (body: { action: string; key: string }, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_ACTION_PATH, body, fetchImpl);

/** Checks or pauses one goal and returns one line for the page. Never throws. */
export const submitGoalAction = (body: { action: string; goal: string }, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_GOAL_PATH, body, fetchImpl);

export type MailActionBody =
  | { action: "trash" | "unimportant" | "report" | "digest.keep" | "unsubscribe" | "unsubscribe.rule"; key: string }
  | { action: `waiting.${import("../../desk/mail-waiting-schema").WaitingOp}`; key: string }
  | { action: "move"; key: string; target: import("../../desk/mail-move").MoveTarget }
  | { action: "undo" | "block"; move: string }
  | { action: "sweep"; sweep: string; keys: string[]; target?: import("../../desk/mail-move").MoveTarget }
  | { action: "sweep.undo"; sweep: string }
  | { action: "attach.undo"; link: string }
  | { action: "correct"; key: string; said: import("../../desk/mail-actions").MailCorrection; correction?: number }
  | { action: "draft"; key: string; body: string; decision?: import("../../desk/mail-yes-filter").MailDecision }
  | { action: "studio.add"; key: string; requestId: string; thread: string | null; reason?: string; includeText: boolean }
  | { action: "assistant.hand"; key: string; requestId: string; instruction?: string }
  | { action: "snooze"; key: string; until: import("../../desk/mail-snooze-schema").SnoozeChoice }
  | { action: "snooze.cancel"; key: string }
  | { action: "not-phishing"; key: string }
  | { action: "not-phishing.undo"; trust: string }
  | { action: "not-phishing.remove"; sender: string }
  | { action: "assistant.approve" | "assistant.discard" | "assistant.retry"; key: string }
  | { action: "invite.reply"; key: string; reply: import("../../desk/mail-invitation-schema").InviteReply; requestId: string; commitment: import("../../desk/mail-yes-filter").Commitment | null; confirmed: boolean };

export type InviteProposalOutcome = { ok: true; body: string; note: string | null } | { ok: false; text: string };

export async function fetchInviteProposal(key: string, fetchImpl: FetchLike = fetch): Promise<InviteProposalOutcome> {
  try {
    const res = await fetchImpl(DESK_MAIL_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "invite.propose", key }) });
    const parsed = (await res.json().catch(() => null)) as { body?: unknown; note?: unknown; error?: unknown } | null;
    if (res.ok && typeof parsed?.body === "string") return { ok: true, body: parsed.body, note: typeof parsed.note === "string" ? parsed.note : null };
    return { ok: false, text: typeof parsed?.error === "string" ? parsed.error : `The Desk could not read your calendars (HTTP ${res.status}).` };
  } catch (err) {
    return { ok: false, text: `Mission Control did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export type StudioProposalOutcome = { ok: true; proposal: import("../../desk/mail-studio").MailStudioProposal } | { ok: false; text: string };

export async function fetchMailThreadProposal(key: string, fetchImpl: FetchLike = fetch): Promise<StudioProposalOutcome> {
  try {
    const res = await fetchImpl(DESK_MAIL_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "studio.propose", key }) });
    const parsed = (await res.json().catch(() => null)) as { proposal?: import("../../desk/mail-studio").MailStudioProposal; error?: unknown } | null;
    if (res.ok && parsed?.proposal) return { ok: true, proposal: parsed.proposal };
    return { ok: false, text: typeof parsed?.error === "string" ? parsed.error : `The Studio did not answer (HTTP ${res.status}).` };
  } catch (err) {
    return { ok: false, text: `Mission Control did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Moves one listed mail (Archive, Spam, Delete), undoes a move, blocks a spam sender's domain, marks a sender
 * unimportant, or saves a reply draft, and returns one line for the page. A move carries its Undo id. Never throws.
 */
export const submitMailAction = (body: MailActionBody, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_MAIL_PATH, body, fetchImpl);

/** Tells the Desk the principal opened one mail. Fire and forget: it never delays the open and never throws. */
export function noteMailOpened(key: string, fetchImpl: FetchLike = fetch): void {
  if (!key.startsWith("mail:")) return;
  try {
    fetchImpl(DESK_MAIL_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "opened", key }), keepalive: true }).catch(() => undefined);
  } catch {
    return;
  }
}

export type MailRuleBody =
  | { op: "approve" | "later" | "never"; proposal: string }
  | { op: "release" | "stop" | "start" | "delete"; rule: string }
  | { op: "edit"; rule: string; match: string; value: string; action: string }
  | { op: "create"; match: string; value: string; action: string }
  | { op: "undo"; run: string };

/** Answers a rule proposal, changes a rule, or undoes one rule run, and returns one line for the page. Never throws. */
export const submitMailRule = (body: MailRuleBody, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_MAIL_RULES_PATH, body, fetchImpl);

/** "Got it" on a DMARC failure card: hides that report's cards. Never throws. */
export const submitDmarcAck = (report: string, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_DMARC_PATH, { op: "ack", report }, fetchImpl);

/**
 * Records a ruling and resumes its node. On a failure, `recorded` means the ruling is in the node and only the resume
 * failed; `uncertain` means no answer came, so the ruling may be recorded. Never throws.
 */
export const submitRuling = (body: { key: string; text: string; requestId: string }, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_RULING_PATH, body, fetchImpl);

export const DESK_STUDIO_ACT_PATH = "/api/desk/studio/act";

export type StudioActOutcome = Outcome & { studio?: StudioView; needsPark?: boolean };

/**
 * Sends one Studio act. `uncertain` means no answer came, so the act may be written; the caller retries it with the
 * same request id, which the server answers without a second commit. Never throws.
 */
export async function submitStudioAct(body: StudioAct & { requestId: string }, fetchImpl: FetchLike = fetch): Promise<StudioActOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(DESK_STUDIO_ACT_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    return { ok: false, uncertain: true, text: `Mission Control did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown; studio?: StudioView; needsPark?: unknown } | null;
  if (res.ok && parsed?.studio) return { ok: true, text: typeof parsed.message === "string" ? parsed.message : "Done.", studio: parsed.studio };
  const error = typeof parsed?.error === "string" ? parsed.error : `The Studio did not record it (HTTP ${res.status}).`;
  return { ok: false, text: error, ...(res.status >= 500 ? { uncertain: true } : {}), ...(parsed?.needsPark === true ? { needsPark: true } : {}) };
}
