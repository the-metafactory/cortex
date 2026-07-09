/**
 * P-14 U2.1 (#934) — observability attention producer.
 *
 * Two of signal's observability conditions are not just history to chart — they
 * are surface-health outages the cockpit should raise: a degraded collector
 * (`system.signal.collector.degraded`) and an unreachable transport backend
 * (`system.signal.backend.unreachable`). Both are the SAME class of signal as
 * the existing adapter-health producer (`projectAdapterLifecycle`), so they reuse
 * its `att:adapter:` namespace (db/adapter-lifecycle.ts `ADAPTER_ATTENTION_PREFIX`)
 * and the same upsert/resolve lifecycle — one open item per origin, idempotent
 * under redelivery, resolved by the matching recovered/reachable signal.
 *
 *   - `system.signal.collector.degraded`           → OPEN  att:adapter:collector:{id}
 *   - `system.signal.collector.recovered`          → RESOLVE it
 *   - `system.signal.backend.unreachable`          → OPEN  att:adapter:transport:{id}
 *   - `system.signal.backend.reachable`            → RESOLVE it
 *   - `system.transport.leaf-disconnect`           → OPEN  att:adapter:transport:{id}
 *   - `system.transport.leaf-connect`              → RESOLVE it
 *
 * The origin id keys the item: `collector_id` (collector family) or `backend` /
 * `leaf` / `node` (transport family), falling back to the family name so a
 * payload missing its id still produces a deterministic, resolvable item rather
 * than dropping the outage silently.
 *
 * Non-throwing: a non-matching type or malformed payload returns null. Mirrors
 * `projectAdapterLifecycle`'s contract so the renderer can treat both uniformly.
 */

import type { Database } from "bun:sqlite";

import {
  upsertAttentionItem,
  resolveAttentionItem,
  getAttentionItem,
} from "../db/attention";
import { ADAPTER_ATTENTION_PREFIX } from "./adapter-lifecycle";
import type { AttentionItem } from "../types";

/**
 * #1661 (MC folds) — attention id prefix for `system.access.denied`. Distinct
 * from the substrate-health `att:adapter:` namespace: a denial is a governance
 * event, not an adapter outage. The id COLLAPSES BY KEY on `{principal_id}:{
 * capability}` (decision D) so a storm of denials for the same principal+
 * capability is ONE high-severity item, not a flood.
 */
export const ACCESS_DENIED_ATTENTION_PREFIX = "att:access:denied:";

export interface ProjectableObservabilityEnvelope {
  id?: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface ObservabilityAttentionResult {
  action: "opened" | "resolved";
  /** The `att:adapter:`-prefixed MC attention item id. */
  itemId: string;
}

interface Mapping {
  /** Whether this type opens an outage or resolves one. */
  opens: boolean;
  /** Id-namespace segment after the shared adapter prefix (`collector:` / `transport:`). */
  ns: "collector" | "transport";
  /** Payload keys to try, in order, for the origin id. */
  idKeys: string[];
}

function classify(type: string): Mapping | null {
  switch (type) {
    case "system.signal.collector.degraded":
      return { opens: true, ns: "collector", idKeys: ["collector_id", "collector", "id"] };
    case "system.signal.collector.recovered":
      return { opens: false, ns: "collector", idKeys: ["collector_id", "collector", "id"] };
    case "system.signal.backend.unreachable":
      return { opens: true, ns: "transport", idKeys: ["backend", "backend_id", "id"] };
    case "system.signal.backend.reachable":
      return { opens: false, ns: "transport", idKeys: ["backend", "backend_id", "id"] };
    case "system.transport.leaf-disconnect":
      return { opens: true, ns: "transport", idKeys: ["leaf", "node", "peer", "id"] };
    case "system.transport.leaf-connect":
      return { opens: false, ns: "transport", idKeys: ["leaf", "node", "peer", "id"] };
    default:
      return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Produce the observability attention transition for ONE envelope, or null when
 * the type isn't one of the six health signals above. Idempotent: re-opening an
 * already-open item upserts in place; resolving an absent item is a harmless
 * no-op.
 */
export function produceObservabilityAttention(
  db: Database,
  envelope: ProjectableObservabilityEnvelope,
): ObservabilityAttentionResult | null {
  const rawPayload: unknown = envelope.payload;
  const payload: Record<string, unknown> =
    typeof rawPayload === "object" && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};

  // #1661 — admission degraded/recovered lifecycle. Decision (D): ONE type
  // (`system.admission.degraded`) carries a `mode` field, NOT a `.recovered`
  // twin. Branch the open/resolve lifecycle on payload.mode, keyed by the
  // admission KV `bucket` so a multi-stack view groups by store.
  if (envelope.type === "system.admission.degraded") {
    return admissionAttention(db, payload);
  }

  // #1661 — access.denied → high-severity, collapse-by-key, principal-acked,
  // NO auto-resolve (decision D). No producer branch ever resolves it — only
  // the principal (CK-6b resolve/dismiss) clears it.
  if (envelope.type === "system.access.denied") {
    return accessDeniedAttention(db, payload);
  }

  const mapping = classify(envelope.type);
  if (mapping === null) return null;

  let originId: string | null = null;
  for (const key of mapping.idKeys) {
    originId = asString(payload[key]);
    if (originId !== null) break;
  }
  // Fall back to the namespace itself so a payload missing its id still yields a
  // deterministic, resolvable item rather than dropping the outage silently.
  const id = originId ?? mapping.ns;
  const itemId = `${ADAPTER_ATTENTION_PREFIX}${mapping.ns}:${id}`;

  if (!mapping.opens) {
    resolveAttentionItem(db, itemId);
    return { action: "resolved", itemId };
  }

  const item: AttentionItem = {
    id: itemId,
    // The origin id segment groups a multi-stack view by source, same as the
    // adapter-health producer stamps `stackId` with the adapter id.
    stackId: `${mapping.ns}:${id}`,
    workItemId: null,
    sessionId: null,
    kind: "blocked",
    severity: "high",
    status: "open",
  };
  upsertAttentionItem(db, item);
  return { action: "opened", itemId };
}

/**
 * #1661 — `system.admission.degraded` open/resolve, branched on payload.mode
 * (decision D: ONE type + mode field, not a `.recovered` twin). `mode ===
 * "recovered"` resolves the item; any other transition (`"degraded-local"`)
 * opens it. Keyed by the admission KV `bucket` (falls back to `admission` so a
 * payload missing the bucket still yields a deterministic, resolvable item).
 */
function admissionAttention(
  db: Database,
  payload: Record<string, unknown>,
): ObservabilityAttentionResult | null {
  const bucket = asString(payload.bucket) ?? "admission";
  const itemId = `${ADAPTER_ATTENTION_PREFIX}admission:${bucket}`;

  if (asString(payload.mode) === "recovered") {
    resolveAttentionItem(db, itemId);
    return { action: "resolved", itemId };
  }

  upsertAttentionItem(db, {
    id: itemId,
    stackId: `admission:${bucket}`,
    workItemId: null,
    sessionId: null,
    kind: "blocked",
    severity: "high",
    status: "open",
  });
  return { action: "opened", itemId };
}

/**
 * #1661 — `system.access.denied` → a HIGH-severity attention item that COLLAPSES
 * BY KEY on `{principal_id}:{capability}` (decision D). Principal-acked with NO
 * auto-resolve: no producer branch ever resolves it, and — unlike the collector
 * health signals — a redelivered (or fresh) denial for a key the principal has
 * already resolved/dismissed does NOT resurrect it. That divergence from the
 * plain upsert is deliberate: a HIGH-severity item the principal cleared must not
 * pop back on the next at-least-once redelivery. The denial always lands as an
 * observability ROW regardless, so nothing is lost — only the queue stays quiet.
 */
function accessDeniedAttention(
  db: Database,
  payload: Record<string, unknown>,
): ObservabilityAttentionResult | null {
  const principalId = asString(payload.principal_id) ?? "unknown";
  const capability = asString(payload.capability) ?? "unknown";
  const itemId = `${ACCESS_DENIED_ATTENTION_PREFIX}${principalId}:${capability}`;

  // Respect the principal's ack: never reopen a resolved/dismissed key.
  const existing = getAttentionItem(db, itemId);
  if (existing !== null && existing.status !== "open") return null;

  upsertAttentionItem(db, {
    id: itemId,
    stackId: `access:${principalId}:${capability}`,
    workItemId: null,
    sessionId: null,
    kind: "blocked",
    severity: "high",
    status: "open",
  });
  return { action: "opened", itemId };
}
