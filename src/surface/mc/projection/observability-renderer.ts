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
  type ObservabilityOrigin,
} from "../db/observability";
import { produceObservabilityAttention } from "./observability-attention";

/** Stable surface-router id for the observability projection renderer. */
export const OBSERVABILITY_PROJECTION_RENDERER_ID = "mc-observability-projection";

/**
 * NATS subject patterns the renderer subscribes to — the stack-ful
 * (`local.{principal}.{stack}.…`) + stack-less (`local.{principal}.…`) LOCAL
 * grammars for each family. Intentionally broad WITHIN the local scope; the
 * authoritative filter is the renderer's own `type` prefix check (an
 * over-matching subject costs only a cheap compare).
 *
 * `*` matches exactly one segment, `>` one-or-more trailing segments.
 *
 * ## P-14 U3.3 (#937) — LOCAL-ONLY. The `federated.*` grammars were REMOVED.
 *
 * Pre-U3.3 this renderer also subscribed to `federated.*.*.system.{signal,
 * federation,transport}.>` and folded peer rows UN-origin-badged, WITHOUT chain
 * verification, and WITHOUT cortex's curation gate (so it would have folded the
 * DENIED `system.signal.*` class from a peer). That was a trust gap for a
 * cross-principal fold. At U3.3 ALL `federated.*` observability flows through
 * the dedicated TRUST-VERIFIED path (`bus/agent-network/federated-observability-
 * fold.ts`): curation gate + federation accept-list + `verifySignedByChain` +
 * source-bound origin badge. This renderer now folds ONLY this principal's own
 * (and local-sibling) observability, every row `origin: "local"` (the default).
 * The two paths are disjoint by subject scope — no double-fold.
 */
export const OBSERVABILITY_PROJECTION_SUBJECTS: string[] = [
  // signal (covers signal.collector.* too — the prefix check splits them)
  "local.*.system.signal.>",
  "local.*.*.system.signal.>",
  // federation
  "local.*.system.federation.>",
  "local.*.*.system.federation.>",
  // transport (hub-emitted; non-hub stacks just never see these)
  "local.*.system.transport.>",
  "local.*.*.system.transport.>",

  // #1661 (MC folds) — the cortex-LOCAL families. Subscribed to the EXACT
  // subjects the folded types publish on (`local.{principal}[.{stack}].{type}`),
  // NOT broad `system.access.>` / `system.bus.>` prefixes — so high-volume
  // sibling types (`system.access.allowed`, `system.bus.peer_dispatch_received`)
  // never reach the renderer's dispatch loop at all. `familyForType` remains the
  // authoritative belt-filter for anything that does arrive.
  // access:
  "local.*.system.access.denied",
  "local.*.*.system.access.denied",
  "local.*.system.access.filtered",
  "local.*.*.system.access.filtered",
  "local.*.system.admission.throttled",
  "local.*.*.system.admission.throttled",
  "local.*.system.admission.degraded",
  "local.*.*.system.admission.degraded",
  // dispatch:
  "local.*.system.dispatch.stage",
  "local.*.*.system.dispatch.stage",
  "local.*.system.inbound.aborted",
  "local.*.*.system.inbound.aborted",
  "local.*.system.bus.process",
  "local.*.*.system.bus.process",
  // reflex:
  "local.*.reflex.activation.>",
  "local.*.*.reflex.activation.>",
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

  // #1661 (MC folds) — three cortex-LOCAL families. Consumer-side ONLY (#97):
  // this renderer READS these system envelopes; the producer emit sites in
  // bus/system-events.ts are OUT of scope and untouched. Routed by EXACT type,
  // not broad prefix — sibling types like `system.access.allowed` (high-volume)
  // or `system.bus.peer_dispatch_received` stay OUT of the fold by design
  // (decision B is 3 SECTIONS, not "everything under the prefix"). Widening a
  // family's type set is a deliberate follow-up, never an accidental default.
  //   access   = system.access.{denied,filtered} + system.admission.{throttled,degraded}
  if (
    type === "system.access.denied" ||
    type === "system.access.filtered" ||
    type === "system.admission.throttled" ||
    type === "system.admission.degraded"
  ) {
    return "access";
  }
  //   dispatch = system.dispatch.stage + system.inbound.aborted + system.bus.process
  if (
    type === "system.dispatch.stage" ||
    type === "system.inbound.aborted" ||
    type === "system.bus.process"
  ) {
    return "dispatch";
  }
  //   reflex   = reflex.activation.* (fired, decision, …)
  if (type.startsWith("reflex.activation.")) return "reflex";

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
 * `origin` defaults to `"local"` — the U2.1 contract (this renderer + every
 * local caller folds local rows). P-14 U3.3's federated fold path passes
 * `{ kind: "foreign"; peer }` via {@link projectForeignObservability} so the row
 * carries the chain-verified peer origin badge.
 *
 * Exported for direct unit testing.
 */
export function projectObservability(
  db: Database,
  envelope: ProjectableEnvelope,
  wsRegistry: WsClientRegistry | undefined,
  origin: ObservabilityOrigin = "local",
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

  // Origin-stack id is a best-effort GROUPING hint off the payload. For a
  // FOREIGN row the authoritative ATTRIBUTION is the `origin.peer` (chain-
  // verified source), persisted via the `origin` column — never the payload.
  const rowId = insertObservabilityEvent(db, {
    envelopeId,
    family,
    type: envelope.type,
    stackId: originStackId(payload),
    summary: asString(payload.summary) ?? asString(payload.message),
    payload,
    origin,
  });

  // The attention producer rides the SAME seam — every observability envelope is
  // offered to it; only the six health signals (collector/transport up/down)
  // open or resolve an `att:adapter:` item. It runs independently of the row
  // insert's idempotent no-op (a redelivered degraded must still keep the item
  // open / resolvable), so it is NOT gated on `rowId`.
  //
  // P-14 U3.3 — only LOCAL observability opens the principal's actionable
  // `att:adapter:` attention items. A FOREIGN peer's substrate health is
  // origin-badged HISTORY (+ Network-view overlay), NOT the principal's own
  // adapter to action — and `att:adapter:` items are keyed by leaf/backend id
  // alone, so a peer's leaf would collide with a local one. Foreign rows project
  // history + broadcast only; the attention queue stays the principal's own.
  const attn =
    origin === "local"
      ? produceObservabilityAttention(db, { id: envelope.id, type: envelope.type, payload })
      : null;

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
 * P-14 U3.3 (#937) — the projection entry point for the TRUST-VERIFIED federated
 * observability fold (`bus/agent-network/federated-observability-fold.ts`).
 *
 * Writes the curated, chain-verified peer envelope as an ORIGIN-BADGED row
 * (`origin: { kind: "foreign"; peer }`), where `peer` is the chain-verified
 * `{principal}/{stack}` the fold derived from the envelope SOURCE (never the
 * payload). Thin wrapper over {@link projectObservability} with the foreign
 * origin — so a foreign row gets the SAME idempotent-redelivery + WS-broadcast
 * treatment as a local one, while being durably attributed to its peer and
 * NEVER opening a local attention item.
 *
 * Non-throwing is the CALLER's contract here (the fold callback swallows), but
 * the underlying inserts/broadcasts already never throw on valid inputs.
 */
export function projectForeignObservability(
  db: Database,
  envelope: ProjectableEnvelope,
  peer: string,
  wsRegistry: WsClientRegistry | undefined,
): ObservabilityFamily | null {
  return projectObservability(db, envelope, wsRegistry, { kind: "foreign", peer });
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
