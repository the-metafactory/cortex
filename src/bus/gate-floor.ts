/**
 * CO-4 (epic cortex#939) — the per-offer-scope GATE FLOOR (ADR-0008 DD-CO-3).
 *
 * Offer-scope *raises the gate floor*. The further out a capability is
 * offered, the more the gates matter — and offering at a wider scope makes
 * those gates NON-OPTIONAL. This module is the pure, structural admission
 * gate: given a resolved offering's scope + accept-policy, the stack's signing
 * posture, and a per-request context, {@link gateFloorForScope} decides whether
 * an offered-capability dispatch CLEARS the floor its scope demands — and, on
 * failure, maps to the right entry in the dispatch refusal taxonomy
 * (CONTEXT.md §Dispatch): `policy_denied` (accept/structural), `compliance_block`
 * (compliance), `not_now` (rate-limit backpressure).
 *
 * ## The floor, per scope (design §5, ADR-0008 DD-CO-3)
 *
 * | scope     | trust anchor                | minimum gates this module enforces                                  |
 * |-----------|-----------------------------|---------------------------------------------------------------------|
 * | local     | the offering stack itself   | **none beyond the home bus** — always admit (byte-identical)        |
 * | federated | the registry + peer pubkeys | signing ≥ permissive; signed envelope; accept-policy roster check    |
 * | public    | the surface (e.g. GitHub)   | signing-enforce (bus peers); surface verified; bounded accept;      |
 * |           |   + rate limit              | compliance gate; rate-limit                                         |
 *
 * Offer-scope is ORTHOGONAL to but a MINIMUM on the signing-posture knob: it
 * raises a floor, never lowers the configured posture. A stack on
 * `signing: enforce` clears the federated `≥ permissive` floor trivially; a
 * stack on `signing: off` cannot offer at federated/public until it raises its
 * posture (the floor refuses).
 *
 * ## Byte-identical-local (the CO-4 contract)
 *
 * A `local`-only offering — the default-deny resolution for EVERY capability
 * today (CO-1 `resolveOffering`) — adds NO floor beyond today's home-bus
 * admission: {@link gateFloorForScope} returns `{ admit: true }` for `local`
 * unconditionally, reading neither the accept-policy nor the context. With
 * `policy.offerings` absent every capability resolves `local`, so the floor is
 * a no-op and boot + behaviour are byte-identical. The federated/public floors
 * engage ONLY when something is offered wider (CO-3's `cortex offer`).
 *
 * ## Scope of CO-4 (the STRUCTURAL floor, not the deep handling)
 *
 * This module is the structural admission gate + refusal mapping ONLY. The
 * inputs it reads (`surfaceVerified`, `surfacePredicatePassed`, `peerInNetwork`,
 * `complianceOk`, `rateOk`) are DECISIONS made upstream by the seams CO-5 and
 * CO-7 own — this module composes them into the floor verdict, it does not
 * compute them:
 *
 *   - **CO-5 seam** — the gh-webhook Stage-1 tap (ADR-0010) is what HMAC-
 *     validates the surface, evaluates the metadata-only accept-predicate, and
 *     decides `surfaceVerified` / `surfacePredicatePassed` *before any Offer is
 *     published*. CO-4 consumes those booleans; it does NOT parse webhooks or
 *     evaluate predicates against request content. See
 *     {@link GateFloorContext.surfaceVerified} / `.surfacePredicatePassed`.
 *   - **CO-7 seam** — the untrusted-content & prompt-injection hardening
 *     (M1–M6: boundary, least-privilege session, sandbox, egress, persona
 *     hardening) is the DEEP content handling that runs AFTER the floor admits.
 *     CO-4 is the admission floor; CO-7 is what a sandboxed reviewer does with
 *     the content once it is in. `complianceOk` is the boolean a CO-7
 *     compliance hook resolves; CO-4 maps a `false` to `compliance_block`.
 *
 * Anchors: docs/design-capability-offering.md §5 · docs/adr/0008-capability-offering-scope.md (DD-CO-3) ·
 *          docs/adr/0010-public-accept-gate-two-stage.md · CONTEXT.md §Capability offering / §Dispatch.
 */

import type { SigningMode } from "../common/security-posture";
import type { AcceptPolicy, OfferScope } from "../common/types/offering";
import type { DispatchTaskFailedReason } from "./dispatch-events";

// ---------------------------------------------------------------------------
// Per-request context — the upstream decisions the floor composes
// ---------------------------------------------------------------------------

/**
 * The per-request inputs {@link gateFloorForScope} reads to evaluate a
 * federated/public floor. Every field is a DECISION made upstream (the
 * envelope validator for `signed`/`peerPrincipal`; the registry/network
 * resolver for `peerInNetwork`; the CO-5 Stage-1 tap for `surfaceVerified` /
 * `surfacePredicatePassed`; a CO-7 compliance hook for `complianceOk`; a
 * rate-limiter for `rateOk`). The floor COMPOSES them — it never recomputes
 * them, and it never reads request CONTENT (ADR-0010: content can never
 * influence whether a request gets in).
 *
 * `local` reads NONE of these — its floor is unconditional admit.
 */
export interface GateFloorContext {
  /**
   * Whether the inbound envelope carries a verified `signed_by[]` chain.
   * Federated/public both require a signed bus peer (the requester proves
   * *who*). For a PUBLIC request the requester is a surface, not a bus peer —
   * `signed` then refers to the surface-relay's signed Offer on the bus, with
   * the surface identity carried in `originator` (ADR-0010 DD-CO-8).
   */
  readonly signed: boolean;
  /**
   * The signed peer's principal id (stripped from `signed_by[0].principal`).
   * Consulted by the `{kind:'principals'}` federated accept. `undefined` when
   * unsigned.
   */
  readonly peerPrincipal?: string;
  /**
   * Whether the peer is on the registry roster of the accept-policy's network
   * (the `{kind:'network'}` federated accept). Resolved by the network/registry
   * resolver upstream; CO-4 reads the boolean. (CO-2/CO-3 wire the live
   * resolution; until then a caller passes the resolved membership.)
   */
  readonly peerInNetwork: boolean;
  /**
   * **CO-5 seam.** Whether the surface (e.g. GitHub) was HMAC-verified by the
   * Stage-1 tap — the public trust anchor. For non-public scopes this is
   * unread. A public floor REFUSES (`policy_denied`) when the surface is not
   * verified: with no trust anchor there is no admissible identity.
   */
  readonly surfaceVerified: boolean;
  /**
   * **CO-5 seam.** Whether the metadata-only accept-predicate (repo-membership
   * / sender-allow / sender-block / rate — the bounded accept) PASSED at the
   * Stage-1 tap (ADR-0010 DD-CO-8). CO-4 reads the boolean; it never evaluates
   * a predicate against request content. A `false` is `policy_denied` (the
   * accept-policy bounded what may be asked, and this request fell outside).
   */
  readonly surfacePredicatePassed: boolean;
  /**
   * **CO-7 seam.** Whether the compliance hook cleared the request. A `false`
   * is `compliance_block` (a permanent refusal — the request is structurally
   * forbidden, not merely throttled). The hook itself (STD-EXAMPLE-AI-001 / output
   * egress / persona) is CO-7 territory; CO-4 maps its verdict.
   */
  readonly complianceOk: boolean;
  /**
   * Whether the rate-limit / cost-cap gate admits the request. A `false` is
   * `not_now` (transient backpressure — retry safe). The limiter is the §5
   * gate-floor knob (`PublicLimits`); CO-4 maps its verdict and attaches a
   * retry hint.
   */
  readonly rateOk: boolean;
  /**
   * Optional backpressure hint (ms) attached to a `not_now` rate refusal.
   * Defaults to {@link DEFAULT_RATE_RETRY_AFTER_MS} when the limiter doesn't
   * supply one.
   */
  readonly rateRetryAfterMs?: number;
}

/**
 * The floor verdict. Discriminated on `admit`:
 *   - `{ admit: true }` — the dispatch clears the scope's floor; the consumer
 *     proceeds to its capability/payload/concurrency gates.
 *   - `{ admit: false, refusal }` — the floor refused; the consumer publishes
 *     `dispatch.task.failed` with `refusal` and naks/terms per the standard
 *     `failedReasonToAckDecision` mapping (`policy_denied`/`compliance_block`
 *     → term; `not_now` → nak).
 */
export type GateFloorDecision =
  | { admit: true }
  | { admit: false; refusal: DispatchTaskFailedReason };

/** Default `not_now` retry hint for a tripped rate-limit (5s). */
export const DEFAULT_RATE_RETRY_AFTER_MS = 5000;

// ---------------------------------------------------------------------------
// Refusal builders — map a failed floor to the dispatch refusal taxonomy
// ---------------------------------------------------------------------------

/** A `policy_denied` refusal carrying a structured `deny` payload for audit. */
function denied(deny: Record<string, unknown>): GateFloorDecision {
  return { admit: false, refusal: { kind: "policy_denied", deny } };
}

/** A `compliance_block` refusal (permanent — compliance hook forbids it). */
function complianceBlock(detail: string): GateFloorDecision {
  return { admit: false, refusal: { kind: "compliance_block", detail } };
}

/** A `not_now` refusal (transient — rate-limit backpressure, retry safe). */
function rateLimited(retryAfterMs: number): GateFloorDecision {
  return {
    admit: false,
    refusal: {
      kind: "not_now",
      detail: "gate-floor rate-limit: request throttled — retry",
      retry_after_ms: retryAfterMs,
    },
  };
}

const ADMIT: GateFloorDecision = { admit: true };

// ---------------------------------------------------------------------------
// The pure floor evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate the gate floor an offered-capability dispatch must clear, given the
 * offering's `scope`, its `accept`-policy, the stack's `signing` posture, and
 * the per-request `ctx`. Pure + total: no I/O, no throw.
 *
 * **Refusal ordering is deterministic + STRUCTURAL-FIRST.** Within a scope the
 * floor checks the structural admission gates (signing posture, signed-peer
 * proof, surface trust anchor, bounded accept-policy) BEFORE the
 * compliance/rate gates, and a PERMANENT refusal (`policy_denied`,
 * `compliance_block`) is preferred over a TRANSIENT one (`not_now`) — so a
 * structurally-forbidden request is refused permanently (term) rather than
 * naked into an endless retry loop.
 *
 * @param scope    the offer-scope being evaluated (from the resolved offering).
 * @param accept   the accept-policy the offering carries (undefined for local).
 * @param signing  the stack's `security.signing` posture (`off`/`permissive`/`enforce`).
 * @param ctx      the per-request context (unread for `local`).
 */
export function gateFloorForScope(
  scope: OfferScope,
  accept: AcceptPolicy | undefined,
  signing: SigningMode,
  ctx: GateFloorContext,
): GateFloorDecision {
  switch (scope) {
    case "local":
      // The home bus IS the floor — nothing beyond it. Byte-identical: no
      // accept, no signing, no context read. (A local offering carries no
      // accept by schema; even if a caller passes one we never read it.)
      return ADMIT;

    case "federated":
      return federatedFloor(accept, signing, ctx);

    case "public":
      return publicFloor(accept, signing, ctx);
  }
}

/**
 * The federated floor (DD-CO-3): signing ≥ permissive + a signed peer + the
 * accept-policy's roster admits that peer. A federated offering with NO accept
 * is default-deny (the CO-1 schema rejects it; defensively the floor refuses).
 */
function federatedFloor(
  accept: AcceptPolicy | undefined,
  signing: SigningMode,
  ctx: GateFloorContext,
): GateFloorDecision {
  // Floor 1 — signing posture ≥ permissive. `off` is below the floor: a
  // federated peer's identity must be cryptographically attachable.
  if (signing === "off") {
    return denied({
      floor: "federated",
      requirement: "signing>=permissive",
      actual_signing: signing,
    });
  }

  // Floor 2 — the envelope must be a signed peer (proof of *who*).
  if (!ctx.signed) {
    return denied({ floor: "federated", requirement: "signed_peer" });
  }

  // Floor 3 — the accept-policy must exist and be a federated accept.
  if (accept === undefined) {
    return denied({ floor: "federated", requirement: "accept_policy_present" });
  }
  if (accept.kind !== "network" && accept.kind !== "principals") {
    return denied({
      floor: "federated",
      requirement: "federated_accept",
      accept_kind: accept.kind,
    });
  }

  // Floor 4 — the roster admits this peer.
  if (accept.kind === "network") {
    if (!ctx.peerInNetwork) {
      return denied({
        floor: "federated",
        requirement: "network_roster",
        network: accept.network,
        peer: ctx.peerPrincipal ?? null,
      });
    }
    return ADMIT;
  }

  // {kind:'principals'} — the named allowlist must contain the peer principal.
  if (ctx.peerPrincipal === undefined || !accept.principals.includes(ctx.peerPrincipal)) {
    return denied({
      floor: "federated",
      requirement: "principals_roster",
      peer: ctx.peerPrincipal ?? null,
    });
  }
  return ADMIT;
}

/**
 * The public floor (DD-CO-3, ADR-0010): signing-enforce (bus peers) + a
 * verified surface trust anchor + the bounded metadata accept-predicate passed
 * + compliance + rate-limit. Structural gates first (signing → surface →
 * predicate), then the permanent compliance gate, then the transient rate
 * gate — so a structurally-forbidden or compliance-forbidden request terms
 * rather than naking forever.
 */
function publicFloor(
  accept: AcceptPolicy | undefined,
  signing: SigningMode,
  ctx: GateFloorContext,
): GateFloorDecision {
  // Floor 1 — signing-enforce for bus peers. Public is the highest trust bar:
  // anything less than `enforce` cannot offer publicly.
  if (signing !== "enforce") {
    return denied({
      floor: "public",
      requirement: "signing==enforce",
      actual_signing: signing,
    });
  }

  // Floor 2 — the accept-policy must exist and be a public surface accept.
  if (accept === undefined) {
    return denied({ floor: "public", requirement: "accept_policy_present" });
  }
  if (accept.kind !== "surface") {
    return denied({
      floor: "public",
      requirement: "public_accept",
      accept_kind: accept.kind,
    });
  }

  // Floor 3 — the surface is the trust anchor; it must be HMAC-verified
  // (CO-5 Stage-1 tap). No verified surface ⇒ no admissible identity.
  if (!ctx.surfaceVerified) {
    return denied({
      floor: "public",
      requirement: "surface_verified",
      surface: accept.surface,
    });
  }

  // Floor 4 — the bounded metadata accept-predicate must have passed at the
  // tap (ADR-0010 DD-CO-8). This is the "accept-policy bounds WHAT may be
  // asked" gate — the offered capability only, never a sibling.
  if (!ctx.surfacePredicatePassed) {
    return denied({
      floor: "public",
      requirement: "accept_predicate",
      surface: accept.surface,
      predicate_kind: accept.predicate.kind,
    });
  }

  // Floor 5 — compliance gate (CO-7 seam). PERMANENT refusal: a
  // compliance-forbidden request is structurally not allowed, so it terms.
  if (!ctx.complianceOk) {
    return complianceBlock("gate-floor compliance hook denied the public request");
  }

  // Floor 6 — rate-limit / cost-cap (the §5 floor knob). TRANSIENT: the
  // request is admissible, just throttled — nak with a retry hint.
  if (!ctx.rateOk) {
    return rateLimited(ctx.rateRetryAfterMs ?? DEFAULT_RATE_RETRY_AFTER_MS);
  }

  return ADMIT;
}
