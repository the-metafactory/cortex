/**
 * MC-I1.S6 (#848, ADR-0005 §4) — project `system.attention.*` envelopes into
 * the MC attention queue.
 *
 * ## Scoping decision (stated in the PR): FEDERATED attention only.
 *
 * MC already has a LOCAL attention producer: `reconcileAttention`
 * (db/attention-sources.ts), driven by the cockpit refresh loop, derives the
 * open attention set from LOCAL DB state (blocked assignments, stale work items)
 * under its OWN id namespace (`att:block:` / `att:stale:`) and — critically —
 * resolves ONLY items carrying those prefixes ("never touch items produced by
 * other sources"). The cockpit loop ALSO publishes those local deltas as
 * `system.attention.*` envelopes onto the bus.
 *
 * If the projection ingested EVERY `system.attention.*` envelope it would fight
 * the local reconciler two ways:
 *   1. It would re-ingest the loop's OWN published local deltas — a write echo.
 *   2. A federated item under a foreign prefix would never be resolved by the
 *      prefix-scoped local reconciler, and a locally-derived item re-published
 *      by the projection under a different prefix would double-count.
 *
 * So the projection's value is the attention the local loop CANNOT see:
 * **federated attention from peer stacks** arriving on `federated.*` subjects.
 * Local (own-principal) attention stays the cockpit loop's job. The projection:
 *   - ingests ONLY envelopes delivered on a `federated.` subject (the renderer
 *     passes the matched subject; we gate on its prefix),
 *   - stores them under a DISTINCT `att:fed:` id namespace so the local
 *     reconciler's prefix-scoped resolve never touches them and vice-versa,
 *   - NULLs the local FK link targets (`work_item_id` / `session_id`): a peer's
 *     session/work-item ids are not local rows, and the schema FKs would reject
 *     them. The peer `stack_id` is stamped (plain key, no FK) so a multi-stack
 *     view can group federated items by origin.
 *
 * `opened` → upsert open; `resolved` → resolve. Idempotent on the item id.
 * Non-throwing: malformed payloads / non-federated subjects return null.
 */

import type { Database } from "bun:sqlite";

import { upsertAttentionItem, resolveAttentionItem } from "../db/attention";
import type {
  AttentionItem,
  AttentionKind,
  AttentionSeverity,
} from "../types";

/** The federated-attention id namespace — disjoint from the local reconciler's. */
export const FEDERATED_ATTENTION_PREFIX = "att:fed:";

const ATTENTION_KINDS = new Set<AttentionKind>([
  "input_needed",
  "permission",
  "review",
  "state_change",
  "proposal",
  "failed_dispatch",
  "stale",
  "blocked",
]);
const ATTENTION_SEVERITIES = new Set<AttentionSeverity>([
  "low",
  "normal",
  "high",
  "critical",
]);

export interface ProjectableAttentionEnvelope {
  id?: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface AttentionProjectionResult {
  /** The lifecycle action projected. */
  action: "opened" | "resolved";
  /** The MC attention item id (always `att:fed:`-prefixed). */
  itemId: string;
}

/**
 * Project one `system.attention.{opened,resolved}` envelope. `subject` is the
 * matched NATS subject the renderer passes through — the projection ingests
 * ONLY envelopes on a `federated.` subject (see scoping decision). Returns null
 * for a non-federated subject, a non-attention type, or a malformed payload.
 */
export function projectAttention(
  db: Database,
  envelope: ProjectableAttentionEnvelope,
  subject: string | undefined,
): AttentionProjectionResult | null {
  // Gate: federated only. A missing subject (direct test call without the
  // router) is treated as non-federated — the renderer always passes one in
  // production, and a subject-less call has no provenance to trust as federated.
  //
  // PROVENANCE (#862 review): this projection trusts the post-gate `federated.`
  // subject and does NOT re-verify signatures — that is the correct layering.
  // The surface-router's `evaluateFederationGate` is the SINGLE ingress trust
  // boundary for `federated.*` envelopes: it resolves the source principal →
  // `peers[]` membership, cross-checks the delivering leaf link for anti-spoof,
  // and applies the network's accept/deny patterns + hop budget BEFORE any
  // `render()` fires. Re-verifying the signed_by chain in every consumer would
  // be wrong duplication (mirrors how every other renderer consumes the bus).
  // CAVEAT: that gate is OPT-IN — it engages only when `policy.federated.networks[]`
  // is configured (`federatedNetworksById.size > 0`). On a network-joined stack
  // with no `federated:` policy block, a `federated.*` subject passes ungated
  // and this projection ingests it on subject-prefix alone. That is the
  // ecosystem-wide renderer posture (not a regression here), but flagged because
  // this is the first projection to write federated peer data into a
  // principal-visible queue.
  if (!subject?.startsWith("federated.")) return null;

  const action = attentionAction(envelope.type);
  if (action === null) return null;

  const rawPayload: unknown = envelope.payload;
  const payload =
    typeof rawPayload === "object" && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};
  const rawAttention: unknown = payload.attention;
  const attention =
    typeof rawAttention === "object" && rawAttention !== null
      ? (rawAttention as Record<string, unknown>)
      : {};

  const sourceId = asString(attention.id);
  if (sourceId === null) {
    process.stderr.write(
      `[mission-control] attention-projection: ignoring ${envelope.type} — missing attention.id\n`,
    );
    return null;
  }
  // Re-namespace the peer's item id into our federated namespace so it can never
  // collide with a local `att:block:`/`att:stale:` id (and the local reconciler
  // never resolves it).
  const itemId = `${FEDERATED_ATTENTION_PREFIX}${sourceId}`;

  const kind = asKind(attention.kind);
  const severity = asSeverity(attention.severity);
  const stackId = asString(attention.stack_id) ?? subject.split(".")[1] ?? "peer";

  if (action === "resolved") {
    resolveAttentionItem(db, itemId);
    return { action, itemId };
  }

  // opened: upsert as open. FK link targets are NULL — a peer's session /
  // work-item ids are not local rows; the schema FKs would reject them.
  const item: AttentionItem = {
    id: itemId,
    stackId,
    workItemId: null,
    sessionId: null,
    kind: kind ?? "input_needed",
    severity: severity ?? "normal",
    status: "open",
  };
  upsertAttentionItem(db, item);
  return { action, itemId };
}

function attentionAction(type: string): "opened" | "resolved" | null {
  if (type === "system.attention.opened") return "opened";
  if (type === "system.attention.resolved") return "resolved";
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asKind(value: unknown): AttentionKind | null {
  return typeof value === "string" && ATTENTION_KINDS.has(value as AttentionKind)
    ? (value as AttentionKind)
    : null;
}

function asSeverity(value: unknown): AttentionSeverity | null {
  return typeof value === "string" &&
    ATTENTION_SEVERITIES.has(value as AttentionSeverity)
    ? (value as AttentionSeverity)
    : null;
}
