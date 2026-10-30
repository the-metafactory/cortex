export const DESK_ACTION_PATH = "/api/desk/action";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Sends one Desk action and returns one line for the page. Never throws. */
export async function submitDeskAction(
  body: { action: string; key: string },
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; text: string }> {
  let res: Response;
  try {
    res = await fetchImpl(DESK_ACTION_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, text: `Mission Control did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown; detail?: unknown } | null;
  if (res.ok) return { ok: true, text: typeof parsed?.message === "string" ? parsed.message : "Done." };
  const error = typeof parsed?.error === "string" ? parsed.error : "";
  const line = typeof parsed?.detail === "string" ? parsed.detail : error;
  return { ok: false, text: line || `The action failed (HTTP ${res.status}).` };
}
