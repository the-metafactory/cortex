/**
 * IAW D.4 — Network registry public types.
 *
 * These shapes are the wire contract between the registry and any cortex
 * peer that consults it. Kept narrow and JSON-only so the same shapes
 * round-trip through D1 / KV / in-memory stores without coupling.
 *
 * Grammar conventions (mirrors `src/common/types/cortex-config.ts`):
 *   - operator_id    : lowercase alphanumeric + hyphen, letter-prefixed
 *                      (cortex#141 invariant — segments starting with a
 *                      digit interact badly with NATS subject matchers).
 *   - stack_id       : `{operator_id}/{stack_slug}` — the slash form is
 *                      load-bearing because the surface-router and
 *                      PolicyEngine derive `home_operator` by splitting
 *                      on the first `/`. Forged-attribution drift is
 *                      blocked at register time (see `validateOperator`).
 *   - operator_pubkey: base64-encoded Ed25519 public key (32 raw bytes
 *                      before encoding). Matches `PolicyFederatedPeerSchema`
 *                      shape in PR #223 — the schema we are about to feed.
 *   - capability_id  : Phase A.6 grammar — `<domain>.<entity>` (e.g.
 *                      `tasks.code-review`). Lowercase + dots + hyphens.
 */

/**
 * A single stack identity belonging to an operator. An operator can
 * declare multiple stacks (e.g. `andreas/laptop`, `andreas/server`)
 * and the registry stores them as a flat list keyed by operator.
 */
export interface StackIdentity {
  /** `{operator_id}/{stack_slug}` — slash-delimited. */
  stack_id: string;
  /** Human-readable label for dashboards. */
  display_name?: string;
  /**
   * Optional per-stack metadata. Free-form JSON map; the registry
   * does not interpret it. Useful for `region`, `data_residency`,
   * `tier`, etc. — but those are advisory, not enforced here.
   */
  metadata?: Record<string, string>;
}

/**
 * A capability the operator wants discoverable across the federation.
 * Mirrors the announce_capabilities[] list on `PolicyFederatedNetworkSchema`
 * in PR #223. The registry treats this as a search-only index — it
 * never executes capabilities, only advertises them.
 */
export interface Capability {
  /** Phase A.6 grammar — `<domain>.<entity>`. */
  id: string;
  /** Free-text description shown in capability search results. */
  description?: string;
  /**
   * Networks (by id) this capability is announced into. Empty array
   * means "default network only"; the operator's announce policy
   * still gates whether traffic actually reaches the stack.
   */
  networks?: string[];
}

/**
 * The body an operator posts to `POST /operators/{operator_id}/register`.
 * Wrapped by `SignedRegistration` (below) — the signature covers a
 * canonical JSON serialisation of this object plus a nonce + timestamp,
 * so the registry can verify before mutating any state.
 */
export interface RegistrationClaim {
  /** Must match the URL path parameter. Echoed for canonicalisation. */
  operator_id: string;
  /** Base64 Ed25519 pubkey the operator wants on record. */
  operator_pubkey: string;
  /** All stacks the operator is publishing. Empty list is permitted. */
  stacks: StackIdentity[];
  /** Capabilities the operator wants advertised. */
  capabilities: Capability[];
  /** ISO-8601 UTC timestamp at which the operator signed this claim. */
  issued_at: string;
  /**
   * Random nonce included in the signed payload to prevent replay.
   * The registry rejects nonces seen within the configured window.
   */
  nonce: string;
}

/**
 * The on-wire envelope around a `RegistrationClaim`. The operator
 * signs the canonical JSON of `claim` with their operator NKey;
 * the registry verifies the signature against `claim.operator_pubkey`
 * (TOFU on first sight; rotation is a follow-up, see README §Roadmap).
 */
export interface SignedRegistration {
  claim: RegistrationClaim;
  /** Base64-encoded Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * The view of an operator returned by `GET /operators/{operator_id}`.
 * Includes the registry's own signed assertion so peers can verify
 * before caching. Cortex callers MUST verify the assertion against
 * the registry pubkey they pinned at config time before trusting
 * `operator_pubkey` — that is the chain D.4.4 mandates.
 */
export interface OperatorRecord {
  operator_id: string;
  operator_pubkey: string;
  stacks: StackIdentity[];
  capabilities: Capability[];
  /** When the operator last successfully (re-)registered. */
  updated_at: string;
}

/**
 * A registry-signed assertion wrapping any payload returned by a GET.
 * The signature covers canonical-JSON({ payload, issued_at, registry })
 * so the bound payload, the issuance time, and the registry identity
 * are all integrity-protected — re-signing one without the others is
 * not possible without the registry's secret key.
 */
export interface SignedAssertion<T> {
  payload: T;
  issued_at: string;
  /** The registry's own pubkey (base64). Pin this client-side. */
  registry: string;
  /** Base64 Ed25519 signature over canonical-JSON of the bound triple. */
  signature: string;
}

/**
 * `GET /networks/{network_id}/roster` — operators that have announced
 * capabilities into this network. Roster membership is implicit:
 * an operator is "in" a network if any of their capabilities lists
 * that network in `capability.networks[]`. There is no separate
 * join/leave handshake in v1 — the operator's next register call
 * mutates membership atomically.
 */
export interface NetworkRoster {
  network_id: string;
  members: {
    operator_id: string;
    operator_pubkey: string;
    capabilities: string[];
  }[];
}

/**
 * A capability search hit. `GET /capabilities?query=foo` returns the
 * matching capability ids alongside the operator that announced
 * them. The caller resolves operator → pubkey via a follow-up
 * `GET /operators/{operator_id}` if they need the chain.
 */
export interface CapabilityHit {
  capability_id: string;
  operator_id: string;
  networks: string[];
  description?: string;
}
