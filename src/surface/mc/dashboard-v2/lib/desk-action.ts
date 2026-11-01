import type { StudioAct } from "../../desk/studio/acts";
import type { StudioView } from "../../desk/studio/view";

export const DESK_ACTION_PATH = "/api/desk/action";
export const DESK_GOAL_PATH = "/api/desk/goal";
export const DESK_MAIL_PATH = "/api/desk/mail";
export const DESK_RULING_PATH = "/api/desk/ruling";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type Outcome = { ok: boolean; text: string; recorded?: boolean; uncertain?: boolean; undo?: string; block?: string; restored?: string };

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
  const parsed = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown; detail?: unknown; recorded?: unknown; undo?: unknown; block?: unknown; restored?: unknown } | null;
  if (res.ok) {
    return {
      ok: true, text: typeof parsed?.message === "string" ? parsed.message : "Done.",
      ...(typeof parsed?.undo === "string" ? { undo: parsed.undo } : {}), ...(typeof parsed?.block === "string" ? { block: parsed.block } : {}),
      ...(typeof parsed?.restored === "string" ? { restored: parsed.restored } : {}),
    };
  }
  const error = typeof parsed?.error === "string" ? parsed.error : "";
  const line = typeof parsed?.detail === "string" ? parsed.detail : error;
  return { ok: false, text: line || `The action failed (HTTP ${res.status}).`, ...(parsed?.recorded === true ? { recorded: true } : {}) };
}

/** Sends one Desk action and returns one line for the page. Never throws. */
export const submitDeskAction = (body: { action: string; key: string }, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_ACTION_PATH, body, fetchImpl);

/** Checks or pauses one goal and returns one line for the page. Never throws. */
export const submitGoalAction = (body: { action: string; goal: string }, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_GOAL_PATH, body, fetchImpl);

export type MailActionBody =
  | { action: "trash" | "unimportant"; key: string }
  | { action: "move"; key: string; target: import("../../desk/mail-move").MoveTarget }
  | { action: "undo" | "block"; move: string }
  | { action: "draft"; key: string; body: string; decision?: import("../../desk/mail-yes-filter").MailDecision };

/**
 * Moves one listed mail (Archive, Spam, Delete), undoes a move, blocks a spam sender's domain, marks a sender
 * unimportant, or saves a reply draft, and returns one line for the page. A move carries its Undo id. Never throws.
 */
export const submitMailAction = (body: MailActionBody, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_MAIL_PATH, body, fetchImpl);

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
