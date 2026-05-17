/**
 * Thread C (P-VERIFY round-trip) — signed pilot-shape envelope end-to-end.
 *
 * **What this test proves.** A `tasks.code-review.<flavor>` envelope built
 * via the production `createReviewRequestEvent` builder (the same builder
 * pilot's `buildReviewRequestedEnvelope` morally mirrors — both produce the
 * wire shape pilot publishes) survives a full `signEnvelope` →
 * `verifySignedByChain({ cryptoVerify: true })` round-trip with the same
 * canonicalisation, trust-resolution, and ed25519-verification path
 * cortex's bus-peer harness uses on inbound (`src/substrates/bus-peer/harness.ts`).
 *
 * The existing `src/bus/__tests__/verify-signed-by-chain.test.ts` already
 * pins crypto round-trip against a synthetic `test.verify.case` envelope.
 * What was missing was the pin against the **production review-request
 * envelope shape** — if `createReviewRequestEvent` ever drifts (e.g. emits
 * a field whose JCS canonicalisation differs between sign-time and
 * verify-time, or adds an `undefined` field that breaks canonical ordering),
 * the synthetic-fixture test wouldn't catch it. This file is the wire-shape
 * regression guard.
 *
 * **The wiring gap this test surfaces (filed separately).** cortex#322
 * wired `verifySignedByChain` into `src/runner/dispatch-listener.ts` and
 * `src/substrates/bus-peer/harness.ts`. The review-consumer path
 * (`src/bus/review-consumer.ts`) does NOT yet call `verifySignedByChain` on
 * inbound `tasks.code-review.*` envelopes. So while pilot can produce
 * signed envelopes and cortex's verifier accepts them (this test proves
 * both halves work), the review-consumer route doesn't actually enforce
 * the chain. Follow-up issue **cortex#327** tracks the wiring; this test
 * pins the cryptographic contract so the wiring change is a one-line
 * addition, not a "re-derive the verify story from scratch" exercise.
 *
 * **Why bus-peer's pattern, not dispatch-listener's.** dispatch-listener
 * reads `signed_by[0].principal` to attribute task dispatches but does NOT
 * call `verifySignedByChain` — that's a known IAW Phase A.2 deferral
 * (see `dispatch-listener.ts:664-690` doc). The bus-peer harness is the
 * canonical site for inbound verification today; the review-consumer
 * wiring follow-up mirrors that pattern.
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { signEnvelope } from "@the-metafactory/myelin/identity";
import { createReviewRequestEvent, type ReviewEventSource } from "../bus/review-events";
import {
  verifySignedByChain,
  type ChainVerificationResult,
} from "../bus/verify-signed-by-chain";
import { AgentRegistry } from "../common/agents/registry";
import { TrustResolver } from "../common/agents/trust-resolver";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { Agent } from "../common/types/cortex-config";

// =============================================================================
// Fixtures
// =============================================================================

/**
 * Generate a fresh ed25519 keypair in both encodings the crypto path needs.
 * Same pattern as `verify-signed-by-chain.test.ts`'s `generateEd25519KeyPair`,
 * inlined here so this test file is self-contained — Thread C is a
 * cross-cutting acceptance pin and shouldn't reach across test directories.
 */
function generateEd25519KeyPair(): { nkeyPub: string; privateKeyBase64: string } {
  const kp = createUser();
  const nkeyPub = kp.getPublicKey();
  const rawSeed = (kp as unknown as { getRawSeed(): Uint8Array }).getRawSeed();
  const privateKeyBase64 = Buffer.from(rawSeed).toString("base64");
  return { nkeyPub, privateKeyBase64 };
}

/** Minimal `discord` block required by `AgentSchema`. Mirrors the helper in
 *  `verify-signed-by-chain.test.ts`. */
function discordPresence() {
  return {
    enabled: true,
    token: "discord-bot-token",
    guildId: "1487000000000000000",
    agentChannelId: "1487000000000000001",
    logChannelId: "1487000000000000002",
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
    id: "cortex",
    displayName: "Cortex",
    persona: "./personas/cortex.md",
    roles: [],
    trust: [],
    presence: { discord: discordPresence() },
    ...overrides,
  } as Agent;
}

const PILOT_SOURCE: ReviewEventSource = {
  org: "metafactory",
  agent: "pilot",
  instance: "local",
};

const SAMPLE_PAYLOAD = {
  repo: "the-metafactory/pilot",
  pr: 133,
  reviewer: "sage",
  feature: "thread-a",
  title: "Thread A — derive envelope source from operator-id",
  cycle: 1,
};

/**
 * Build a pilot-shape envelope using cortex's production helper. The shape
 * mirrors what pilot's `buildReviewRequestedEnvelope` (in pilot/src/bus/
 * publish-review-request.ts) emits — the two helpers landed independently
 * but converge on the same on-wire shape per design-pilot-restructure §4.1.
 */
function buildPilotShapeRequest(): Envelope {
  return createReviewRequestEvent({
    source: PILOT_SOURCE,
    flavor: "typescript",
    payload: SAMPLE_PAYLOAD,
  });
}

// =============================================================================
// Cases
// =============================================================================

describe("Thread C — signed pilot-shape envelope round-trip (P-VERIFY)", () => {
  test("happy path — pilot-shape envelope signed by pilot principal verifies under cortex's chain validator", async () => {
    // Pilot's keypair: would in production come from
    // `~/.config/nats/pilot.creds`'s seed via the standard NSC path; we
    // generate ephemerally for hermetic testing. The Principal DID is the
    // shape cortex's `extractAgentIdFromDid` parses (`did:mf:<agent-id>`).
    const { nkeyPub: pilotNKey, privateKeyBase64: pilotSeed } =
      generateEd25519KeyPair();

    // Receiver (cortex agent) trusts pilot. Both agents need NKeys so the
    // structural-trust + crypto-trust layers each have the data they need.
    const cortex = agentFixture({ id: "cortex", trust: ["pilot"] });
    const pilot = agentFixture({
      id: "pilot",
      displayName: "Pilot",
      nkey_pub: pilotNKey,
    });
    const resolver = new TrustResolver(AgentRegistry.fromAgents([cortex, pilot]));

    // Build the production envelope shape, then sign it. Cast is the
    // same back-compat-union widening used in `verify-signed-by-chain.test.ts`:
    // cortex's `Envelope.signed_by` keeps a `SignedBy | SignedBy[] | undefined`
    // back-compat shape while myelin's `MyelinEnvelope` tightens to array
    // only. The unsigned envelope has `signed_by: undefined` so the cast
    // is structurally safe.
    const request = buildPilotShapeRequest();
    const signed = await signEnvelope(
      request as Parameters<typeof signEnvelope>[0],
      pilotSeed,
      "did:mf:pilot",
    );

    const result: ChainVerificationResult = await verifySignedByChain(signed, {
      resolver,
      receivingAgentId: "cortex",
      cryptoVerify: true,
      operatorId: "metafactory",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.skipped).toEqual([]);
    }

    // Wire-shape spot check — confirm the signed envelope still carries
    // the production fields after signing (signing must NOT mutate the
    // payload or core fields; only `signed_by` is appended).
    expect(signed.type).toBe("tasks.code-review.typescript");
    expect(signed.source).toBe("metafactory.pilot.local");
    expect((signed.payload as { repo: string }).repo).toBe(SAMPLE_PAYLOAD.repo);
    expect((signed.payload as { pr: number }).pr).toBe(SAMPLE_PAYLOAD.pr);
    expect(signed.id).toBe(request.id);
  });

  test("tampered payload — re-canonicalisation reveals the forgery", async () => {
    // Mutate the payload AFTER signing. Verifier re-canonicalises the
    // envelope and runs ed25519 verify against the canonical bytes; any
    // post-sign mutation breaks the bytes the signature was over.
    //
    // This is the load-bearing safety property: a man-in-the-middle on
    // the bus can't change PR numbers, repo paths, or reviewer identity
    // without invalidating the chain.
    const { nkeyPub: pilotNKey, privateKeyBase64: pilotSeed } =
      generateEd25519KeyPair();
    const cortex = agentFixture({ id: "cortex", trust: ["pilot"] });
    const pilot = agentFixture({
      id: "pilot",
      displayName: "Pilot",
      nkey_pub: pilotNKey,
    });
    const resolver = new TrustResolver(AgentRegistry.fromAgents([cortex, pilot]));

    const request = buildPilotShapeRequest();
    const signed = await signEnvelope(
      request as Parameters<typeof signEnvelope>[0],
      pilotSeed,
      "did:mf:pilot",
    );

    // Tamper: bump the PR number on the published envelope. Signature
    // still attaches but covers the wrong canonical bytes now.
    const tampered: Envelope = {
      ...signed,
      payload: {
        ...(signed.payload as Record<string, unknown>),
        pr: 9999,
      },
    };

    const result = await verifySignedByChain(tampered, {
      resolver,
      receivingAgentId: "cortex",
      cryptoVerify: true,
      operatorId: "metafactory",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.kind).toBe("crypto_verify_failed");
      if (result.reason.kind === "crypto_verify_failed") {
        expect(result.reason.myelinReason.length).toBeGreaterThan(0);
      }
    }
  });

  test("untrusted signer — structural check rejects before crypto runs", async () => {
    // Pilot signs the envelope correctly, but cortex's agent fixture
    // does NOT include pilot in its `trust:` list. The chain has a valid
    // signature, but the receiver's local policy says "I don't admit
    // envelopes from this principal" — structural-trust rejection at
    // `signer_not_trusted` (which is the structural-trust class for "the
    // bytes might verify but you can't accept them anyway").
    const { nkeyPub: pilotNKey, privateKeyBase64: pilotSeed } =
      generateEd25519KeyPair();
    // Note: cortex's `trust:` list omits "pilot".
    const cortex = agentFixture({ id: "cortex", trust: [] });
    const pilot = agentFixture({
      id: "pilot",
      displayName: "Pilot",
      nkey_pub: pilotNKey,
    });
    const resolver = new TrustResolver(AgentRegistry.fromAgents([cortex, pilot]));

    const request = buildPilotShapeRequest();
    const signed = await signEnvelope(
      request as Parameters<typeof signEnvelope>[0],
      pilotSeed,
      "did:mf:pilot",
    );

    const result = await verifySignedByChain(signed, {
      resolver,
      receivingAgentId: "cortex",
      cryptoVerify: true,
      operatorId: "metafactory",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      // The structural check fires BEFORE the crypto pass, so the
      // rejection reason is the trust-list miss, not a crypto failure.
      // Fails-closed-on-trust: even if the bytes verify, the operator's
      // local policy holds the gate.
      expect(result.reason.kind).toBe("signer_not_trusted");
      expect(result.rejectedAt).toBe(0);
    }
  });

  test("empty chain — unsigned pilot envelope rejected by default", async () => {
    // P-VERIFY operational stance: post-cortex#325 (stack signing ON by
    // default), an unsigned envelope arriving at a cortex with `trust:`
    // configured is treated as a fail-closed condition. Pin the
    // `empty_chain` rejection here so a future relaxation of the default
    // surfaces as a deliberate test change rather than a silent regression.
    const cortex = agentFixture({ id: "cortex", trust: ["pilot"] });
    const pilot = agentFixture({
      id: "pilot",
      displayName: "Pilot",
      nkey_pub: "U" + "Z".repeat(55), // shape-valid placeholder; the empty-chain
                                       // path never reaches crypto.
    });
    const resolver = new TrustResolver(AgentRegistry.fromAgents([cortex, pilot]));

    const unsigned = buildPilotShapeRequest();
    const result = await verifySignedByChain(unsigned, {
      resolver,
      receivingAgentId: "cortex",
      // rejectEmpty defaults to true — explicit here so the contract is
      // visible at the call site.
      rejectEmpty: true,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.kind).toBe("empty_chain");
    }
  });
});
