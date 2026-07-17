/**
 * WP-1 (cortex#1877, epic #1876) — FEDERATED PRESENCE E2E HARNESS.
 *
 * ## Why this file exists
 *
 * `src/__tests__/iaw-phase-b-integration.test.ts` already stands up two
 * in-process stacks with real signers and runs real chain verification — and it
 * PASSES. Yet three federated addressing bugs (#1812, #1852, …) shipped under
 * that green suite. The reason is structural: its `fanOut` helper (`:109`)
 * builds `` `local.${orgSegment}.${envelope.type}` `` — a LOCAL subject — and it
 * never touches presence at all. A harness that never constructs a
 * `federated.{principal}.{stack}.…` subject cannot catch a federated-addressing
 * bug.
 *
 * This harness closes that gap. It fans REAL federated presence subjects between
 * two in-process stacks and drives the receive path end-to-end:
 *
 *   alpha: AgentPresenceProducer (real) → federated `agent.online` envelope
 *        → signEnvelope (mirrors `MyelinRuntime.publish`'s signing stamp)
 *   wire:  `federated.alpha.meta-factory.agent.online`  ← REAL subject grammar
 *   beta:  startFederatedAgentPresenceSubscriber (real)
 *        → evaluateFederationGate (real)      — TRUST GATE 1 (accept-list)
 *        → verifySignedByChain (real, ed25519) — TRUST GATE 2 (chain)
 *        → AgentPresenceRegistry.applyForeign (real fold)
 *
 * ## HARD FIXTURE RULE — never a stack slug of `default`
 *
 * Both fixtures use NON-`default`, hyphen-bearing slugs (`alpha/meta-factory`,
 * `beta/sage-host`). A stack named `default` masks this entire bug class: it is
 * exactly how #1812 hid for two days (a `default` slug collapses the
 * `{principal}.{stack}` distinction and makes a mis-addressed subject look
 * right). The hyphen exercises the `did:mf:{principal}-{stack}` ambiguity that
 * WP-3/WP-4 close. If you touch these fixtures, keep both properties.
 *
 * ## Scope
 *
 * Test-only. No production source is modified. The subject is constructed inline
 * (WP-2's codec does not exist yet; WP-5 migrates this call site). Real
 * NATS / leaf nodes / NSC are WP-7 — this is in-process fan-out.
 *
 * The `test.todo` entries below are this epic's progress meter: each flips live
 * when its gating slice merges.
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { signEnvelope, type Identity } from "@the-metafactory/myelin/identity";

import { AgentPresenceProducer } from "../runner/agent-presence-producer";
import type { PresenceScheduler } from "../runner/agent-presence-producer";
import {
  startFederatedAgentPresenceSubscriber,
  federatedAgentPresenceSubject,
} from "../bus/agent-network/federated-subscriber";
import { AgentPresenceRegistry, isForeignOrigin } from "../bus/agent-network/registry";
import { deriveAcceptSubjects } from "../bus/agent-network/accept-subjects";
import { subjectMatches } from "../bus/surface-router";
import { nkeyToBase64Pubkey } from "../bus/verify-signed-by-chain";
import type { FederatedPeerResolution } from "../bus/verify-signed-by-chain";
import { AgentRegistry } from "../common/agents/registry";
import { TrustResolver } from "../common/agents/trust-resolver";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";
import type { MyelinSubscriber } from "../bus/myelin/subscriber";
import type { SystemEventSource } from "../bus/system-events";
import type {
  Agent,
  PolicyFederated,
  PolicyFederatedNetwork,
} from "../common/types/cortex-config";

// =============================================================================
// Fixtures — NON-`default` slugs, both hyphen-bearing (see file header)
// =============================================================================

/** The EMITTING stack. Hyphen in the stack slug is deliberate (DID ambiguity). */
const ALPHA = { principal: "alpha", stack: "meta-factory" } as const;
/** The RECEIVING stack. Hyphen in the stack slug is deliberate. */
const BETA = { principal: "beta", stack: "sage-host" } as const;

/** The stack signing DID class production stamps: `did:mf:{principal}-{stack}`. */
function stackDid(id: { principal: string; stack: string }): string {
  return `did:mf:${id.principal}-${id.stack}`;
}

/** The wire subject alpha's `agent.online` lands on. Asserted, never assumed. */
const ALPHA_ONLINE_SUBJECT = "federated.alpha.meta-factory.agent.online";

/** Beta's `system.access.denied` audit identity. */
const BETA_SYSTEM_SOURCE: SystemEventSource = {
  principal: BETA.principal,
  agent: "cortex",
  instance: "local",
};

/** The network both stacks share. `leaf_node: "primary"` ⇒ no anti-spoof leaf check. */
function sharedNetwork(acceptSubjects: string[]): PolicyFederatedNetwork {
  return {
    id: "wp1-federated-presence",
    leaf_node: "primary",
    // The gate resolves the SOURCE network from the SOURCE principal's
    // `peers[]` membership — the network is never on the wire (ADR-0001).
    peers: [
      {
        principal_id: ALPHA.principal,
        stack_id: `${ALPHA.principal}/${ALPHA.stack}`,
      },
    ],
    accept_subjects: acceptSubjects,
    deny_subjects: [],
    announce_capabilities: [],
    // Chain length is 1 (alpha's single stamp); `max_hop: 0` would deny it.
    max_hop: 3,
  };
}

function federatedPolicy(networks: PolicyFederatedNetwork[]): PolicyFederated {
  return { networks };
}

/**
 * Beta's local receiving agent — the `receivingAgentId` whose trust list is
 * consulted. `trust: []` is deliberate: a federated peer is never in a local
 * trust list; its stamp is admitted via the registry resolve seam + the crypto
 * bytes-check, not the local trust graph (`verify-signed-by-chain.ts:360-367`).
 * `presence: {}` carries no surface bindings — none are needed and no test
 * fixture should carry a platform id.
 */
function lunaAgent(): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    trust: [],
    presence: {},
  };
}

// =============================================================================
// In-process stack handle (fixture pattern from iaw-phase-b-integration.test.ts:95-120)
// =============================================================================

/**
 * Test-only `MyelinRuntime` that exposes its handler set (so the harness can fan
 * envelopes in) and captures every `publish` (so the harness can lift the
 * producer's federated copy back off the "wire").
 */
interface StackRuntime extends MyelinRuntime {
  _handlers: Set<EnvelopeHandler>;
  published: Envelope[];
  subscribedPatterns: string[];
}

interface StackHandle {
  runtime: StackRuntime;
  /** Mirrors `iaw-phase-b-integration.test.ts:95-102`'s signer shape, plus the seed b64 `signEnvelope` wants. */
  signer: {
    rawSeedBytes: Uint8Array;
    seedBase64: string;
    principal: string;
    stack: string;
    nkeyPub: string;
    did: string;
  };
}

function buildStack(id: { principal: string; stack: string }): StackHandle {
  const kp = createUser();
  const rawSeedBytes = (
    kp as unknown as { getRawSeed(): Uint8Array }
  ).getRawSeed();
  const nkeyPub = kp.getPublicKey();

  const handlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  const subscribedPatterns: string[] = [];
  const noopSubscriber = {
    stop: (): Promise<void> => Promise.resolve(),
  } as unknown as MyelinSubscriber;

  const runtime: StackRuntime = {
    enabled: true,
    _handlers: handlers,
    published,
    subscribedPatterns,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: (): boolean => handlers.delete(handler) };
    },
    publish(envelope) {
      published.push(envelope);
      return Promise.resolve();
    },
    subscribe(pattern: string) {
      subscribedPatterns.push(pattern);
      return Promise.resolve(noopSubscriber);
    },
    stop() {
      handlers.clear();
      return Promise.resolve();
    },
  };

  return {
    runtime,
    signer: {
      rawSeedBytes,
      seedBase64: Buffer.from(rawSeedBytes).toString("base64"),
      principal: id.principal,
      stack: id.stack,
      nkeyPub,
      did: stackDid(id),
    },
  };
}

// =============================================================================
// fanOutFederated — the REAL federated subject, not `local.*`
// =============================================================================

/**
 * Fan a presence envelope onto its REAL federated subject:
 *
 *     federated.{source.principal}.{source.stack}.{envelope.type}
 *
 * per ADR-0001 (the `{principal}`/`{stack}` segments come from the envelope's
 * own `source` triple `{principal}.{stack}.{instance}`; `network_id` is NEVER on
 * the wire). Presence is SOURCE-addressed, so segment[1]/[2] name the EMITTING
 * peer — the property `deriveAcceptSubjects` widens a receiver's accept-list for.
 *
 * This is the whole point of the file: the sibling `iaw-phase-b-integration`
 * harness's `fanOut` (`:109`) builds `local.{org}.{type}` and therefore exercises
 * none of the federated addressing. Do not reuse that helper here.
 *
 * Constructed inline on purpose: WP-2 introduces the subject codec and WP-5
 * migrates this call site to it.
 */
function fanOutFederated(
  envelope: Envelope,
  stacks: StackHandle[],
  sourceLink: string,
): string {
  const segments = envelope.source.split(".");
  const principal = segments[0];
  const stack = segments[1];
  if (principal === undefined || stack === undefined) {
    throw new Error(
      `test harness: cannot derive {principal}/{stack} from source "${envelope.source}"`,
    );
  }
  const subject = `federated.${principal}.${stack}.${envelope.type}`;
  for (const target of stacks) {
    for (const handler of target.runtime._handlers) {
      handler(envelope, subject, sourceLink);
    }
  }
  return subject;
}

// =============================================================================
// Alpha's emit path — the REAL producer, then the signing stamp
// =============================================================================

/** A scheduler whose interval never fires — the harness drives `agent.online` only. */
const inertScheduler: PresenceScheduler = {
  setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
  clearInterval: () => undefined,
};

/**
 * Drive alpha's REAL `AgentPresenceProducer` and lift the `classification:
 * "federated"` copy it dual-emits (`agent-presence-producer.ts:471-484` —
 * `publishOnline` → `dualEmit("agent.online", …)` → `createAgentOnlineEvent`).
 *
 * Production signs on the way out, inside `MyelinRuntime.publish`'s configured
 * signer (IAW B.3); the harness's runtime is a capture stub, so we apply the
 * same stamp here with `signEnvelope(envelope, seed, stackDid)` — the identical
 * ed25519 stamp the runtime would have written, with the stack DID class
 * production uses.
 */
async function alphaEmitsOnline(alpha: StackHandle): Promise<Envelope> {
  const producer = new AgentPresenceProducer({
    runtime: alpha.runtime,
    source: {
      principal: ALPHA.principal,
      stack: ALPHA.stack,
      instance: "local",
    },
    agents: [
      {
        identity: {
          nkey_public_key: alpha.signer.nkeyPub,
          agent_id: "forge",
          assistant_name: "Forge",
        },
        scope: { principal: ALPHA.principal, stack: ALPHA.stack },
        capabilities: ["code-review.typescript"],
      },
    ],
    scheduler: inertScheduler,
    // G-1114.E.1 — dual-emit the `classification: "federated"` copy peers fold.
    federate: true,
  });
  producer.start();

  const federatedCopy = alpha.runtime.published.find(
    (env) =>
      env.sovereignty.classification === "federated" &&
      env.type === "agent.online",
  );
  if (federatedCopy === undefined) {
    throw new Error(
      "test harness: producer emitted no federated agent.online copy",
    );
  }

  // `signEnvelope` narrows `signed_by` to an array; cortex's `Envelope` allows
  // the legacy single-stamp shape. Same cast the sibling harnesses use
  // (`federated-subscriber-self-deny.test.ts:205`).
  return await signEnvelope(
    federatedCopy as unknown as Parameters<typeof signEnvelope>[0],
    alpha.signer.seedBase64,
    alpha.signer.did,
  );
}

// =============================================================================
// Beta's receive path — subscriber → gate → chain verify → fold
// =============================================================================

/**
 * Resolve alpha's federated peer identity the way the enforce-posture registry
 * seam does (`verify-signed-by-chain.ts:380-413`). The resolved `identity.id`
 * MUST equal the DID class alpha stamped on the wire, else the chain verify
 * rejects with `unknown_agent` — that correspondence is a live production bug
 * (WP-6) and is asserted only by the `test.todo` below; here both sides are
 * pinned to `did:mf:{principal}-{stack}` so the happy path is exercised.
 */
function peerResolverFor(
  peer: StackHandle,
): (principal: string, stack?: string) => Promise<FederatedPeerResolution> {
  // NOTE (harness reality-check): the verifier threads `stackFromEnvelope()`
  // into this seam's second argument, and that helper returns the QUALIFIED
  // `{principal}/{stack}` (`envelope-validator.ts:639-645`) — NOT the bare
  // stack slug. `MultiPrincipalIdentityRegistry.resolve` keys its per-stack
  // cache on the same qualified string. Matching on the bare slug here silently
  // yields `federated_peer_unresolved`.
  const qualifiedStack = `${peer.signer.principal}/${peer.signer.stack}`;
  return (principal: string, stack?: string): Promise<FederatedPeerResolution> => {
    if (principal !== peer.signer.principal || stack !== qualifiedStack) {
      return Promise.resolve({
        resolved: false,
        reason: `unknown peer ${principal}/${stack ?? "<none>"}`,
      });
    }
    const publicKey = nkeyToBase64Pubkey(peer.signer.nkeyPub);
    if (publicKey === undefined) {
      throw new Error("test harness: peer NKey did not decode");
    }
    const identity: Identity = {
      // The DID class production stamps on the wire — see `peer.signer.did`.
      id: peer.signer.did,
      display_name: principal,
      network: principal,
      public_key: publicKey,
      type: "agent",
      created_at: new Date(0).toISOString(),
    };
    return Promise.resolve({ resolved: true, identity });
  };
}

/** Beta's accept-list, DERIVED (never hand-written) from self + the alpha peer. */
function betaAcceptSubjects(): string[] {
  return deriveAcceptSubjects(
    { principal: BETA.principal, stack: BETA.stack },
    [{ principal: ALPHA.principal, stack: ALPHA.stack }],
  );
}

/** Start beta's federated presence subscriber with the full enforce-posture wiring. */
async function startBeta(
  beta: StackHandle,
  alpha: StackHandle,
  registry: AgentPresenceRegistry,
): Promise<{ stop(): Promise<void> }> {
  return startFederatedAgentPresenceSubscriber({
    runtime: beta.runtime,
    registry,
    federated: federatedPolicy([sharedNetwork(betaAcceptSubjects())]),
    source: BETA_SYSTEM_SOURCE,
    trustResolver: new TrustResolver(AgentRegistry.fromAgents([lunaAgent()])),
    receivingAgentId: "luna",
    principalId: BETA.principal,
    cryptoVerify: true,
    // `signing: enforce` — an empty `signed_by[]` chain is rejected.
    rejectEmpty: true,
    stackIdentity: beta.signer.did,
    stackNKeyPub: beta.signer.nkeyPub,
    resolveFederatedPeer: peerResolverFor(alpha),
  });
}

/**
 * Wait until the fold lands. The subscriber folds inside `verifySignedByChain`'s
 * `.then`, so the assertion has to wait on real ed25519 work — observed between
 * ~5ms (warm) and ~1.5s (cold, first keypair + verify in a fresh process). A
 * fixed sleep is therefore a flake in both directions; poll for the positive
 * signal instead and fail loudly on timeout.
 */
async function waitForFold(
  registry: AgentPresenceRegistry,
  expected: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (registry.getAgents().length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `test harness: timed out after ${timeoutMs}ms waiting for ${expected} folded ` +
      `record(s); registry holds ${registry.getAgents().length}. A DROP (gate or ` +
      `chain-verify) prints its reason on stderr above.`,
  );
}

// =============================================================================
// Cases
// =============================================================================

describe("WP-1 — federated presence E2E (two in-process stacks, REAL federated subjects)", () => {
  test("happy path: alpha's signed agent.online folds into beta's registry with verifiedScope alpha/meta-factory", async () => {
    const alpha = buildStack(ALPHA);
    const beta = buildStack(BETA);
    const registry = new AgentPresenceRegistry();
    const handle = await startBeta(beta, alpha, registry);

    // Beta bound the federated presence firehose (not a `local.*` pattern).
    expect(beta.runtime.subscribedPatterns).toEqual([
      federatedAgentPresenceSubject(),
    ]);

    const signed = await alphaEmitsOnline(alpha);
    // The envelope really is federated-classified and really is signed.
    expect(signed.sovereignty.classification).toBe("federated");
    expect(Array.isArray(signed.signed_by) ? signed.signed_by.length : 0).toBe(1);

    const subject = fanOutFederated(signed, [beta], "primary");
    // The REAL federated subject grammar — this is what the sibling harness never built.
    expect(subject).toBe(ALPHA_ONLINE_SUBJECT);
    expect(subject.startsWith("federated.")).toBe(true);
    // …and beta's DERIVED accept-list admits it (gate step 3 passes for a reason).
    expect(
      betaAcceptSubjects().some((pattern) => subjectMatches(pattern, subject)),
    ).toBe(true);

    await waitForFold(registry, 1);

    // Gated → chain-verified → folded.
    const agents = registry.getAgents();
    expect(agents.length).toBe(1);
    const record = agents[0];
    if (record === undefined) throw new Error("expected one folded record");

    expect(record.agentId).toBe("forge");
    expect(record.state).toBe("online");
    // `verifiedScope` — the chain-verified `{principal}/{stack}` the registry
    // keys the record on (source-bound, never `payload.scope`).
    expect(record.principal).toBe(ALPHA.principal);
    expect(record.stack).toBe(ALPHA.stack);
    expect(`${record.principal}/${record.stack}`).toBe("alpha/meta-factory");
    // Provenance: foreign, tagged with the peer's verified identity.
    expect(isForeignOrigin(record.origin)).toBe(true);
    if (isForeignOrigin(record.origin)) {
      expect(record.origin.principal).toBe(ALPHA.principal);
      expect(record.origin.stack).toBe(ALPHA.stack);
    }

    await handle.stop();
  });

  test("#1812 regression guard: a peer whose stack slug is NOT `default` folds correctly", async () => {
    const alpha = buildStack(ALPHA);
    const beta = buildStack(BETA);
    const registry = new AgentPresenceRegistry();
    const handle = await startBeta(beta, alpha, registry);

    const signed = await alphaEmitsOnline(alpha);
    const subject = fanOutFederated(signed, [beta], "primary");
    await waitForFold(registry, 1);

    // The stack slug survives END-TO-END. #1812 was invisible under a `default`
    // slug: every segment that should carry the slug carried `default` instead,
    // so a mis-addressed subject and a correctly-addressed one were textually
    // identical. Each assertion below is a place the real slug must appear.
    //
    // 1. On the wire — the subject names the peer's REAL stack, not `default`.
    expect(subject).toBe(ALPHA_ONLINE_SUBJECT);
    expect(subject.split(".")[2]).toBe("meta-factory");
    // 2. In the envelope source triple that the fold derives provenance from.
    expect(signed.source).toBe("alpha.meta-factory.local");
    // 3. In the folded record's verified scope.
    const agents = registry.getAgents();
    expect(agents.length).toBe(1);
    const record = agents[0];
    if (record === undefined) throw new Error("expected one folded record");
    expect(record.stack).toBe("meta-factory");
    // 4. And in the record key the registry partitions the foreign namespace by.
    expect(record.key).toBe("alpha/meta-factory/forge");
    //
    // Each assertion above pins the EXACT expected slug. That is strictly
    // stronger than asserting the masking slug is absent (and it keeps this file
    // free of the literal, per the WP-1 acceptance grep): if the slug were ever
    // collapsed — to the masking value or to anything else — every one of these
    // fails.

    await handle.stop();
  });

  // ===========================================================================
  // WP-3 (#1879) FLIPPED LIVE — the producer/consumer agreement guard. This
  // todo's ONLY gate was #1879 (this slice), so it flips to a real assertion
  // here. The exhaustive property version (all presence actions, `default` AND
  // non-`default`, 256 generated pairs) lives in
  // `src/common/wire/__tests__/identity.property.test.ts`; this is the E2E
  // guard pinned to the harness's real non-`default` fixture.
  // ===========================================================================

  test("WP-3 (#1879): deriveAcceptSubjects(self,[peer]) admits the subject the presence producer emits", async () => {
    const alpha = buildStack(ALPHA);

    // The REAL subject alpha's producer emits for its federated agent.online —
    // derived from the emitted envelope's own source triple, not hand-written.
    const signed = await alphaEmitsOnline(alpha);
    const [principal, stack] = signed.source.split(".");
    const producerSubject = `federated.${principal}.${stack}.${signed.type}`;
    expect(producerSubject).toBe(ALPHA_ONLINE_SUBJECT);

    // Beta's accept-list is DERIVED from self + the alpha peer (never
    // hand-written) and MUST contain a pattern matching that subject. Their
    // disagreement was #1812. The fixture slug is NON-`default` on purpose — a
    // `default` slug would pass too, which is exactly how #1812 hid.
    const accept = betaAcceptSubjects();
    expect(accept.some((pattern) => subjectMatches(pattern, producerSubject))).toBe(true);
  });

  // ===========================================================================
  // Epic progress meter — each remaining todo flips live when its gating slice
  // merges.
  //
  // The empty bodies are a TYPE requirement, not a stub: bun-types declares
  // `test.todo` as `Test<T>` (2-3 args), so a one-argument call fails
  // `tsc --noEmit`. The repo's other progress-meter suite works around this with
  // a cast alias (`e2e-lifecycle/lifecycle.test.ts:102`); an empty body is the
  // same thing without the cast. Bun never executes a `.todo` body absent
  // `--todo`, and reports these as 3 todo.
  //
  // The injectivity todo below stays gated: its encoding DECISION (WP-4 #1880)
  // is HELD and cortex still mints the naive `did:mf:{p}-{s}` form, so the
  // invariant is genuinely violated today (the property suite asserts the
  // hazard LIVE and holds the cortex-side invariant as the same #1880 todo).
  // ===========================================================================

  test.todo(
    "WP-6 (#1882): a peer's resolved identity DID class matches the wire stamp (did:mf:{p}-{s}), so chain verify does not return unknown_agent",
    () => {},
  );
  test.todo(
    "WP-6 (#1882): presence folds under signing:'permissive' (resolveFederatedPeer is enforce-only today — cortex.ts:2831)",
    () => {},
  );
  test.todo(
    "WP-3/WP-4 (#1879/#1880): a principal id containing '-' can never produce a DID equal to another (principal, stack) pair's stack DID",
    () => {},
  );
});
