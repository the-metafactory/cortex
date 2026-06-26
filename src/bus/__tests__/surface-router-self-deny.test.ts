/**
 * cortex#1222 — surface-router DISPATCH-deny self-deny flood fix (#1214 follow-up).
 *
 * #1214 self-short-circuited the inbound federated-SUBSCRIBER path. The LIVE
 * flood is the surface-router's `federated.subject_dispatch` gate
 * (`emitFederationDenied`): the stack publishes its OWN presence onto
 * `federated.{us}.{stack}.agent.heartbeat`; the router denies it
 * (`peer_not_in_accept_list` / `unknown_network` — we are not our own peer) and
 * audits it on EVERY tick. #1214 EXPLICITLY flagged this path as out-of-scope.
 *
 * Coverage (mirrors federated-subscriber-self-deny.test.ts):
 *   1. OWN validly-signed heartbeat ⇒ NOT denied, NO audit, NOT routed to
 *      adapters; the crypto bytes-check still RUNS (proven by test 2).
 *   2. Spoofed self-DID (bad signature) ⇒ STILL denied + audited
 *      (`chain_verify_failed`): the trust short-circuit is bytes-checked.
 *   3. A genuinely-denied FOREIGN dispatch ⇒ STILL denied, audited at MOST once
 *      per window (a 2nd identical denial is suppressed).
 *   4. The principal-facing bubble-up fires exactly ONCE across repeats.
 */

import { describe, expect, test } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { signEnvelope } from "@the-metafactory/myelin/identity";
import {
  createSurfaceRouter,
  type SurfaceAdapter,
  type SurfaceDenialBubbleUp,
} from "../surface-router";
import { createAgentHeartbeatEvent, type AgentPresenceSource } from "../agent-network/builders";
import type { Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime } from "../myelin/runtime";
import type { SystemEventSource } from "../system-events";
import type {
  PolicyFederated,
  PolicyFederatedNetwork,
} from "../../common/types/cortex-config";
import { TrustResolver } from "../../common/agents/trust-resolver";
import { AgentRegistry } from "../../common/agents/registry";
import { AccessDeniedDeduper } from "../access-denied-dedup";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSTEM_SOURCE: SystemEventSource = {
  principal: "andreas",
  agent: "cortex",
  instance: "local",
};

const STACK_IDENTITY = "did:mf:andreas-meta-factory";

/** OUR OWN presence source — andreas/meta-factory (the receiving stack). */
const SELF_SOURCE: AgentPresenceSource = {
  principal: "andreas",
  stack: "meta-factory",
  instance: "local",
};

const SELF_SUBJECT = "federated.andreas.meta-factory.agent.heartbeat";
const FOREIGN_SUBJECT = "federated.joel.research.agent.heartbeat";

/** Generate an ed25519 NATS keypair; returns the NKey pub + raw base64 seed. */
function generateEd25519KeyPair(): {
  nkeyPub: string;
  privateKeyBase64: string;
} {
  const kp = createUser();
  const nkeyPub = kp.getPublicKey();
  const rawSeed = (kp as unknown as { getRawSeed(): Uint8Array }).getRawSeed();
  return { nkeyPub, privateKeyBase64: Buffer.from(rawSeed).toString("base64") };
}

/** An unsigned self-presence heartbeat (federated classification). */
function selfHeartbeatBase(): Envelope {
  return createAgentHeartbeatEvent({
    source: SELF_SOURCE,
    identity: {
      nkey_public_key: "USELF",
      agent_id: "luna",
      assistant_name: "Luna",
    },
    scope: { principal: "andreas", stack: "meta-factory" },
    sentAt: new Date("2026-06-25T09:00:00.000Z"),
    classification: "federated",
  });
}

/** A foreign heartbeat from joel (federated). */
function foreignHeartbeat(): Envelope {
  return createAgentHeartbeatEvent({
    source: { principal: "joel", stack: "research", instance: "local" },
    identity: {
      nkey_public_key: "UPEER",
      agent_id: "sage",
      assistant_name: "Sage",
    },
    scope: { principal: "joel", stack: "research" },
    sentAt: new Date("2026-06-25T09:00:00.000Z"),
    classification: "federated",
  });
}

/** Network where joel is NOT a peer (so joel is denied) but our own subtree is accepted. */
function networkWithoutJoel(): PolicyFederatedNetwork {
  return {
    id: "metafactory",
    leaf_node: "primary",
    peers: [],
    accept_subjects: ["federated.andreas.meta-factory.agent.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 3,
  };
}

function federatedPolicy(networks: PolicyFederatedNetwork[]): PolicyFederated {
  return { networks };
}

function emptyTrustResolver(): TrustResolver {
  return new TrustResolver(AgentRegistry.fromAgents([]));
}

// ---------------------------------------------------------------------------
// Fake runtime + a recording adapter
// ---------------------------------------------------------------------------

interface FakeRuntime extends MyelinRuntime {
  published: Envelope[];
}

function makeFakeRuntime(): FakeRuntime {
  const published: Envelope[] = [];
  return {
    enabled: true,
    published,
    onEnvelope() {
      return { unregister: () => {} };
    },
    publish: (env: Envelope) => {
      published.push(env);
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
}

/** A recording adapter matching ALL federated presence so we can assert routed/not-routed. */
function recordingAdapter(): { adapter: SurfaceAdapter; rendered: Envelope[] } {
  const rendered: Envelope[] = [];
  const adapter: SurfaceAdapter = {
    id: "recorder",
    subjects: ["federated.>"],
    render: (envelope: Envelope) => {
      rendered.push(envelope);
      return Promise.resolve();
    },
  };
  return { adapter, rendered };
}

function deniedEnvelopes(runtime: FakeRuntime): Envelope[] {
  return runtime.published.filter((e) => e.type === "system.access.denied");
}

// ---------------------------------------------------------------------------
// 1 + 2. Self short-circuit (root fix) — bytes-checked
// ---------------------------------------------------------------------------

describe("cortex#1222 — surface-router self short-circuit", () => {
  test("OWN validly-signed heartbeat ⇒ NOT denied, NO audit, NOT routed", async () => {
    const { nkeyPub: stackNKeyPub, privateKeyBase64: stackSeed } =
      generateEd25519KeyPair();
    const runtime = makeFakeRuntime();
    const { adapter, rendered } = recordingAdapter();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: SYSTEM_SOURCE,
      federated: federatedPolicy([networkWithoutJoel()]),
      trustResolver: emptyTrustResolver(),
      receivingAgentId: "luna",
      principalId: "andreas",
      cryptoVerify: true,
      stackIdentity: STACK_IDENTITY,
      stackNKeyPub,
    });
    router.register(adapter);

    // Sign the self heartbeat with the STACK key (own DID) — exactly how the
    // runtime stamps an own-presence publish.
    const signed = await signEnvelope(
      selfHeartbeatBase() as unknown as Parameters<typeof signEnvelope>[0],
      stackSeed,
      STACK_IDENTITY,
    );

    await router.dispatch(signed, SELF_SUBJECT, "primary");

    // The verified self-loopback is silently dropped: NOT routed to any
    // adapter (the stack renders its own presence off `local.*`) …
    expect(rendered.length).toBe(0);
    // … and crucially NO system.access.denied flood.
    expect(deniedEnvelopes(runtime).length).toBe(0);
  });

  test("spoofed self-DID with a BAD signature ⇒ STILL denied + audited (bytes-check runs)", async () => {
    const { nkeyPub: stackNKeyPub, privateKeyBase64: stackSeed } =
      generateEd25519KeyPair();
    const runtime = makeFakeRuntime();
    const { adapter, rendered } = recordingAdapter();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: SYSTEM_SOURCE,
      federated: federatedPolicy([networkWithoutJoel()]),
      trustResolver: emptyTrustResolver(),
      receivingAgentId: "luna",
      principalId: "andreas",
      cryptoVerify: true,
      stackIdentity: STACK_IDENTITY,
      stackNKeyPub,
    });
    router.register(adapter);

    const signed = await signEnvelope(
      selfHeartbeatBase() as unknown as Parameters<typeof signEnvelope>[0],
      stackSeed,
      STACK_IDENTITY,
    );
    // TAMPER the signature — the stamp still CLAIMS our stack DID (so the trust
    // short-circuit accepts it structurally) but the bytes no longer verify.
    const signedEnv: Envelope = signed;
    const chain = Array.isArray(signedEnv.signed_by) ? signedEnv.signed_by : [];
    const firstStamp = chain[0];
    if (firstStamp?.method !== "ed25519") {
      throw new Error("test fixture: expected ed25519 stamp at index 0");
    }
    const tamperedSig = firstStamp.signature.startsWith("A")
      ? "B" + firstStamp.signature.slice(1)
      : "A" + firstStamp.signature.slice(1);
    const tampered: Envelope = {
      ...signedEnv,
      signed_by: [{ ...firstStamp, signature: tamperedSig }],
    };

    await router.dispatch(tampered, SELF_SUBJECT, "primary");

    // Forged self-DID: NOT routed, and AUDITED as a chain-verify failure — the
    // crypto bytes-check ran (the trust short-circuit alone would have accepted).
    expect(rendered.length).toBe(0);
    const denied = deniedEnvelopes(runtime);
    expect(denied.length).toBe(1);
    expect((denied[0]!.payload as { reason: { kind: string } }).reason.kind).toBe(
      "chain_verify_failed",
    );
  });

  test("self-claim with NO verifier wired ⇒ dropped (no flood), bubbles up once", async () => {
    const { privateKeyBase64: stackSeed } = generateEd25519KeyPair();
    const runtime = makeFakeRuntime();
    const { adapter, rendered } = recordingAdapter();
    const bubbles: SurfaceDenialBubbleUp[] = [];
    const router = createSurfaceRouter(runtime, {
      systemEventSource: SYSTEM_SOURCE,
      federated: federatedPolicy([networkWithoutJoel()]),
      // NO trustResolver / receivingAgentId — the no-verifier branch.
      stackIdentity: STACK_IDENTITY,
      onDenialBubbleUp: (info) => bubbles.push(info),
    });
    router.register(adapter);

    const signed = await signEnvelope(
      selfHeartbeatBase() as unknown as Parameters<typeof signEnvelope>[0],
      stackSeed,
      STACK_IDENTITY,
    );

    await router.dispatch(signed, SELF_SUBJECT, "primary");
    await router.dispatch(signed, SELF_SUBJECT, "primary");

    // Dropped (never routed), no deny audit flood, bubble-up fires once.
    expect(rendered.length).toBe(0);
    expect(deniedEnvelopes(runtime).length).toBe(0);
    expect(bubbles.length).toBe(1);
    expect(bubbles[0]?.identity.reason).toBe("self_loopback_unverifiable");
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. Dedupe + bubble-up — a real foreign denial is still denied, once
// ---------------------------------------------------------------------------

describe("cortex#1222 — surface-router dedupe + bubble-up", () => {
  test("FOREIGN non-peer denied EVERY tick ⇒ audited at MOST once per window", async () => {
    const runtime = makeFakeRuntime();
    const { adapter, rendered } = recordingAdapter();
    const router = createSurfaceRouter(runtime, {
      systemEventSource: SYSTEM_SOURCE,
      federated: federatedPolicy([networkWithoutJoel()]),
      // Large window so back-to-back identical denials collapse to one.
      denialDeduper: new AccessDeniedDeduper({ windowMs: 60_000 }),
    });
    router.register(adapter);

    // joel is in no network's peers[] ⇒ peer_not_in_accept_list, every tick.
    await router.dispatch(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");
    await router.dispatch(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");
    await router.dispatch(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");

    // STILL denied (never routed) but audited only ONCE (no flood).
    expect(rendered.length).toBe(0);
    expect(deniedEnvelopes(runtime).length).toBe(1);
  });

  test("bubble-up fires exactly ONCE across repeated identical denials", async () => {
    const runtime = makeFakeRuntime();
    const bubbles: SurfaceDenialBubbleUp[] = [];
    const router = createSurfaceRouter(runtime, {
      systemEventSource: SYSTEM_SOURCE,
      federated: federatedPolicy([networkWithoutJoel()]),
      denialDeduper: new AccessDeniedDeduper({ windowMs: 60_000 }),
      onDenialBubbleUp: (info) => bubbles.push(info),
    });

    await router.dispatch(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");
    await router.dispatch(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");
    await router.dispatch(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");

    expect(bubbles.length).toBe(1);
    expect(bubbles[0]?.identity.reason).toBe("peer_not_in_accept_list");
  });
});
