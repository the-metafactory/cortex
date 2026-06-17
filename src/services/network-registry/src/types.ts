/**
 * IAW D.4 — Network registry public types.
 *
 * These shapes are the wire contract between the registry and any cortex
 * peer that consults it. Kept narrow and JSON-only so the same shapes
 * round-trip through D1 / KV / in-memory stores without coupling.
 *
 * Grammar conventions (mirrors `src/common/types/cortex-config.ts`):
 *   - principal_id   : lowercase alphanumeric + hyphen, letter-prefixed
 *                      (cortex#141 invariant — segments starting with a
 *                      digit interact badly with NATS subject matchers).
 *   - stack_id       : `{principal_id}/{stack_slug}` — the slash form is
 *                      load-bearing because the surface-router and
 *                      PolicyEngine derive `home_principal` by splitting
 *                      on the first `/`. Forged-attribution drift is
 *                      blocked at register time (see `validatePrincipal`).
 *   - principal_pubkey: base64-encoded Ed25519 public key (32 raw bytes
 *                      before encoding). Matches `PolicyFederatedPeerSchema`
 *                      shape in PR #223 — the schema we are about to feed.
 *   - capability_id  : Phase A.6 grammar — `<domain>.<entity>` (e.g.
 *                      `tasks.code-review`). Lowercase + dots + hyphens.
 */

/**
 * A single stack identity belonging to a principal. A principal can
 * declare multiple stacks (e.g. `andreas/laptop`, `andreas/server`)
 * and the registry stores them as a flat list keyed by principal.
 */
export interface StackIdentity {
  /** `{principal_id}/{stack_slug}` — slash-delimited. */
  stack_id: string;
  /**
   * C-787 — the per-stack Ed25519 signing pubkey (base64, 44 chars w/
   * padding). Each stack federates with its OWN key so a principal can run
   * multiple stacks (e.g. `andreas/meta-factory`, `andreas/community`). The
   * principal's `principal_pubkey` remains the ROOT/authority key that
   * authorizes ADDING a stack; this field is the key federated envelopes
   * FROM this stack are verified against.
   *
   * OPTIONAL on the wire for back-compat: a producer that predates C-787
   * omits it, and the registry backfills it from `principal_pubkey` at
   * register time (so an existing single-stack principal keeps verifying).
   * After a successful register the stored record always carries it.
   */
  stack_pubkey?: string;
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
 * A capability the principal wants discoverable across the federation.
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
   * means "default network only"; the principal's announce policy
   * still gates whether traffic actually reaches the stack.
   */
  networks?: string[];
}

/**
 * The body a principal posts to `POST /principals/{principal_id}/register`.
 * Wrapped by `SignedRegistration` (below) — the signature covers a
 * canonical JSON serialisation of this object plus a nonce + timestamp,
 * so the registry can verify before mutating any state.
 */
export interface RegistrationClaim {
  /** Must match the URL path parameter. Echoed for canonicalisation. */
  principal_id: string;
  /** Base64 Ed25519 pubkey the principal wants on record. */
  principal_pubkey: string;
  /** All stacks the principal is publishing. Empty list is permitted. */
  stacks: StackIdentity[];
  /** Capabilities the principal wants advertised. */
  capabilities: Capability[];
  /**
   * #825 — optimistic concurrency. The `updated_at` of the record this claim's
   * merge was computed from (captured during the client's verified read). The
   * registry compare-and-sets on it: if the stored row changed since (a
   * concurrent host's register/join), the write is rejected `409 stale_record`
   * and the client re-reads + re-merges. Omitted on a first register / when the
   * client read no existing record (nothing to clobber). Part of the signed
   * canonical payload — a MITM cannot strip or forge the CAS token.
   */
  expected_updated_at?: string;
  /** ISO-8601 UTC timestamp at which the principal signed this claim. */
  issued_at: string;
  /**
   * Random nonce included in the signed payload to prevent replay.
   * The registry rejects nonces seen within the configured window.
   */
  nonce: string;
}

/**
 * The on-wire envelope around a `RegistrationClaim`. The principal
 * signs the canonical JSON of `claim` with their principal NKey;
 * the registry verifies the signature against `claim.principal_pubkey`
 * (TOFU on first sight; rotation is a follow-up, see README §Roadmap).
 */
export interface SignedRegistration {
  claim: RegistrationClaim;
  /** Base64-encoded Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * The view of a principal returned by `GET /principals/{principal_id}`.
 * Includes the registry's own signed assertion so peers can verify
 * before caching. Cortex callers MUST verify the assertion against
 * the registry pubkey they pinned at config time before trusting
 * `principal_pubkey` — that is the chain D.4.4 mandates.
 */
export interface PrincipalRecord {
  principal_id: string;
  principal_pubkey: string;
  stacks: StackIdentity[];
  capabilities: Capability[];
  /** When the principal last successfully (re-)registered. */
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
 * `GET /networks/{network_id}/roster` — principals that have announced
 * capabilities into this network. Roster membership is implicit:
 * a principal is "in" a network if any of their capabilities lists
 * that network in `capability.networks[]`. There is no separate
 * join/leave handshake in v1 — the principal's next register call
 * mutates membership atomically.
 */
export interface NetworkRoster {
  network_id: string;
  members: {
    principal_id: string;
    principal_pubkey: string;
    capabilities: string[];
  }[];
}

/**
 * S2.5 (Network Join Control Plane, #745 · epic #733 · spec DD-12) — the
 * network **descriptor** payload carried by `GET /networks/{network_id}`
 * inside a `SignedAssertion<NetworkDescriptor>`.
 *
 * **DD-12 — hub via registry-served descriptor.** The hub's reachability
 * (`hub_url` + `leaf_port`) is served by the registry, NOT pinned in each
 * peer's local config, so the hub can relocate without every peer re-editing
 * `cortex.yaml`. The join command (S4) and the leaf renderer (S3) derive the
 * nats-server leaf remote from this descriptor.
 *
 * Like every registry GET, the descriptor is wrapped in a `SignedAssertion`
 * and the cortex client verifies it against the pinned registry pubkey before
 * trusting it (DD-9).
 *
 * **Source-of-truth split.** `hub_url` + `leaf_port` come from a stored
 * {@link NetworkRecord} (admin-seeded topology); `members[]` is the
 * lightweight membership view DERIVED from the principal roster at read time
 * (the same implicit membership the `/roster` route computes — a principal is
 * "in" a network if any announced capability targets it). The full per-peer
 * roster (with pubkeys + stacks) remains `GET /networks/{id}/roster`.
 *
 * This shape MUST stay structurally compatible with the cortex-side
 * `NetworkDescriptor` in `src/common/registry/types.ts` (the S1 client's
 * `parseDescriptor` reads exactly `network_id` / `hub_url` (non-empty string) /
 * `leaf_port` (integer) / `members` (string[])). The service is the source of
 * truth for the schema; the client mirrors it.
 */
export interface NetworkDescriptor {
  /** Network id — letter-prefixed lowercase-alphanumeric + hyphen. */
  network_id: string;
  /**
   * The hub's leaf-node dial URL (e.g. `tls://hub.meta-factory.ai:7422`).
   * Where a joining stack's nats-server leaf remote points. DD-12: relocatable
   * via the registry, never hand-pinned.
   */
  hub_url: string;
  /**
   * The hub's leaf-node listen port (e.g. 7422). Carried alongside `hub_url`
   * so the leaf renderer can validate / reconstruct the remote independently
   * of URL parsing.
   */
  leaf_port: number;
  /**
   * Principal ids that are members of this network — the lightweight
   * membership view. Derived from the roster (implicit membership via announced
   * capabilities), not stored on the network record.
   */
  members: string[];
}

/**
 * S2.5 (#745) — the stored network-topology record backing the descriptor's
 * `hub_url` + `leaf_port`. Seeded at the STORE level by an admin (deploy-time
 * seed script / direct D1 write), NOT via a public HTTP route — an
 * unauthenticated write that the registry then signs would defeat DD-9
 * (descriptor poisoning → federation MITM). Read by `GET /networks/{id}`.
 * `members[]` is NOT stored here — it is derived from the principal roster at
 * descriptor-read time.
 */
export interface NetworkRecord {
  network_id: string;
  /** The hub's leaf-node dial URL. */
  hub_url: string;
  /** The hub's leaf-node listen port. */
  leaf_port: number;
  /** ISO-8601 UTC; when the topology was last (re-)seeded. */
  updated_at: string;
}

/**
 * A capability search hit. `GET /capabilities?query=foo` returns the
 * matching capability ids alongside the principal that announced
 * them. The caller resolves principal → pubkey via a follow-up
 * `GET /principals/{principal_id}` if they need the chain.
 */
export interface CapabilityHit {
  capability_id: string;
  principal_id: string;
  networks: string[];
  description?: string;
}

// =============================================================================
// O-4a.1 — Issuance-request state machine types
// =============================================================================

/**
 * The lifecycle status of an issuance request.
 * Transitions: PENDING → GRANTED (on admin grant)
 *              PENDING → REJECTED (on admin reject)
 * Re-transitions are forbidden (409 already_decided).
 */
export type IssuanceStatus = "PENDING" | "GRANTED" | "REJECTED";

/**
 * A persisted issuance request — the metadata record that a verified
 * registration creates. No secrets; no credentials. The `leaf_package`
 * column is the O-4a.2 seam (always null in O-4a.1).
 */
export interface IssuanceRequest {
  /** Opaque hex UUID, URL-safe. Primary key. */
  request_id: string;
  /** The principal that registered and triggered this request. */
  principal_id: string;
  /**
   * Base64 Ed25519 pubkey of the peer stack being onboarded.
   * The (principal_id, peer_pubkey) pair is unique — re-registration
   * returns the existing row rather than inserting a duplicate.
   */
  peer_pubkey: string;
  /**
   * The NATS subject scope the peer is requesting,
   * e.g. `federated.<peer_slug>.>`.
   */
  requested_scope: string;
  /** Current lifecycle state. */
  status: IssuanceStatus;
  /** ISO-8601 UTC; when the request was first created. */
  created_at: string;
  /** ISO-8601 UTC; updated on grant/reject. */
  updated_at: string;
  /**
   * The admin pubkey (base64) that granted or rejected this request.
   * Null while PENDING.
   */
  granted_by: string | null;
  /**
   * O-4a.2 seam: JSON blob of the issued leaf credential package.
   * Always null in O-4a.1; populated by the next slice.
   */
  leaf_package: string | null;
}

/**
 * The admin-signed claim carried by
 * `POST /issuance-requests/{request_id}/grant` and `/reject`.
 *
 * Mirrors `NetworkCreateClaim` in structure so the admin gate can be
 * reused verbatim: admin signs canonicalJSON(claim); registry verifies
 * the signature against claim.admin_pubkey and checks the allowlist.
 */
export interface IssuanceDecisionClaim {
  /** Must equal the URL path parameter. Echoed for canonicalisation. */
  request_id: string;
  /** The decision: "grant" or "reject". Part of the signed payload. */
  decision: "grant" | "reject";
  /** Base64 Ed25519 pubkey of the admin signing this claim. */
  admin_pubkey: string;
  /** ISO-8601 UTC timestamp at which the admin signed this claim. */
  issued_at: string;
  /** Random nonce to prevent replay (same replay cache as network-create). */
  nonce: string;
}

/** On-wire envelope for a grant/reject decision. */
export interface SignedIssuanceDecision {
  claim: IssuanceDecisionClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * The admin-signed claim carried by GET /issuance-requests reads.
 * The GET endpoints are operational metadata; we gate them behind
 * an admin signature sent via `x-admin-signed` header. This prevents
 * any unauthenticated enumeration of the onboarding queue.
 *
 * A lightweight claim (no nonce/replay check — reads are idempotent
 * and don't mutate state). Clock-skew check applies to prevent stale
 * tokens lingering. The admin proves allowlisted possession.
 */
export interface IssuanceReadClaim {
  /** The admin's own pubkey — used for allowlist check. */
  admin_pubkey: string;
  /** ISO-8601 UTC; within the CLOCK_SKEW_MS window. */
  issued_at: string;
}

/** On-wire envelope for an admin read authorisation. */
export interface SignedIssuanceRead {
  claim: IssuanceReadClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}
