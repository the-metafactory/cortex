import { STEP_UP_HEADER } from "./authorize-lib";

export const DESK_ACTION_PATH = "/api/desk/action";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const STEP_UP_LINES: Record<string, string> = {
  step_up_required: "Enter your step-up code first. Nothing was sent to Ranger.",
  step_up_invalid: "That step-up code did not match. Nothing was sent to Ranger.",
  step_up_not_configured: "Step-up MFA is not set up on this stack. Run `cortex step-up enroll` first.",
};

/** Sends one Desk action with the step-up code and returns one line for the page. Never throws. */
export async function submitDeskAction(
  body: { action: string; key: string },
  stepUpCode: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; text: string; needsCode: boolean }> {
  let res: Response;
  try {
    res = await fetchImpl(DESK_ACTION_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...(stepUpCode.trim() ? { [STEP_UP_HEADER]: stepUpCode.trim() } : {}) },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, text: `Mission Control did not answer: ${err instanceof Error ? err.message : String(err)}`, needsCode: false };
  }
  const parsed = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown; detail?: unknown } | null;
  if (res.ok) return { ok: true, text: typeof parsed?.message === "string" ? parsed.message : "Done.", needsCode: false };
  const error = typeof parsed?.error === "string" ? parsed.error : "";
  const line = STEP_UP_LINES[error] ?? (typeof parsed?.detail === "string" ? parsed.detail : error);
  return { ok: false, text: line || `The action failed (HTTP ${res.status}).`, needsCode: error === "step_up_required" };
}
