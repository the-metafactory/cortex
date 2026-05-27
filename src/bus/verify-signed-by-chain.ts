/**
 * IAW Phase B.1a/B.1c (cortex#114) — verification of an envelope's
 * `signed_by[]` chain against the local trust registry, optionally
 * including cryptographic verification of each stamp's ed25519 signature.
 *
 * Two layered checks:
 *
 *   1. **Structural trust** (B.1a, always on). For every ed25519 stamp,
 *      checks that the claimed principal:
 *        a. Resolves to a known agent in the local registry
 *        b. Has an `nkey_pub` declared (the agent intends to sign on bus)
 *        c. Passes `TrustResolver.trustsByNKey(receivingAgentId, nkey_pub)`
 *           — i.e. the receiving agent's `trust:` list includes this signer
 *
 *   2. **Cryptographic verification** (B.1c, opt-in via `cryptoVerify: true`).
 *      After structural pass, calls myelin's `verifyEnvelopeIdentity` which:
 *        a. Canonicalizes the envelope per JCS (RFC 8785)
 *        b. Verifies every stamp's ed25519 signature over the canonical bytes
 *        c. Checks timestamp freshness (clock-skew window)
 *      Failure surfaces as `crypto_verify_failed` with the underlying
 *      myelin rejection reason carried through.
 *
 * **Why two layers, both gated by trust:** the structural check alone is
 * not safe to wire into a production inbound path — a stamp can lie
 * about its principal, and a sloppy operator copying an unknown agent's
 * NKey into their own `trust:` list would accept the forgery. The crypto
 * check alone is not enough either — a verified signer the receiver
 * doesn't trust shouldn't be admitted. The two checks compose: structural
 * fails closed on unknown/untrusted; crypto fails closed on forged bytes.
 *
 * Hub-stamp variants (`method === "hub-stamp"`) pass through this helper
 * structurally — they're a Phase D concern (federation hub trust).
 * They're surfaced as `skipped` indices so a strict caller can opt to
 * reject all non-bare-ed25519 chains.
 *
 * **Import discipline.** Crypto helpers come from
 * `@the-metafactory/myelin/identity` — the constrained subpath added by
 * myelin#146 (closes myelin#145), tightened to strict-null safety by
 * myelin#148 (closes myelin#147). Importing from the top-level
 * `@the-metafactory/myelin` package pulls myelin's full source tree into
 * tsc analysis and surfaces strict-null violations in modules cortex
 * doesn't consume; the `./identity` subpath limits resolution to
 * myelin's identity submodule + its transitive deps.
 */

import {
  verifyEnvelopeIdentity,
  createInMemoryRegistry,
  type IdentityRegistry,
} from "@the-metafactory/myelin/identity";
import { Prefix } from "@nats-io/nkeys";
// `Codec` is the internal NKey base32 + CRC + prefix-byte decoder.
// Marked `@ignore` in @nats-io/nkeys but stable; the public `fromPublic`
// helper stores only the ASCII bytes of the NKey string on its returned
// `PublicKey.publicKey` field, not the raw 32-byte ed25519 pubkey. We
// need the raw bytes to bridge to myelin's `Principal.public_key`
// (base64-encoded raw ed25519), so this subpath import is the narrow
// way in without re-implementing crockford base32 + CRC16 inline.
import { Codec } from "@nats-io/nkeys/lib/codec";

import {
  getSignedByChain,
  type Envelope,
  type SignedBy,
} from "./myelin/envelope-validator";
import { TrustResolver } from "../common/agents/trust-resolver";
import type { AgentRegistry } from "../common/agents/registry";
import { extractAgentIdFromDid } from "../common/policy/did";

// =============================================================================
// Result types
// =============================================================================

/**
 * Reason a stamp failed structural verification. Discriminated union so
 * callers can branch on the specific class for logging / audit (Phase C
 * wires audit envelopes that carry this reason verbatim — splitting now
 * to avoid a schema break later, per Echo's B.1a review).
 *
 * - `malformed_principal` — the stamp's `principal` is not a `did:mf:<id>`.
 *   Wire-format misconfiguration; either an unsupported DID method
 *   (e.g. `did:key:…`), an empty tail, or further-segmented payload.
 *   Phase D may add hub-trust paths that legitimise some `did:web:` /
 *   `did:key:` shapes; at this slice, anything other than `did:mf:<id>`
 *   is rejected.
 * - `unknown_agent` — the principal IS a well-formed `did:mf:<id>` but
 *   no agent with that id is registered locally. Indicates the sender
 *   is unrecognised to this stack; different operational class from
 *   wire-format failure.
 * - `principal_has_no_nkey_pub` — agent is registered but its
 *   `nkey_pub` is unset, so we can't even structurally trust it on the
 *   bus. Indicates the agent intends to live on Discord/Mattermost
 *   only (B.1a optional `nkey_pub`).
 * - `signer_not_trusted` — agent is registered with an `nkey_pub`, but
 *   `receivingAgent.trust` does not list this signer.
 * - `empty_chain` — envelope arrived with no `signed_by[]` and the
 *   caller asked for `rejectEmpty: true`.
 */
export type ChainRejectionReason =
  | { kind: "empty_chain" }
  | { kind: "malformed_principal"; principal: string }
  | { kind: "unknown_agent"; principal: string; agentId: string }
  | { kind: "principal_has_no_nkey_pub"; principal: string; agentId: string }
  | { kind: "signer_not_trusted"; principal: string; agentId: string }
  | {
      /**
       * Cryptographic verification failed — the bytes don't match the
       * claimed signature, OR the timestamp is outside the freshness
       * window, OR myelin's principal-registry lookup failed for the
       * stamp's DID (when the structural check accepted the agent but
       * the per-stamp Principal lookup inside myelin's verify did not).
       *
       * `myelinReason` carries myelin's own rejection text verbatim so
       * audit envelopes (Phase C) can surface "ed25519 verify failed"
       * vs. "timestamp outside freshness window" without recomputing.
       */
      kind: "crypto_verify_failed";
      myelinReason: string;
    };

/**
 * Discriminated outcome of `verifySignedByChain`.
 *
 * - `valid: true` — every ed25519 stamp passed the structural check
 *   (hub-stamps were skipped — see `skipped` for visibility).
 * - `valid: false` — at least one ed25519 stamp failed; `rejectedAt`
 *   is the chain index of the first failing stamp; `reason` carries
 *   the structured failure class. Caller does NOT continue iterating
 *   beyond `rejectedAt`; the first rejection is terminal. `skipped`
 *   carries the hub-stamp indices encountered up to (but not
 *   including) the rejection so audit envelopes can preserve the
 *   "rejected after skipping hub-stamps at [0, 2]" shape (per Echo's
 *   B.1a review).
 */
export type ChainVerificationResult =
  | {
      valid: true;
      /** Indices of stamps that were skipped (e.g. hub-stamp method). */
      skipped: number[];
    }
  | {
      valid: false;
      rejectedAt: number;
      reason: ChainRejectionReason;
      /**
       * Indices of stamps skipped BEFORE the rejection. Useful for audit
       * envelopes that need to reconstruct the chain-walk context (which
       * hub-stamps were encountered before the rejected stamp). Empty
       * array when the rejection happens on the first stamp, OR when the
       * rejection is `empty_chain`.
       */
      skipped: number[];
    };

/**
 * Options for `verifySignedByChain`. Required so this helper is reusable
 * by future harnesses without bundling environment-specific lookups.
 */
export interface VerifySignedByChainOptions {
  /** Trust resolver backed by the local agent registry. */
  resolver: TrustResolver;
  /** The agent id of the receiving / verifying side of the dispatch. */
  receivingAgentId: string;
  /**
   * When true, the helper rejects any envelope whose chain is empty.
   * Default `true` — a B.1b `BusPeerHarness` will use this. Tests + CLI
   * tooling that legitimately accept unsigned envelopes pass `false`.
   */
  rejectEmpty?: boolean;
  /**
   * When true (B.1c), runs myelin's `verifyEnvelopeIdentity` after the
   * structural pass to verify each stamp's ed25519 signature over the
   * JCS-canonical envelope bytes. Default `false` for back-compat: the
   * structural check alone is the B.1a contract and existing B.1b
   * call sites keep their behaviour unchanged until they opt in.
   *
   * When `cryptoVerify: true`, the caller must also pass `principalId`
   * so the helper can build a myelin `IdentityRegistry` from the
   * `TrustResolver`'s underlying `AgentRegistry`. Each agent with an
   * `nkey_pub` becomes a Principal whose `public_key` is the
   * base64-encoded raw ed25519 pubkey derived from the NATS NKey.
   */
  cryptoVerify?: boolean;
  /**
   * Principal id (e.g. `andreas`). Required when `cryptoVerify: true` —
   * threaded into each constructed Principal so myelin's verification
   * has the network field populated. Ignored when `cryptoVerify` is
   * false / undefined.
   */
  principalId?: string;
  /**
   * Optional clock-skew tolerance for myelin's timestamp-freshness
   * check (passed through to `verifyEnvelopeIdentity`). Default per
   * myelin: 5 minutes.
   */
  clockSkewMs?: number;
}

// =============================================================================
// Verification
// =============================================================================

/**
 * Walk `envelope.signed_by` chain (normalised via `getSignedByChain`) and
 * verify each ed25519 stamp against the local trust registry.
 *
 * Two layered checks: structural trust (always), then cryptographic
 * verification (when `opts.cryptoVerify === true`). See file header.
 *
 * Iteration short-circuits on the first structural failure. The crypto
 * check is invoked once at the end, on the full chain, because myelin's
 * `verifyEnvelopeIdentity` itself walks the chain and threads canonical-
 * bytes commitment from one stamp to the next (myelin#31).
 *
 * `verifySignedByChain` is async because `verifyEnvelopeIdentity` is
 * async (@noble/ed25519's `verifyAsync`). When `cryptoVerify: false`
 * (default), the helper still returns a Promise to keep one signature
 * for both modes — a sync/async split based on an option flag would
 * force every call site to handle both branches.
 */
export async function verifySignedByChain(
  envelope: Envelope,
  opts: VerifySignedByChainOptions,
): Promise<ChainVerificationResult> {
  const chain = getSignedByChain(envelope);
  const rejectEmpty = opts.rejectEmpty ?? true;

  if (chain.length === 0) {
    if (rejectEmpty) {
      return {
        valid: false,
        rejectedAt: 0,
        reason: { kind: "empty_chain" },
        skipped: [],
      };
    }
    return { valid: true, skipped: [] };
  }

  const skipped: number[] = [];

  for (const [i, stamp] of chain.entries()) {
    const stampResult = verifyOneStamp(stamp, opts);
    if (stampResult.kind === "skip") {
      skipped.push(i);
      continue;
    }
    if (stampResult.kind === "reject") {
      return {
        valid: false,
        rejectedAt: i,
        reason: stampResult.reason,
        skipped: [...skipped],
      };
    }
    // stampResult.kind === "accept" — continue to next stamp
  }

  // Crypto layer (B.1c) — opt-in. Structural check has already passed
  // for every ed25519 stamp at this point; myelin's verifier runs the
  // canonical-bytes + signature + freshness check on top.
  if (opts.cryptoVerify === true) {
    if (opts.principalId === undefined) {
      throw new Error(
        "verifySignedByChain: cryptoVerify requires opts.principalId — " +
          "myelin's Principal shape needs the network field populated.",
      );
    }
    const registry = buildIdentityRegistry(
      opts.resolver.getRegistry(),
      opts.principalId,
    );
    // Myelin's verifier expects `signed_by` normalised to array form;
    // cortex's `Envelope` keeps the back-compat shim of single-stamp
    // OR array. Normalise here before handing off.
    //
    // R2 (vocabulary migration 2026-05) — the cortex vendored SignedBy
    // declares `identity?` AND `principal?` as optional so the transition
    // window can carry either; upstream myelin's discriminated union
    // requires exactly one. The runtime guarantee is identical (the
    // envelope validator's `dual_field_conflict` check fires before this
    // helper runs), so cast through `unknown` at the type boundary.
    const myelinEnvelope = {
      ...envelope,
      signed_by: chain,
    } as unknown as Parameters<typeof verifyEnvelopeIdentity>[0];
    const myelinResult = await verifyEnvelopeIdentity(
      myelinEnvelope,
      registry,
      opts.clockSkewMs !== undefined
        ? { clockSkewMs: opts.clockSkewMs }
        : undefined,
    );
    if (myelinResult.status !== "verified") {
      return {
        valid: false,
        // The structural walk accepted every stamp; the crypto failure
        // is a chain-level rejection rather than a per-stamp index.
        // Surface as rejectedAt: 0 (the first stamp) with the myelin
        // reason carried verbatim.
        rejectedAt: 0,
        reason: {
          kind: "crypto_verify_failed",
          myelinReason: myelinResult.reason,
        },
        skipped: [...skipped],
      };
    }
  }

  return { valid: true, skipped };
}

// =============================================================================
// Per-stamp helpers (private)
// =============================================================================

type StampOutcome =
  | { kind: "accept" }
  | { kind: "skip" }
  | { kind: "reject"; reason: ChainRejectionReason };

/**
 * Classify a single stamp. Hub-stamps are skipped at this slice — Phase D
 * extends with hub-trust verification. Bare ed25519 stamps run the
 * structural trust check.
 */
function verifyOneStamp(
  stamp: SignedBy,
  opts: VerifySignedByChainOptions,
): StampOutcome {
  if (stamp.method === "hub-stamp") {
    return { kind: "skip" };
  }
  // Discriminated union — narrows to SignedByEd25519 once hub-stamp is out.

  // R2 (vocabulary migration 2026-05) — dual-read the stamp DID:
  // canonical `identity` wins, fall back to deprecated `principal`
  // for pre-migration / JetStream-replayed stamps. The envelope-level
  // dual_field_conflict check fires upstream at envelope validation.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const principal = stamp.identity ?? stamp.principal;
  if (principal === undefined) {
    return {
      kind: "reject",
      reason: { kind: "malformed_principal", principal: "<missing>" },
    };
  }
  const agentId = extractAgentIdFromDid(principal);
  if (agentId === undefined) {
    return {
      kind: "reject",
      reason: { kind: "malformed_principal", principal },
    };
  }

  const registry = opts.resolver.getRegistry();
  const agent = registry.tryGetById(agentId);
  if (!agent) {
    return {
      kind: "reject",
      reason: { kind: "unknown_agent", principal, agentId },
    };
  }

  if (agent.nkey_pub === undefined) {
    return {
      kind: "reject",
      reason: { kind: "principal_has_no_nkey_pub", principal, agentId },
    };
  }

  const trusted = opts.resolver.trustsByNKey(
    opts.receivingAgentId,
    agent.nkey_pub,
  );
  if (!trusted) {
    return {
      kind: "reject",
      reason: { kind: "signer_not_trusted", principal, agentId },
    };
  }

  return { kind: "accept" };
}

// `extractAgentIdFromDid` lives in `src/common/policy/did.ts` so the
// bus-side verifier and the dispatch-listener's policy gate share
// one parser (Echo cortex#220 round 2 S-1). Re-imported at the top
// of this file.

// =============================================================================
// Principal-registry bridge (B.1c)
// =============================================================================

/**
 * Bridge cortex's `AgentRegistry` to myelin's `IdentityRegistry` for the
 * crypto-verification step. Every agent with a declared `nkey_pub` becomes
 * a Principal whose `public_key` is the base64-encoded raw ed25519 pubkey
 * extracted from the NATS NKey via `@nats-io/nkeys`'s `fromPublic`.
 *
 * Why the decode is needed: cortex stores agent signing keys in NATS NKey
 * format (`U` + 55 base32 chars) for parity with `StackConfigSchema.nkey_pub`.
 * Myelin's verify pipeline consumes raw ed25519 pubkeys encoded as base64.
 * The two encodings cover the same 32-byte ed25519 pubkey underneath —
 * `fromPublic` gives us a `KeyPair` whose underlying concrete class
 * stores the raw `Uint8Array` which we base64-encode for myelin.
 *
 * Agents without `nkey_pub` are skipped — the structural check will have
 * already rejected stamps claiming those principals before crypto verify
 * runs.
 *
 * Exported so callers (tests, future tooling) can construct a registry
 * independently and pass it through; this also keeps the
 * verifySignedByChain hot path from rebuilding a registry per call when
 * the caller has a stable agent set (future caching is a separate
 * concern — at B.1c, every cryptoVerify call rebuilds).
 */
export function buildIdentityRegistry(
  agentRegistry: AgentRegistry,
  principalId: string,
): IdentityRegistry {
  const registry = createInMemoryRegistry();
  const createdAt = new Date(0).toISOString();
  for (const agent of agentRegistry.getAll()) {
    if (agent.nkey_pub === undefined) continue;
    const publicKey = nkeyToBase64Pubkey(agent.nkey_pub);
    if (publicKey === undefined) {
      // Malformed NKey at this point would already have failed the
      // AgentSchema regex on config load — defensive only.
      continue;
    }
    registry.add({
      id: `did:mf:${agent.id}`,
      display_name: agent.displayName,
      // R4 (vocabulary migration 2026-05) — myelin's `Identity` interface
      // renamed `operator` → `network` (Luna's PR-5/PR-8 in #168/#171).
      // `principalId` here stores the network slug per the
      // bus-addressing model — cortex's canonical principal/network id.
      network: principalId,
      public_key: publicKey,
      type: "agent",
      created_at: createdAt,
    });
  }
  return registry;
}

/**
 * Convert a NATS NKey public-key (e.g. `UA...`, 56 chars) to the
 * base64-encoded 32-byte raw ed25519 pubkey shape myelin expects on
 * `Principal.public_key`. Returns `undefined` if `@nats-io/nkeys`
 * rejects the input — defensive against drift between AgentSchema's
 * regex and the on-the-wire decode.
 *
 * `Codec.decode(Prefix.User, asciiBytes)` from `@nats-io/nkeys`:
 *   1. Base32-decodes the NKey ASCII (`UA...` 56 chars → 35 raw bytes)
 *   2. Validates the leading prefix byte matches `Prefix.User` (0xa0)
 *   3. Strips the prefix + trailing 2-byte CRC
 *   4. Returns the 32-byte raw ed25519 pubkey
 *
 * The public `fromPublic` helper does the same decode internally for
 * validation, but stores only the ASCII bytes of the NKey string on
 * its returned `PublicKey.publicKey` field — not the raw 32 bytes we
 * want. The `Codec` subpath import is the narrow way to the decoded
 * payload without re-implementing crockford base32 + CRC16 inline.
 */
function nkeyToBase64Pubkey(nkey: string): string | undefined {
  try {
    const asciiBytes = new TextEncoder().encode(nkey);
    const raw = Codec.decode(Prefix.User, asciiBytes);
    return Buffer.from(raw).toString("base64");
  } catch {
    return undefined;
  }
}
