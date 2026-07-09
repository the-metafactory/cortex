/**
 * G-1114.E.2 + E.5 — trust-verified federated agent-presence subscriber tests.
 *
 * The SECURITY-FOCUSED slice. Coverage axes:
 *   1. Opt-in — no `policy.federated.networks[]` ⇒ subscriber INERT (binds
 *      nothing, folds nothing).
 *   2. Fold — a foreign agent.online from an ACCEPT-LISTED peer ⇒ appears in the
 *      registry, tagged with foreign provenance; local records unaffected.
 *   3. TRUST gate 1 (accept-list) — a foreign envelope from a peer NOT in any
 *      network's `peers[]` is DROPPED (not folded). (load-bearing)
 *   4. TRUST gate 2 (chain) — a foreign envelope that FAILS signed_by
 *      verification is DROPPED. (load-bearing)
 *   5. Provenance — foreign records distinguishable from local (the origin field).
 *   6. Subject filter — a `local.*` presence envelope is ignored by the federated
 *      subscriber (B.3 owns local).
 *   7. Teardown — stop() removes foreign agents cleanly; local survive.
 */

import { describe, expect, test, mock } from "bun:test";
import {
  startFederatedAgentPresenceSubscriber,
  federatedAgentPresenceSubject,
} from "../federated-subscriber";
import { AgentPresenceRegistry, isForeignOrigin } from "../registry";
import { FederatedPresenceReceipts } from "../federated-presence-receipts";
import {
  createAgentOnlineEvent,
  type AgentPresenceSource,
} from "../builders";
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

/** A foreign peer's presence source — `joel/research`. */
const PEER_SOURCE: AgentPresenceSource = {
  principal: "joel",
  stack: "research",
  instance: "local",
};
const PEER_IDENTITY = {
  nkey_public_key: "UPEER1234567890",
  agent_id: "sage",
  assistant_name: "Sage",
};
const PEER_SCOPE = { principal: "joel", stack: "research" };

/** Build a foreign `agent.online` (classification federated). */
function foreignOnline(opts: { signedBy?: SignedBy[] } = {}): Envelope {
  const env = createAgentOnlineEvent({
    source: PEER_SOURCE,
    identity: PEER_IDENTITY,
    scope: PEER_SCOPE,
    capabilities: ["code-review.typescript"],
    startedAt: new Date("2026-06-11T09:00:00.000Z"),
    classification: "federated",
  });
  if (opts.signedBy !== undefined) {
    return { ...env, signed_by: opts.signedBy };
  }
  return env;
}

/**
 * BLOCKER repro — a SPOOF envelope: the wire `source` is the verified peer
 * `joel.research.local`, but the PAYLOAD scope + identity claim a DIFFERENT,
 * LOCAL-looking agent (`andreas/meta-factory/<agentId>`). Pre-fix this would
 * paint a fake local-looking record AND overwrite the real local one via the
 * shared map key. Post-fix the registry must use the SOURCE identity (and the
 * scope≠source mismatch is a spoof ⇒ dropped).
 */
function spoofOnline(claimedAgentId: string): Envelope {
  return createAgentOnlineEvent({
    // VERIFIED source — the accept-listed peer.
    source: PEER_SOURCE,
    // Attacker-controlled payload claims a LOCAL agent identity.
    identity: {
      nkey_public_key: "USPOOF-LOCAL-KEY",
      agent_id: claimedAgentId,
      assistant_name: "Luna",
    },
    scope: { principal: "andreas", stack: "meta-factory" },
    capabilities: ["evil.capability"],
    startedAt: new Date("2026-06-11T09:00:00.000Z"),
    classification: "federated",
  });
}

/** A network that accept-lists joel as a peer + accepts agent presence. */
function networkWithJoel(): PolicyFederatedNetwork {
  return {
    id: "research-collab",
    leaf_node: "primary",
    peers: [{ principal_id: "joel", stack_id: "joel/research" }],
    accept_subjects: ["federated.andreas.meta-factory.agent.>", "federated.joel.research.agent.>"],
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
    accept_subjects: ["federated.joel.research.agent.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 3,
  };
}

function federatedPolicy(networks: PolicyFederatedNetwork[]): PolicyFederated {
  return { networks };
}

// ---------------------------------------------------------------------------
// Fake runtime
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
  const fakeSubscriber = {
    stop: subscriberStop,
  } as unknown as MyelinSubscriber;
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

/** Empty trust resolver — every unknown signer fails structurally. */
function emptyTrustResolver(): TrustResolver {
  return new TrustResolver(AgentRegistry.fromAgents([]));
}

/** Let the microtask queue flush (chain verify resolves on a promise). */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const FED_SUBJECT = "federated.joel.research.agent.online";

// ---------------------------------------------------------------------------
// 1. Opt-in
// ---------------------------------------------------------------------------

describe("E.1 — federation opt-in", () => {
  test("no networks ⇒ subscriber INERT (binds nothing, folds nothing)", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: undefined,
      source: SYSTEM_SOURCE,
    });
    expect(runtime.subscribedPatterns).toEqual([]);
    // Even if a federated envelope were fired, no handler is registered to fold.
    runtime.fire(foreignOnline(), FED_SUBJECT);
    await flush();
    expect(registry.getAgents().length).toBe(0);
    await handle.stop();
  });

  test("empty networks[] ⇒ also inert", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([]),
      source: SYSTEM_SOURCE,
    });
    expect(runtime.subscribedPatterns).toEqual([]);
    await handle.stop();
  });

  test("networks present ⇒ subscribes the federated presence firehose", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
    });
    expect(runtime.subscribedPatterns).toEqual([federatedAgentPresenceSubject()]);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// 2. Fold (accept-listed peer, no chain verifier) + 5. Provenance
// ---------------------------------------------------------------------------

describe("E.2 — fold accept-listed foreign presence", () => {
  test("accept-listed peer's agent.online ⇒ folded, tagged foreign provenance", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      // No trustResolver ⇒ chain check skipped; the accept-list gate alone
      // bounds admissible peers (the production path adds the chain check).
    });
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    const agents = registry.getAgents();
    expect(agents.length).toBe(1);
    expect(agents[0]?.agentId).toBe("sage");
    expect(agents[0]?.principal).toBe("joel");
    expect(agents[0]?.stack).toBe("research");
    expect(agents[0]?.origin).toEqual({
      kind: "foreign",
      principal: "joel",
      stack: "research",
    });
    expect(isForeignOrigin(agents[0]!.origin)).toBe(true);
    await handle.stop();
  });

  test("local records are unaffected by foreign folds (distinguishable)", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    // Seed a LOCAL record directly (B.3 path).
    registry.apply(
      createAgentOnlineEvent({
        source: { principal: "andreas", stack: "meta-factory", instance: "local" },
        identity: { nkey_public_key: "ULOCAL", agent_id: "luna", assistant_name: "Luna" },
        scope: { principal: "andreas", stack: "meta-factory" },
        capabilities: [],
        startedAt: new Date("2026-06-11T08:00:00.000Z"),
      }),
    );
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
    });
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    const local = registry.getAgents().find((a) => a.agentId === "luna");
    const foreign = registry.getAgents().find((a) => a.agentId === "sage");
    expect(local?.origin).toBe("local");
    expect(foreign?.origin).toMatchObject({ kind: "foreign" });
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// FS-6 (cortex#1821) — per-peer received-presence receipts (offline vs unheard)
// ---------------------------------------------------------------------------

describe("FS-6 — records received-presence receipts (folded OR gated)", () => {
  test("a FOLDED accept-listed peer's presence records a receipt", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const receipts = new FederatedPresenceReceipts();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      receipts,
      now: () => 4242,
    });
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    // Folded (accept-listed) AND recorded.
    expect(registry.getAgents().length).toBe(1);
    expect(receipts.everReceived("joel")).toBe(true);
    expect(receipts.get("joel")).toEqual({ count: 1, lastAt: 4242 });
    await handle.stop();
  });

  test("a GATED (non-accept-listed) peer's presence STILL records a receipt — heard on the wire, not unheard", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const receipts = new FederatedPresenceReceipts();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      // joel is NOT a peer here ⇒ the accept-list gate DROPS the envelope.
      federated: federatedPolicy([networkWithoutJoel()]),
      source: SYSTEM_SOURCE,
      receipts,
      now: () => 7000,
    });
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    // DROPPED (not folded) — but we DID hear it on the wire, so it is recorded.
    // This is the FS-6 honesty invariant: "unheard" must mean nothing arrived,
    // NOT arrived-but-policy-dropped. A gated peer is `absent-offline`, never the
    // misleading `absent-unheard`.
    expect(registry.getAgents().length).toBe(0);
    expect(receipts.everReceived("joel")).toBe(true);
    expect(receipts.get("joel")?.count).toBe(1);
    await handle.stop();
  });

  test("a NEVER-heard peer has no receipt (⇒ absent-unheard downstream)", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const receipts = new FederatedPresenceReceipts();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      receipts,
    });
    // Fire nothing for `nyx` — never heard.
    await flush();
    expect(receipts.everReceived("nyx")).toBe(false);
    await handle.stop();
  });

  test("a non-presence subject (local.*) does NOT record a federated receipt", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const receipts = new FederatedPresenceReceipts();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      receipts,
    });
    // A `local.*` presence envelope is B.3's, not the federated subscriber's —
    // it must be ignored entirely (no fold, no receipt).
    runtime.fire(foreignOnline(), "local.joel.research.agent.online", "primary");
    await flush();
    expect(receipts.everReceived("joel")).toBe(false);
    await handle.stop();
  });

  test("repeated heartbeats bump the receipt count (monotonic)", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const receipts = new FederatedPresenceReceipts();
    let clock = 1000;
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      receipts,
      now: () => clock,
    });
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    clock = 2000;
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    expect(receipts.get("joel")).toEqual({ count: 2, lastAt: 2000 });
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// 3. TRUST gate 1 — accept-list (load-bearing)
// ---------------------------------------------------------------------------

describe("E.5 — TRUST: federation accept-list gate", () => {
  test("peer NOT in any network's peers[] ⇒ DROPPED (not folded)", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithoutJoel()]),
      source: SYSTEM_SOURCE,
    });
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    // joel is in NO network's peers[] ⇒ peer_not_in_accept_list ⇒ dropped.
    expect(registry.getAgents().length).toBe(0);
    // The drop is observable as a system.access.denied audit envelope.
    const denied = runtime.published.find((e) =>
      e.type.includes("access") && e.type.includes("denied"),
    );
    expect(denied).toBeDefined();
    await handle.stop();
  });

  test("denied subject ⇒ DROPPED even though peer is accept-listed", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const net = networkWithJoel();
    net.deny_subjects = ["federated.joel.research.agent.>"];
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([net]),
      source: SYSTEM_SOURCE,
    });
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    expect(registry.getAgents().length).toBe(0);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// 4. TRUST gate 2 — chain verification (load-bearing)
// ---------------------------------------------------------------------------

describe("E.5 — TRUST: signed_by chain verification", () => {
  test("foreign envelope with UNRESOLVABLE signer ⇒ DROPPED", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      // Chain verifier wired with an EMPTY trust registry — any non-own signer
      // fails `unknown_agent`. (Structural failure; no crypto needed.)
      trustResolver: emptyTrustResolver(),
      receivingAgentId: "luna",
      principalId: "andreas",
      cryptoVerify: false,
    });
    // A signed-but-untrusted foreign envelope: passes the accept-list gate,
    // then FAILS chain verification ⇒ dropped.
    const signed = foreignOnline({
      signedBy: [
        { method: "ed25519", identity: "did:mf:stranger", signature: "x", timestamp: "t" } as unknown as SignedBy,
      ],
    });
    runtime.fire(signed, FED_SUBJECT, "primary");
    await flush();
    expect(registry.getAgents().length).toBe(0);
    // cortex#932 — the chain-verify rejection is no longer silent: it emits a
    // system.access.denied audit envelope with reason kind chain_verify_failed.
    const denied = runtime.published.find(
      (e) => e.type === "system.access.denied",
    );
    expect(denied).toBeDefined();
    expect(
      (denied!.payload as { reason: { kind: string } }).reason.kind,
    ).toBe("chain_verify_failed");
    await handle.stop();
  });

  test("verifier THREW ⇒ DROPPED + system.access.denied chain_verify_fault (cortex#932)", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    // Force the verify promise to REJECT by making the federated-peer
    // resolution seam throw. `verifySignedByChain` engages this seam only with
    // cryptoVerify:true + a federated-classification envelope (both true here),
    // and the seam is contractually "must never throw" — so a throw drops into
    // the subscriber's .catch() fault path (the cortex#932 chain_verify_fault).
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      trustResolver: emptyTrustResolver(),
      receivingAgentId: "luna",
      principalId: "andreas",
      cryptoVerify: true,
      resolveFederatedPeer: () => {
        throw new Error("resolver exploded");
      },
    });
    const signed = foreignOnline({
      signedBy: [
        { method: "ed25519", identity: "did:mf:stranger", signature: "x", timestamp: "t" } as unknown as SignedBy,
      ],
    });
    runtime.fire(signed, FED_SUBJECT, "primary");
    await flush();
    expect(registry.getAgents().length).toBe(0);
    const denied = runtime.published.find(
      (e) => e.type === "system.access.denied",
    );
    expect(denied).toBeDefined();
    expect(
      (denied!.payload as { reason: { kind: string } }).reason.kind,
    ).toBe("chain_verify_fault");
    await handle.stop();
  });

  test("ENFORCE posture (rejectEmpty:true): EMPTY-chain foreign ⇒ DROPPED", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      trustResolver: emptyTrustResolver(),
      receivingAgentId: "luna",
      principalId: "andreas",
      cryptoVerify: false,
      // signing=enforce → rejectEmpty:true → an unsigned foreign envelope is
      // rejected (must carry a verifiable chain).
      rejectEmpty: true,
    });
    // No signed_by[] ⇒ empty chain ⇒ rejected under enforce.
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    expect(registry.getAgents().length).toBe(0);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// 4b. POSTURE — signing=off folds accept-list-only-unsigned (matches #484)
// ---------------------------------------------------------------------------

describe("E.5 — POSTURE: signing=off (rejectEmpty:false, #484-consistent)", () => {
  test("off-posture: accept-listed EMPTY-chain foreign ⇒ FOLDED (accept-list-only trust)", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      trustResolver: emptyTrustResolver(),
      receivingAgentId: "luna",
      principalId: "andreas",
      cryptoVerify: false,
      // signing=off → rejectEmpty:false → accept-list-ONLY trust (the SAME
      // posture the #484 dispatch-listener uses for federated inbound). Safe
      // because identity is source-bound (the peer can only announce its own
      // agents).
      rejectEmpty: false,
    });
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    // Accept-listed + unsigned ⇒ folded under off-posture, tagged foreign.
    const agents = registry.getAgents();
    expect(agents.length).toBe(1);
    expect(agents[0]?.origin).toEqual({
      kind: "foreign",
      principal: "joel",
      stack: "research",
    });
    await handle.stop();
  });

  test("off-posture STILL drops a peer NOT on the accept-list (gate is posture-independent)", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithoutJoel()]),
      source: SYSTEM_SOURCE,
      rejectEmpty: false,
    });
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    // Even under off-posture, a non-accept-listed peer is gate-dropped.
    expect(registry.getAgents().length).toBe(0);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// 6. Subject filter
// ---------------------------------------------------------------------------

describe("E.2 — subject filter", () => {
  test("a local.* presence envelope is IGNORED (B.3 owns local)", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
    });
    // Fire a LOCAL-subject presence envelope through the federated subscriber.
    runtime.fire(foreignOnline(), "local.joel.research.agent.online", "primary");
    await flush();
    expect(registry.getAgents().length).toBe(0);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// 7. Teardown — disabling federation removes foreign agents cleanly
// ---------------------------------------------------------------------------

describe("E.2 — teardown removes foreign agents cleanly", () => {
  test("stop() drops foreign records; local survive", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    // Local record.
    registry.apply(
      createAgentOnlineEvent({
        source: { principal: "andreas", stack: "meta-factory", instance: "local" },
        identity: { nkey_public_key: "ULOCAL", agent_id: "luna", assistant_name: "Luna" },
        scope: { principal: "andreas", stack: "meta-factory" },
        capabilities: [],
        startedAt: new Date("2026-06-11T08:00:00.000Z"),
      }),
    );
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
    });
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    expect(registry.getAgents().length).toBe(2);

    await handle.stop();
    const remaining = registry.getAgents();
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.agentId).toBe("luna");
    expect(remaining[0]?.origin).toBe("local");
  });

  test("stop() is idempotent", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
    });
    await handle.stop();
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// 8. BLOCKER — provenance/identity spoofing (PR #914 review)
// ---------------------------------------------------------------------------

describe("E.5 — BLOCKER: source-bound identity (no provenance spoof)", () => {
  test("scope≠source spoof ⇒ DROPPED (not folded under the claimed identity)", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      // off-posture (accept-list-only) so the spoof can't hide behind a chain
      // failure — the scope≠source check is what must catch it.
      rejectEmpty: false,
    });
    // joel (accept-listed, verified source) signs an envelope whose payload
    // claims andreas/meta-factory/luna.
    runtime.fire(spoofOnline("luna"), FED_SUBJECT, "primary");
    await flush();
    // The spoof must NOT produce a record claiming the local identity.
    const fake = registry
      .getAgents()
      .find((a) => a.principal === "andreas" && a.stack === "meta-factory");
    expect(fake).toBeUndefined();
    // Nothing folded at all (scope≠source ⇒ dropped).
    expect(registry.getAgents().length).toBe(0);
    await handle.stop();
  });

  test("spoof CANNOT overwrite / delete a real local record of the claimed name", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    // Seed the REAL local luna.
    registry.apply(
      createAgentOnlineEvent({
        source: { principal: "andreas", stack: "meta-factory", instance: "local" },
        identity: { nkey_public_key: "UREAL-LOCAL-LUNA", agent_id: "luna", assistant_name: "Luna" },
        scope: { principal: "andreas", stack: "meta-factory" },
        capabilities: ["code-review.typescript"],
        startedAt: new Date("2026-06-11T08:00:00.000Z"),
      }),
    );
    const realKey = "andreas/meta-factory/luna";
    expect(registry.getAgent(realKey)?.nkeyPublicKey).toBe("UREAL-LOCAL-LUNA");

    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      rejectEmpty: false,
    });
    // joel signs a spoof claiming andreas/meta-factory/luna.
    runtime.fire(spoofOnline("luna"), FED_SUBJECT, "primary");
    await flush();

    // The real local record is UNTOUCHED — not overwritten by the spoof's
    // nkey/capabilities, and still origin "local".
    const real = registry.getAgent(realKey);
    expect(real).toBeDefined();
    expect(real?.nkeyPublicKey).toBe("UREAL-LOCAL-LUNA");
    expect(real?.origin).toBe("local");
    expect(real?.capabilities).toEqual(["code-review.typescript"]);

    // And teardown of the foreign subscriber must NOT delete the real local one.
    await handle.stop();
    expect(registry.getAgent(realKey)?.nkeyPublicKey).toBe("UREAL-LOCAL-LUNA");
  });

  test("a peer announcing ITS OWN agent (scope==source) is folded normally", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithJoel()]),
      source: SYSTEM_SOURCE,
      rejectEmpty: false,
    });
    // scope == source (joel/research) — legitimate self-announce.
    runtime.fire(foreignOnline(), FED_SUBJECT, "primary");
    await flush();
    const rec = registry.getAgent("joel/research/sage");
    expect(rec).toBeDefined();
    expect(rec?.origin).toEqual({ kind: "foreign", principal: "joel", stack: "research" });
    await handle.stop();
  });
});
