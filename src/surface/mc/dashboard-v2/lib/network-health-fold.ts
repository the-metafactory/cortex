/**
 * OBS-2 (plan-mc-future-state §4.B Track B) — tri-state HEALTH fold + RTT policy.
 *
 * A pure, DOM-free fold that derives a single per-node HEALTH status from the
 * three health signals MC has for a stack, applying the precedence settled in
 * **ADR-0022** (`docs/adr/0022-mc-health-and-rtt.md`). This is the single citable
 * implementation of that decision — no call site re-derives thresholds or
 * re-orders the fold (a reorder is a bug against the ADR, not a variant).
 *
 * ## The four states
 *
 *   - `green`       — observed healthy.
 *   - `amber`       — observed, warning (soft: degraded latency / weak-tier absence).
 *   - `red`         — observed, alarm (ground-truth outage / security anomaly / ≥2000ms).
 *   - `unobserved`  — no signal has an opinion. NEVER a stand-in for green or red.
 *
 * The cardinal rule (ADR §Decision, §Rationale): **NEVER default green, NEVER
 * default red.** Absent inputs fold to `unobserved` — a stack MC has never
 * measured must read differently from one MC measured and found unhealthy.
 * A `null` RTT is "not measured", not "unreachable", so it can never alarm.
 *
 * ## Fold precedence (ADR §Decision — highest wins on disagreement)
 *
 *   1. **collector-health**  — is the collector itself receiving envelopes?
 *                              Closest to ground truth ⇒ strongest.
 *   2. **transport-verdict** — signal's federation-layer reachability verdict
 *                              (taken VERBATIM via {@link verdictBadge}) folded
 *                              with the RTT threshold policy.
 *   3. **presence**          — bare last-seen heartbeat. Weakest, most easily stale.
 *
 * The highest-priority tier that HAS an opinion (is not `unobserved`) decides;
 * lower tiers are ignored entirely once a higher tier speaks. This is faithful to
 * the ADR: "When more than one of these three inputs disagrees … the fold resolves
 * to whichever is highest in this list." Consequence worth naming: a healthy
 * collector legitimately masks a lower-tier alarm — that is the ADR's intent
 * (collector = ground truth), not an oversight.
 *
 * ## Verdicts stay VERBATIM
 *
 * This module NEVER re-derives a transport verdict. It reads the verdict signal
 * already folded into {@link TransportPeerOverlay} (from `network-transport-overlay.ts`,
 * which sources verdicts verbatim from signal's `system.transport.*` envelopes)
 * and maps it to a severity through the canonical {@link verdictBadge} — the same
 * single source of truth the badge UI uses. Nothing here touches the overlay's
 * `ObservabilityOrigin` monotonic-foreign guard; a peer's verdict is never
 * re-attributed as local health.
 */

import type {
  TransportPeerOverlay,
  VerdictSeverity,
} from "./network-transport-overlay";
import { verdictBadge } from "./network-transport-overlay";

/** The tri-state HEALTH lane plus the honest fourth state for "no signal". */
export type NodeHealth = "green" | "amber" | "red" | "unobserved";

/**
 * Collector-health tier input — signal's `system.signal.collector.*` condition
 * for this node's collector. `unknown` means MC has seen no collector signal for
 * it ⇒ this (strongest) tier abstains and the fold falls through.
 */
export type CollectorHealth = "healthy" | "degraded" | "unknown";

/**
 * Presence tier input — the last liveness `state` off an `AgentPresenceTile`
 * (`agent.online` / `agent.offline`), or `unknown` when no presence is known.
 */
export type PresenceState = "online" | "offline" | "unknown";

/**
 * Transport tier input: signal's verdict severity (taken verbatim via
 * {@link verdictBadge}) plus the single-vantage leaf RTT. `null` for the whole
 * tier means no transport verdict was observed for this node.
 */
export interface TransportTier {
  /** Severity of signal's verbatim transport verdict (`verdictBadge(v).severity`). */
  severity: VerdictSeverity;
  /** Single-vantage leaf RTT in ms, or `null` when unreported (ADR: ⇒ unobserved). */
  rttMs: number | null;
}

/** The three tiers folded into one node HEALTH status (ADR precedence order). */
export interface NodeHealthInputs {
  /** Strongest tier. `unknown` ⇒ abstains. */
  collector: CollectorHealth;
  /** Middle tier. `null` ⇒ abstains. Verdict is verbatim from signal. */
  transport: TransportTier | null;
  /** Weakest tier. `unknown` ⇒ abstains. */
  presence: PresenceState;
}

// =============================================================================
// RTT threshold policy (ADR §Decision) — the OBS-2 deliverable for edges/aggregates.
// =============================================================================

/** amber boundary — a leaf RTT at or above this is degraded latency (ADR: ≥500ms). */
export const AMBER_RTT_MS = 500;
/** red boundary — a leaf RTT at or above this is an alarm (ADR: ≥2000ms). */
export const RED_RTT_MS = 2000;

/**
 * Map a single-vantage leaf RTT to a HEALTH state, per ADR-0022 thresholds.
 *
 *   - `null`      ⇒ `unobserved` — not measured is NOT a failure; NEVER `red`.
 *   - `< 500ms`   ⇒ `green`
 *   - `≥ 500ms`   ⇒ `amber`
 *   - `≥ 2000ms`  ⇒ `red`
 *
 * This is the standalone threshold policy every RTT render site (D5 canvas edges,
 * aggregate rollups) shares so none re-invents a boundary. Non-finite / negative
 * inputs are treated as absent (`unobserved`) rather than alarmed on — a
 * defensive extension of the null rule, never a fabricated `red`.
 */
export function rttHealth(rttMs: number | null): NodeHealth {
  if (rttMs === null || !Number.isFinite(rttMs) || rttMs < 0) return "unobserved";
  if (rttMs >= RED_RTT_MS) return "red";
  if (rttMs >= AMBER_RTT_MS) return "amber";
  return "green";
}

// =============================================================================
// Per-tier opinions — each maps its tier to a HEALTH opinion (or `unobserved`).
// =============================================================================

/** Severity rank so a fold can take the WORSE of two opinions. `unobserved` is lowest. */
const HEALTH_RANK: Record<NodeHealth, number> = {
  unobserved: 0,
  green: 1,
  amber: 2,
  red: 3,
};

/** The more-severe of two HEALTH opinions; `unobserved` never lowers the other. */
function worse(a: NodeHealth, b: NodeHealth): NodeHealth {
  return HEALTH_RANK[a] >= HEALTH_RANK[b] ? a : b;
}

/**
 * Verdict severity → HEALTH (`ok`→green, `warn`→amber, `alert`→red). This is the
 * parity anchor: a node whose only signal is its transport verdict folds to
 * exactly the severity {@link verdictBadge} assigns that verdict.
 */
export function severityHealth(severity: VerdictSeverity): NodeHealth {
  switch (severity) {
    case "ok":
      return "green";
    case "warn":
      return "amber";
    case "alert":
      return "red";
  }
}

/** collector-health tier opinion. `unknown` abstains; `degraded` is a ground-truth outage. */
export function collectorHealthOpinion(collector: CollectorHealth): NodeHealth {
  switch (collector) {
    case "healthy":
      return "green";
    case "degraded":
      // The collector is not receiving envelopes — the attention producer opens
      // an outage on this exact signal (observability-attention.ts). Ground-truth
      // outage ⇒ red. (Signal's collector vocabulary is binary degraded/recovered;
      // if it ever gains a distinct "down", revisit whether degraded softens to amber.)
      return "red";
    case "unknown":
      return "unobserved";
  }
}

/**
 * transport-verdict tier opinion: the WORSE of the verbatim verdict severity and
 * the RTT threshold policy. A `null` tier abstains. `null` RTT contributes
 * `unobserved`, so it never escalates a `connected` link and never manufactures
 * `red` — the verdict alone drives the base, RTT only ever raises it.
 */
export function transportHealthOpinion(transport: TransportTier | null): NodeHealth {
  if (transport === null) return "unobserved";
  return worse(severityHealth(transport.severity), rttHealth(transport.rttMs));
}

/** presence tier opinion. Weakest tier: `offline` is a soft `amber`, never a hard `red`. */
export function presenceHealthOpinion(presence: PresenceState): NodeHealth {
  switch (presence) {
    case "online":
      return "green";
    case "offline":
      // Presence is the weakest, stalest signal (ADR §Decision). On its own it
      // warrants attention, not a hard alarm — hard `red` is reserved for
      // ground-truth outages (collector degraded, `unregistered-present`, ≥2000ms).
      return "amber";
    case "unknown":
      return "unobserved";
  }
}

// =============================================================================
// The fold.
// =============================================================================

/**
 * Fold the three health tiers into one node HEALTH status, ADR-0022 precedence
 * (collector-health > transport-verdict > presence). The highest-priority tier
 * with an opinion decides; all tiers absent ⇒ `unobserved`. Never defaults to
 * `green` or `red`.
 */
export function foldNodeHealth(inputs: NodeHealthInputs): NodeHealth {
  const collector = collectorHealthOpinion(inputs.collector);
  if (collector !== "unobserved") return collector;

  const transport = transportHealthOpinion(inputs.transport);
  if (transport !== "unobserved") return transport;

  return presenceHealthOpinion(inputs.presence);
}

/**
 * Build the transport tier input from a peer's overlay row — reading the verdict
 * VERBATIM (`overlay.verdict`, never recomputed) and mapping it to severity via
 * the canonical {@link verdictBadge}. `null` overlay ⇒ `null` tier (abstains).
 * This is the real composition path from `network-transport-overlay.ts` into the
 * fold; nothing here mutates the overlay or its origin guard.
 */
export function transportTierFromOverlay(
  overlay: TransportPeerOverlay | null,
): TransportTier | null {
  if (overlay === null) return null;
  return {
    severity: verdictBadge(overlay.verdict).severity,
    rttMs: overlay.rttMs,
  };
}
