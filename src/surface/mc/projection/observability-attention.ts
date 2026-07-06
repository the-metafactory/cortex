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

import { upsertAttentionItem, resolveAttentionItem } from "../db/attention";
import { ADAPTER_ATTENTION_PREFIX } from "./adapter-lifecycle";
import type { AttentionItem } from "../types";

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
  const mapping = classify(envelope.type);
  if (mapping === null) return null;

  const rawPayload: unknown = envelope.payload;
  const payload: Record<string, unknown> =
    typeof rawPayload === "object" && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};

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
