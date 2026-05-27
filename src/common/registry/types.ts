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
 * the two is a bug. When the registry's payload shape changes, this
 * file moves first, then the service.
 *
 * TODO: a single shared `@cortex/registry-types` package would
 * eliminate the redeclaration but is over-scoped for D.4.3.
 */

/**
 * A single stack identity belonging to an operator. Mirrors
 * `StackIdentity` on the producer side.
 */
export interface StackIdentity {
  /** `{operator_id}/{stack_slug}` — slash-delimited. */
  stack_id: string;
  display_name?: string;
  metadata?: Record<string, string>;
}

/**
 * A capability the operator advertises across the federation. Mirrors
 * `Capability` on the producer side.
 */
export interface Capability {
  id: string;
  description?: string;
  networks?: string[];
}

/**
 * The view of an operator returned by `GET /operators/{operator_id}`.
 * Mirrors `OperatorRecord` on the producer side.
 *
 * `operator_pubkey` is base64-encoded Ed25519 (32 raw bytes → 44 chars
 * including padding). This is distinct from the NATS NKey format used
 * by the static `policy.federated.networks[].peers[].operator_pubkey`
 * field in cortex.yaml — D.4.3 introduces this second format as the
 * registry-resolved alternative. Phase-B caveat: the surface-router's
 * NKey-based verification path is unchanged; D.4.3 only populates a
 * cache; consumers wanting registry-resolved verification must opt in
 * by reading from this client instead of the static peer list.
 */
export interface OperatorRecord {
  operator_id: string;
  /** Base64 Ed25519 pubkey (32 raw bytes, 44 chars w/ padding). */
  operator_pubkey: string;
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
   * `policy.federated.networks[].peers[].operator_id` (de-duplicated;
   * wire field stays `operator_id` until PR-R7c-network-registry
   * renames the registry service).
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
   * Return the cached `OperatorRecord` for `principalId`, or
   * `undefined` if the principal is unknown, the cache is empty, the
   * last fetch failed, or the signature did not verify.
   *
   * The return type stays `OperatorRecord` until PR-R7c-network-registry
   * renames the registry service's wire-shape symbol.
   *
   * Never throws — federation failures must not crash the rest of
   * cortex. All error paths log via `logError` and return
   * `undefined`.
   */
  getPrincipal(principalId: string): OperatorRecord | undefined;
}
