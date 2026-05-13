/**
 * MIG-7.2b — Trust resolver.
 *
 * Process-wide bidirectional `(platform, platformUserId) ↔ agentId` map. Sits
 * atop the AgentRegistry (MIG-7.2a) — the registry is the authoritative
 * agent source, the resolver layers the platform-id mapping on top.
 *
 * Architecture §9.3 ("Coupling discipline"):
 *
 *   > Cross-agent trust resolves at adapter startup: each presence adapter,
 *   > on connect, learns its own platform user id (e.g. `discord.client.user.id`)
 *   > and registers it in a process-wide `(platformId → agentId)` map. When
 *   > an inbound message arrives from a known platform id, the receiving
 *   > adapter looks up the source agent and consults its parent's `trust:` list.
 *
 * This module owns that map. It replaces grove-v2's hand-maintained
 * `trustedAgentBots` list (an array of platform user ids that the operator
 * manually kept in sync). The resolver builds the equivalent state from
 * adapter-connect-time registrations — no manual sync, no drift.
 *
 * ## Lifecycle
 *
 *   1. Cortex boot:        `new TrustResolver(registry)`  (no platform IDs yet)
 *   2. Discord adapter for Luna connects:
 *                          `resolver.register("discord", "1487...", "luna")`
 *   3. Inbound message from `1487...`:
 *                          `resolver.lookupAgentByPlatformId("discord", "1487...")`
 *                          → returns the Luna Agent
 *   4. Receiving adapter (Echo) checks trust:
 *                          `resolver.trustsByPlatformId("echo", "discord", "1487...")`
 *                          → true iff echo.trust includes luna
 *   5. Discord adapter for Luna disconnects:
 *                          `resolver.unregister("discord", "1487...")`
 *
 * ## Invariants
 *
 *   - A given `(platform, platformId)` maps to **at most one** agent at a
 *     time. Re-registering the same pair to a different agent throws
 *     `PlatformIdAlreadyRegisteredError` so a misconfigured presence
 *     adapter doesn't silently steal another agent's identity.
 *   - An agent can have multiple platform identities (e.g. Discord +
 *     Mattermost simultaneously). The reverse index `agentId →
 *     Set<{platform, platformId}>` carries them all.
 *   - `register` requires the target agent id to be a known agent in the
 *     backing registry. Unknown ids throw — fail-closed per §9.3 ("A
 *     presence adapter MUST refuse to start if its parent agent's id is
 *     missing from the registry").
 *
 * ## NOT in scope for 7.2b
 *
 *   - Adapter refactor — `DiscordPresenceAdapter(agent, presence)` lands at
 *     MIG-7.2c. The resolver is callable by today's adapters via a shim if
 *     useful, but the new constructor shape isn't enforced here.
 *   - Persistence — the resolver is in-memory. Cortex restart re-registers
 *     all platform ids when adapters reconnect; there's no SQLite-backed
 *     cache. (If reconnect storms become a problem post-MIG-7, revisit.)
 *   - Cross-process state — single-process only. Multi-shard cortex isn't a
 *     v1 concern.
 */

import { decode, type User } from "@nats-io/jwt";
import { fromPublic } from "@nats-io/nkeys";

import type { Agent } from "../types/cortex-config";
import { AgentNotFoundError, AgentRegistry } from "./registry";

// =============================================================================
// Public types
// =============================================================================

/**
 * Known platform names. Constrained to the platforms cortex actually supports
 * — adding a new platform requires adding the value here AND a presence-block
 * variant in `cortex-config.ts`.
 */
export type Platform = "discord" | "mattermost";

/** A `(platform, platformId)` pair that uniquely identifies a connected presence. */
export interface PlatformIdentity {
  readonly platform: Platform;
  readonly platformId: string;
}

// =============================================================================
// Operator-signature verification (cortex#76)
// =============================================================================

/**
 * Options for an operator-aware `TrustResolver`. Optional — when omitted, the
 * resolver behaves as the pre-cortex#76 platform-identity map and the
 * operator-verification methods throw `OperatorVerifierNotConfiguredError`.
 *
 * The operator account signing public key (`A…` prefix) is the trust anchor:
 * every NATS user JWT minted by `mintUserCreds()` carries this pubkey in its
 * `iss` claim. A request is "operator-trusted" iff its user JWT chains to
 * this pubkey AND the request payload is signed by the user nkey that owns
 * the JWT's `sub` claim.
 */
export interface TrustResolverOptions {
  /**
   * Operator account signing public key (`A…`). Pass `keyPair.getPublicKey()`
   * from the result of `loadAccountSigningKey()` in `cortex.ts`. The pubkey
   * is public material — safe to log, safe to embed in config diagnostics.
   *
   * NOT the seed. NOT the keypair. Just the public key string. The verifier
   * never needs signing material — verification is one-way.
   */
  operatorAccountSigningPublicKey?: string;

  /**
   * Optional clock-skew tolerance (seconds) for `exp` / `nbf` JWT claims and
   * for `ts` on signed-request envelopes. Defaults to 60s. Set higher for
   * test rigs running with deliberately divergent clocks; set to 0 for the
   * strictest production posture.
   */
  clockSkewToleranceSec?: number;

  /**
   * Optional max age (seconds) for signed-request `ts` — defends against
   * replay of a captured envelope long after the fact. Defaults to 300s
   * (5 minutes). The user nkey signature alone has no built-in freshness
   * guarantee, so the verifier enforces this at the envelope layer.
   */
  signedRequestMaxAgeSec?: number;
}

/**
 * Default tolerances. Exported so consumers can match production policy in
 * out-of-band scripts (e.g. a `cortex trust verify --jwt …` debug command).
 */
export const DEFAULT_CLOCK_SKEW_SEC = 60;
export const DEFAULT_SIGNED_REQUEST_MAX_AGE_SEC = 300;

/**
 * A signed NATS request envelope. The shape composes with `mintUserCreds()`:
 *
 *   - `userJwt` is the JWT minted for the requesting agent (the `userJwt`
 *     field returned by `mintUserCreds`). It carries the user's nkey
 *     pubkey in `sub` and the operator account signing pubkey in `iss`.
 *   - `subject` is the NATS subject the request is published on. Bound into
 *     the canonical form so a captured signature can't be replayed against
 *     a different subject (e.g. lift a `creds.issue` signature and aim it
 *     at `creds.rotate`).
 *   - `nonce` is a fresh, per-request random token. Bound into the canonical
 *     form to defend against in-window replays. The verifier itself does
 *     not maintain a nonce-seen cache — that's the caller's responsibility
 *     if they want at-most-once semantics. The nonce is here so a future
 *     cache CAN exist; today's value-add is preventing identical-payload
 *     in-window replays from being byte-identical envelopes.
 *   - `ts` is an ISO-8601 timestamp. Bound into the canonical form AND
 *     checked against `signedRequestMaxAgeSec` for replay defence.
 *   - `payload` is the request body (verb + args, etc.). Arbitrary JSON.
 *     Canonicalised via `JSON.stringify(payload)` — callers are responsible
 *     for ensuring stable key order if their payloads contain objects whose
 *     key order varies across runtimes. For the cortex#75 use case (CredsRequest)
 *     payloads are flat `{verb, agent_id}` so this is not a concern.
 *     Note: `JSON.stringify(payload)` is non-deterministic for nested objects
 *     across runtimes (key ordering, number representation, whitespace).
 *     Safe for the current flat key-value payload shape. If payload shape ever
 *     grows to nested objects, either restrict the shape at the transport
 *     layer or swap in a deterministic canonicaliser (e.g. RFC 8785 JCS) at
 *     `canonicalSignedRequestBytes` — but do it in lock-step with all
 *     producers, since the producer and verifier MUST agree byte-for-byte.
 *   - `signature` is base64url of the ed25519 signature over the canonical
 *     bytes, produced by the user's nkey via `KeyPair.sign(bytes)`.
 *
 * # Why this shape vs. pure NATS-level auth?
 *
 * NATS authenticates the connection via the user JWT at CONNECT time. The
 * server enforces subject permissions baked into the JWT. That's sufficient
 * if the application trusts the NATS server to relay the connection identity
 * faithfully. But cortex's threat model assumes the NATS server is a
 * separate trust domain (operator may run NATS managed by Synadia, etc.) —
 * so the verifier re-establishes identity end-to-end at the application
 * layer. The signature over the canonical form gives the application
 * cryptographic proof of producer identity per request, not just per
 * connection.
 */
export interface SignedRequest {
  readonly subject: string;
  readonly userJwt: string;
  readonly nonce: string;
  readonly ts: string;
  readonly payload: unknown;
  /** Base64url-encoded ed25519 signature over `canonicalSignedRequestBytes`. */
  readonly signature: string;
}

/**
 * Outcome of a verification attempt. Discriminated on `ok` so callers can
 * branch on the failure reason without parsing strings. The structured
 * `reason` lets the consumer (e.g. cortex#75's NATS transport gate) log /
 * meter the failure class without surfacing it back to the requesting bot
 * (which would leak verifier internals).
 */
export type OperatorVerificationResult =
  | { ok: true; userPublicKey: string; agentName: string }
  | { ok: false; reason: OperatorVerificationFailure; detail: string };

export type OperatorVerificationFailure =
  | "malformed_jwt"
  | "wrong_issuer"
  | "expired"
  | "not_yet_valid"
  | "malformed_envelope"
  | "subject_mismatch"
  | "ts_out_of_range"
  | "malformed_signature"
  | "signature_invalid";

/**
 * Thrown when an operator-verification method is called on a `TrustResolver`
 * built without an `operatorAccountSigningPublicKey`. Lets the consumer fail
 * fast with a clear message rather than silently rejecting every request.
 */
export class OperatorVerifierNotConfiguredError extends Error {
  constructor() {
    super(
      "TrustResolver.verifyOperatorSignature called but no operatorAccountSigningPublicKey " +
        "was supplied at construction. Pass options.operatorAccountSigningPublicKey " +
        "(e.g. accountSigningKey.getPublicKey() from loadAccountSigningKey) when " +
        "instantiating the resolver if you intend to verify operator-signed requests.",
    );
    this.name = "OperatorVerifierNotConfiguredError";
  }
}

/**
 * Build the canonical byte-string that the user nkey signs. The format is a
 * deliberately simple newline-separated tuple of subject, nonce, ts, and
 * `JSON.stringify(payload)`. Newline separators are safe because subject /
 * nonce / ts are all token-shaped (no literal newlines), and `JSON.stringify`
 * never emits a bare newline.
 *
 * Exported so the matching `signSignedRequest` helper (and tests, and any
 * future producer in cortex#75) computes IDENTICAL bytes — there must be
 * exactly one canonical form in the codebase or signatures will silently
 * mismatch.
 *
 * Determinism caveat: `JSON.stringify(payload)` is NOT guaranteed
 * byte-identical across runtimes for nested objects — key order is
 * insertion order in V8 / JSC / Bun, but spec only guarantees order for
 * string keys. Today's cortex#75 payloads are flat `{verb, agent_id}` so
 * this is fine. If the payload grows nested, swap to a deterministic
 * canonicaliser (e.g. RFC 8785 JCS) in lock-step with all producers.
 */
export function canonicalSignedRequestBytes(parts: {
  subject: string;
  nonce: string;
  ts: string;
  payload: unknown;
}): Uint8Array {
  const canonical = `${parts.subject}\n${parts.nonce}\n${parts.ts}\n${JSON.stringify(parts.payload)}`;
  return new TextEncoder().encode(canonical);
}

/**
 * Verify a NATS user JWT against the operator account signing public key.
 *
 * `@nats-io/jwt`'s `decode` already verifies the JWT signature against the
 * pubkey in the `iss` claim — so a successful decode means the JWT is
 * self-consistent. This wrapper adds the missing checks the consumer cares
 * about: (a) `iss` actually matches the operator we trust, (b) the JWT is
 * within its validity window.
 *
 * Pure function over inputs. No I/O. No state.
 */
export function verifyOperatorUserJwt(
  jwt: string,
  operatorAccountSigningPublicKey: string,
  opts: { clockSkewToleranceSec?: number; nowMs?: number } = {},
): OperatorVerificationResult {
  if (typeof jwt !== "string" || jwt.length === 0) {
    return { ok: false, reason: "malformed_jwt", detail: "jwt is empty or not a string" };
  }

  let claims;
  try {
    claims = decode<User>(jwt);
  } catch (err) {
    return {
      ok: false,
      reason: "malformed_jwt",
      detail: `jwt decode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (claims.iss !== operatorAccountSigningPublicKey) {
    return {
      ok: false,
      reason: "wrong_issuer",
      detail:
        `jwt iss=${claims.iss} does not match trusted operator pubkey ` +
        `${operatorAccountSigningPublicKey}`,
    };
  }

  const skew = opts.clockSkewToleranceSec ?? DEFAULT_CLOCK_SKEW_SEC;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (typeof claims.exp === "number" && claims.exp > 0 && claims.exp + skew < nowSec) {
    return {
      ok: false,
      reason: "expired",
      detail: `jwt expired at exp=${claims.exp} (now=${nowSec}, skew=${skew}s)`,
    };
  }
  if (typeof claims.nbf === "number" && claims.nbf > 0 && claims.nbf - skew > nowSec) {
    return {
      ok: false,
      reason: "not_yet_valid",
      detail: `jwt not yet valid: nbf=${claims.nbf} (now=${nowSec}, skew=${skew}s)`,
    };
  }

  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return {
      ok: false,
      reason: "malformed_jwt",
      detail: "jwt sub (user pubkey) is missing or empty",
    };
  }

  return { ok: true, userPublicKey: claims.sub, agentName: claims.name ?? "" };
}

/**
 * Verify a full operator-signed request envelope: JWT chains to operator,
 * envelope shape is well-formed, the timestamp is within the freshness
 * window, and the ed25519 signature over the canonical bytes verifies
 * against the user's nkey pubkey (taken from the JWT's `sub`).
 *
 * The check order matches the cost / specificity profile:
 *   1. Envelope shape (cheap, structural)
 *   2. JWT verify + freshness (cheap, structural)
 *   3. Subject + ts envelope bindings (cheap, semantic)
 *   4. Signature verify (expensive, cryptographic)
 *
 * Pure function. The caller is responsible for nonce-replay state if they
 * need at-most-once semantics — see `SignedRequest.nonce` rationale.
 *
 * # Replay-window note
 *
 * The verifier enforces TWO independent freshness windows:
 *   - envelope `ts` must be within `signedRequestMaxAgeSec` (default 300s)
 *   - the user JWT's `exp` must be within `clockSkewToleranceSec` (default 60s)
 *
 * These stack — the effective max-replay-age is `min(maxAge, jwtExp − now)`.
 * If the JWT is long-lived (cortex's default credential lifetime), `ts`
 * dominates. If the JWT is short-lived (rotated frequently), `jwt.exp`
 * dominates. Callers tuning either knob should consider both.
 *
 * # `expectedSubject` is required
 *
 * The caller MUST supply the NATS subject the transport actually delivered
 * the envelope on. The verifier then checks that `envelope.subject` matches.
 * This binds the signature to the transport delivery channel at the
 * application layer — without it, an attacker who captures a valid envelope
 * on subject A could replay it on subject B, because the signature only
 * covers `envelope.subject` (which they don't need to alter). Making this
 * parameter required at the type level forces production transports to
 * pass it; tests that don't care about the subject check pass the same
 * subject they signed with.
 */
export function verifyOperatorSignedRequest(
  envelope: unknown,
  operatorAccountSigningPublicKey: string,
  opts: {
    clockSkewToleranceSec?: number;
    signedRequestMaxAgeSec?: number;
    nowMs?: number;
    /** The NATS subject the transport delivered this envelope on. Bound into
     *  the verifier so a captured envelope can't be replayed against a
     *  different subject. REQUIRED — no default-skip. Tests that don't care
     *  about the subject check pass the same subject the envelope was signed
     *  with. */
    expectedSubject: string;
  },
): OperatorVerificationResult {
  if (!isSignedRequestShape(envelope)) {
    return {
      ok: false,
      reason: "malformed_envelope",
      detail: "envelope does not match SignedRequest shape",
    };
  }

  const env = envelope as SignedRequest;

  if (env.subject !== opts.expectedSubject) {
    return {
      ok: false,
      reason: "subject_mismatch",
      detail: `envelope.subject="${env.subject}" but transport delivered on "${opts.expectedSubject}"`,
    };
  }

  const jwtResult = verifyOperatorUserJwt(env.userJwt, operatorAccountSigningPublicKey, {
    clockSkewToleranceSec: opts.clockSkewToleranceSec,
    nowMs: opts.nowMs,
  });
  if (!jwtResult.ok) return jwtResult;

  // Envelope freshness — defend against replay even when the JWT itself is
  // long-lived. ISO-8601 parse is permissive; reject zero-length / NaN.
  const tsMs = Date.parse(env.ts);
  if (!Number.isFinite(tsMs)) {
    return {
      ok: false,
      reason: "ts_out_of_range",
      detail: `envelope.ts="${env.ts}" is not a valid ISO-8601 date`,
    };
  }
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = (opts.signedRequestMaxAgeSec ?? DEFAULT_SIGNED_REQUEST_MAX_AGE_SEC) * 1000;
  const skewMs = (opts.clockSkewToleranceSec ?? DEFAULT_CLOCK_SKEW_SEC) * 1000;
  // Two-sided check: the envelope must not be older than the max age, and
  // must not be too far in the future (clock skew tolerated).
  if (nowMs - tsMs > maxAgeMs) {
    return {
      ok: false,
      reason: "ts_out_of_range",
      detail: `envelope ts=${env.ts} older than ${maxAgeMs / 1000}s (delta=${(nowMs - tsMs) / 1000}s)`,
    };
  }
  if (tsMs - nowMs > skewMs) {
    return {
      ok: false,
      reason: "ts_out_of_range",
      detail: `envelope ts=${env.ts} too far in future (delta=${(tsMs - nowMs) / 1000}s, skew=${skewMs / 1000}s)`,
    };
  }

  // Crypto verify last — most expensive step. Decode base64url to bytes,
  // reconstruct the public-key KeyPair, verify.
  let sigBytes: Uint8Array;
  try {
    sigBytes = decodeBase64Url(env.signature);
  } catch (err) {
    return {
      ok: false,
      reason: "malformed_signature",
      detail: `signature is not valid base64url: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let userKeyPair;
  try {
    userKeyPair = fromPublic(jwtResult.userPublicKey);
  } catch (err) {
    return {
      ok: false,
      reason: "malformed_jwt",
      detail: `jwt sub="${jwtResult.userPublicKey}" is not a valid NKey public key: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const canonical = canonicalSignedRequestBytes({
    subject: env.subject,
    nonce: env.nonce,
    ts: env.ts,
    payload: env.payload,
  });

  let verified: boolean;
  try {
    verified = userKeyPair.verify(canonical, sigBytes);
  } catch (err) {
    // `KeyPair.verify` shouldn't throw for valid inputs, but defensively
    // catch malformed sig lengths etc. so a bug in the producer surfaces
    // as a structured failure rather than crashing the verifier.
    return {
      ok: false,
      reason: "signature_invalid",
      detail: `verify threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!verified) {
    return {
      ok: false,
      reason: "signature_invalid",
      detail: "ed25519 signature does not verify against jwt sub pubkey",
    };
  }

  // Reuse the `ok: true` result from `verifyOperatorUserJwt` — it already
  // carries the validated `userPublicKey` and `agentName`. Constructing a
  // fresh object here would be redundant and risk drift if the success
  // shape gains new fields.
  return jwtResult;
}

/**
 * Type guard for `SignedRequest`. Conservative — checks every field's
 * presence and string-ness (except `payload`, which is allowed to be any
 * JSON value including null).
 */
function isSignedRequestShape(value: unknown): value is SignedRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.subject === "string" &&
    typeof v.userJwt === "string" &&
    typeof v.nonce === "string" &&
    typeof v.ts === "string" &&
    typeof v.signature === "string" &&
    "payload" in v
  );
}

/**
 * Decode a base64url string to bytes. Accepts the `@nats-io/jwt`
 * convention (no padding, `-_` instead of `+/`). Throws on invalid chars
 * via the spec'd atob fallback.
 *
 * We inline this rather than importing `Base64UrlCodec` from
 * `@nats-io/jwt/lib/base64` — that path isn't part of the package's public
 * exports and would couple us to its internals. `atob` is stdlib in Bun
 * and Node 18+, which both target environments support.
 */
function decodeBase64Url(input: string): Uint8Array {
  // Re-introduce padding atob requires.
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  // atob throws on non-base64 chars. Let it.
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Thrown when `register` would overwrite an existing mapping with a
 * different agent. Re-registering the same agent for the same platform id
 * is a no-op (idempotent reconnect); claiming someone else's id throws so a
 * misconfigured token doesn't silently steal another agent's identity.
 */
export class PlatformIdAlreadyRegisteredError extends Error {
  readonly platform: Platform;
  readonly platformId: string;
  readonly existingAgentId: string;
  readonly attemptedAgentId: string;

  constructor(
    platform: Platform,
    platformId: string,
    existingAgentId: string,
    attemptedAgentId: string,
  ) {
    super(
      `platform identity ${platform}:${platformId} is already registered to agent ` +
        `"${existingAgentId}" — refusing to claim it for "${attemptedAgentId}". ` +
        `Check that the Discord/Mattermost token belongs to the expected bot account.`,
    );
    this.name = "PlatformIdAlreadyRegisteredError";
    this.platform = platform;
    this.platformId = platformId;
    this.existingAgentId = existingAgentId;
    this.attemptedAgentId = attemptedAgentId;
  }
}

// =============================================================================
// TrustResolver
// =============================================================================

/**
 * Process-wide map between platform user ids and agent ids, backed by an
 * AgentRegistry. Mutable — adapters register on connect, unregister on
 * disconnect. Single-process; no persistence.
 */
export class TrustResolver {
  private readonly registry: AgentRegistry;

  /** Forward: `${platform}:${platformId}` → agentId */
  private readonly forward = new Map<string, string>();

  /** Reverse: agentId → Set<`${platform}:${platformId}`> */
  private readonly reverse = new Map<string, Set<string>>();

  /**
   * Operator account signing public key, if configured. When undefined,
   * `verifyOperatorSignature` throws `OperatorVerifierNotConfiguredError`.
   * See `TrustResolverOptions.operatorAccountSigningPublicKey`.
   */
  private readonly operatorAccountSigningPublicKey: string | undefined;
  private readonly clockSkewToleranceSec: number;
  private readonly signedRequestMaxAgeSec: number;

  constructor(registry: AgentRegistry, options: TrustResolverOptions = {}) {
    this.registry = registry;
    this.operatorAccountSigningPublicKey = options.operatorAccountSigningPublicKey;
    this.clockSkewToleranceSec = options.clockSkewToleranceSec ?? DEFAULT_CLOCK_SKEW_SEC;
    this.signedRequestMaxAgeSec =
      options.signedRequestMaxAgeSec ?? DEFAULT_SIGNED_REQUEST_MAX_AGE_SEC;
  }

  /**
   * cortex#76 — verify that a NATS request envelope was signed by
   * operator-trusted credentials. Returns a structured result rather than
   * a plain boolean so callers (e.g. the cortex#75 NATS transport gate)
   * can branch on the specific failure class for logging / metering.
   *
   * @param signedRequest The envelope. See `SignedRequest`.
   * @param opts.expectedSubject REQUIRED. The NATS subject the transport
   *        delivered the envelope on. Bound into the verifier to defend
   *        against signature-rebinding: an attacker who captures a valid
   *        envelope on subject A would otherwise be able to replay it on
   *        subject B. Required at the type level so production transports
   *        cannot accidentally skip the check.
   *
   * @throws OperatorVerifierNotConfiguredError if the resolver was built
   *         without `operatorAccountSigningPublicKey`.
   *
   * Delegates to the module-level `verifyOperatorSignedRequest`. Sibling
   * pure functions exposed for callers that don't want the resolver
   * instance (e.g. tooling, debug CLI).
   */
  verifyOperatorSignature(
    signedRequest: unknown,
    opts: { expectedSubject: string; nowMs?: number },
  ): OperatorVerificationResult {
    if (!this.operatorAccountSigningPublicKey) {
      throw new OperatorVerifierNotConfiguredError();
    }
    return verifyOperatorSignedRequest(signedRequest, this.operatorAccountSigningPublicKey, {
      clockSkewToleranceSec: this.clockSkewToleranceSec,
      signedRequestMaxAgeSec: this.signedRequestMaxAgeSec,
      expectedSubject: opts.expectedSubject,
      nowMs: opts.nowMs,
    });
  }

  /**
   * cortex#76 — convenience: verify just the user JWT against the trusted
   * operator pubkey, without requiring a full signed envelope. Useful at
   * NATS-connection authorization time when the application only has the
   * connection's user JWT and wants to gate the connection on operator
   * trust before accepting subscriptions.
   *
   * @throws OperatorVerifierNotConfiguredError if the resolver was built
   *         without `operatorAccountSigningPublicKey`.
   */
  verifyUserJwt(
    jwt: string,
    opts: { nowMs?: number } = {},
  ): OperatorVerificationResult {
    if (!this.operatorAccountSigningPublicKey) {
      throw new OperatorVerifierNotConfiguredError();
    }
    return verifyOperatorUserJwt(jwt, this.operatorAccountSigningPublicKey, {
      clockSkewToleranceSec: this.clockSkewToleranceSec,
      nowMs: opts.nowMs,
    });
  }

  /** True iff the resolver was constructed with an operator pubkey. */
  get isOperatorVerifierConfigured(): boolean {
    return this.operatorAccountSigningPublicKey !== undefined;
  }

  /**
   * Register a platform identity for an agent. Called by presence adapters
   * on connect with their freshly-learned platform user id.
   *
   * @throws AgentNotFoundError if `agentId` is not in the backing registry.
   * @throws PlatformIdAlreadyRegisteredError if the `(platform, platformId)`
   *         pair is already registered to a *different* agent. Re-registering
   *         the same agent is idempotent (no-op).
   */
  register(platform: Platform, platformId: string, agentId: string): void {
    // Validate agent existence — fail-closed per architecture §9.3.
    if (!this.registry.tryGetById(agentId)) {
      throw new AgentNotFoundError(agentId);
    }

    const key = makeKey(platform, platformId);
    const existing = this.forward.get(key);
    if (existing) {
      if (existing === agentId) {
        // Idempotent reconnect — silently OK.
        return;
      }
      throw new PlatformIdAlreadyRegisteredError(platform, platformId, existing, agentId);
    }

    this.forward.set(key, agentId);
    let owned = this.reverse.get(agentId);
    if (!owned) {
      owned = new Set();
      this.reverse.set(agentId, owned);
    }
    owned.add(key);
  }

  /**
   * Remove a platform identity registration. Called by presence adapters on
   * graceful disconnect. Silently no-op on unknown pairs (avoids spurious
   * errors during shutdown races).
   */
  unregister(platform: Platform, platformId: string): void {
    const key = makeKey(platform, platformId);
    const agentId = this.forward.get(key);
    if (!agentId) return;
    this.forward.delete(key);
    const owned = this.reverse.get(agentId);
    if (owned) {
      owned.delete(key);
      if (owned.size === 0) this.reverse.delete(agentId);
    }
  }

  /**
   * Reverse lookup: given a platform user id, return the registered agent
   * id (or undefined). The caller usually pairs this with
   * `registry.getById(agentId)` to get the full Agent object.
   */
  lookupAgentId(platform: Platform, platformId: string): string | undefined {
    return this.forward.get(makeKey(platform, platformId));
  }

  /**
   * Reverse lookup: given a platform user id, return the registered Agent
   * (or undefined). Convenience wrapper combining `lookupAgentId` and the
   * registry.
   */
  lookupAgent(platform: Platform, platformId: string): Agent | undefined {
    const agentId = this.lookupAgentId(platform, platformId);
    if (!agentId) return undefined;
    return this.registry.tryGetById(agentId);
  }

  /**
   * Forward lookup: given an agent id, return all platform identities it has
   * registered. Order is registration order. Returns `[]` for unknown or
   * unregistered agents.
   */
  identitiesOf(agentId: string): PlatformIdentity[] {
    const owned = this.reverse.get(agentId);
    if (!owned) return [];
    const out: PlatformIdentity[] = [];
    for (const key of owned) {
      const [platform, platformId] = parseKey(key);
      out.push({ platform, platformId });
    }
    return out;
  }

  /**
   * cortex#98 (part B) — inverse of `lookupAgentId`: given an agent id and a
   * platform, return the platform user id this agent registered on that
   * platform (or `undefined` if unregistered).
   *
   * Used by cortex.ts at adapter-start to translate an agent's
   * `trust: [<peer-agent-id>, ...]` list into a set of bot user ids for the
   * Discord `trustedBotIds` allowlist. Peers that are cross-process
   * (never registered into THIS resolver) return `undefined` and are
   * silently skipped — the operator-explicit `presence.discord.trustedBotIds`
   * field carries those cases as the documented cross-process bridge.
   *
   * An agent can have at most ONE identity per platform (a single Discord
   * adapter per agent — Architecture §9.1's "one presence per platform" rule).
   * Implementation walks `identitiesOf` and returns the first match; if a
   * future schema flip allows multiple per platform, callers may need to
   * adapt — but today this is unambiguous.
   *
   * Returns `undefined` for unknown agent ids (no throw — callers usually
   * iterate over a `trust:` list where missing peers are silently expected,
   * not a precondition violation).
   */
  lookupPlatformIdByAgent(platform: Platform, agentId: string): string | undefined {
    const owned = this.reverse.get(agentId);
    if (!owned) return undefined;
    const prefix = `${platform}|`;
    for (const key of owned) {
      if (key.startsWith(prefix)) {
        return key.slice(prefix.length);
      }
    }
    return undefined;
  }

  /**
   * Full trust check by platform identity. Returns true iff:
   *   1. The `(platform, platformId)` is registered to a known agent.
   *   2. `receivingAgentId` is a known agent.
   *   3. `receivingAgent.trust` includes the sender's agent id
   *      (OR sender and receiver are the same agent — self-trust is
   *      transitive, matching `AgentRegistry.trusts`).
   *
   * Returns false (not throws) for any unknown identity, so the receiving
   * adapter can fall back to human-message handling without a try/catch.
   */
  trustsByPlatformId(
    receivingAgentId: string,
    senderPlatform: Platform,
    senderPlatformId: string,
  ): boolean {
    const senderAgentId = this.lookupAgentId(senderPlatform, senderPlatformId);
    if (!senderAgentId) return false;
    return this.registry.trusts(receivingAgentId, senderAgentId);
  }

  /**
   * The backing registry. Exposed for callers that need the full Agent
   * object alongside the platform-id mapping (e.g. presence adapters that
   * fetch personas after resolving the sender).
   */
  getRegistry(): AgentRegistry {
    return this.registry;
  }

  /** Number of currently-registered platform identities (debug + tests). */
  get size(): number {
    return this.forward.size;
  }
}

// =============================================================================
// Private — key encoding
// =============================================================================

/**
 * Encode a `(platform, platformId)` pair into a Map key. Separator chosen to
 * avoid collision with Discord/Mattermost id characters (digits + dashes for
 * snowflakes, lowercase alphanumeric for Mattermost). `|` is reserved across
 * both platforms.
 */
function makeKey(platform: Platform, platformId: string): string {
  return `${platform}|${platformId}`;
}

function parseKey(key: string): [Platform, string] {
  const sep = key.indexOf("|");
  const platform = key.slice(0, sep) as Platform;
  const platformId = key.slice(sep + 1);
  return [platform, platformId];
}
