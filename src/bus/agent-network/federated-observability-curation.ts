/**
 * P-14 U3.3 (#937) — the CURATION GATE for folded federated observability.
 *
 * This is cortex's OWN, code-enforced mirror of signal's U3.2 curation recipe
 * (signal#141, merged): the closed set of observability classes a peer may have
 * curated+exported and that this stack will therefore FOLD into Mission Control.
 *
 *   ALLOW — fold these `system.*` families:
 *     - `system.transport.>`   (leaf liveness / RTT / intent⋈reality verdicts)
 *     - `system.federation.>`  (peer roster lifecycle)
 *
 *   DENY — NEVER fold (a peer's interior / forensic / session-scoped streams):
 *     - `trace.>`              (OTLP spans — the session interior, ADR-0005)
 *     - `metric.>`
 *     - `log.>`
 *     - `session.>`
 *     - `system.signal.*`      (signal-collector health — a peer's substrate
 *                               interior, NOT folded cross-principal)
 *
 * ## Why a cortex-side gate AND the surface-router accept-list?
 *
 * The surface-router's `evaluateFederationGate` enforces the PER-NETWORK
 * `accept_subjects` / `deny_subjects` a principal configured for a peer — a
 * deployment-topology decision. THIS gate is a separate, code-fixed invariant:
 * regardless of how a peer's network is configured (or misconfigured), cortex
 * folds ONLY the curated observability classes. The recipe is not a config knob
 * a lax peer or a fat-fingered `accept_subjects: ["system.>"]` can widen — it is
 * the bounded context boundary between *work consolidation* (cortex, #21) and
 * *observability consolidation* (signal), enforced here in code.
 *
 * So a peer envelope must clear BOTH: the network accept-list (is this peer
 * allowed at all, on a subject its network permits) AND this curation gate (is
 * this an observability CLASS cortex folds). The curation gate is the load-
 * bearing NEGATIVE CONTROL: a peer's non-exported class (`trace.>`,
 * `system.signal.*`) is excluded HERE even if it somehow passed the network
 * accept-list — it can never appear in MC.
 *
 * Pure + dependency-free → exhaustively unit-testable against the class matrix.
 * The decision is taken on the envelope `type` (`domain.entity.action`), the
 * canonical class identifier — NOT the wire subject, which a peer cannot forge
 * past the source-bound identity but which carries the `federated.{principal}.
 * {stack}.` routing prefix the class check would have to strip anyway.
 */

/**
 * The closed ALLOW-list of folded observability class prefixes. A type folds
 * IFF it starts with one of these. Ordered most-specific-first is unnecessary
 * here (the two prefixes are disjoint), but kept explicit for the recipe's
 * one-to-one correspondence with signal#141.
 */
export const FOLDED_OBSERVABILITY_PREFIXES: readonly string[] = [
  "system.transport.",
  "system.federation.",
] as const;

/**
 * The DENY-list — classes that must NEVER fold, listed for the negative-control
 * test's explicitness and for an auditable record of the recipe. The gate's
 * decision is ALLOW-list-driven (anything not on the allow-list is denied), so
 * this list is documentation + a belt-and-braces guard the test pins; a class
 * that is BOTH (impossible by construction — the prefixes are disjoint) would
 * deny, since deny is the default.
 */
export const DENIED_OBSERVABILITY_PREFIXES: readonly string[] = [
  "trace.",
  "metric.",
  "log.",
  "session.",
  "system.signal.",
] as const;

/** Structured curation outcome — `allow`, or a deny carrying the rejected class. */
export type CurationDecision =
  | { kind: "allow" }
  | { kind: "deny_not_curated"; type: string };

/**
 * Decide whether a federated observability envelope of `type` may be folded.
 *
 * ALLOW-list semantics (fail-closed): a type folds IFF it matches a
 * {@link FOLDED_OBSERVABILITY_PREFIXES} entry. Everything else — including every
 * {@link DENIED_OBSERVABILITY_PREFIXES} class and any unanticipated class — is
 * `deny_not_curated`. A peer cannot widen this by emitting a novel class: the
 * default is deny.
 *
 * Note `system.signal.` is denied while `system.federation.`/`system.transport.`
 * allow — the curation boundary runs THROUGH the `system.` domain, not around
 * it, which is exactly why an allow-list (not a `system.>` blanket) is required.
 */
export function evaluateObservabilityCuration(type: string): CurationDecision {
  for (const prefix of FOLDED_OBSERVABILITY_PREFIXES) {
    if (type.startsWith(prefix)) return { kind: "allow" };
  }
  return { kind: "deny_not_curated", type };
}

/** Convenience boolean form for hot-path call sites. */
export function isFoldableObservabilityClass(type: string): boolean {
  return evaluateObservabilityCuration(type).kind === "allow";
}
