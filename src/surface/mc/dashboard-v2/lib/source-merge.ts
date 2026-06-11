/**
 * U1.1 item 3 — source-merge policy + honest fidelity labeling.
 *
 * ONE transcript panel renders the best-available source for a session:
 *
 *   controlled (local, MC-dispatched) → stream-json firehose (FULL fidelity)
 *   local-observed                    → hook events  (item 1; ~80% CC feel)
 *   else (remote / historical)        → sideband timeline (item 2; preview)
 *
 * Guardrail — ADR-0007: session interiors are strictly LOCAL-PANE. A FOREIGN
 * origin's stream-json / hook events NEVER land locally, so this policy refuses
 * to pick them for a foreign session; the only interior path for a foreign
 * session is the (loopback-only) sideband when a correlation_id is known, else
 * the panel honestly says "interior capture not available".
 *
 * Pure decision function — no fetch, no DOM — so the policy is unit-testable in
 * isolation and lives in the entry bundle (it's tiny); the heavy sideband fetch
 * + mapping lives behind the lazy chunk (`sideband-source.tsx`).
 */

import type { AgentOrigin } from "../hooks/use-agents";
import type { SidebandError } from "../../../../common/sideband/proxy";

/** How MC came to know about this session — drives the source pick. */
export type DispatchOrigin =
  /** MC dispatched it; the full stream-json firehose is in the events table. */
  | "controlled"
  /** Cortex observed it locally via the cc-events tap (hook events present). */
  | "observed"
  /** Neither — fleet / remote / historical; only the sideband can reconstruct. */
  | "historical";

/** The minimal session metadata the policy needs. */
export interface TranscriptSessionMeta {
  sessionId: string;
  /** `"local"` or a foreign `{ principal, stack }` (ADR-0007 boundary). */
  origin: AgentOrigin;
  dispatchOrigin: DispatchOrigin;
  /** W3C trace_id ≡ correlation_id for the sideband lookup; null when unknown. */
  correlationId: string | null;
}

/** Provenance grade for the WHOLE panel — drives the honest header label. */
export type SourceFidelity = "full" | "observed" | "preview";

export type TranscriptSource =
  | { kind: "stream-json"; fidelity: "full" }
  | { kind: "hook-events"; fidelity: "observed" }
  | { kind: "sideband"; fidelity: "preview"; correlationId: string }
  | { kind: "unavailable" };

/** True for a foreign (federated peer) origin — interiors are local-pane only. */
function isForeign(origin: AgentOrigin): origin is { principal: string; stack: string } {
  return origin !== "local";
}

/**
 * Pick the best-available transcript source for a session, honoring the
 * ADR-0007 local-pane guardrail.
 */
export function selectTranscriptSource(meta: TranscriptSessionMeta): TranscriptSource {
  // FOREIGN origin: the local stream-json / hook-event paths can't apply (those
  // interiors never leave the peer's stack). Only the loopback sideband can
  // reconstruct one, and only with a correlation_id.
  if (isForeign(meta.origin)) {
    if (meta.correlationId) {
      return { kind: "sideband", fidelity: "preview", correlationId: meta.correlationId };
    }
    return { kind: "unavailable" };
  }

  // LOCAL origin: prefer the highest-fidelity local source.
  if (meta.dispatchOrigin === "controlled") {
    return { kind: "stream-json", fidelity: "full" };
  }
  if (meta.dispatchOrigin === "observed") {
    return { kind: "hook-events", fidelity: "observed" };
  }
  // Local but historical — fall back to the sideband when we can correlate.
  if (meta.correlationId) {
    return { kind: "sideband", fidelity: "preview", correlationId: meta.correlationId };
  }
  return { kind: "unavailable" };
}

/**
 * Honest fidelity label for the panel header. `null` ⇒ full-fidelity
 * controlled (no badge — it's the real transcript).
 */
export function fidelityLabel(fidelity: SourceFidelity): string | null {
  switch (fidelity) {
    case "full":
      return null;
    case "observed":
      return "Reconstructed from observed hook events — full interior on this session's home stack";
    case "preview":
      return "Preview-grade — full interior on this session's home stack";
  }
}

/**
 * Honest message for a sideband failure. Never throws on a malformed body —
 * the panel must degrade, not crash. On `backend_unavailable` we say "interior
 * capture not available for this session" (the issue's exact copy); the
 * `deep_link`, when present, is surfaced separately as the analyst's exit.
 */
export function sidebandErrorLabel(err: SidebandError | null | undefined): string {
  const code = err && typeof err === "object" ? err.code : undefined;
  switch (code) {
    case "backend_timeout":
      return "Interior capture not available — the sideband timed out. Retry, or open the deep link.";
    case "invalid_correlation_id":
      return "Interior capture not available for this session — no valid trace id to correlate.";
    case "backend_unavailable":
    case "internal_error":
    default:
      return "Interior capture not available for this session.";
  }
}
