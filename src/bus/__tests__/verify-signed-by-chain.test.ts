/**
 * IAW Phase B.1a (cortex#114) — `verifySignedByChain` tests.
 *
 * Nine table-driven cases per Echo's B.1a review minimum baseline:
 *   1. Happy path — single trusted ed25519 stamp
 *   2. Empty chain, `rejectEmpty: true` (default) → empty_chain
 *   3. Empty chain, `rejectEmpty: false` → valid w/ empty skipped
 *   4. Malformed principal (did:key:…) → malformed_principal
 *   5. Well-formed DID, agent not in registry → unknown_agent
 *   6. Agent registered but no nkey_pub → principal_has_no_nkey_pub
 *   7. Signer not in receiver's trust → signer_not_trusted
 *   8. Mixed chain — hub-stamp at 0 (skipped), ed25519 at 1 → valid w/ skipped:[0]
 *   9. Multi-stamp, second rejected → rejectedAt:1, reason carried, skipped:[]
 *
 * Structural checks only at this slice — the cryptographic ed25519 verify
 * lands in B.1c.
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { signEnvelope, type Identity } from "@the-metafactory/myelin/identity";
import { AgentRegistry } from "../../common/agents/registry";
import { TrustResolver } from "../../common/agents/trust-resolver";
import {
  verifySignedByChain,
  nkeyToBase64Pubkey,
  type ChainVerificationResult,
  type FederatedPeerResolution,
} from "../verify-signed-by-chain";
import {
  MultiPrincipalIdentityRegistry,
  PrincipalPubkeyResolver,
} from "../../common/registry";
import type { Envelope, SignedBy } from "../myelin/envelope-validator";
import type { Agent } from "../../common/types/cortex-config";

// =============================================================================
// Fixtures
// =============================================================================

// Valid 56-char U-prefixed base32 NKey shapes — same regex as
// StackConfigSchema.nkey_pub / AgentSchema.nkey_pub. The bytes don't
// have to be valid NATS keys for structural-trust tests; only the
// regex shape matters.
const NKEY_LUNA = "U" + "A".repeat(55);
const NKEY_ECHO = "U" + "B".repeat(55);
const NKEY_HOLLY = "U" + "C".repeat(55);

function discordPresence() {
  return {
    enabled: true,
    token: "discord-bot-token",
    guildId: "1111111111111111111",
    agentChannelId: "2222222222222222222",
    logChannelId: "3333333333333333333",
    contextDepth: 10,
    enableAgentLog: false,
    roles: [],
    defaultRole: "allow-all",
    dm: {
      operatorRole: {
        features: ["chat", "async", "team"] as const,
        disallowedTools: [],
        bashGuard: true,
      },
      defaultRole: "denied" as const,
      userRoles: [],
    },
  };
}

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    roles: [],
    trust: [],
    presence: { discord: discordPresence() },
    ...overrides,
  } as Agent;
}

function ed25519Stamp(principal: string): SignedBy {
  return {
    method: "ed25519",
    // R11 — stamp DID key is `identity` (post-myelin#184); `principal`
    // is no longer accepted on the wire. Parameter name kept as
    // `principal` to keep test call-sites readable.
    identity: principal,
    // 88-char base64 placeholder — the structural slice doesn't verify
    // signature bytes; B.1c will. Any string of the right rough shape.
    signature: "A".repeat(88),
    at: "2026-05-15T08:00:00.000Z",
  };
}

function hubStamp(principal: string, hub: string): SignedBy {
  return {
    method: "hub-stamp",
    // R11 — stamp DID key is `identity` post-myelin#184.
    identity: principal,
    stamped_by: hub,
    signature: "B".repeat(88),
    at: "2026-05-15T08:00:00.000Z",
  };
}

function envelopeWithChain(chain: SignedBy[] | SignedBy | undefined): Envelope {
  const base: Envelope = {
    id: "00000000-0000-4000-8000-000000000001",
    source: "metafactory.luna.local",
    type: "test.verify.case",
    timestamp: "2026-05-15T08:00:00.000Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 4,
      frontier_ok: false,
      model_class: "any",
    },
    payload: {},
  };
  if (chain !== undefined) {
    base.signed_by = chain;
  }
  return base;
}

function resolverWith(...agents: Agent[]): TrustResolver {
  return new TrustResolver(AgentRegistry.fromAgents(agents));
}

// =============================================================================
// Cases
// =============================================================================

describe("verifySignedByChain — happy path + skipped semantics", () => {
  test("[1] single trusted ed25519 stamp → valid with empty skipped", async () => {
    // Receiver "luna" trusts sender "echo" with known nkey.
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);

    const env = envelopeWithChain([ed25519Stamp("did:mf:echo")]);
    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.skipped).toEqual([]);
    }
  });

  test("[8] mixed chain — hub-stamp at index 0 (skipped), trusted ed25519 at index 1 → valid w/ skipped:[0]", async () => {
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);

    const env = envelopeWithChain([
      hubStamp("did:mf:echo", "did:mf:hub-alpha"),
      ed25519Stamp("did:mf:echo"),
    ]);
    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.skipped).toEqual([0]);
    }
  });
});

describe("verifySignedByChain — empty chain semantics", () => {
  test("[2] empty chain, rejectEmpty defaults to true → empty_chain rejection", async () => {
    const luna = agentFixture({ id: "luna" });
    const resolver = resolverWith(luna);
    const env = envelopeWithChain(undefined);

    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(0);
      expect(result.reason.kind).toBe("empty_chain");
      expect(result.skipped).toEqual([]);
    }
  });

  test("[3] empty chain, rejectEmpty explicit false → valid w/ empty skipped", async () => {
    const luna = agentFixture({ id: "luna" });
    const resolver = resolverWith(luna);
    const env = envelopeWithChain(undefined);

    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
      rejectEmpty: false,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.skipped).toEqual([]);
    }
  });
});

describe("verifySignedByChain — split rejection reasons", () => {
  test("[4] malformed principal (did:key:…) → malformed_principal", async () => {
    const luna = agentFixture({ id: "luna" });
    const resolver = resolverWith(luna);
    const env = envelopeWithChain([ed25519Stamp("did:key:abc123")]);

    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(0);
      expect(result.reason).toEqual({
        kind: "malformed_principal",
        principal: "did:key:abc123",
      });
    }
  });

  test("[5] well-formed did:mf but agent not registered → unknown_agent", async () => {
    const luna = agentFixture({ id: "luna" });
    const resolver = resolverWith(luna);
    const env = envelopeWithChain([ed25519Stamp("did:mf:nobody")]);

    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(0);
      expect(result.reason).toEqual({
        kind: "unknown_agent",
        principal: "did:mf:nobody",
        agentId: "nobody",
      });
    }
  });

  test("[6] agent registered but no nkey_pub → principal_has_no_nkey_pub", async () => {
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    // echo has no nkey_pub — intentional.
    const echo = agentFixture({ id: "echo", displayName: "Echo" });
    const resolver = resolverWith(luna, echo);

    const env = envelopeWithChain([ed25519Stamp("did:mf:echo")]);
    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(0);
      expect(result.reason).toEqual({
        kind: "principal_has_no_nkey_pub",
        principal: "did:mf:echo",
        agentId: "echo",
      });
    }
  });

  test("[7] signer's NKey known but receiver doesn't trust them → signer_not_trusted", async () => {
    // luna does NOT include echo in `trust:`.
    const luna = agentFixture({ id: "luna", trust: [] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);

    const env = envelopeWithChain([ed25519Stamp("did:mf:echo")]);
    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(0);
      expect(result.reason).toEqual({
        kind: "signer_not_trusted",
        principal: "did:mf:echo",
        agentId: "echo",
      });
    }
  });
});

describe("verifySignedByChain — multi-stamp rejection", () => {
  test("[9] valid stamp at index 0, untrusted stamp at index 1 → rejectedAt:1, skipped:[]", async () => {
    // luna trusts echo (NKey present) but not holly. Chain has echo first
    // (accepted), holly second (rejected — signer_not_trusted). Verify
    // that `rejectedAt: 1` carries the per-stamp index, and that the
    // pre-rejection accepts are NOT counted as skips (skips are
    // hub-stamps only).
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const holly = agentFixture({
      id: "holly",
      displayName: "Holly",
      nkey_pub: NKEY_HOLLY,
    });
    const resolver = resolverWith(luna, echo, holly);

    const env = envelopeWithChain([
      ed25519Stamp("did:mf:echo"),
      ed25519Stamp("did:mf:holly"),
    ]);
    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(1);
      expect(result.reason).toEqual({
        kind: "signer_not_trusted",
        principal: "did:mf:holly",
        agentId: "holly",
      });
      expect(result.skipped).toEqual([]);
    }
  });

  test("rejection on stamp 2 with hub-stamp at index 0 → skipped:[0] preserved", async () => {
    // Extra coverage on the new `skipped` carry-through behaviour for
    // failure variants: hub-stamp at 0 was skipped before the rejection
    // at index 2 fires, so the failure result must surface skipped:[0].
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);

    const env = envelopeWithChain([
      hubStamp("did:mf:echo", "did:mf:hub-alpha"),
      ed25519Stamp("did:mf:echo"),
      ed25519Stamp("did:mf:nobody"),
    ]);
    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(2);
      expect(result.reason.kind).toBe("unknown_agent");
      expect(result.skipped).toEqual([0]);
    }
  });
});

// =============================================================================
// Crypto-verify (B.1c)
// =============================================================================

/**
 * Generate a fresh ed25519 NATS user keypair for tests. Returns both
 * encodings cortex/myelin care about:
 *   - `nkeyPub`: the U-prefixed base32 NATS NKey shape — fed into
 *     `AgentSchema.nkey_pub` so `buildPrincipalRegistry` can derive
 *     the matching base64 ed25519 pubkey via `@nats-io/nkeys`.
 *   - `privateKeyBase64`: the 32-byte ed25519 seed encoded as base64 —
 *     what `signEnvelope` expects for the signing key argument.
 *
 * The seed returned by `getSeed()` is the 58-char NKey-encoded seed
 * (`SU...`). To get the raw 32-byte ed25519 seed `signEnvelope` wants,
 * we extract via the `_seed` field on the concrete `KP` class. This is
 * a test-only cast — production-side signing (B.3) will use a
 * cortex-controlled path that owns its own private-key storage shape.
 */
function generateEd25519KeyPair(): {
  nkeyPub: string;
  privateKeyBase64: string;
} {
  const kp = createUser();
  const nkeyPub = kp.getPublicKey();
  // KP's concrete class exposes `getRawSeed()` returning the 32-byte
  // ed25519 seed — that's the shape signEnvelope wants (which calls
  // bytesFromBase64 then expects 32 bytes). `getSeed()` returns the
  // wrapped 58-char NKey-encoded seed (`SU...`) which is the wrong
  // shape for crypto consumption.
  const rawSeed = (kp as unknown as { getRawSeed(): Uint8Array }).getRawSeed();
  const privateKeyBase64 = Buffer.from(rawSeed).toString("base64");
  return { nkeyPub, privateKeyBase64 };
}

describe("verifySignedByChain — cryptoVerify (B.1c)", () => {
  test("cryptoVerify accepts an envelope signed by a trusted agent's NKey", async () => {
    const { nkeyPub: echoNKey, privateKeyBase64: echoSeed } =
      generateEd25519KeyPair();
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: echoNKey,
    });
    const resolver = resolverWith(luna, echo);

    // Build an envelope WITHOUT signed_by, then have echo sign it via
    // myelin's signEnvelope. That produces a canonically-signed chain
    // that verifyEnvelopeIdentity will accept.
    // Cast through Parameters because cortex's Envelope.signed_by is
    // the back-compat union `SignedBy | SignedBy[] | undefined` while
    // myelin's MyelinEnvelope tightens to `SignedBy[] | undefined`.
    // For this test the envelope has no signed_by yet, so the cast
    // is structurally safe.
    const base = envelopeWithChain(undefined) as Parameters<
      typeof signEnvelope
    >[0];
    const signed = await signEnvelope(base, echoSeed, "did:mf:echo");

    const result: ChainVerificationResult = await verifySignedByChain(
      signed,
      {
        resolver,
        receivingAgentId: "luna",
        cryptoVerify: true,
        principalId: "test-principal",
      },
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.skipped).toEqual([]);
    }
  });

  test("cryptoVerify rejects an envelope whose signature was tampered post-signing", async () => {
    const { nkeyPub: echoNKey, privateKeyBase64: echoSeed } =
      generateEd25519KeyPair();
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: echoNKey,
    });
    const resolver = resolverWith(luna, echo);

    const base = envelopeWithChain(undefined) as Parameters<
      typeof signEnvelope
    >[0];
    const signed = await signEnvelope(base, echoSeed, "did:mf:echo");

    // Tamper: flip the signature so the bytes no longer match the
    // canonical envelope. Structurally the stamp still looks valid
    // (the principal is echo, NKey is registered, trust list includes
    // echo); only the bytes-check exposes the forgery.
    const chain = Array.isArray(signed.signed_by)
      ? signed.signed_by
      : signed.signed_by
        ? [signed.signed_by]
        : [];
    const firstStamp = chain[0];
    if (firstStamp?.method !== "ed25519") {
      throw new Error("test fixture: expected ed25519 stamp at index 0");
    }
    const tamperedSig = firstStamp.signature.startsWith("A")
      ? "B" + firstStamp.signature.slice(1)
      : "A" + firstStamp.signature.slice(1);
    const tamperedEnvelope: Envelope = {
      ...signed,
      signed_by: [{ ...firstStamp, signature: tamperedSig }],
    };

    const result = await verifySignedByChain(tamperedEnvelope, {
      resolver,
      receivingAgentId: "luna",
      cryptoVerify: true,
      principalId: "test-principal",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.kind).toBe("crypto_verify_failed");
      if (result.reason.kind === "crypto_verify_failed") {
        // myelin's reason string carries the specific failure class
        // (signature mismatch vs. timestamp drift vs. principal lookup).
        // We don't pin the exact text — myelin may rephrase — but we
        // assert it isn't an empty / placeholder string.
        expect(result.reason.myelinReason.length).toBeGreaterThan(0);
      }
    }
  });

  test("[cortex#480] cryptoVerify accepts a self-signed envelope from the receiving stack", async () => {
    // The stack has private-key authority for its own DID. Adapter-
    // originated dispatches arrive signed by the stack identity
    // (`did:mf:<principal>-<stack>`), NOT by an agent in the registry.
    // The verifier must short-circuit + bytes-check against the stack's
    // own NKey.
    const stackIdentity = "did:mf:andreas-meta-factory";
    const { nkeyPub: stackNKeyPub, privateKeyBase64: stackSeed } =
      generateEd25519KeyPair();
    // Only luna is registered as an agent. The stack identity is NOT.
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = resolverWith(luna);

    const base = envelopeWithChain(undefined) as Parameters<
      typeof signEnvelope
    >[0];
    const signed = await signEnvelope(base, stackSeed, stackIdentity);

    const result = await verifySignedByChain(signed, {
      resolver,
      receivingAgentId: "luna",
      cryptoVerify: true,
      principalId: "andreas",
      stackIdentity,
      stackNKeyPub,
    });

    expect(result.valid).toBe(true);
  });

  test("[cortex#480] structural-only own-stack short-circuit (no agent registry hit needed)", async () => {
    const stackIdentity = "did:mf:andreas-meta-factory";
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = resolverWith(luna);

    // Stamp claims the stack identity. The stack is NOT in the agent
    // registry — pre-fix this would reject as `unknown_agent`.
    const env = envelopeWithChain([ed25519Stamp(stackIdentity)]);
    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
      stackIdentity,
      // cryptoVerify deliberately omitted — structural-only path
      // exercises the short-circuit in isolation.
    });

    expect(result.valid).toBe(true);
  });

  test("[cortex#480] rejects when stack DID does NOT match opts.stackIdentity", async () => {
    // Defence in depth: a stamp claiming a *different* stack DID does
    // NOT get the short-circuit; it falls back to the registry lookup
    // and is rejected as `unknown_agent`.
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = resolverWith(luna);

    const env = envelopeWithChain([
      ed25519Stamp("did:mf:other-stack"),
    ]);
    const result = await verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
      stackIdentity: "did:mf:andreas-meta-factory",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.kind).toBe("unknown_agent");
    }
  });

  test("[cortex#480] cryptoVerify rejects tampered self-signed stack envelope", async () => {
    // Short-circuit handles TRUST; bytes-check still runs and catches
    // forgery claiming the stack identity.
    const stackIdentity = "did:mf:andreas-meta-factory";
    const { nkeyPub: stackNKeyPub, privateKeyBase64: stackSeed } =
      generateEd25519KeyPair();
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = resolverWith(luna);

    const base = envelopeWithChain(undefined) as Parameters<
      typeof signEnvelope
    >[0];
    const signed = await signEnvelope(base, stackSeed, stackIdentity);

    const chain = Array.isArray(signed.signed_by)
      ? signed.signed_by
      : signed.signed_by
        ? [signed.signed_by]
        : [];
    const firstStamp = chain[0];
    if (firstStamp?.method !== "ed25519") {
      throw new Error("test fixture: expected ed25519 stamp at index 0");
    }
    const tamperedSig = firstStamp.signature.startsWith("A")
      ? "B" + firstStamp.signature.slice(1)
      : "A" + firstStamp.signature.slice(1);
    const tamperedEnvelope: Envelope = {
      ...signed,
      signed_by: [{ ...firstStamp, signature: tamperedSig }],
    };

    const result = await verifySignedByChain(tamperedEnvelope, {
      resolver,
      receivingAgentId: "luna",
      cryptoVerify: true,
      principalId: "andreas",
      stackIdentity,
      stackNKeyPub,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.kind).toBe("crypto_verify_failed");
    }
  });

  test("cryptoVerify throws when principalId is missing", async () => {
    // Agent must have an nkey_pub + be self-trusted so the structural
    // check passes and the cryptoVerify-without-principalId branch is
    // reached. (A structural rejection would mask the principalId guard.)
    const { nkeyPub: lunaNKey } = generateEd25519KeyPair();
    const luna = agentFixture({
      id: "luna",
      trust: ["luna"],
      nkey_pub: lunaNKey,
    });
    const resolver = resolverWith(luna);
    const env = envelopeWithChain([ed25519Stamp("did:mf:luna")]);

    // bun's `expect(promise).rejects.toThrow` is the canonical pattern
    // for promise-rejection assertions; `expect(async fn).toThrow`
    // doesn't await the inner async call before checking, which silently
    // passes the test even when the function does throw.
    await expect(
      verifySignedByChain(env, {
        resolver,
        receivingAgentId: "luna",
        cryptoVerify: true,
        // principalId omitted — must throw.
      }),
    ).rejects.toThrow(/principalId/);
  });
});

// =============================================================================
// TC-2d (cortex#635) — federated.* crypto-verify against registry-resolved
// peer pubkeys. The CAPSTONE of the cross-principal trust chain.
// =============================================================================

/**
 * Build a `federated.*` envelope whose SOURCE is the peer principal. The
 * signer peer principal the verifier resolves is the leading dotted segment
 * of `envelope.source` (`principalFromEnvelope`), e.g. `bravo` for
 * `bravo.bravo-stack.review`. The `federated.{network_id}` SUBJECT segment
 * (cortex#661) names the TARGET network and is irrelevant to signer
 * resolution — the test fixtures deliberately don't set a subject.
 */
function federatedEnvelopeFrom(peerPrincipal: string): Envelope {
  return {
    id: "00000000-0000-4000-8000-0000000000fe",
    source: `${peerPrincipal}.${peerPrincipal}-stack.review`,
    type: "test.federated.case",
    timestamp: "2026-06-04T08:00:00.000Z",
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 4,
      frontier_ok: false,
      model_class: "any",
    },
    payload: {},
  };
}

/**
 * The peer's verified myelin `Identity` — the shape the TC-2b
 * `MultiPrincipalIdentityRegistry.resolveFederatedPeer` returns and the
 * verifier merges into the crypto-verify registry. `public_key` is the
 * base64 raw ed25519 derived from the peer's NKey (the SAME key the peer
 * signs with), keyed by `did:mf:<peerPrincipal>`.
 */
function peerIdentity(peerPrincipal: string, nkeyPub: string): Identity {
  const publicKey = nkeyToBase64Pubkey(nkeyPub);
  if (publicKey === undefined) {
    throw new Error("test fixture: peer NKey did not decode");
  }
  return {
    id: `did:mf:${peerPrincipal}`,
    display_name: peerPrincipal,
    network: peerPrincipal,
    public_key: publicKey,
    type: "agent",
    created_at: new Date(0).toISOString(),
  };
}

describe("verifySignedByChain — TC-2d federated.* peer verify (cortex#635)", () => {
  test("federated envelope, peer resolvable + signature valid → ACCEPTED", async () => {
    const peer = "bravo";
    const { nkeyPub: peerNKey, privateKeyBase64: peerSeed } =
      generateEd25519KeyPair();
    // Only the LOCAL agent luna is in the registry — the peer is NOT a
    // local agent; it is admitted purely via the federated resolve seam.
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = resolverWith(luna);

    // The peer signs the federated envelope with ITS principal DID.
    const base = federatedEnvelopeFrom(peer) as Parameters<
      typeof signEnvelope
    >[0];
    const signed = await signEnvelope(base, peerSeed, `did:mf:${peer}`);

    let resolveCalls = 0;
    const resolveFederatedPeer = async (
      p: string,
    ): Promise<FederatedPeerResolution> => {
      resolveCalls++;
      expect(p).toBe(peer); // signer peer = source's leading segment
      return { resolved: true, identity: peerIdentity(peer, peerNKey) };
    };

    const result = await verifySignedByChain(signed, {
      resolver,
      receivingAgentId: "luna",
      cryptoVerify: true,
      principalId: "alpha",
      resolveFederatedPeer,
    });

    expect(result.valid).toBe(true);
    expect(resolveCalls).toBe(1);
  });

  test("federated envelope, peer resolvable but signature forged → REJECTED (crypto_verify_failed)", async () => {
    const peer = "bravo";
    const { nkeyPub: peerNKey, privateKeyBase64: peerSeed } =
      generateEd25519KeyPair();
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = resolverWith(luna);

    const base = federatedEnvelopeFrom(peer) as Parameters<
      typeof signEnvelope
    >[0];
    const signed = await signEnvelope(base, peerSeed, `did:mf:${peer}`);

    // Tamper the signature bytes — the peer resolves fine, but the bytes
    // no longer match the canonical envelope.
    const chain = Array.isArray(signed.signed_by)
      ? signed.signed_by
      : signed.signed_by
        ? [signed.signed_by]
        : [];
    const firstStamp = chain[0];
    if (firstStamp?.method !== "ed25519") {
      throw new Error("test fixture: expected ed25519 stamp at index 0");
    }
    const tamperedSig = firstStamp.signature.startsWith("A")
      ? "B" + firstStamp.signature.slice(1)
      : "A" + firstStamp.signature.slice(1);
    const tampered: Envelope = {
      ...signed,
      signed_by: [{ ...firstStamp, signature: tamperedSig }],
    };

    const result = await verifySignedByChain(tampered, {
      resolver,
      receivingAgentId: "luna",
      cryptoVerify: true,
      principalId: "alpha",
      resolveFederatedPeer: async () => ({
        resolved: true,
        identity: peerIdentity(peer, peerNKey),
      }),
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.kind).toBe("crypto_verify_failed");
    }
  });

  test("federated envelope, valid signature by the WRONG key → REJECTED (crypto_verify_failed)", async () => {
    // The sharpest statement of the threat: the attacker produces a fully
    // VALID ed25519 signature — just with THEIR OWN key — while stamping the
    // peer's DID and setting source to the peer. The registry resolves the
    // peer's REAL (different) pubkey, and the bytes-check verifies the stamp
    // against THAT key, not the attacker's → rejected. Distinct from the
    // byte-tamper case above: nothing is malformed; only the signing key is
    // wrong, which is exactly the cross-principal forgery the resolved-key
    // bytes-check exists to defeat.
    const peer = "bravo";
    const { nkeyPub: peerRealNKey } = generateEd25519KeyPair(); // bravo's real key (in registry)
    const { privateKeyBase64: attackerSeed } = generateEd25519KeyPair(); // attacker's key
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = resolverWith(luna);

    // Attacker signs with THEIR seed but stamps bravo's DID + bravo's source.
    const base = federatedEnvelopeFrom(peer) as Parameters<
      typeof signEnvelope
    >[0];
    const forged = await signEnvelope(base, attackerSeed, `did:mf:${peer}`);

    const result = await verifySignedByChain(forged, {
      resolver,
      receivingAgentId: "luna",
      cryptoVerify: true,
      principalId: "alpha",
      // Registry returns bravo's REAL pubkey — not the attacker's.
      resolveFederatedPeer: async () => ({
        resolved: true,
        identity: peerIdentity(peer, peerRealNKey),
      }),
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.kind).toBe("crypto_verify_failed");
    }
  });

  test("federated envelope, peer NOT in registry (not_found) → REJECTED + logged", async () => {
    const peer = "ghost";
    const { privateKeyBase64: peerSeed } = generateEd25519KeyPair();
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = resolverWith(luna);

    const base = federatedEnvelopeFrom(peer) as Parameters<
      typeof signEnvelope
    >[0];
    const signed = await signEnvelope(base, peerSeed, `did:mf:${peer}`);

    const result = await verifySignedByChain(signed, {
      resolver,
      receivingAgentId: "luna",
      cryptoVerify: true,
      principalId: "alpha",
      // Peer unverifiable — the registry returned not_found.
      resolveFederatedPeer: async () => ({
        resolved: false,
        reason: "not_found",
      }),
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.kind).toBe("federated_peer_unresolved");
      if (result.reason.kind === "federated_peer_unresolved") {
        expect(result.reason.peerPrincipal).toBe(peer);
        expect(result.reason.detail).toBe("not_found");
      }
    }
  });

  test("local.* envelope under enforce → boot-identity verify, peer seam NEVER consulted", async () => {
    // The single-principal path: a local.* envelope verifies against the
    // boot/local identity exactly as today. The federated resolve seam,
    // even when supplied, is NOT engaged for a non-federated envelope.
    const { nkeyPub: echoNKey, privateKeyBase64: echoSeed } =
      generateEd25519KeyPair();
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: echoNKey,
    });
    const resolver = resolverWith(luna, echo);

    // envelopeWithChain builds a `local` classification envelope.
    const base = envelopeWithChain(undefined) as Parameters<
      typeof signEnvelope
    >[0];
    const signed = await signEnvelope(base, echoSeed, "did:mf:echo");

    let seamCalls = 0;
    const result = await verifySignedByChain(signed, {
      resolver,
      receivingAgentId: "luna",
      cryptoVerify: true,
      rejectEmpty: true, // enforce posture
      principalId: "alpha",
      resolveFederatedPeer: async () => {
        seamCalls++;
        return { resolved: false, reason: "unresolved" };
      },
    });

    expect(result.valid).toBe(true);
    // The capstone invariant: local.* NEVER touches the peer seam.
    expect(seamCalls).toBe(0);
  });

  test("federated envelope WITHOUT a peer seam → verifies local-only (no resolve), unchanged", async () => {
    // off/permissive postures omit the seam entirely. A federated envelope
    // then verifies against the local registry only — exactly today's
    // behaviour. Here the peer is not a local agent, so the crypto pass
    // rejects as a normal local-registry miss (NOT federated_peer_unresolved),
    // proving the federated branch is never entered without a seam.
    const peer = "bravo";
    const { privateKeyBase64: peerSeed } = generateEd25519KeyPair();
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = resolverWith(luna);

    const base = federatedEnvelopeFrom(peer) as Parameters<
      typeof signEnvelope
    >[0];
    const signed = await signEnvelope(base, peerSeed, `did:mf:${peer}`);

    const result = await verifySignedByChain(signed, {
      resolver,
      receivingAgentId: "luna",
      cryptoVerify: true,
      principalId: "alpha",
      // resolveFederatedPeer deliberately omitted (off/permissive shape).
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      // The stamp's `did:mf:bravo` is not a local agent → structural
      // unknown_agent rejection. The point: NO federated_peer_unresolved,
      // because the federated branch is never reached without a seam.
      expect(result.reason.kind).not.toBe("federated_peer_unresolved");
    }
  });

  test("[S-1 hardening] federated seam wired but cryptoVerify:false → NO structural short-circuit (fail closed)", async () => {
    // The federated structural short-circuit is only safe when the crypto
    // bytes-check runs. With cryptoVerify off, a resolved peer must NOT be
    // admitted structurally (that would accept a forged stamp on the
    // strength of an unauthenticated source segment). It must fall through
    // to the normal structural walk and fail closed.
    const peer = "bravo";
    const { nkeyPub: peerNKey, privateKeyBase64: peerSeed } =
      generateEd25519KeyPair();
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = resolverWith(luna);

    const base = federatedEnvelopeFrom(peer) as Parameters<
      typeof signEnvelope
    >[0];
    const signed = await signEnvelope(base, peerSeed, `did:mf:${peer}`);

    let seamCalls = 0;
    const result = await verifySignedByChain(signed, {
      resolver,
      receivingAgentId: "luna",
      cryptoVerify: false, // ← no bytes-check; short-circuit must NOT engage
      principalId: "alpha",
      resolveFederatedPeer: async () => {
        seamCalls++;
        return { resolved: true, identity: peerIdentity(peer, peerNKey) };
      },
    });

    // Seam never consulted (gated on cryptoVerify), peer falls through to
    // structural unknown_agent — fail closed.
    expect(seamCalls).toBe(0);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.kind).toBe("unknown_agent");
    }
  });
});

// =============================================================================
// TC-2d #635 LOAD-BEARING GATE — posture OFF/permissive performs ZERO
// registry I/O on an inbound federated envelope. Exercises the REAL
// PrincipalPubkeyResolver + MultiPrincipalIdentityRegistry stack with an
// ephemeral Bun.serve({ port: 0 }) fetch spy (NEVER a hardcoded port).
// =============================================================================

describe("verifySignedByChain — TC-2d #635 zero-registry-I/O when posture is not enforce", () => {
  test("off/permissive: inbound federated envelope drives ZERO registry fetches", async () => {
    // Count every fetch the registry would receive — the assertion is that
    // it stays at 0 because a disabled resolver is INERT (no network).
    let fetchCount = 0;
    const server = Bun.serve({
      port: 0, // ephemeral — OS assigns a free port (#671 de-flake pattern)
      fetch() {
        fetchCount++;
        return new Response("should never be reached", { status: 500 });
      },
    });
    const baseUrl = server.url.toString().replace(/\/$/, "");

    try {
      const peer = "bravo";
      const { privateKeyBase64: peerSeed } = generateEd25519KeyPair();
      const luna = agentFixture({ id: "luna", trust: [] });
      const resolver = resolverWith(luna);

      // The REAL stack, but with `enabled: false` — exactly the shape
      // `resolveSigningKnobs` would yield for `off`/`permissive` (where the
      // #635 gate keeps the resolver disabled even though `cryptoVerify` is
      // true for all postures). Boot principal pinned, peer resolver wired
      // but DISABLED.
      const peerResolver = new PrincipalPubkeyResolver({
        enabled: false, // ← the gate: signing !== "enforce"
        baseUrl,
        registryPubkey: "A".repeat(43) + "=",
        logError: () => {},
      });
      const peerRegistry = new MultiPrincipalIdentityRegistry({
        bootPrincipal: {
          principalId: "alpha",
          identity: {
            id: "did:mf:alpha-stack",
            display_name: "alpha-stack",
            network: "alpha",
            public_key: "A".repeat(43) + "=",
            type: "agent",
            created_at: new Date(0).toISOString(),
          },
        },
        resolver: peerResolver,
        logError: () => {},
      });

      const base = federatedEnvelopeFrom(peer) as Parameters<
        typeof signEnvelope
      >[0];
      const signed = await signEnvelope(base, peerSeed, `did:mf:${peer}`);

      const result = await verifySignedByChain(signed, {
        resolver,
        receivingAgentId: "luna",
        cryptoVerify: true, // true for ALL postures (cheap observability)
        principalId: "alpha",
        // The seam IS wired here — proving that even when wired, a disabled
        // resolver does zero I/O. (In cortex.ts the seam is `undefined`
        // entirely under off/permissive — a strictly stronger guarantee.)
        resolveFederatedPeer:
          peerRegistry.resolveFederatedPeer.bind(peerRegistry),
      });

      // The peer is unverifiable because the resolver is disabled → reject.
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.kind).toBe("federated_peer_unresolved");
        if (result.reason.kind === "federated_peer_unresolved") {
          expect(result.reason.detail).toBe("disabled");
        }
      }
      // THE LOAD-BEARING ASSERTION: zero registry I/O. A dev stack
      // (signing off/permissive) NEVER reaches out to the registry.
      expect(fetchCount).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
