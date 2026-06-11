/**
 * CO-4 (epic cortex#939) — the admission-point wiring for the per-offer-scope
 * gate floor. Composes CO-1's `resolveOffering` (the default-deny scope
 * resolver) with CO-4's `gateFloorForScope` (the per-scope floor) into ONE
 * call a capability consumer makes at its admission point, BEFORE the
 * capability/payload/concurrency gates run.
 *
 * ## The contract: byte-identical for local-only
 *
 * With `policy.offerings` absent (the live state of every stack today), EVERY
 * capability resolves to `local`-only via `resolveOffering` (ADR-0008 DD-CO-1),
 * and `gateFloorForScope('local', …)` admits unconditionally. So
 * {@link admitOfferedDispatch} returns `{ admit: true }` for the local case
 * WITHOUT reading the context — the consumer's behaviour is unchanged and boot
 * is byte-identical. The federated/public floors engage ONLY once a capability
 * is offered wider (CO-3's `cortex offer`), at which point the consumer is also
 * bound on the wider scope prefixes (CO-2). Until both land, this helper is a
 * provingly-inert no-op on the local path.
 *
 * ## Why a separate module (not inlined in a consumer)
 *
 * The floor is consumed by BOTH the `dev`/`release` consumers (runner/) and the
 * `review` consumer (bus/). Centralising the resolve→floor composition here
 * keeps the two sibling consumers from drifting (the same discipline the
 * `failedReasonToAckDecision` mapping is duplicated to preserve), and keeps the
 * floor logic out of the consumer hot path so it stays unit-testable.
 *
 * ## Seams left for CO-2 / CO-5 / CO-7
 *
 *   - **CO-2** wires the consumer to read the resolved offer-scope and bind its
 *     JetStream consumer on the admitted scope prefixes. Until CO-2, a consumer
 *     calls this with `scope` derived from the subject it actually received
 *     (local today). The `resolveOffering` call here is the same resolver CO-2
 *     consumes for binding — single source of truth.
 *   - **CO-5** (the gh-webhook Stage-1 tap) computes `surfaceVerified` /
 *     `surfacePredicatePassed` for the public path and only THEN emits the
 *     Offer; this helper reads those booleans off the {@link GateFloorContext}.
 *   - **CO-7** computes `complianceOk` (the untrusted-content / persona /
 *     egress compliance hook); this helper reads it and maps a `false` to
 *     `compliance_block`.
 *
 * Anchors: docs/design-capability-offering.md §5/§9-CO-4 · ADR-0008 DD-CO-3 ·
 *          ADR-0010 · CONTEXT.md §Capability offering.
 */

import type { SigningMode } from "../common/security-posture";
import {
  resolveOffering,
  type Offering,
  type OfferScope,
} from "../common/types/offering";
import {
  gateFloorForScope,
  type GateFloorContext,
  type GateFloorDecision,
} from "./gate-floor";

/**
 * Inputs to {@link admitOfferedDispatch}. The consumer supplies the capability
 * it is about to serve, the stack's offerings list (from `policy.offerings`),
 * the scope the dispatch arrived at, the stack's signing posture, and the
 * per-request floor context.
 */
export interface AdmitOfferedDispatchInput {
  /** The capability id the inbound dispatch targets (e.g. `dev.implement`). */
  readonly capability: string;
  /**
   * The stack's offerings list (`config.policy.offerings`). `undefined` ⇒
   * every capability resolves `local`-only (default-deny) ⇒ byte-identical.
   */
  readonly offerings: readonly Offering[] | undefined;
  /**
   * The offer-scope the dispatch ARRIVED at — derived from the subject prefix
   * (`local.`/`federated.`/`public.`). Today consumers only bind `local`
   * subjects, so this is `local`; CO-2 widens the binding. The floor is
   * evaluated against THIS scope (the floor a request at this scope must
   * clear), cross-checked against what the offering admits.
   */
  readonly arrivedScope: OfferScope;
  /** The stack's `security.signing` posture. */
  readonly signing: SigningMode;
  /** The per-request floor context (unread for the local path). */
  readonly ctx: GateFloorContext;
}

/**
 * Resolve the capability's offering and evaluate the gate floor for the scope
 * the dispatch arrived at. Pure + total.
 *
 * Two structural checks before the floor:
 *
 *   1. **Scope-admission.** The resolved offering must actually admit the
 *      `arrivedScope`. A dispatch that arrived at `public` for a capability
 *      offered only `local`/`federated` is refused `policy_denied` — the
 *      capability is not exposed at that tier (defence-in-depth against a
 *      mis-bound consumer or a forged-wide subject). For the local default
 *      this is always satisfied (`resolveOffering` ⇒ `['local']`).
 *   2. **Floor.** Given the admitted scope, delegate to
 *      {@link gateFloorForScope} for the signing/roster/surface/compliance/rate
 *      floor + refusal mapping.
 *
 * For the byte-identical local path (`arrivedScope === 'local'`, no offering or
 * a local offering), step 1 passes and step 2 admits unconditionally.
 */
export function admitOfferedDispatch(
  input: AdmitOfferedDispatchInput,
): GateFloorDecision {
  const resolved = resolveOffering(input.capability, input.offerings);

  // 1. Scope-admission: is the capability offered at the scope it arrived on?
  if (!resolved.scopes.includes(input.arrivedScope)) {
    return {
      admit: false,
      refusal: {
        kind: "policy_denied",
        deny: {
          floor: "scope_admission",
          requirement: "capability_offered_at_scope",
          capability: input.capability,
          arrived_scope: input.arrivedScope,
          offered_scopes: resolved.scopes,
        },
      },
    };
  }

  // 2. The per-scope floor.
  return gateFloorForScope(
    input.arrivedScope,
    resolved.accept,
    input.signing,
    input.ctx,
  );
}
