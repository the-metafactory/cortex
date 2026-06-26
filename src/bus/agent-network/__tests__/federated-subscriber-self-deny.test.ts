/**
 * cortex#1213 — federation self-deny loop fix.
 *
 * A federated stack publishes its OWN presence onto `federated.{us}.agent.>`
 * (so peers see it); that loops back to its own federated subscriber and — pre
 * fix — the accept-list gate denied + audited it on EVERY heartbeat tick (we
 * are not our own peer), flooding `system.access.denied`.
 *
 * Coverage:
 *   1. OWN heartbeat (validly self-signed) ⇒ NOT denied, NO audit, NOT folded;
 *      the crypto bytes-check still RUNS (proven by test 2's rejection of a
 *      forged self-DID — same path, only the bytes differ).
 *   2. Spoofed self-DID (bad signature) ⇒ STILL rejected + audited
 *      (`chain_verify_failed`): the trust short-circuit is bytes-checked.
 *   3. A genuinely-denied FOREIGN envelope ⇒ STILL denied, but audited at MOST
 *      once per window (a 2nd identical denial is suppressed).
 *   4. The principal-facing bubble-up fires exactly ONCE across repeats.
 */

import { describe, expect, test, mock } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { signEnvelope } from "@the-metafactory/myelin/identity";
import {
  startFederatedAgentPresenceSubscriber,
  type DenialBubbleUp,
} from "../federated-subscriber";
import { AgentPresenceRegistry } from "../registry";
import { createAgentHeartbeatEvent, type AgentPresenceSource } from "../builders";
import type { Envelope } from "../../myelin/envelope-validator";
import type { MyelinRuntime, EnvelopeHandler } from "../../myelin/runtime";
import type { MyelinSubscriber } from "../../myelin/subscriber";
import type { SystemEventSource } from "../../system-events";
import type {
  PolicyFederated,
  PolicyFederatedNetwork,
} from "../../../common/types/cortex-config";
import { TrustResolver } from "../../../common/agents/trust-resolver";
import { AgentRegistry } from "../../../common/agents/registry";
import { AccessDeniedDeduper } from "../../access-denied-dedup";

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
// Fake runtime
// ---------------------------------------------------------------------------

interface FakeRuntime extends MyelinRuntime {
  fire(envelope: Envelope, subject: string, sourceLink?: string): void;
  published: Envelope[];
}

function makeFakeRuntime(): FakeRuntime {
  const handlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  const fakeSubscriber = { stop: mock(() => Promise.resolve()) } as unknown as MyelinSubscriber;
  return {
    enabled: true,
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
    subscribe: () => Promise.resolve(fakeSubscriber),
    fire(envelope, subject, sourceLink) {
      for (const h of handlers) h(envelope, subject, sourceLink);
    },
  };
}

function deniedEnvelopes(runtime: FakeRuntime): Envelope[] {
  return runtime.published.filter((e) => e.type === "system.access.denied");
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * The chain verify is async (ed25519 verifyAsync + a promise chain); a single
 * macrotask tick is not enough to let it settle under full-suite load. Poll
 * until `predicate` holds or the budget elapses.
 */
async function until(
  predicate: () => boolean,
  { tries = 200, stepMs = 5 }: { tries?: number; stepMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ---------------------------------------------------------------------------
// 1. OWN heartbeat — self short-circuit (root fix)
// ---------------------------------------------------------------------------

describe("cortex#1213 — self short-circuit", () => {
  test("OWN validly-signed heartbeat ⇒ NOT denied, NO audit, NOT folded", async () => {
    const { nkeyPub: stackNKeyPub, privateKeyBase64: stackSeed } =
      generateEd25519KeyPair();
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithoutJoel()]),
      source: SYSTEM_SOURCE,
      trustResolver: emptyTrustResolver(),
      receivingAgentId: "luna",
      principalId: "andreas",
      cryptoVerify: true,
      stackIdentity: STACK_IDENTITY,
      stackNKeyPub,
    });

    // Sign the self heartbeat with the STACK key (own DID) — exactly how the
    // runtime stamps an own-presence publish.
    const signed = await signEnvelope(
      selfHeartbeatBase() as unknown as Parameters<typeof signEnvelope>[0],
      stackSeed,
      STACK_IDENTITY,
    );

    runtime.fire(signed, SELF_SUBJECT, "primary");
    // Give the async crypto verify ample time to settle, then assert the
    // ABSENCE of any fold / audit (a generous fixed wait — there is no positive
    // signal to poll for on the silent-drop happy path).
    await new Promise((r) => setTimeout(r, 150));

    // The self-loopback is silently dropped: not folded as a foreign record …
    expect(registry.getAgents().length).toBe(0);
    // … and crucially NO system.access.denied flood.
    expect(deniedEnvelopes(runtime).length).toBe(0);
    await handle.stop();
  });

  test("spoofed self-DID with a BAD signature ⇒ STILL rejected + audited (bytes-check runs)", async () => {
    const { nkeyPub: stackNKeyPub, privateKeyBase64: stackSeed } =
      generateEd25519KeyPair();
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithoutJoel()]),
      source: SYSTEM_SOURCE,
      trustResolver: emptyTrustResolver(),
      receivingAgentId: "luna",
      principalId: "andreas",
      cryptoVerify: true,
      stackIdentity: STACK_IDENTITY,
      stackNKeyPub,
    });

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

    runtime.fire(tampered, SELF_SUBJECT, "primary");
    await until(() => deniedEnvelopes(runtime).length >= 1);

    // Forged self-DID: not folded, and AUDITED as a chain-verify failure — the
    // crypto bytes-check ran (the trust short-circuit alone would have accepted).
    expect(registry.getAgents().length).toBe(0);
    const denied = deniedEnvelopes(runtime);
    expect(denied.length).toBe(1);
    expect((denied[0]!.payload as { reason: { kind: string } }).reason.kind).toBe(
      "chain_verify_failed",
    );
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. Dedupe + bubble-up — a real foreign denial is still denied, once
// ---------------------------------------------------------------------------

describe("cortex#1213 — dedupe + bubble-up", () => {
  test("FOREIGN non-peer denied EVERY tick ⇒ audited at MOST once per window", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithoutJoel()]),
      source: SYSTEM_SOURCE,
      // Large window so two back-to-back identical denials collapse to one.
      denialDeduper: new AccessDeniedDeduper({ windowMs: 60_000 }),
    });

    // joel is in no network's peers[] ⇒ peer_not_in_accept_list, every tick.
    runtime.fire(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");
    runtime.fire(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");
    runtime.fire(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");
    await flush();

    // STILL denied (security preserved) but audited only ONCE (no flood).
    expect(registry.getAgents().length).toBe(0);
    expect(deniedEnvelopes(runtime).length).toBe(1);
    await handle.stop();
  });

  test("bubble-up fires exactly ONCE across repeated identical denials", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const bubbles: DenialBubbleUp[] = [];
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithoutJoel()]),
      source: SYSTEM_SOURCE,
      denialDeduper: new AccessDeniedDeduper({ windowMs: 60_000 }),
      onDenialBubbleUp: (info) => bubbles.push(info),
    });

    runtime.fire(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");
    runtime.fire(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");
    runtime.fire(foreignHeartbeat(), FOREIGN_SUBJECT, "primary");
    await flush();

    expect(bubbles.length).toBe(1);
    expect(bubbles[0]?.identity.reason).toBe("peer_not_in_accept_list");
    await handle.stop();
  });
});
