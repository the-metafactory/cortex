/**
 * MC-I1.S7 (#849, G-1113.E.2 completion) — the `failed_dispatch` attention
 * producer, event-driven off the dispatch-lifecycle projection seam.
 *
 * ## Why a producer here, not in the reconciler
 *
 * E.2's `reconcileAttention` (db/attention-sources.ts) derives attention from
 * DURABLE MC DB state (blocked assignments, stale work items). A failed dispatch
 * is a TERMINAL bus event — `dispatch.task.{failed,aborted}` — that the lifecycle
 * projection already turns into a terminal assignment row, but the FAILURE detail
 * (`error_summary`, the cortex#249 four-way nak `reason` union) rides the envelope
 * payload and is NOT persisted as queryable DB state. So the reconciler can't
 * re-derive it on its next pass. This producer reads the envelope at projection
 * time and opens an AttentionItem from it — the event IS the source of truth.
 *
 * ## Disjoint prefix (the slice's CRITICAL invariant)
 *
 * Items are minted under `att:faildis:` — disjoint from the reconciler's
 * `att:block:` / `att:stale:` and the S6 federated projection's `att:fed:`. The
 * reconciler's auto-resolve sweep is prefix-scoped (`startsWith(BLOCK_PREFIX) ||
 * startsWith(STALE_PREFIX)`), so it can NEVER sweep an `att:faildis:` item; and
 * THIS producer only ever resolves its OWN `att:faildis:` ids. The two never
 * touch each other's items.
 *
 * ## Auto-resolve on redispatch (the lifecycle wires it)
 *
 * A failed dispatch's attention clears when the SAME task is redispatched and
 * makes progress: a later `started` or `completed` lifecycle for the same
 * `correlation_id` anchor resolves `att:faildis:{correlationId}`. The dispatch-
 * lifecycle renderer calls this producer for EVERY `dispatch.task.*` envelope, so
 * the resolve path rides the same seam as the open path — no separate trigger.
 *
 * ## Principal-cancel is NOT attention
 *
 * `dispatch.task.aborted` carries a free-form `reason` (`"timeout"`, `"shutdown"`,
 * `"principal-cancel"`, `"replaced"` — dispatch-events.ts). A principal cancelling
 * their OWN dispatch needs no attention (they did it on purpose), so an aborted
 * with `reason === "principal-cancel"` opens nothing. Every other abort reason
 * (timeout, shutdown, replaced, …) is an outside force the principal should see.
 *
 * ## Notify funnel
 *
 * This producer returns an {@link AttentionDelta} (`opened` / `resolved` items).
 * The renderer funnels that delta to the SAME `system.attention.*` notify path
 * the cockpit loop uses — via the established `publishAttentionNotifications`
 * builder in attention-notify.ts (see dispatch-lifecycle-renderer.ts). The
 * publisher is optional: when omitted (headless / test) the DB item is still
 * written, only the bus notification is skipped — mirroring the `wsRegistry`
 * optionality. Items reach the bus through the established builder, NOT through
 * the loop's reconcile (this is event-driven, the loop is state-derived).
 *
 * Non-throwing: a malformed payload / non-terminal type returns an empty delta.
 */

import type { Database } from "bun:sqlite";

import type { AttentionItem, AttentionSeverity } from "../types";
import { upsertAttentionItem, getAttentionItem, resolveAttentionItem } from "../db/attention";
import { findAnchorSession } from "./anchor";
import type { AttentionDelta } from "../attention-notify";

// Re-export the shared notify delta so existing importers of this producer (the
// renderer, tests) keep one import site; the canonical type lives in
// attention-notify.ts (the consumer) so the funnel is type-level (PR #873 review).
export type { AttentionDelta };

/** The failed-dispatch id namespace — disjoint from every other producer's. */
export const FAILED_DISPATCH_PREFIX = "att:faildis:";

/** The conventional aborted reason that means "the principal cancelled" → no attention. */
export const PRINCIPAL_CANCEL_REASON = "principal-cancel";

const EMPTY_DELTA: AttentionDelta = { opened: [], resolved: [] };

/** The minimal envelope shape this producer reads (kept structural, like the projection). */
export interface FailedDispatchEnvelope {
  type: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

/** The cortex#249 four-way+reserved nak reason union, as it rides the failed payload. */
type NakReasonKind =
  | "policy_denied"
  | "cant_do"
  | "wont_do"
  | "not_now"
  | "compliance_block";

/**
 * Map a terminal failure to its attention severity.
 *
 *   - a HARD policy/compliance refusal (`policy_denied` / `wont_do` /
 *     `compliance_block`) is a `critical` — it will never self-heal on retry,
 *     the principal must intervene;
 *   - a `cant_do` (capability mismatch / bad output) is `high` — a real error
 *     that needs a look but isn't a governance stop;
 *   - a `not_now` (transient / backpressure) is `normal` — it may clear on the
 *     handler's own retry, so it's the softest failure signal;
 *   - an aborted-by-outside-force (timeout / shutdown / replaced) is `high` —
 *     the task was killed mid-flight and likely needs a redispatch.
 */
function severityForFailure(reasonKind: NakReasonKind | null, aborted: boolean): AttentionSeverity {
  if (aborted) return "high";
  switch (reasonKind) {
    case "policy_denied":
    case "wont_do":
    case "compliance_block":
      return "critical";
    case "not_now":
      return "normal";
    case "cant_do":
      return "high";
    case null:
      // A `failed` with no structured reason (CC exited non-zero, parse error)
      // — a real error, treat as `high`.
      return "high";
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Read the nak reason kind off a `failed` payload's `reason` union, or null. */
function nakReasonKind(payload: Record<string, unknown>): NakReasonKind | null {
  const reason = payload.reason;
  if (typeof reason !== "object" || reason === null) return null;
  const kind = (reason as Record<string, unknown>).kind;
  if (
    kind === "policy_denied" ||
    kind === "cant_do" ||
    kind === "wont_do" ||
    kind === "not_now" ||
    kind === "compliance_block"
  ) {
    return kind;
  }
  return null;
}

/**
 * Produce the failed-dispatch attention delta for ONE `dispatch.task.*` envelope.
 *
 *   - `failed`                          → open `att:faildis:{correlationId}`.
 *   - `aborted` (reason ≠ principal-cancel) → open it.
 *   - `aborted` (reason = principal-cancel) → no-op (intentional cancel).
 *   - `started` / `completed`           → resolve it (a redispatch healed it).
 *   - anything else                     → empty delta.
 *
 * Idempotent: re-opening an already-open item upserts in place (no duplicate
 * "opened" delta); resolving an absent / already-resolved item yields no
 * "resolved" delta; a redelivered failed/aborted for a DISMISSED item is a no-op
 * (the dismiss is honoured, never resurrected). Redelivery is therefore safe.
 */
export function produceFailedDispatchAttention(
  db: Database,
  envelope: FailedDispatchEnvelope,
  opts: { stackId: string },
): AttentionDelta {
  const kind = terminalOrRedispatchKind(envelope.type);
  if (kind === null) return EMPTY_DELTA;

  const rawPayload: unknown = envelope.payload;
  const payload: Record<string, unknown> =
    typeof rawPayload === "object" && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};

  // The anchor key — shared by all four lifecycle envelopes for one task. Fall
  // back to task_id (the builder's default correlation_id) when the field is
  // absent, matching projectDispatchLifecycle.
  const correlationId = asString(envelope.correlation_id) ?? asString(payload.task_id);
  if (correlationId === null) return EMPTY_DELTA;

  const itemId = `${FAILED_DISPATCH_PREFIX}${correlationId}`;

  // Redispatch progress → resolve any open failed-dispatch item for this anchor.
  if (kind === "started" || kind === "completed") {
    const existing = getAttentionItem(db, itemId);
    if (existing !== null && existing.status === "open") {
      resolveAttentionItem(db, itemId);
      return { opened: [], resolved: [existing] };
    }
    return EMPTY_DELTA;
  }

  // aborted by the principal's own cancel → no attention.
  if (kind === "aborted" && asString(payload.reason) === PRINCIPAL_CANCEL_REASON) {
    return EMPTY_DELTA;
  }

  // Dismiss-resurrection guard (#621 bug class; PR #873 review major 1). NATS is
  // at-least-once, so a `dispatch.task.failed` is redelivered routinely. If the
  // principal already DISMISSED this item ("stop showing me this"), a redelivery
  // must NOT flip it back to open + re-notify. `upsertAttentionItem` writes
  // `status = excluded.status` unconditionally, so we early-return BEFORE the
  // upsert when the prior row is dismissed — mirroring how `reconcileAttention`
  // guards via `dismissedIds`. (Latent until E.4's dismiss action ships, but
  // fixed now while the producer is fresh.)
  const prior = getAttentionItem(db, itemId);
  if (prior !== null && prior.status === "dismissed") return EMPTY_DELTA;

  // Open (or re-upsert) the failed-dispatch item. Deep-link via the dispatch
  // anchor's session (the §7.4 drill-down target — "the session that needs
  // action"); null when no anchor was projected (e.g. a terminal that raced its
  // own projection), in which case the drill-down derives from the item id.
  const sessionId = findAnchorSession(db, correlationId);
  const reasonKind = kind === "failed" ? nakReasonKind(payload) : null;
  const severity = severityForFailure(reasonKind, kind === "aborted");

  const item: AttentionItem = {
    id: itemId,
    stackId: opts.stackId,
    workItemId: null,
    sessionId,
    kind: "failed_dispatch",
    severity,
    status: "open",
  };

  // Only the absent → open transition is a "newly opened" delta to notify on;
  // a re-upsert of an already-open item must not re-notify (idempotent redelivery).
  const wasOpen = prior !== null && prior.status === "open";
  upsertAttentionItem(db, item);
  return wasOpen ? EMPTY_DELTA : { opened: [item], resolved: [] };
}

/**
 * Map `envelope.type` to the lifecycle kind this producer reacts to, or null.
 * `started` / `completed` drive the auto-resolve; `failed` / `aborted` the open.
 */
function terminalOrRedispatchKind(
  type: string,
): "started" | "completed" | "failed" | "aborted" | null {
  switch (type) {
    case "dispatch.task.started":
      return "started";
    case "dispatch.task.completed":
      return "completed";
    case "dispatch.task.failed":
      return "failed";
    case "dispatch.task.aborted":
      return "aborted";
    default:
      return null;
  }
}
