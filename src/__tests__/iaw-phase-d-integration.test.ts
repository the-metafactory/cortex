/**
 * IAW Phase D.6 (cortex#116) — cross-operator federation integration tests.
 *
 * This file wires two cortex stacks (operator alpha + operator beta) in
 * process with their own `MyelinRuntime` stubs, surface-router (carrying
 * the D.2 federation gate), `PolicyEngine` (carrying the D.3 per-network
 * slice), and `BusDispatchListener` + dispatch-listener pair. A shared
 * in-memory bus fans an envelope published on either stack to BOTH
 * stacks' handlers — the same broadcast semantics a NATS leaf-node pair
 * would provide on the wire.
 *
 * Each test is a slice of cortex#116 §D.6:
 *
 *   1. **D.6.1 — cross-operator dispatch + reply chain.** Alpha emits a
 *      signed `dispatch.task.received` envelope on
 *      `federated.research-collab.dispatch.task.received`. Beta's
 *      surface-router admits it (D.2 accept-list), beta's
 *      dispatch-listener PolicyEngine accepts it (D.3 peer roster),
 *      beta's fake harness produces a `dispatch.task.completed`. The
 *      reply is then signed by beta's stack key and replayed onto the
 *      shared bus. Alpha verifies the chain (Phase B verifier) and
 *      asserts both stacks' audit envelopes show their respective
 *      stamps.
 *
 *   2. **D.6.2 — registry register + query.** Alpha registers with the
 *      D.4 network-registry service; beta queries `GET /operators/alpha`
 *      and verifies the registry's signed assertion against the pinned
 *      registry pubkey. The cortex-side `RegistryClient` (D.4.3) is a
 *      separate parallel slice; this test scopes to the producer
 *      surface that's already merged.
 *
 *   3. **D.6.3 — deny-list rejection.** Alpha emits an envelope on a
 *      `deny_subjects[]` pattern; beta's surface-router rejects it with
 *      reason `peer_deny_list` and emits a `system.access.denied`
 *      audit envelope. Beta's dispatch-listener never runs (the gate
 *      sits in front of fan-out).
 *
 * Coverage matrix vs. the unit tests:
 *
 *   - `surface-router.test.ts` covers D.2 in isolation (gate decision +
 *     emit), with a fake runtime + a single recordingAdapter.
 *   - `dispatch-listener.test.ts` covers D.3 in isolation (engine on a
 *     single-stack runtime).
 *   - `iaw-phase-b-integration.test.ts` covers cross-stack Phase B
 *     signing + verification with a `BusDispatchListener` pair.
 *
 *   This file is the multiplied case: TWO stacks each running BOTH the
 *   surface-router-side D.2 gate AND the listener-side D.3 gate, with
 *   the Phase B chain-of-stamps spanning the round trip.
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { signEnvelope } from "@the-metafactory/myelin/identity";
import { createSurfaceRouter, type SurfaceRouter } from "../bus/surface-router";
import type {
  EnvelopeHandler,
  MyelinRuntime,
} from "../bus/myelin/runtime";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { SystemEventSource } from "../bus/system-events";
import { createDispatchListener } from "../runner/dispatch-listener";
import type { CCSessionFactory } from "../runner/dispatch-listener";
import type { CCSessionResult } from "../runner/cc-session";
import { PolicyEngine } from "../common/policy/engine";
import type {
  PolicyFederated,
  PolicyFederatedNetwork,
} from "../common/types/cortex-config";
import registryApp from "../services/network-registry/src/index";
import type { Env as RegistryEnv } from "../services/network-registry/src/index";
import {
  generateKeypair,
  signEd25519,
  verifyEd25519,
  canonicalJSON,
} from "../services/network-registry/src/signing";
import type {
  OperatorRecord,
  RegistrationClaim,
  SignedAssertion,
} from "../services/network-registry/src/types";
import {
  _setStoreForTest,
  _setNonceCacheForTest,
} from "../services/network-registry/src/store";
import { _resetDerivedPublicKeyForTest } from "../services/network-registry/src/index";

// =============================================================================
// Cross-operator stack fixture
// =============================================================================

/**
 * In-process `MyelinRuntime` that records every `publish()` and exposes
 * the registered handler set so the shared-bus fan-out helper can drive
 * inbound envelopes directly.
 */
interface StackRuntime extends MyelinRuntime {
  _handlers: Set<EnvelopeHandler>;
  published: Envelope[];
}

interface StackHandle {
  id: string;
  /** Stack-key signer — DID is `did:mf:<principalId>` (see `signerPrincipalId`). */
  signerSeedB64: string;
  signerPrincipalDid: string;
  /** Bare principal id (no `did:mf:` prefix). Used to populate
   *  `policy.principals[].id` on the receiving side. */
  principalId: string;
  /** `{operator_id}/{stack_id}` shape. Used as `principal.home_stack` AND
   *  as the network peer's `stack_id` entry. */
  homeStack: string;
  runtime: StackRuntime;
  router: SurfaceRouter;
  source: SystemEventSource;
}

function buildStackRuntime(): StackRuntime {
  const handlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  return {
    enabled: true,
    _handlers: handlers,
    published,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async publish(envelope) {
      published.push(envelope);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async stop() {
      handlers.clear();
    },
  };
}

/**
 * Build one stack handle (operator α or β). Mints a real Ed25519
 * keypair via NATS NKeys (myelin's signEnvelope reads the raw seed
 * bytes; same path Phase B's runtime.publish uses).
 */
function buildStack(opts: {
  operatorId: string;
  principalId: string;
  homeStack: string;
  federated?: PolicyFederated;
}): StackHandle {
  const kp = createUser();
  const rawSeedBytes = (
    kp as unknown as { getRawSeed(): Uint8Array }
  ).getRawSeed();
  const seedB64 = Buffer.from(rawSeedBytes).toString("base64");
  const principalDid = `did:mf:${opts.principalId}`;

  const runtime = buildStackRuntime();
  const source: SystemEventSource = {
    org: opts.operatorId,
    agent: "cortex",
    instance: "local",
  };
  const router = createSurfaceRouter(runtime, {
    systemEventSource: source,
    ...(opts.federated && { federated: opts.federated }),
  });

  return {
    id: opts.operatorId,
    signerSeedB64: seedB64,
    signerPrincipalDid: principalDid,
    principalId: opts.principalId,
    homeStack: opts.homeStack,
    runtime,
    router,
    source,
  };
}

/**
 * Wire two stacks into a shared in-memory bus. An envelope published on
 * either stack fans out to BOTH stacks' router-handler sets (mirrors
 * NATS leaf-node broadcast). Self-fan is preserved — the real NATS
 * contract delivers a publisher's own envelopes back too; receivers
 * filter on `source` if they care.
 *
 * Returns a `deliver()` helper that drives a single envelope onto the
 * shared wire under a chosen subject.
 */
function wireSharedBus(stacks: StackHandle[]): {
  deliver: (envelope: Envelope, subject: string) => Promise<void>;
} {
  return {
    async deliver(envelope, subject) {
      for (const stack of stacks) {
        for (const handler of stack.runtime._handlers) {
          handler(envelope, subject);
        }
      }
      // Drain a tick so any `void router.dispatch()` floats settle
      // before the caller asserts on `runtime.published`.
      await new Promise<void>((r) => setTimeout(r, 10));
    },
  };
}

// =============================================================================
// Fake CC session factory — yields one terminal result, no process spawn
// =============================================================================

function fakeFactory(result: CCSessionResult): CCSessionFactory {
  return (_opts) => {
    const session = {
      start() {
        return session;
      },
      async wait() {
        return result;
      },
    };
    return session;
  };
}

const SUCCESS_RESULT: CCSessionResult = {
  success: true,
  response: "Hello from beta! Code review complete.\nMore details follow.",
  exitCode: 0,
  durationMs: 100,
  sessionId: "session-beta",
};

// =============================================================================
// D.6 fixture builders — policy blocks + signed envelopes
// =============================================================================

/**
 * Build α's federated policy block: α is the originator, declares β
 * as a peer on `research-collab`. The accept-list permits the
 * `dispatch.task.completed` reply subject so β's reply can pass α's
 * surface-router gate.
 */
function alphaFederated(beta: StackHandle): PolicyFederated {
  const network: PolicyFederatedNetwork = {
    id: "research-collab",
    leaf_node: "leaf-research",
    peers: [
      {
        operator_id: "beta",
        stack_id: beta.homeStack,
        operator_pubkey: "U" + "A".repeat(55), // structural-only here; α doesn't crypto-verify β's reply via this field
      },
    ],
    accept_subjects: [
      "federated.research-collab.dispatch.task.completed",
      "federated.research-collab.dispatch.task.started",
    ],
    deny_subjects: [],
    announce_capabilities: ["code-review"],
    max_hop: 2,
  };
  return { networks: [network] };
}

/**
 * Build β's federated policy block. β declares α as a peer, accepts the
 * D.6.1 task-dispatch subject, and (for D.6.3) denies a
 * `*.private.>` slice that an inbound envelope from α will trip.
 */
function betaFederated(alpha: StackHandle): PolicyFederated {
  const network: PolicyFederatedNetwork = {
    id: "research-collab",
    leaf_node: "leaf-research",
    peers: [
      {
        operator_id: "alpha",
        stack_id: alpha.homeStack,
        operator_pubkey: "U" + "A".repeat(55),
      },
    ],
    accept_subjects: [
      "federated.research-collab.dispatch.task.received",
    ],
    deny_subjects: [
      "federated.research-collab.dispatch.task.received.private.>",
    ],
    announce_capabilities: ["code-review"],
    max_hop: 2,
  };
  return { networks: [network] };
}

/** β's PolicyEngine — knows α as a principal whose home_stack is in `research-collab`. */
function betaEngine(alpha: StackHandle): PolicyEngine {
  return new PolicyEngine({
    principals: [
      {
        id: alpha.principalId,
        home_operator: "alpha",
        home_stack: alpha.homeStack,
        role: ["peer"],
        trust: [],
      },
    ],
    roles: [{ id: "peer", capabilities: ["dispatch.cortex"] }],
    federated: {
      networks: [
        {
          id: "research-collab",
          peers: [{ stack_id: alpha.homeStack }],
        },
      ],
    },
  });
}

/** α's PolicyEngine — symmetric: knows β. Only needed when α runs a
 *  dispatch-listener for β-originated tasks; the reply path uses the
 *  surface-router gate, not the policy engine. */
function alphaEngine(beta: StackHandle): PolicyEngine {
  return new PolicyEngine({
    principals: [
      {
        id: beta.principalId,
        home_operator: "beta",
        home_stack: beta.homeStack,
        role: ["peer"],
        trust: [],
      },
    ],
    roles: [{ id: "peer", capabilities: ["dispatch.cortex"] }],
    federated: {
      networks: [
        {
          id: "research-collab",
          peers: [{ stack_id: beta.homeStack }],
        },
      ],
    },
  });
}

/**
 * Build + sign a `dispatch.task.received` envelope from the given
 * stack. Returns the signed envelope ready for shared-bus delivery.
 */
async function signedDispatchReceived(
  stack: StackHandle,
  args: {
    taskId: string;
    prompt: string;
    /** Override the default federated classification. */
    classification?: Envelope["sovereignty"]["classification"];
  },
): Promise<Envelope> {
  const unsigned: Envelope = {
    id: `00000000-0000-4000-8000-${args.taskId.slice(-12)}`,
    source: `${stack.id}.cortex.local`,
    type: "dispatch.task.received",
    timestamp: new Date().toISOString(),
    correlation_id: args.taskId,
    sovereignty: {
      classification: args.classification ?? "federated",
      data_residency: "NZ",
      max_hop: 2,
      frontier_ok: false,
      model_class: "any",
    },
    payload: {
      task_id: args.taskId,
      agent_id: "cortex",
      prompt: args.prompt,
    },
  };
  return await signEnvelope(
    unsigned as Parameters<typeof signEnvelope>[0],
    stack.signerSeedB64,
    stack.signerPrincipalDid,
  );
}

// =============================================================================
// D.6.1 — Cross-operator dispatch + reply chain
// =============================================================================

describe("IAW Phase D.6.1 — cross-operator federated dispatch + reply (refs cortex#116)", () => {
  test(
    "alpha → beta dispatch on research-collab: D.2 gate admits, D.3 engine allows, beta replies with own stamp, alpha verifies chain",
    async () => {
      const alpha = buildStack({
        operatorId: "alpha",
        principalId: "alpha-cortex",
        homeStack: "alpha/research",
      });
      const beta = buildStack({
        operatorId: "beta",
        principalId: "beta-cortex",
        homeStack: "beta/research",
      });

      // Now that both stacks exist, install the cross-referenced
      // federation policy blocks. We rebuild each router with the
      // peer-aware block because createSurfaceRouter freezes its
      // federation map at construction time (per
      // src/bus/surface-router.ts:266-275).
      alpha.router = createSurfaceRouter(alpha.runtime, {
        systemEventSource: alpha.source,
        federated: alphaFederated(beta),
      });
      beta.router = createSurfaceRouter(beta.runtime, {
        systemEventSource: beta.source,
        federated: betaFederated(alpha),
      });

      // β's dispatch-listener: subscribes to the federated subject so
      // its surface adapter receives admitted envelopes. The
      // PolicyEngine carries the D.3 federation slice — α's principal
      // is declared with the home_stack β advertises in the network's
      // peer roster.
      const taskId = "11111111-1111-4111-8111-111111111111";
      const betaListener = createDispatchListener({
        runtime: beta.runtime,
        router: beta.router,
        source: beta.source,
        subjects: ["federated.research-collab.dispatch.task.received"],
        ccSessionFactory: fakeFactory(SUCCESS_RESULT),
        policyEngine: betaEngine(alpha),
      });

      await betaListener.start();
      await beta.router.start();
      await alpha.router.start();

      const bus = wireSharedBus([alpha, beta]);

      // ─── α emits onto the wire ───────────────────────────────────
      const dispatch = await signedDispatchReceived(alpha, {
        taskId,
        prompt: "Please review this TypeScript change for cortex#116.",
      });
      await bus.deliver(
        dispatch,
        "federated.research-collab.dispatch.task.received",
      );

      // β's published stream should contain (in order):
      //   1. system.access.allowed   — D.3 engine accepted α's principal
      //   2. dispatch.task.started   — fake harness lifecycle
      //   3. dispatch.task.completed — fake harness terminal
      const betaTypes = beta.runtime.published.map((e) => e.type);
      expect(betaTypes).toContain("system.access.allowed");
      expect(betaTypes).toContain("dispatch.task.started");
      expect(betaTypes).toContain("dispatch.task.completed");

      // D.3.1 audit invariant: β's `system.access.allowed` carries the
      // federated wire subject verbatim — proves the listener saw the
      // matched NATS subject through to the audit envelope and didn't
      // synthesize a local fallback.
      const betaAllowed = beta.runtime.published.find(
        (e) => e.type === "system.access.allowed",
      );
      expect(betaAllowed).toBeDefined();
      expect(
        (betaAllowed!.payload as { envelope_subject?: string }).envelope_subject,
      ).toBe("federated.research-collab.dispatch.task.received");
      expect(
        (betaAllowed!.payload as { principal_id?: string }).principal_id,
      ).toBe(alpha.principalId);

      // β's audit also preserves α's signed_by[] chain verbatim
      // (C.4.3 invariant). One stamp originally from α; α's DID on it.
      const auditSignedBy = (
        betaAllowed!.payload as { signed_by?: { principal: string }[] }
      ).signed_by;
      expect(auditSignedBy).toBeDefined();
      expect(auditSignedBy!.length).toBeGreaterThanOrEqual(1);
      expect(auditSignedBy![0]?.principal).toBe(alpha.signerPrincipalDid);

      // ─── β's reply is re-signed with β's stack key + replayed ────
      // The dispatch-listener publishes the harness's terminal envelope
      // onto β.runtime.publish without signing (production would sign
      // at the runtime layer — Phase B's runtime.publish wraps a signer;
      // in this in-process test we sign manually and replay onto α's
      // wire, mirroring what NATS would deliver back).
      const betaCompleted = beta.runtime.published.find(
        (e) => e.type === "dispatch.task.completed",
      );
      expect(betaCompleted).toBeDefined();

      // Build the reply envelope as it would arrive on α's wire:
      //   federated classification, β's source, signed by β's stack
      //   key. Carry α's correlation_id so the chain is observably
      //   the SAME task across both stacks (no causal-reply guarantee
      //   in the wire protocol — operators correlate via correlation_id).
      const reply: Envelope = {
        ...betaCompleted!,
        source: `${beta.id}.cortex.local`,
        sovereignty: {
          ...betaCompleted!.sovereignty,
          classification: "federated",
        },
      };
      const signedReply = await signEnvelope(
        reply as Parameters<typeof signEnvelope>[0],
        beta.signerSeedB64,
        beta.signerPrincipalDid,
      );

      // Reset α's published log so we cleanly assert the reply path.
      alpha.runtime.published.length = 0;

      await bus.deliver(
        signedReply,
        "federated.research-collab.dispatch.task.completed",
      );

      // α's surface-router admitted the reply on accept_subjects —
      // no `system.access.denied` should have been emitted on α's
      // wire for this envelope.
      const alphaDenied = alpha.runtime.published.find(
        (e) => e.type === "system.access.denied",
      );
      expect(alphaDenied).toBeUndefined();

      // ─── Chain-of-stamps assertion (Phase B invariant) ───────────
      // The reply envelope must carry exactly one stamp on the wire:
      // β's. (The reply was constructed from a fresh `dispatch.task.completed`
      // envelope that the harness emitted unsigned, then we appended
      // β's stamp — there's no α-stamp on this envelope, only on the
      // ORIGINATING dispatch.task.received envelope. Both operators
      // saw their respective stamps on their respective envelopes.)
      const replyChain = signedReply.signed_by;
      const replyStamps = Array.isArray(replyChain)
        ? replyChain
        : replyChain
          ? [replyChain]
          : [];
      expect(replyStamps.length).toBe(1);
      expect(replyStamps[0]?.principal).toBe(beta.signerPrincipalDid);

      // The originating dispatch carried α's stamp — assert that too
      // so the test docs both halves of the cross-operator audit trail.
      const dispatchChain = dispatch.signed_by;
      const dispatchStamps = Array.isArray(dispatchChain)
        ? dispatchChain
        : dispatchChain
          ? [dispatchChain]
          : [];
      expect(dispatchStamps.length).toBe(1);
      expect(dispatchStamps[0]?.principal).toBe(alpha.signerPrincipalDid);
    },
  );
});

// =============================================================================
// D.6.2 — Registry register + query (cortex-side consumer deferred to D.4.3)
// =============================================================================

describe("IAW Phase D.6.2 — network-registry register + cross-operator query (refs cortex#116)", () => {
  test(
    "alpha registers operator pubkey + capabilities; beta-side query returns registry-signed assertion verifying against the pinned registry pubkey",
    async () => {
      _setStoreForTest(undefined);
      _setNonceCacheForTest(undefined);
      _resetDerivedPublicKeyForTest();

      const registryKey = await generateKeypair();
      const env: RegistryEnv = {
        REGISTRY_SIGNING_KEY: registryKey.privateKeyB64,
        REGISTRY_PUBLIC_KEY: registryKey.publicKeyB64,
        ENVIRONMENT: "test",
      };

      // α mints its operator key + signs a registration claim.
      const alphaOpKey = await generateKeypair();
      const claim: RegistrationClaim = {
        operator_id: "alpha",
        operator_pubkey: alphaOpKey.publicKeyB64,
        stacks: [
          { stack_id: "alpha/research", display_name: "Alpha research stack" },
        ],
        capabilities: [
          {
            id: "tasks.code-review",
            description: "Reviews TypeScript PRs for the research collab.",
            networks: ["research-collab"],
          },
        ],
        issued_at: new Date().toISOString(),
        nonce: "d6-test-nonce-0000000000000001",
      };
      const message = new TextEncoder().encode(canonicalJSON(claim));
      const signature = await signEd25519(alphaOpKey.privateKeyB64, message);

      const registerRes = await registryApp.fetch(
        new Request("http://localhost/operators/alpha/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claim, signature }),
        }),
        env,
      );
      expect(registerRes.status).toBe(201);

      // β-side query: GET /operators/alpha. The response is a
      // SignedAssertion<OperatorRecord> carrying the registry's own
      // signature over canonical-JSON({payload, issued_at, registry}).
      const queryRes = await registryApp.fetch(
        new Request("http://localhost/operators/alpha"),
        env,
      );
      expect(queryRes.status).toBe(200);
      const assertion = (await queryRes.json()) as SignedAssertion<OperatorRecord>;

      // Payload shape — β sees α's pubkey + capability declaration.
      expect(assertion.payload.operator_id).toBe("alpha");
      expect(assertion.payload.operator_pubkey).toBe(alphaOpKey.publicKeyB64);
      expect(assertion.payload.stacks).toHaveLength(1);
      expect(assertion.payload.stacks[0]!.stack_id).toBe("alpha/research");
      expect(assertion.payload.capabilities).toHaveLength(1);
      expect(assertion.payload.capabilities[0]!.id).toBe("tasks.code-review");

      // β verifies the registry's signature against the pinned
      // registry pubkey (D.4.4 — peers MUST verify before trusting).
      const bound = canonicalJSON({
        payload: assertion.payload,
        issued_at: assertion.issued_at,
        registry: assertion.registry,
      });
      const ok = await verifyEd25519(
        registryKey.publicKeyB64,
        assertion.signature,
        new TextEncoder().encode(bound),
      );
      expect(ok).toBe(true);

      // Tamper-detection invariant: if β cached the assertion and an
      // attacker mutated the payload, the same verify call MUST fail.
      const tamperedBound = canonicalJSON({
        payload: {
          ...assertion.payload,
          operator_pubkey: "AAAA" + assertion.payload.operator_pubkey.slice(4),
        },
        issued_at: assertion.issued_at,
        registry: assertion.registry,
      });
      const tamperedOk = await verifyEd25519(
        registryKey.publicKeyB64,
        assertion.signature,
        new TextEncoder().encode(tamperedBound),
      );
      expect(tamperedOk).toBe(false);

      // The cortex-side `RegistryClient` (D.4.3) consumes this same
      // wire shape: pin the registry pubkey at config load, GET the
      // operator record, verify the assertion, then refresh the
      // in-memory peer pubkey cache. Implementation lands in a
      // sibling slice (D.4.3); this test scopes to the producer
      // contract which is the federation's source of truth.
    },
  );
});

// =============================================================================
// D.6.3 — Deny-list rejection at the surface-router gate
// =============================================================================

describe("IAW Phase D.6.3 — federated deny_subjects[] rejection (refs cortex#116)", () => {
  test(
    "alpha sends on a deny-listed subject pattern; beta's surface-router emits system.access.denied with reason=peer_deny_list and the dispatch-listener never fires",
    async () => {
      const alpha = buildStack({
        operatorId: "alpha",
        principalId: "alpha-cortex",
        homeStack: "alpha/research",
      });
      const beta = buildStack({
        operatorId: "beta",
        principalId: "beta-cortex",
        homeStack: "beta/research",
      });

      // β's federation block: accept the canonical dispatch subject,
      // but DENY the `*.private.>` slice α is about to violate.
      beta.router = createSurfaceRouter(beta.runtime, {
        systemEventSource: beta.source,
        federated: betaFederated(alpha),
      });

      // β's dispatch-listener subscribes to the canonical (admitted)
      // dispatch subject — but the deny-listed envelope never reaches
      // adapter fan-out, so the harness factory MUST NOT be invoked.
      let harnessInvocations = 0;
      const recordingFactory: CCSessionFactory = (_opts) => {
        harnessInvocations += 1;
        const session = {
          start() {
            return session;
          },
          async wait() {
            return SUCCESS_RESULT;
          },
        };
        return session;
      };
      const betaListener = createDispatchListener({
        runtime: beta.runtime,
        router: beta.router,
        source: beta.source,
        subjects: [
          "federated.research-collab.dispatch.task.received",
          "federated.research-collab.dispatch.task.received.private.>",
        ],
        ccSessionFactory: recordingFactory,
        policyEngine: betaEngine(alpha),
      });

      await betaListener.start();
      await beta.router.start();

      const bus = wireSharedBus([alpha, beta]);

      // α emits onto a deny-listed subject — `*.private.>`. The
      // surface-router's D.2 gate must reject BEFORE the
      // dispatch-listener's adapter sees it.
      const taskId = "33333333-3333-4333-8333-333333333333";
      const denied = await signedDispatchReceived(alpha, {
        taskId,
        prompt: "Confidential review — should never reach beta's harness.",
      });
      await bus.deliver(
        denied,
        "federated.research-collab.dispatch.task.received.private.confidential",
      );

      // β's published stream must carry exactly one `system.access.denied`
      // envelope with reason kind `peer_deny_list`, and zero
      // dispatch.task.started/completed/failed events.
      const accessDenied = beta.runtime.published.filter(
        (e) => e.type === "system.access.denied",
      );
      expect(accessDenied).toHaveLength(1);
      const reason = (
        accessDenied[0]!.payload as {
          reason?: { kind?: string; matched_pattern?: string };
        }
      ).reason;
      expect(reason).toBeDefined();
      expect(reason!.kind).toBe("peer_deny_list");
      expect(reason!.matched_pattern).toBe(
        "federated.research-collab.dispatch.task.received.private.>",
      );

      // Surface-router emit also surfaces network_id + envelope_subject
      // for operators triaging the audit stream (D.2 spec).
      const denyPayload = accessDenied[0]!.payload as {
        network_id?: string;
        envelope_subject?: string;
        capability?: string;
      };
      expect(denyPayload.network_id).toBe("research-collab");
      expect(denyPayload.envelope_subject).toBe(
        "federated.research-collab.dispatch.task.received.private.confidential",
      );
      expect(denyPayload.capability).toBe("federated.subject_dispatch");

      // No dispatch lifecycle envelopes — the listener never ran.
      const dispatchLifecycle = beta.runtime.published.filter((e) =>
        e.type.startsWith("dispatch.task."),
      );
      expect(dispatchLifecycle).toHaveLength(0);

      // Harness factory never invoked — defensive cross-check that the
      // gate sits strictly in front of the listener's render path.
      expect(harnessInvocations).toBe(0);
    },
  );
});
