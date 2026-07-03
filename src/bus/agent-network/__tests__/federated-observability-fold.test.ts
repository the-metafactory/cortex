/**
 * P-14 U3.3 (#937) — TRUST-VERIFIED federated observability fold tests.
 *
 * The SECURITY-FOCUSED slice — the trust-path FINALE. Coverage axes mirror the
 * federated-subscriber test (same Option-D path) PLUS the curation gate:
 *
 *   1. Opt-in — no `policy.federated.networks[]` ⇒ fold INERT.
 *   2. Fold — an ALLOW-listed (curation) + accept-listed (federation) peer's
 *      `system.transport.*` ⇒ projected, ORIGIN-BADGED foreign (chain-verified
 *      `{principal}/{stack}`), never local. (acceptance: origin attribution)
 *   3. NEGATIVE CONTROL (critical) — a peer's NON-exported class
 *      (`system.signal.*`, `trace.*`) provably does NOT fold — excluded at the
 *      curation gate. (load-bearing)
 *   4. TRUST gate (accept-list) — a non-allowlisted peer is DROPPED + denial.
 *   5. TRUST gate (chain) — an unsigned/bad-chain envelope is DROPPED FAIL-CLOSED
 *      + emits `system.access.denied (chain_verify_failed)`. (load-bearing)
 *   6. Source-bound origin — the badge derives from the verified SOURCE, never
 *      the attacker-controlled payload.
 *   7. Subject filter — a `local.*` system envelope is ignored (U2.1 owns local).
 */

import { describe, expect, test, mock } from "bun:test";
import {
  startFederatedObservabilityFold,
  federatedObservabilitySubject,
  foldVerifiedObservability,
  type FoldedObservability,
} from "../federated-observability-fold";
import type { Envelope, SignedBy } from "../../myelin/envelope-validator";
import type { MyelinRuntime, EnvelopeHandler } from "../../myelin/runtime";
import type { MyelinSubscriber } from "../../myelin/subscriber";
import type { SystemEventSource } from "../../system-events";
import type {
  PolicyFederated,
  PolicyFederatedNetwork,
} from "../../../common/types/cortex-config";
import { TrustResolver } from "../../../common/agents/trust-resolver";
import { AgentRegistry } from "../../../common/agents/registry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSTEM_SOURCE: SystemEventSource = {
  principal: "andreas",
  agent: "cortex",
  instance: "local",
};

/**
 * A foreign (peer `joel/research`) observability envelope of `type`, carrying a
 * canonical-myelin shape with the verified SOURCE `joel.research.local`. The
 * payload can claim anything — the fold derives the origin from `source`, never
 * the payload (the spoof-resistance check).
 */
function foreignObs(
  type: string,
  payload: Record<string, unknown> = {},
  opts: { signedBy?: SignedBy[]; source?: string } = {},
): Envelope {
  return {
    id: crypto.randomUUID(),
    source: opts.source ?? "joel.research.local",
    type,
    timestamp: "2026-06-12T00:00:00.000Z",
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 3,
      frontier_ok: true,
      model_class: "any",
    },
    payload,
    signed_by: opts.signedBy ?? [],
  } as unknown as Envelope;
}

/** A network that accept-lists joel + accepts its system observability subtree. */
function networkWithJoel(): PolicyFederatedNetwork {
  return {
    id: "research-collab",
    leaf_node: "primary",
    peers: [{ principal_id: "joel", stack_id: "joel/research" }],
    accept_subjects: ["federated.joel.research.system.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 3,
  };
}

/** A network that does NOT list joel (no peer) — joel is unknown/untrusted. */
function networkWithoutJoel(): PolicyFederatedNetwork {
  return {
    id: "research-collab",
    leaf_node: "primary",
    peers: [],
    accept_subjects: ["federated.joel.research.system.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 3,
  };
}

function federatedPolicy(networks: PolicyFederatedNetwork[]): PolicyFederated {
  return { networks };
}

// ---------------------------------------------------------------------------
// Fake runtime + recording fold callback
// ---------------------------------------------------------------------------

interface FakeRuntime extends MyelinRuntime {
  fire(envelope: Envelope, subject: string, sourceLink?: string): void;
  subscribedPatterns: string[];
  published: Envelope[];
}

function makeFakeRuntime(opts: { canSubscribe?: boolean } = {}): FakeRuntime {
  const canSubscribe = opts.canSubscribe ?? true;
  const handlers = new Set<EnvelopeHandler>();
  const subscribedPatterns: string[] = [];
  const published: Envelope[] = [];
  const subscriberStop = mock(() => Promise.resolve());
  const fakeSubscriber = { stop: subscriberStop } as unknown as MyelinSubscriber;
  return {
    enabled: true,
    subscribedPatterns,
    published,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    publish: (env: Envelope) => {
      published.push(env);
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
    subscribe: (pattern: string) => {
      subscribedPatterns.push(pattern);
      return Promise.resolve(canSubscribe ? fakeSubscriber : null);
    },
    fire(envelope, subject, sourceLink) {
      for (const h of handlers) h(envelope, subject, sourceLink);
    },
  };
}

/** A recording fold callback + the rows it received. */
function recordingFold(): { fn: (f: FoldedObservability) => void; folded: FoldedObservability[] } {
  const folded: FoldedObservability[] = [];
  return { fn: (f) => folded.push(f), folded };
}

function emptyTrustResolver(): TrustResolver {
  return new TrustResolver(AgentRegistry.fromAgents([]));
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const TRANSPORT_TYPE = "system.transport.leaf-connect";
const TRANSPORT_SUBJECT = "federated.joel.research.system.transport.leaf_connect";

// ===========================================================================
// 1. Opt-in
// ===========================================================================

describe("U3.3 — federation opt-in", () => {
  test("no networks ⇒ fold INERT (binds nothing, folds nothing)", async () => {
    const runtime = makeFakeRuntime();
    const fold = recordingFold();
    const handle = await startFederatedObservabilityFold({
      runtime,
      foldObservability: fold.fn,
      federated: undefined,
      source: SYSTEM_SOURCE,
    });
    expect(runtime.subscribedPatterns).toEqual([]);
    runtime.fire(foreignObs(TRANSPORT_TYPE), TRANSPORT_SUBJECT, "primary");
    await flush();
    expect(fold.folded.length).toBe(0);
    await handle.stop();
  });

  test("networks present ⇒ subscribes the federated system firehose", async () => {
    const runtime = makeFakeRuntime();
    const fold = recordingFold();
    const handle = await startFederatedObservabilityFold({
      runtime,
      foldObservability: fold.fn,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
    });
    expect(runtime.subscribedPatterns).toEqual([federatedObservabilitySubject()]);
    expect(federatedObservabilitySubject()).toBe("federated.*.*.system.>");
    await handle.stop();
  });
});

// ===========================================================================
// 2. Fold (curated + accept-listed) + origin attribution
// ===========================================================================

describe("U3.3 — fold curated + accept-listed foreign observability", () => {
  test("allow-listed peer's system.transport.* ⇒ folded, ORIGIN-BADGED foreign", async () => {
    const runtime = makeFakeRuntime();
    const fold = recordingFold();
    const handle = await startFederatedObservabilityFold({
      runtime,
      foldObservability: fold.fn,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      // No trustResolver ⇒ chain check skipped; curation + accept-list gates
      // bound admissible classes + peers (production adds the chain check).
    });
    runtime.fire(
      foreignObs(TRANSPORT_TYPE, { network: "metafactory", leaf: { principal: "joel", stack: "research" } }),
      TRANSPORT_SUBJECT,
      "primary",
    );
    await flush();
    expect(fold.folded.length).toBe(1);
    // The origin badge is the CHAIN-VERIFIED source `{principal}/{stack}`.
    expect(fold.folded[0]?.peer).toBe("joel/research");
    expect(fold.folded[0]?.envelope.type).toBe(TRANSPORT_TYPE);
    await handle.stop();
  });

  test("folds system.federation.* too (the other curated class)", async () => {
    const runtime = makeFakeRuntime();
    const fold = recordingFold();
    const handle = await startFederatedObservabilityFold({
      runtime,
      foldObservability: fold.fn,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
    });
    runtime.fire(
      foreignObs("system.federation.peer.added", { peer: "joel" }),
      "federated.joel.research.system.federation.peer.added",
      "primary",
    );
    await flush();
    expect(fold.folded.length).toBe(1);
    expect(fold.folded[0]?.peer).toBe("joel/research");
    await handle.stop();
  });
});

// ===========================================================================
// 3. NEGATIVE CONTROL (critical) — a peer's non-exported class never folds
// ===========================================================================

describe("U3.3 — NEGATIVE CONTROL: non-exported class excluded at the curation gate", () => {
  test("a peer's system.signal.* is DROPPED — never folded (no row)", async () => {
    const runtime = makeFakeRuntime();
    const fold = recordingFold();
    const handle = await startFederatedObservabilityFold({
      runtime,
      foldObservability: fold.fn,
      // The peer IS accept-listed at the federation tier — proving the curation
      // gate is an INDEPENDENT exclusion, not piggybacking on the accept-list.
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
    });
    runtime.fire(
      foreignObs("system.signal.collector.degraded", { collector_id: "relay-1" }),
      "federated.joel.research.system.signal.collector.degraded",
      "primary",
    );
    await flush();
    expect(fold.folded.length).toBe(0);
    await handle.stop();
  });

  test("a peer's trace.* (session interior) is DROPPED — never folded", async () => {
    const runtime = makeFakeRuntime();
    const fold = recordingFold();
    const handle = await startFederatedObservabilityFold({
      runtime,
      foldObservability: fold.fn,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
    });
    // Even if it somehow rode the `system.>` bind (it wouldn't — trace.* isn't
    // under system.), the curation gate denies it. Fire it on a system subject
    // to prove the gate decides on the TYPE, not just the subject.
    runtime.fire(
      foreignObs("trace.span.start", { span: "x" }),
      "federated.joel.research.system.transport.leaf_connect",
      "primary",
    );
    await flush();
    expect(fold.folded.length).toBe(0);
    await handle.stop();
  });
});

// ===========================================================================
// 4. TRUST gate — federation accept-list (load-bearing)
// ===========================================================================

describe("U3.3 — TRUST: federation accept-list gate", () => {
  test("peer NOT in any network's peers[] ⇒ DROPPED + denial emitted", async () => {
    const runtime = makeFakeRuntime();
    const fold = recordingFold();
    const handle = await startFederatedObservabilityFold({
      runtime,
      foldObservability: fold.fn,
      federated: federatedPolicy([networkWithoutJoel()]),
      source: SYSTEM_SOURCE,
    });
    runtime.fire(foreignObs(TRANSPORT_TYPE), TRANSPORT_SUBJECT, "primary");
    await flush();
    expect(fold.folded.length).toBe(0);
    // The drop is observable as a system.access.denied audit envelope.
    const denied = runtime.published.find(
      (e) => e.type.includes("access") && e.type.includes("denied"),
    );
    expect(denied).toBeDefined();
    await handle.stop();
  });
});

// ===========================================================================
// 5. TRUST gate — chain verification (load-bearing: unsigned/bad-chain drop)
// ===========================================================================

describe("U3.3 — TRUST: signed_by chain verification (fail-closed)", () => {
  test("UNSIGNED foreign envelope under enforce ⇒ DROPPED + chain_verify_failed denial", async () => {
    const runtime = makeFakeRuntime();
    const fold = recordingFold();
    const handle = await startFederatedObservabilityFold({
      runtime,
      foldObservability: fold.fn,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      trustResolver: emptyTrustResolver(),
      receivingAgentId: "luna",
      principalId: "andreas",
      cryptoVerify: false,
      // enforce posture: an empty chain is rejected.
      rejectEmpty: true,
    });
    // An UNSIGNED envelope (empty signed_by): passes curation + accept-list,
    // then FAILS chain verification (empty_chain under rejectEmpty) ⇒ dropped.
    runtime.fire(foreignObs(TRANSPORT_TYPE, {}, { signedBy: [] }), TRANSPORT_SUBJECT, "primary");
    await flush();
    expect(fold.folded.length).toBe(0);
    const denied = runtime.published.find((e) => e.type === "system.access.denied");
    expect(denied).toBeDefined();
    expect((denied!.payload as { reason: { kind: string } }).reason.kind).toBe(
      "chain_verify_failed",
    );
    await handle.stop();
  });

  test("BAD-CHAIN foreign envelope (unresolvable signer) ⇒ DROPPED + denial", async () => {
    const runtime = makeFakeRuntime();
    const fold = recordingFold();
    const handle = await startFederatedObservabilityFold({
      runtime,
      foldObservability: fold.fn,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      trustResolver: emptyTrustResolver(),
      receivingAgentId: "luna",
      principalId: "andreas",
      cryptoVerify: false,
    });
    // A signed-but-untrusted foreign envelope: passes curation + accept-list,
    // then FAILS chain verification (unknown_agent) ⇒ dropped.
    const signed = foreignObs(TRANSPORT_TYPE, {}, {
      signedBy: [
        { method: "ed25519", identity: "did:mf:stranger", signature: "x", timestamp: "t" } as unknown as SignedBy,
      ],
    });
    runtime.fire(signed, TRANSPORT_SUBJECT, "primary");
    await flush();
    expect(fold.folded.length).toBe(0);
    const denied = runtime.published.find((e) => e.type === "system.access.denied");
    expect(denied).toBeDefined();
    expect((denied!.payload as { reason: { kind: string } }).reason.kind).toBe(
      "chain_verify_failed",
    );
    await handle.stop();
  });
});

// ===========================================================================
// 6. Source-bound origin (spoof-resistance)
// ===========================================================================

describe("U3.3 — source-bound origin (the #914 spoof-resistance pattern)", () => {
  test("origin badge derives from the verified SOURCE, NOT the payload", () => {
    const fold = recordingFold();
    // Payload tries to claim a DIFFERENT, local-looking origin; the source is the
    // verified peer. foldVerifiedObservability must badge by source.
    const env = foreignObs(
      TRANSPORT_TYPE,
      { stack_id: "andreas/meta-factory", origin: "andreas" },
      { source: "joel.research.local" },
    );
    foldVerifiedObservability(fold.fn, env, TRANSPORT_SUBJECT);
    expect(fold.folded.length).toBe(1);
    expect(fold.folded[0]?.peer).toBe("joel/research");
  });

  test("a source with < 2 segments is DROPPED (originless rows forbidden)", () => {
    const fold = recordingFold();
    const env = foreignObs(TRANSPORT_TYPE, {}, { source: "joel" });
    foldVerifiedObservability(fold.fn, env, TRANSPORT_SUBJECT);
    expect(fold.folded.length).toBe(0);
  });
});

// ===========================================================================
// 7. Subject filter — local.* is ignored (U2.1 owns local)
// ===========================================================================

describe("U3.3 — subject filter", () => {
  test("a local.* system envelope is IGNORED by the federated fold", async () => {
    const runtime = makeFakeRuntime();
    const fold = recordingFold();
    const handle = await startFederatedObservabilityFold({
      runtime,
      foldObservability: fold.fn,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
    });
    runtime.fire(
      foreignObs(TRANSPORT_TYPE, {}, { source: "andreas.meta-factory.local" }),
      "local.andreas.meta-factory.system.transport.leaf_connect",
      "primary",
    );
    await flush();
    // local.* is U2.1's; the federated fold's subject filter rejects it.
    expect(fold.folded.length).toBe(0);
    await handle.stop();
  });
});
