export const DESK_ACTION_PATH = "/api/desk/action";
export const DESK_GOAL_PATH = "/api/desk/goal";
export const DESK_MAIL_PATH = "/api/desk/mail";
export const DESK_RULING_PATH = "/api/desk/ruling";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type Outcome = { ok: boolean; text: string; recorded?: boolean; uncertain?: boolean };

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
  const parsed = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown; detail?: unknown; recorded?: unknown } | null;
  if (res.ok) return { ok: true, text: typeof parsed?.message === "string" ? parsed.message : "Done." };
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

/** Moves one listed mail to Trash, or marks its sender unimportant, and returns one line for the page. Never throws. */
export const submitMailAction = (body: { action: "trash" | "unimportant"; key: string }, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_MAIL_PATH, body, fetchImpl);

/**
 * Records a ruling and resumes its node. On a failure, `recorded` means the ruling is in the node and only the resume
 * failed; `uncertain` means no answer came, so the ruling may be recorded. Never throws.
 */
export const submitRuling = (body: { key: string; text: string; requestId: string }, fetchImpl: FetchLike = fetch): Promise<Outcome> =>
  postDesk(DESK_RULING_PATH, body, fetchImpl);
