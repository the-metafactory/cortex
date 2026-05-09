/**
 * Typed fetch wrapper for the mission-control REST API.
 *
 * Centralises the error-shape contract so feature hooks
 * (use-focus-area, use-tasks, use-drill-events, ...) don't each
 * reinvent JSON-parsing + status-code branching.
 */

export interface ApiError {
  /** HTTP status, or 0 for network/JSON failure. */
  status: number;
  /** Server-provided message when present, else a generic fallback. */
  message: string;
}

export class ApiFailure extends Error {
  constructor(public readonly info: ApiError) {
    super(info.message);
    this.name = "ApiFailure";
  }
}

/**
 * GET a JSON payload. Throws `ApiFailure` on non-2xx. Body parse
 * failure on a 2xx is treated as an empty object — caller deals with
 * the missing fields per its schema.
 */
export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, method: init?.method ?? "GET" });
  } catch (e) {
    throw new ApiFailure({ status: 0, message: e instanceof Error ? e.message : String(e) });
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body && typeof body.error === "string") msg = body.error;
    } catch {
      // body wasn't JSON or was empty; keep the HTTP fallback.
    }
    throw new ApiFailure({ status: res.status, message: msg });
  }
  try {
    return await res.json() as T;
  } catch (e) {
    throw new ApiFailure({ status: 0, message: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * POST a JSON body and parse a JSON response. Same error-shape as `getJson`.
 */
export async function postJson<TReq, TRes>(path: string, body: TReq, init?: RequestInit): Promise<TRes> {
  return getJson<TRes>(path, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });
}
