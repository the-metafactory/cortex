/**
 * IAW Phase D.4.3 — Cortex-side RegistryClient public types.
 *
 * These shapes are the wire contract between cortex and the
 * cortex-network-registry service (`src/services/network-registry/`).
 * Deliberately re-declared on the client side rather than imported
 * from the service: the registry is a deployable artefact that runs
 * on Cloudflare Workers, with its own `package.json` and tsconfig;
 * sharing TypeScript types across the boundary would couple the
 * cortex bot to a sibling deploy target and force us to keep their
 * dependency graphs aligned.
 *
 * The shapes below are structurally compatible with the producer
 * types in `src/services/network-registry/src/types.ts` — that file
 * remains the source of truth for the schema, and any drift between
 * the two is a bug. When the registry's payload shape changes, the
 * service moves first, then this file follows.
 *
 * TODO: a single shared `@cortex/registry-types` package would
 * eliminate the redeclaration but is over-scoped for D.4.3.
 */

/**
 * A single stack identity belonging to a principal. Mirrors
 * `StackIdentity` on the producer side.
 */
export interface StackIdentity {
  /** `{principal_id}/{stack_slug}` — slash-delimited. */
  stack_id: string;
  display_name?: string;
  metadata?: Record<string, string>;
}

/**
 * A capability the principal advertises across the federation. Mirrors
 * `Capability` on the producer side.
 */
export interface Capability {
  id: string;
  description?: string;
  networks?: string[];
}

/**
 * The view of a principal returned by `GET /principals/{principal_id}`.
 * Mirrors `PrincipalRecord` on the producer side.
 *
 * `principal_pubkey` is base64-encoded Ed25519 (32 raw bytes → 44 chars
 * including padding). This is distinct from the NATS NKey format used
 * by the static `policy.federated.networks[].peers[].principal_pubkey`
 * field in cortex.yaml — D.4.3 introduces this second format as the
 * registry-resolved alternative. Phase-B caveat: the surface-router's
 * NKey-based verification path is unchanged; D.4.3 only populates a
 * cache; consumers wanting registry-resolved verification must opt in
 * by reading from this client instead of the static peer list.
 */
export interface PrincipalRecord {
  principal_id: string;
  /** Base64 Ed25519 pubkey (32 raw bytes, 44 chars w/ padding). */
  principal_pubkey: string;
  stacks: StackIdentity[];
  capabilities: Capability[];
  updated_at: string;
}

/**
 * Registry-signed wrapper around any GET payload. The signature
 * covers `canonicalJSON({ payload, issued_at, registry })`. The
 * client verifies against the pinned registry pubkey before
 * trusting `payload`. Mirrors `SignedAssertion<T>` on the producer
 * side.
 *
 * `registry === "unconfigured"` is a sentinel the service returns
 * when it has no signing key provisioned. The client always treats
 * unconfigured assertions as untrusted (no signature path can verify
 * a sentinel value).
 */
export interface SignedAssertion<T> {
  payload: T;
  issued_at: string;
  /** Base64 registry pubkey, or `"unconfigured"` in dev. */
  registry: string;
  /** Base64 Ed25519 signature. Empty string when unconfigured. */
  signature: string;
}

/**
 * Response shape of `GET /registry/pubkey`. Mirrors what the service
 * emits at `src/services/network-registry/src/index.ts`.
 */
export interface RegistryPubkeyResponse {
  algorithm: "Ed25519";
  public_key: string;
}

/**
 * S1 (Network Join Control Plane, #735) — the network **descriptor** payload
 * carried by `GET /networks/{network_id}` inside a `SignedAssertion`.
 *
 * **DD-12 (hub via registry-served descriptor).** The hub's reachability
 * (`hub_url` + `leaf_port`) is served by the registry, NOT pinned in each
 * peer's local config, so the hub can relocate without every peer
 * re-editing `cortex.yaml`. The join command (S4) and the leaf renderer
 * (S3) derive the nats-server leaf remote from this descriptor.
 *
 * Like every registry GET, the descriptor is wrapped in a
 * `SignedAssertion<NetworkDescriptor>` and verified against the pinned
 * registry pubkey before it is trusted (DD-9).
 *
 * NOTE: at S1 the server-side `GET /networks/{id}` route is not yet
 * implemented (the registry currently serves only `/roster`); the client +
 * its stub tests land first per the epic's phasing. The shape below is the
 * client's contract for that route and the source of truth the S3/S4 server
 * work targets.
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
   * Principal ids that are members of this network. The lightweight
   * membership view on the descriptor; the full per-peer roster (with
   * pubkeys + stacks) comes from `GET /networks/{id}/roster`.
   */
  members: string[];
  /**
   * G1a (cortex#1117) — the hub's NSC account public key (nkey-U, `A…`).
   * OPTIONAL: absent means "no cross-account wiring needed" (Case A —
   * hub and leaf share the same NSC account). When present, the joining stack uses this to
   * configure the cross-account nats export/import (G1c, future slice).
   * Grammar: `/^A[A-Z2-7]{55}$/` — same as the O-4b leaf-package `account`.
   * Carried inside the signed assertion so tampering invalidates the
   * registry signature (DD-9). The service-side `NetworkDescriptor` is the
   * source of truth; this field mirrors it.
   */
  hub_account?: string;
}

/**
 * S1 (#735) — a single peer entry in a network roster as consumed by the
 * cortex client. Mirrors one element of the service-side `NetworkRoster.
 * members[]` (`src/services/network-registry/src/types.ts`), narrowed to the
 * fields the join/resolve path needs: who the peer is (`principal_id`), which
 * stack carries its signing identity (`stack_id`), and the verified Ed25519
 * pubkey to anchor trust against (`principal_pubkey`, base64 raw — DD-8
 * translates to nkey-U at the config surface).
 *
 * `stack_id` is OPTIONAL: the registry's roster route derives membership from
 * announced capabilities and does not always carry a stack id per member at
 * S1. When absent, S2's resolver falls back to the principal's first
 * registered stack via `GET /principals/{id}`.
 */
export interface NetworkRosterPeer {
  /** Peer principal id — letter-prefixed lowercase-alphanumeric + hyphen. */
  principal_id: string;
  /** `{principal_id}/{stack_slug}` — the peer's signing stack, when known. */
  stack_id?: string;
  /** Base64 Ed25519 pubkey (32 raw bytes → 44 chars w/ padding). */
  principal_pubkey: string;
}

/**
 * S1 (#735) — the roster payload carried by `GET /networks/{network_id}/roster`
 * inside a `SignedAssertion<NetworkRosterResult>`. Mirrors the service-side
 * `NetworkRoster` shape; `members[]` is narrowed to {@link NetworkRosterPeer}.
 */
export interface NetworkRosterResult {
  network_id: string;
  members: NetworkRosterPeer[];
}

/**
 * Configuration for `RegistryClient`. The required fields are the
 * registry URL and the list of peer principal ids to track; everything
 * else has a sensible default. Tests supply `fetch` + `setTimer` to
 * inject a fake transport + timer without real I/O.
 */
export interface RegistryClientOptions {
  /** Registry base URL. Trailing `/` is normalised away. */
  url: string;
  /**
   * Pinned registry pubkey (base64 Ed25519, 44 chars w/ padding).
   * If absent, the client performs TOFU at `start()` time and pins
   * whatever the registry returns at `/registry/pubkey`. The
   * Phase-B caveat is that the TOFU window is exactly the first
   * `GET /registry/pubkey` call against an unknown registry.
   */
  pubkey?: string;
  /**
   * Principal ids the client should track. Populated at boot from
   * `policy.federated.networks[].peers[].principal_id` (de-duplicated).
   * Empty list means the client starts dormant — no refresh cycles,
   * `getPrincipal()` always returns undefined.
   */
  principalIds: string[];
  /**
   * Refresh interval in milliseconds. Default 5 minutes — long enough
   * to be polite to the registry, short enough that a publish becomes
   * visible network-wide within one minute on average. Set to 0 to
   * disable the background refresh entirely (useful for tests that
   * drive the cycle manually).
   */
  refreshIntervalMs?: number;
  /**
   * Per-request timeout in milliseconds. Default 10 seconds. Wraps
   * each `fetch()` call via AbortController so a hung registry
   * doesn't stall the refresh cycle.
   */
  requestTimeoutMs?: number;
  /**
   * `fetch` implementation. Defaults to `globalThis.fetch`. Tests
   * inject a fake here.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Logger seam — defaults to writing to `process.stderr` per
   * CLAUDE.md "no empty catches" rule. Tests inject a no-op or a
   * spy.
   */
  logError?: (msg: string) => void;
}

/**
 * Subset of `RegistryClient` exposed to the rest of cortex. The
 * implementation has more surface area (start/stop lifecycle, manual
 * refresh seam for tests), but consumers should program against this
 * interface.
 */
export interface RegistryClientReader {
  /**
   * Return the cached `PrincipalRecord` for `principalId`, or
   * `undefined` if the principal is unknown, the cache is empty, the
   * last fetch failed, or the signature did not verify.
   *
   * Never throws — federation failures must not crash the rest of
   * cortex. All error paths log via `logError` and return
   * `undefined`.
   */
  getPrincipal(principalId: string): PrincipalRecord | undefined;
}
