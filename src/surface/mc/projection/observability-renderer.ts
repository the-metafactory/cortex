/**
 * P-14 U2.1 (#934) — the bus→MC projection renderer for signal's four
 * observability families.
 *
 * Analogous to `createDispatchProjectionRenderer` (dispatch-lifecycle-renderer.ts)
 * but for the four canonical myelin envelope families signal emits:
 *
 *   | envelope.type prefix              | section / family   |
 *   |-----------------------------------|--------------------|
 *   | `system.signal.collector.`        | collector          |  ← checked FIRST
 *   | `system.signal.`                  | signal             |    (more specific
 *   | `system.federation.`              | federation         |     prefix wins)
 *   | `system.transport.`               | transport          |
 *
 * cortex has NO local producers for these families — they originate in the
 * **signal** repo and arrive over the bus as canonical, AJV-validated myelin
 * envelopes (signal U0.4 / #124 merged: they pass the myelin schema + carry a
 * body `signed_by`). So this renderer parses the generic validated `Envelope`
 * STRUCTURALLY by `type` + `payload` — exactly like the dispatch renderer's
 * `ProjectableEnvelope` — rather than via any cortex-side typed builder.
 *
 * It is its OWN surface-router renderer (own id + subjects), registered alongside
 * the dispatch renderer in cortex.ts. It does NOT touch surface-router.ts and does
 * NOT extend the dispatch renderer's dispatcher — separate family, separate file.
 *
 * ## Two writes per envelope
 *   1. An append-only `observability_events` row (db/observability.ts) — the tab's
 *      history, retained by db/retention.ts.
 *   2. For the six health signals (collector degraded/recovered, transport
 *      backend reachable/unreachable, leaf connect/disconnect) an `att:adapter:`
 *      attention item via the observability-attention producer — the live oracle
 *      path (stopping the relay / a leaf surfaces `collector.degraded` /
 *      `leaf_disconnect` on the tab AND the attention queue).
 * Either write broadcasts the matching `mc.projection` refresh family.
 *
 * ## Non-throwing contract
 * Like the dispatch renderer, `render()` catches every error and routes it to
 * stderr so a malformed envelope can't poison the surface-router's dispatch loop
 * (Renderer contract §2 — belt to the router's `renderWithIsolation` braces).
 *
 * ## WS push
 * Each projected mutation emits an `mc.projection` refresh signal (family
 * `"observability"`) via {@link broadcastProjection}, reusing the existing helper
 * — NO new WS message type. `wsRegistry` is optional (headless/test → no-op).
 */

import type { Database } from "bun:sqlite";

import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { SurfaceAdapter } from "../../../bus/surface-router";
import type { WsClientRegistry } from "../ws/client-registry";
import { broadcastProjection } from "../notifications";
import {
  insertObservabilityEvent,
  type ObservabilityFamily,
} from "../db/observability";
import { produceObservabilityAttention } from "./observability-attention";

/** Stable surface-router id for the observability projection renderer. */
export const OBSERVABILITY_PROJECTION_RENDERER_ID = "mc-observability-projection";

/**
 * NATS subject patterns the renderer subscribes to — the stack-ful
 * (`local.{principal}.{stack}.…`), stack-less (`local.{principal}.…`) LOCAL and
 * the federated (`federated.{principal}.{stack}.…`) grammars for each family.
 * Intentionally broad; the authoritative filter is the renderer's own `type`
 * prefix check (an over-matching subject costs only a cheap compare).
 *
 * `*` matches exactly one segment, `>` one-or-more trailing segments.
 */
export const OBSERVABILITY_PROJECTION_SUBJECTS: string[] = [
  // signal (covers signal.collector.* too — the prefix check splits them)
  "local.*.system.signal.>",
  "local.*.*.system.signal.>",
  "federated.*.*.system.signal.>",
  // federation
  "local.*.system.federation.>",
  "local.*.*.system.federation.>",
  "federated.*.*.system.federation.>",
  // transport (hub-emitted; non-hub stacks just never see these)
  "local.*.system.transport.>",
  "local.*.*.system.transport.>",
  "federated.*.*.system.transport.>",
];

/** A structural view of an envelope the projection reads. */
interface ProjectableEnvelope {
  id?: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Map an `envelope.type` to its tab family, or null when it's none of the four.
 * `system.signal.collector.` is checked BEFORE `system.signal.` so the more
 * specific collector prefix wins (a collector type also starts with the signal
 * prefix).
 */
export function familyForType(type: string): ObservabilityFamily | null {
  if (type.startsWith("system.signal.collector.")) return "collector";
  if (type.startsWith("system.signal.")) return "signal";
  if (type.startsWith("system.federation.")) return "federation";
  if (type.startsWith("system.transport.")) return "transport";
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Best-effort origin-stack id off the payload, for grouping in a multi-stack view. */
function originStackId(payload: Record<string, unknown>): string | null {
  return (
    asString(payload.stack_id) ??
    asString(payload.stack) ??
    asString(payload.origin) ??
    null
  );
}

/**
 * The single `project(envelope)` dispatcher. Routes on the family prefix to an
 * `observability_events` insert (+ the attention producer for health signals),
 * broadcasting an `mc.projection` refresh on any mutation. Returns the projected
 * family (or null when the type matched no family / the row was a redelivery
 * no-op) so callers/tests can assert routing without the surface-router.
 *
 * Exported for direct unit testing.
 */
export function projectObservability(
  db: Database,
  envelope: ProjectableEnvelope,
  wsRegistry: WsClientRegistry | undefined,
): ObservabilityFamily | null {
  const family = familyForType(envelope.type);
  if (family === null) return null;

  const rawPayload: unknown = envelope.payload;
  const payload: Record<string, unknown> =
    typeof rawPayload === "object" && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};

  // The envelope id anchors idempotent redelivery. A validated bus envelope
  // always carries one; fall back to a random id only for the unvalidated test
  // shape (which then can't dedup, but never collides).
  const envelopeId = asString(envelope.id) ?? crypto.randomUUID();

  const rowId = insertObservabilityEvent(db, {
    envelopeId,
    family,
    type: envelope.type,
    stackId: originStackId(payload),
    summary: asString(payload.summary) ?? asString(payload.message),
    payload,
  });

  // The attention producer rides the SAME seam — every observability envelope is
  // offered to it; only the six health signals (collector/transport up/down)
  // open or resolve an `att:adapter:` item. It runs independently of the row
  // insert's idempotent no-op (a redelivered degraded must still keep the item
  // open / resolvable), so it is NOT gated on `rowId`.
  const attn = produceObservabilityAttention(db, { id: envelope.id, type: envelope.type, payload });

  let mutated = rowId !== null;
  if (attn !== null) {
    broadcastProjection(wsRegistry, "attention");
    mutated = true;
  }
  if (mutated) {
    broadcastProjection(wsRegistry, "observability");
  }
  return family;
}

/**
 * Build the `SurfaceAdapter` the surface-router consumes for the observability
 * projection. `render()` is non-throwing (every projection error caught + logged)
 * so a malformed envelope can't poison the router's dispatch loop. `db` is the
 * in-process MC handle; `wsRegistry` is the embed's live registry (omitted →
 * broadcast is a no-op for headless/test). cortex.ts wires both only when
 * `mc.enabled`.
 */
export function createObservabilityProjectionRenderer(
  db: Database,
  wsRegistry?: WsClientRegistry,
): SurfaceAdapter {
  return {
    id: OBSERVABILITY_PROJECTION_RENDERER_ID,
    subjects: OBSERVABILITY_PROJECTION_SUBJECTS,
    // eslint-disable-next-line @typescript-eslint/require-await
    render: async (envelope: Envelope): Promise<void> => {
      try {
        projectObservability(db, envelope, wsRegistry);
      } catch (err) {
        process.stderr.write(
          `[mission-control] observability renderer: render() swallowed an error for envelope ${envelope.id} (${envelope.type}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
  };
}
