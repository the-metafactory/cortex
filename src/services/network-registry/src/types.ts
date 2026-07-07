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
  /**
   * C-1351 Slice 2 (#1351) — decommission TOMBSTONE. ISO-8601 UTC timestamp
   * stamped by `POST /principals/:id/stacks/retire` when this stack is retired.
   *
   * A retired stack is a DIRECTORY tombstone: the entry STAYS in the record
   * (history is preserved and `GET /principals/:id` still returns it), but every
   * consumer that treats `stacks[]` as the LIVE set MUST filter
   * `retired_at === undefined`. In particular a retired stack's `stack_pubkey`
   * is no longer served as an active verification key (`resolve-pubkey.ts`
   * falls back to the root, so an envelope from the retired stack fails to
   * verify). `undefined`/absent means the stack is live.
   *
   * No migration: stacks live inside the `principals.stacks` JSON column, so a
   * new optional field is a pure additive shape change — a pre-1351 record
   * simply carries no `retired_at` on any entry (⇒ all live).
   */
  retired_at?: string;
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
   * ADR-0018 Gap-A — the target network this registration is requesting
   * admission into. When present, the register hook stamps it onto the PENDING
   * admission request so the idempotency key becomes
   * `(principal_id, peer_pubkey, network_id)` — a stack can request admission to
   * two networks without the second register colliding with the first.
   *
   * OPTIONAL: a registration that names no network (a plain identity register,
   * not a join) creates a network-less PENDING row (`network_id = null`). Part
   * of the SIGNED canonical claim — a MITM cannot strip or forge the target
   * network, so admission is always pinned to the network the joiner named.
   */
  network_id?: string;
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
    /**
     * FLG-4 (cortex, docs/plan-mc-future-state.md §4.D) — the OPTIONAL roster
     * lifecycle facets the MC roster glass surfaces per member. ADDITIVE: a
     * pre-FLG-4 consumer ignores them; the cortex member-read provider
     * (`admission-rows-member-provider.ts`) parses them when present, else
     * defaults to honest absence. NONE are secret material:
     *
     *  - `admission_state` — the row's `AdmissionStatus` (the member-read serves
     *    the ADMITTED roster, so this is `"ADMITTED"` here; the field exists so
     *    an admin-list read can reuse the same shape for former members).
     *  - `sealed` — whether a sealed leaf secret has been DELIVERED
     *    (`sealed_secret !== null`). A boolean signal ONLY — never the ciphertext.
     *  - `hub_authorized_at` — the cortex#1498 hub-authorize timestamp, or null.
     */
    admission_state?: AdmissionStatus;
    sealed?: boolean;
    hub_authorized_at?: string | null;
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
  /**
   * #1598 — hub-mode attestation (`operator` | `simple`), passed through from
   * the admin-seeded {@link NetworkRecord}. Registry-SIGNED with the rest of
   * the descriptor, so the admit-side mode branch and the member-side
   * payload-type expectation read a verified value. Absent on unattested
   * (legacy) rows.
   */
  hub_mode?: "operator" | "simple";
  /** #1598 / design §5.1 — resolver-mode attestation for an operator hub. */
  resolver_mode?: "nats" | "memory";
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
  /**
   * #1321 — this network's admin allowlist: comma-separated base64 Ed25519
   * pubkeys authorized to admit/reject onto THIS network's roster and to update
   * its topology (the **Network posture (admin vs member)** concept, CONTEXT.md
   * §Network posture, encoded into the schema). Format mirrors the global
   * `REGISTRY_ADMIN_PUBKEYS` env var. `undefined`/empty means "global
   * `REGISTRY_ADMIN_PUBKEYS` only" — the `metafactory` bootstrap case. Only a
   * GLOBAL admin may set or change this field (anti-self-escalation). It is NOT
   * exposed in {@link NetworkDescriptor} (kept off the public descriptor; MC
   * posture rendering is a follow-up).
   */
  admin_pubkeys?: string;
  /**
   * #1598 — hub-mode attestation (`operator` | `simple`). Written only through
   * the signed-admin create/update route; exposed on the signed descriptor.
   * Absent = unattested (legacy rows).
   */
  hub_mode?: "operator" | "simple";
  /** #1598 / design §5.1 — resolver-mode attestation for an operator hub. */
  resolver_mode?: "nats" | "memory";
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
// ADR-0015 — Network-admission gate types
//
// The O-4a issuance-request state machine is repurposed as the
// NETWORK-ADMISSION gate (ADR-0015). It gates roster membership, mints
// nothing. The `register → PENDING → admit` flow is unchanged structurally;
// only the vocabulary and the payload (no leaf package) change.
// =============================================================================

/**
 * The lifecycle status of a network admission request.
 * Transitions: PENDING  → ADMITTED (on registry-admin admit/grant)
 *              PENDING  → REJECTED (on registry-admin reject)
 *              ADMITTED → REVOKED  (ADR-0018 Q6 — hub-admin `revoke-member`:
 *                                   the member's hub `authorization` user is
 *                                   dropped + the hub reloaded, cutting
 *                                   transport, and the row is marked REVOKED so
 *                                   the roster + the member PoP-read both stop
 *                                   serving it).
 * Re-transitions out of a decided state are forbidden (409 already_decided);
 * REVOKED is the one transition OUT of ADMITTED (and is itself terminal).
 */
export type AdmissionStatus = "PENDING" | "ADMITTED" | "REJECTED" | "REVOKED" | "DEPARTED";

/**
 * A persisted admission request — the metadata record that a verified
 * registration creates. No secrets; no credentials; mints nothing.
 * The gate controls roster membership for the target network.
 */
export interface AdmissionRequest {
  /** Opaque hex UUID, URL-safe. Primary key. */
  request_id: string;
  /** The principal requesting admission. */
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
  /**
   * The target network id for this admission request.
   * Null for rows migrated from the pre-ADR-0015 issuance_requests table;
   * new rows always carry the network id.
   */
  network_id: string | null;
  /** Current lifecycle state. */
  status: AdmissionStatus;
  /** ISO-8601 UTC; when the request was first created. */
  created_at: string;
  /** ISO-8601 UTC; updated on admit/reject. */
  updated_at: string;
  /**
   * The admin pubkey (base64) that admitted or rejected this request.
   * Null while PENDING.
   */
  granted_by: string | null;
  /**
   * ADR-0018 Q1 (b′) — the per-member secret(s), sealed to THIS member's
   * registered ed25519 pubkey (libsodium `crypto_box_seal`, via
   * {@link sealToPrincipal}). The registry only ever carries the OPAQUE
   * ciphertext — it cannot read it, so the "registry holds no readable secret"
   * invariant survives (it holds a blob the way it already holds opaque
   * pubkeys). NULL until the hub-admin `cortex network secret add-member`
   * delivers it (sealed mode), and NULL again after `revoke-member`.
   *
   * The leaf PSK rides here now (PR5b). The per-network M3 payload key (#1246,
   * not yet merged) rides the SAME slot later — the seal carries a small JSON
   * envelope so a second sealed blob (the payload key) can be added without a
   * schema change. The registry never interprets the bytes either way.
   */
  sealed_secret: string | null;
  /**
   * cortex#1498 (epic #1479 follow-up) — ISO-8601 UTC timestamp the HUB OWNER
   * stamps (via `cortex network authorize`, hub-admin authority — the SAME
   * authority as {@link sealed_secret}'s delivery, ADR-0018 Q5) once they have
   * applied this member's leaf `authorization` entry on their OWN hub
   * nats-server config (the #1481 hub-owner artifact). This is the real signal
   * the guided-join handoff's hub-authorize leg reads (`cortex network handoff
   * status` / `join --guided`) — replacing the honor-system
   * `--hub-authorized-confirmed` attestation with a registry-backed fact. NULL
   * until authorized; cleared back to NULL on `revoke`/`depart` (a revoked or
   * departed member is no longer authorized).
   */
  hub_authorized_at: string | null;
}

/**
 * The admin-signed claim carried by
 * `POST /admission-requests/{request_id}/admit` and `/reject`.
 *
 * Mirrors `NetworkCreateClaim` in structure so the admin gate can be
 * reused verbatim: admin signs canonicalJSON(claim); registry verifies
 * the signature against claim.admin_pubkey and checks the allowlist.
 */
export interface AdmissionDecisionClaim {
  /** Must equal the URL path parameter. Echoed for canonicalisation. */
  request_id: string;
  /** The decision: "admit" or "reject". Part of the signed payload. */
  decision: "admit" | "reject";
  /** Base64 Ed25519 pubkey of the admin signing this claim. */
  admin_pubkey: string;
  /** ISO-8601 UTC timestamp at which the admin signed this claim. */
  issued_at: string;
  /** Random nonce to prevent replay (same replay cache as network-create). */
  nonce: string;
}

/** On-wire envelope for an admit/reject decision. */
export interface SignedAdmissionDecision {
  claim: AdmissionDecisionClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * The admin-signed claim carried by GET /admission-requests reads.
 * The GET endpoints are operational metadata; we gate them behind
 * an admin signature sent via `x-admin-signed` header. This prevents
 * any unauthenticated enumeration of the onboarding queue.
 *
 * A lightweight claim (no nonce/replay check — reads are idempotent
 * and don't mutate state). Clock-skew check applies to prevent stale
 * tokens lingering. The admin proves allowlisted possession.
 */
export interface AdmissionReadClaim {
  /** The admin's own pubkey — used for allowlist check. */
  admin_pubkey: string;
  /**
   * FND-5 (ADR-0020 §4 read-scoping) — OPTIONAL network scope, bound INTO the
   * signed claim so a token minted for network A cannot be replayed to read
   * network B.
   *
   * Authorization + scoping (fail-closed, enforced in the read gate):
   *   - PER-NETWORK admin → MUST name a network they administer; the read is
   *     FORCED to that network's rows only. Naming a network they do NOT
   *     administer (or omitting it) ⇒ 403. This is the security-critical
   *     property: a per-network admin can never read another network's rows.
   *   - GLOBAL admin (`REGISTRY_ADMIN_PUBKEYS`) → MAY name a network to narrow
   *     the result, or OMIT it to read ALL networks (backward-compatible with
   *     the pre-FND-5 global-only read).
   */
  network_id?: string;
  /** ISO-8601 UTC; within the CLOCK_SKEW_MS window. */
  issued_at: string;
}

/** On-wire envelope for an admin read authorisation. */
export interface SignedAdmissionRead {
  claim: AdmissionReadClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * ADR-0018 Q4 (Gap-C) — the member proof-of-possession read claim carried by
 * `GET /admission-requests/mine`.
 *
 * Unlike the admin read claim, this is signed by the MEMBER's own registered
 * key — the signature over `canonicalJSON(claim)` against `peer_pubkey` IS the
 * authorization (no admin key, no allowlist). A caller learns ONLY the
 * admission rows belonging to the key they can prove possession of: the route
 * returns the rows whose `peer_pubkey` equals the (verified) claimed pubkey.
 *
 * No nonce (reads are idempotent); clock-skew applies to stop a captured token
 * being replayed indefinitely. Signed-read so an unauthenticated caller leaks
 * no metadata about the onboarding queue.
 */
export interface AdmissionMineReadClaim {
  /**
   * The principal the caller is asking about. Echoed into the signed claim for
   * canonicalisation/audit only — the route does NOT cross-check it against the
   * returned rows. The sole authority is the signature over `peer_pubkey`: the
   * route queries by the verified `peer_pubkey` (`listIssuanceRequestsByPeer`),
   * so the released rows are exactly those owned by the proven key regardless of
   * this field's value.
   */
  principal_id: string;
  /**
   * The member's registered Ed25519 pubkey (base64). The claim is signed with
   * the matching private key, so verifying the signature against this field
   * proves possession — the rows for this pubkey are released, nothing else.
   */
  peer_pubkey: string;
  /** ISO-8601 UTC; within the CLOCK_SKEW_MS window. */
  issued_at: string;
}

/** On-wire envelope for a member PoP read authorisation. */
export interface SignedAdmissionMineRead {
  claim: AdmissionMineReadClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * C-1282 (ADR-0018 Q4) — the member proof-of-possession read claim carried by
 * `GET /networks/{network_id}/roster/member`.
 *
 * Where {@link AdmissionMineReadClaim} releases a caller's OWN admission rows,
 * this claim releases a NETWORK's ADMITTED peer-roster — but only to a caller
 * who is themselves an ADMITTED member of that network. The signature over
 * `canonicalJSON(claim)` against `peer_pubkey` IS the authorization (no admin
 * key, no allowlist); the route then applies a fail-closed membership gate:
 * the proven pubkey MUST hold an ADMITTED row for `network_id`, else 403. The
 * admitted-peer list is not sensitive to a fellow admitted member (ADR-0018
 * Q4), but a non-member learns nothing.
 *
 * `network_id` is bound INTO the signed claim (not just the path) so the
 * signature is scoped to one network — a token captured for network A cannot
 * be replayed against network B's path. The route rejects a claim whose
 * `network_id` disagrees with the path parameter (400). No nonce (reads are
 * idempotent); clock-skew applies to bound a captured token's lifetime.
 */
export interface NetworkRosterMemberReadClaim {
  /** The network whose ADMITTED roster the caller is requesting. */
  network_id: string;
  /**
   * The caller's registered Ed25519 pubkey (base64). The claim is signed with
   * the matching private key, so verifying the signature against this field
   * proves possession — and the membership gate then checks this pubkey is
   * ADMITTED to `network_id`.
   */
  peer_pubkey: string;
  /** ISO-8601 UTC; within the CLOCK_SKEW_MS window. */
  issued_at: string;
}

/** On-wire envelope for a member network-roster PoP read authorisation. */
export interface SignedNetworkRosterMemberRead {
  claim: NetworkRosterMemberReadClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * ADR-0018 Q1 (b′) / Q5 — the HUB-ADMIN-signed claim carried by
 * `POST /admission-requests/{request_id}/sealed-secret`.
 *
 * Q5 keeps two authorities distinct: the registry-admin signs the admit
 * decision (PENDING → ADMITTED) and MINTS NOTHING; the HUB-ADMIN mints the
 * per-member PSK, writes the hub `authorization` user, and seals the bearer
 * copy. This claim is the second authority's write of that opaque sealed blob
 * onto the ADMITTED row — gated on the hub-admin allowlist
 * (`REGISTRY_HUB_ADMIN_PUBKEYS`, falling back to `REGISTRY_ADMIN_PUBKEYS` when
 * the two authorities collapse into one principal, e.g. metafactory's Luna).
 *
 * The route NEVER mints the secret; it only persists the ciphertext the
 * hub-admin sealed. The registry cannot read it.
 */
export interface SealedSecretWriteClaim {
  /** Must equal the URL path parameter. Echoed for canonicalisation. */
  request_id: string;
  /**
   * The opaque sealed ciphertext (standard base64, `crypto_box_seal`). The
   * registry never decodes/interprets it — it is a blob useless to anyone but
   * the member whose pubkey it was sealed to.
   */
  sealed_secret: string;
  /** Base64 Ed25519 pubkey of the hub-admin signing this claim. */
  hub_admin_pubkey: string;
  /** ISO-8601 UTC timestamp at which the hub-admin signed this claim. */
  issued_at: string;
  /** Random nonce to prevent replay (same replay cache as the admit gate). */
  nonce: string;
}

/** On-wire envelope for a hub-admin sealed-secret write. */
export interface SignedSealedSecretWrite {
  claim: SealedSecretWriteClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * ADR-0018 Q6 — the HUB-ADMIN-signed claim carried by
 * `POST /admission-requests/{request_id}/revoke`.
 *
 * Revoke cuts transport at the hub (the CLI drops the member's `authorization`
 * user + reloads the hub) AND marks the admission row REVOKED so the roster and
 * the member PoP-read both stop serving it. This is the registry-side half of
 * that operation: an ADMITTED → REVOKED transition that also clears the sealed
 * blob. Hub-admin authority (Q5), never the registry-admin admit gate.
 */
export interface AdmissionRevokeClaim {
  /** Must equal the URL path parameter. */
  request_id: string;
  /** Base64 Ed25519 pubkey of the hub-admin signing this claim. */
  hub_admin_pubkey: string;
  /** ISO-8601 UTC timestamp at which the hub-admin signed this claim. */
  issued_at: string;
  /** Random nonce to prevent replay. */
  nonce: string;
}

/** On-wire envelope for a hub-admin revoke. */
export interface SignedAdmissionRevoke {
  claim: AdmissionRevokeClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * cortex#1498 (epic #1479 follow-up) — the HUB-ADMIN-signed claim carried by
 * `POST /admission-requests/{request_id}/authorize`.
 *
 * The counterpart to {@link AdmissionRevokeClaim}: instead of cutting
 * transport, this STAMPS `hub_authorized_at` onto an ADMITTED row once the hub
 * owner has applied the member's leaf `authorization` entry on their OWN hub
 * nats-server config (the #1481 hub-owner artifact). Same authority as
 * {@link SealedSecretWriteClaim} (hub-admin, ADR-0018 Q5) — the registry
 * mints nothing here either; it only records that the hub owner did their
 * part of the 3-leg guided-join handoff (seal → hub-authorize → leaf-up).
 */
export interface HubAuthorizeClaim {
  /** Must equal the URL path parameter. */
  request_id: string;
  /** Base64 Ed25519 pubkey of the hub-admin signing this claim. */
  hub_admin_pubkey: string;
  /** ISO-8601 UTC timestamp at which the hub-admin signed this claim — the
   *  value persisted as {@link AdmissionRequest.hub_authorized_at}. */
  issued_at: string;
  /** Random nonce to prevent replay. */
  nonce: string;
}

/** On-wire envelope for a hub-admin authorize. */
export interface SignedHubAuthorize {
  claim: HubAuthorizeClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * C-1350 Slice 1 (#1350) — the MEMBER-PoP-signed claim carried by
 * `POST /admission-requests/{request_id}/depart`.
 *
 * Where {@link AdmissionRevokeClaim} is the HUB-ADMIN kicking a member
 * (involuntary, ADMITTED → REVOKED), this claim is the MEMBER leaving of their
 * own accord (voluntary, ADMITTED → DEPARTED). The authority model mirrors the
 * `/mine` member PoP-read, promoted to a WRITE: the signature over
 * `canonicalJSON(claim)` against `peer_pubkey` IS the authorization — there is
 * NO admin allowlist on this route. The route additionally enforces
 * own-row-only: the proven `peer_pubkey` MUST equal the target row's stored
 * `peer_pubkey`, else 403 (a member can never depart someone else's row). A
 * `nonce` is bound in (unlike the idempotent `/mine` read) because this is a
 * state-transitioning write — replay protection per the admit/revoke posture.
 */
export interface AdmissionDepartClaim {
  /** Must equal the URL path parameter. */
  request_id: string;
  /**
   * The departing principal id. Echoed into the signed claim for
   * canonicalisation/audit; the sole authority is the signature over
   * `peer_pubkey` + the own-row ownership check (never this field).
   */
  principal_id: string;
  /**
   * The member's registered Ed25519 pubkey (base64). The claim is signed with
   * the matching private key, so verifying the signature against this field
   * proves possession — and the route then requires it to equal the row's
   * stored `peer_pubkey`.
   */
  peer_pubkey: string;
  /** ISO-8601 UTC timestamp at which the member signed this claim. */
  issued_at: string;
  /** Random nonce to prevent replay (state-transitioning write). */
  nonce: string;
}

/** On-wire envelope for a member self-depart. */
export interface SignedAdmissionDepart {
  claim: AdmissionDepartClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * C-1351 Slice 2 (#1351) — the ROOT-KEY-signed claim carried by
 * `POST /principals/:principal_id/stacks/retire`.
 *
 * The DIRECTORY-level decommission tombstone: it retires a stack from a
 * principal's `stacks[]` (excluding it from active resolution while preserving
 * history). Deliberately a DEDICATED route, NOT a register-overwrite — the
 * register route has a load-bearing side effect (it upserts a PENDING admission
 * row), and a deregistration must never touch admission state.
 *
 * Authority = the PRINCIPAL ROOT KEY, exactly like the add-stack path (#791):
 * the route resolves the verification key SERVER-SIDE from the STORED record's
 * `principal_pubkey` (never a pubkey in the claim) and verifies the signature
 * over `canonicalJSON(claim)` against it. A claim signed by a mere stack key —
 * even the retiring stack's own key — fails (401). This is the same root-only
 * authorization model the registry uses for adding a stack: only the holder of
 * the principal root seed can mutate the stack roster.
 *
 * The claim carries NO pubkey — the server resolves it from the record — so a
 * MITM cannot substitute a key it controls (there is nothing on the wire to
 * substitute; tampering any field breaks the signature over the root key).
 */
export interface StackRetireClaim {
  /** Must equal the URL path parameter. Echoed for canonicalisation. */
  principal_id: string;
  /** `{principal_id}/{stack_slug}` — the stack to retire. 404 if not present. */
  stack_id: string;
  /**
   * #825 CAS token — the `updated_at` of the record this claim was computed
   * from (the client's verified pinned read). The route compare-and-sets on it:
   * a mismatch means the record changed since the read → 409 `stale_record`.
   * REQUIRED (every stored principal carries an `updated_at`, and the CLI reads
   * it via a pinned verified fetch before signing). Part of the SIGNED canonical
   * claim — a MITM cannot strip or forge it.
   */
  expected_updated_at: string;
  /** ISO-8601 UTC timestamp at which the principal root signed this claim. */
  issued_at: string;
  /** Random nonce to prevent replay (state-transitioning write). */
  nonce: string;
}

/** On-wire envelope for a stack retire. */
export interface SignedStackRetire {
  claim: StackRetireClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * ADR-0018 Q4 (Gap-C) — one row of the member PoP-read response. The member's
 * own admission request, including the (b′) `sealed_secret` slot.
 *
 * As of PR5b the `sealed_secret` slot is POPULATED by the hub-admin
 * `cortex network secret add-member` (sealed mode) and consumed by
 * `cortex network join` (auto-fetch + unseal). It is part of the base
 * {@link AdmissionRequest} now; this alias is retained as the documented
 * member-read response shape.
 */
export type AdmissionMineRow = AdmissionRequest;

// ---------------------------------------------------------------------------
// Back-compat aliases — store-layer names still reference Issuance* names
// for the underlying D1 table / method vocabulary. These are pure type
// aliases; the wire vocabulary is Admission* only (ADR-0015).
// ---------------------------------------------------------------------------

/** @deprecated Use AdmissionStatus */
export type IssuanceStatus = AdmissionStatus;
/** @deprecated Use AdmissionRequest */
export type IssuanceRequest = AdmissionRequest;
