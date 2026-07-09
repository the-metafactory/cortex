/**
 * FS-1 (cortex#1825) ANTI-SPOOF REGRESSION SUITE — locks the two cross-network
 * / accept-list-bypass spoofs the adversarial review reproduced, now asserting
 * the CORRECT (dropped) behaviour, plus a positive control.
 *
 * REGRESSION 1 (cross-leaf membership-fold spoof, now DROPPED): for a
 * MEMBERSHIP-ONLY principal (admitted in the registry, but with NO static
 * `peers[]` entry in ANY joined network's config), the F-3d leaf/network
 * anti-spoof check (`source_link_mismatch`) never runs in `evaluateFederationGate`
 * (that check is reached only after `resolveSourceNetwork` finds the principal in
 * a network's `peers[]`). The FIX gives the MEMBERSHIP path its OWN leaf→network
 * scope: the override fires only when the source is admitted on a network the
 * DELIVERING leaf serves. So a peer on Leaf A can no longer impersonate a
 * principal admitted only on Network B (reachable via Leaf B) — the envelope
 * delivered on the WRONG leaf now DROPS.
 *
 * REGRESSION 2 (known-peer accept_subjects bypass, now DROPPED): the override now
 * requires `decision.unknown_network === true`, so a peer that IS declared in
 * `peers[]` (known, not hand-pinned) but whose `accept_subjects` deliberately
 * excludes the presence subject is NO LONGER folded by membership — the
 * principal's explicit narrowing is honoured.
 *
 * POSITIVE CONTROL: a legitimately admitted member delivered on ITS OWN
 * network's leaf STILL folds (the fix must not over-correct into breaking FS-1).
 */

import { describe, expect, test } from "bun:test";
import {
  startFederatedAgentPresenceSubscriber,
} from "../federated-subscriber";
import { AgentPresenceRegistry } from "../registry";
import { createAgentOnlineEvent, type AgentPresenceSource } from "../builders";
import type { Envelope, SignedBy } from "../../myelin/envelope-validator";
import type { MyelinRuntime, EnvelopeHandler } from "../../myelin/runtime";
import type { MyelinSubscriber } from "../../myelin/subscriber";
import type { SystemEventSource } from "../../system-events";
import type {
  PolicyFederated,
  PolicyFederatedNetwork,
} from "../../../common/types/cortex-config";

const SYSTEM_SOURCE: SystemEventSource = {
  principal: "andreas",
  agent: "cortex",
  instance: "local",
};

function makeFakeRuntime(): MyelinRuntime & {
  fire(envelope: Envelope, subject: string, sourceLink?: string): void;
} {
  const handlers = new Set<EnvelopeHandler>();
  const fakeSubscriber = { stop: () => Promise.resolve() } as unknown as MyelinSubscriber;
  return {
    enabled: true,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    publish: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    subscribe: () => Promise.resolve(fakeSubscriber),
    fire(envelope, subject, sourceLink) {
      for (const h of handlers) h(envelope, subject, sourceLink);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function federatedPolicy(networks: PolicyFederatedNetwork[]): PolicyFederated {
  return { networks };
}

// ---------------------------------------------------------------------------
// PROBE 1 — cross-leaf membership-fold spoof
// ---------------------------------------------------------------------------

function networkA(): PolicyFederatedNetwork {
  return {
    id: "network-a",
    leaf_node: "leafA",
    peers: [
      { principal_id: "trusted-a", stack_id: "trusted-a/stack", principal_pubkey: "PUBKEY-A" },
    ],
    accept_subjects: ["federated.trusted-a.stack.agent.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 3,
  };
}

function networkB(): PolicyFederatedNetwork {
  return {
    id: "network-b",
    leaf_node: "leafB",
    peers: [],
    accept_subjects: ["federated.victim.stack.agent.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 3,
  };
}

function victimOnline(opts: { signedBy?: SignedBy[] } = {}): Envelope {
  const source: AgentPresenceSource = { principal: "victim", stack: "stack", instance: "local" };
  const env = createAgentOnlineEvent({
    source,
    identity: { nkey_public_key: "UVICTIM", agent_id: "sage", assistant_name: "Sage" },
    scope: { principal: "victim", stack: "stack" },
    capabilities: [],
    startedAt: new Date("2026-06-11T09:00:00.000Z"),
    classification: "federated",
  });
  if (opts.signedBy !== undefined) return { ...env, signed_by: opts.signedBy };
  return env;
}

describe("FS-1 REGRESSION 1 — cross-leaf membership-fold spoof is DROPPED", () => {
  test("victim admitted on Network B, but its presence delivered on the WRONG leaf (leafA) DROPS under signing:off", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkA(), networkB()]),
      source: SYSTEM_SOURCE,
      rejectEmpty: false,
      // victim is a legit admitted member of Network B (leaf leafB) ONLY.
      isAdmittedMemberOfNetwork: (p, nid) => p === "victim" && nid === "network-b",
    });

    // ...but the spoofed envelope arrives on leafA (Network A's leaf). Membership
    // is now leaf-scoped: leafA serves Network A, and victim is NOT admitted
    // there ⇒ DROP.
    runtime.fire(
      victimOnline(),
      "federated.andreas.meta-factory.agent.online",
      "leafA",
    );
    await flush();

    expect(registry.getAgents().length).toBe(0);
    await handle.stop();
  });

  test("POSITIVE CONTROL: victim admitted on Network B, delivered on ITS OWN leaf (leafB) STILL folds", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkA(), networkB()]),
      source: SYSTEM_SOURCE,
      rejectEmpty: false,
      isAdmittedMemberOfNetwork: (p, nid) => p === "victim" && nid === "network-b",
    });

    // Delivered on leafB — Network B's own leaf, where victim IS admitted ⇒ FOLD.
    runtime.fire(
      victimOnline(),
      "federated.andreas.meta-factory.agent.online",
      "leafB",
    );
    await flush();

    const agents = registry.getAgents();
    expect(agents.length).toBe(1);
    expect(agents[0]?.principal).toBe("victim");
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// PROBE 2 — known-peer-with-restricted-accept_subjects still folds by membership
// ---------------------------------------------------------------------------

function networkWithRestrictedJoel(): PolicyFederatedNetwork {
  return {
    id: "research-collab",
    leaf_node: "primary",
    // joel IS declared (known peer, NOT hand-pinned — no principal_pubkey)...
    peers: [{ principal_id: "joel", stack_id: "joel/research" }],
    // ...but the principal deliberately did NOT put joel's presence subject on
    // accept_subjects (e.g. joel is allowed dispatch only, not presence).
    accept_subjects: ["federated.joel.research.dispatch.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 3,
  };
}

function joelOnline(): Envelope {
  const source: AgentPresenceSource = { principal: "joel", stack: "research", instance: "local" };
  return createAgentOnlineEvent({
    source,
    identity: { nkey_public_key: "UJOEL", agent_id: "sage", assistant_name: "Sage" },
    scope: { principal: "joel", stack: "research" },
    capabilities: [],
    startedAt: new Date("2026-06-11T09:00:00.000Z"),
    classification: "federated",
  });
}

describe("FS-1 REGRESSION 2 — known-but-subject-restricted peer is DROPPED", () => {
  test("joel is a KNOWN peer whose accept_subjects deliberately excludes presence — membership override does NOT apply (unknown_network required) ⇒ DROP", async () => {
    const runtime = makeFakeRuntime();
    const registry = new AgentPresenceRegistry();
    const handle = await startFederatedAgentPresenceSubscriber({
      runtime,
      registry,
      federated: federatedPolicy([networkWithRestrictedJoel()]),
      source: SYSTEM_SOURCE,
      rejectEmpty: false,
      isAdmittedMemberOfNetwork: (p, nid) =>
        p === "joel" && nid === "research-collab",
    });

    runtime.fire(joelOnline(), "federated.joel.research.agent.online", "primary");
    await flush();

    // joel IS resolved via peers[] ⇒ the gate denies with
    // `peer_not_in_accept_list` but WITHOUT `unknown_network`. The override now
    // requires `unknown_network === true`, so the principal's accept_subjects
    // narrowing is honoured ⇒ DROP.
    expect(registry.getAgents().length).toBe(0);
    await handle.stop();
  });
});
