/**
 * MC-B2 (cortex#1279) — pure logic for the **Tier-2 admit/reject action** from
 * the Pier queue: request-id-driven, typed-confirm gated.
 *
 * The interactive form (`pier-decide.tsx`) is a thin shell over these pure
 * helpers so the load-bearing behaviour — the typed-confirm gate + the
 * registry-verdict → readable-message mapping — is unit-testable without a DOM
 * harness (the dashboard tests render statically; there is no testing-library).
 *
 * Posture (mirrors the CLI `cortex network admit <request-id> --apply`): the
 * principal supplies the `request_id` (from `cortex network admit --list-pending`
 * or the registry) and re-types it into the confirm box — the deliberate intent
 * gate for a control-plane mutation. The decision is signed by the LOCAL daemon
 * with the stack seed; this client only POSTs and renders the verdict.
 */

/** admit | reject. */
export type DecideVerb = "admit" | "reject";

/** The POST body the endpoint expects (`confirm` must equal `request_id`). */
export interface DecideBody {
  network_id: string;
  request_id: string;
  decision: DecideVerb;
  confirm: string;
}

/** The outcome of a decision POST, already mapped to something renderable. */
export type DecideOutcome =
  | { kind: "ok"; status: "ADMITTED" | "REJECTED"; requestId: string }
  | { kind: "error"; message: string; httpStatus: number };

/** Minimal fetch shape (injectable for tests). */
export type FetchLike = (
  path: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export const ADMISSION_DECISION_PATH = "/api/networks/admission-decision";

/**
 * The typed-confirm gate: a decision may be submitted only when a non-empty
 * request-id has been entered AND the confirm box exactly echoes it AND no
 * request is already in flight. Pure — the single source of truth the button's
 * disabled state and any programmatic caller share.
 */
export function canDecide(input: {
  requestId: string;
  confirm: string;
  busy: boolean;
}): boolean {
  const id = input.requestId.trim();
  if (id.length === 0) return false;
  if (input.busy) return false;
  // Exact echo — NOT trimmed on the confirm side: the principal must reproduce
  // the id verbatim (a stray space is a real mismatch, surfaced honestly).
  return input.confirm === input.requestId;
}

/**
 * POST a decision and map the response to a {@link DecideOutcome}. Reads the
 * server's `{ error, detail }` on failure so the principal sees the readable
 * `detail` (e.g. the not-an-admin explanation) rather than a bare status code.
 * Never throws — a transport failure becomes `{ kind: "error", httpStatus: 0 }`.
 */
export async function submitDecision(
  body: DecideBody,
  fetchImpl: FetchLike,
): Promise<DecideOutcome> {
  let resp: Awaited<ReturnType<FetchLike>>;
  try {
    resp = await fetchImpl(ADMISSION_DECISION_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
      httpStatus: 0,
    };
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    parsed = null;
  }
  const obj = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

  if (resp.ok) {
    const status = obj.status;
    if (status === "ADMITTED" || status === "REJECTED") {
      const requestId = typeof obj.request_id === "string" ? obj.request_id : body.request_id;
      return { kind: "ok", status, requestId };
    }
    return { kind: "error", message: "the decision succeeded but the response was malformed", httpStatus: resp.status };
  }

  // Failure — prefer the human `detail`, fall back to the `error` code, then HTTP.
  const detail = typeof obj.detail === "string" ? obj.detail : undefined;
  const error = typeof obj.error === "string" ? obj.error : undefined;
  const message = detail ?? error ?? `HTTP ${resp.status.toString()}`;
  return { kind: "error", message, httpStatus: resp.status };
}

/** A short, tone-tagged summary of an outcome for the result line. */
export function describeOutcome(outcome: DecideOutcome): { tone: "ok" | "error"; text: string } {
  if (outcome.kind === "ok") {
    const verb = outcome.status === "ADMITTED" ? "admitted" : "rejected";
    return { tone: "ok", text: `Request ${outcome.requestId} ${verb}.` };
  }
  return { tone: "error", text: outcome.message };
}
