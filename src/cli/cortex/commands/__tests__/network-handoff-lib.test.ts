/**
 * Tests for the `cortex network handoff` PURE state model (cortex#1485, epic
 * #1479, join-6).
 *
 * Two layers, both hermetic:
 *   - `deriveHandoffState` / `guardLeafUp` — pure, no ports. Every combination
 *     of the three leg signals → the correct legs / nextLeg / owner /
 *     canBringLeafUp, plus the fail-closed treatment of an `undefined`
 *     (documented-stub) hub-authorize signal.
 *   - `runHandoffStatus` — driven with FAKE ports (a fake admission port, the
 *     documented-stub hub-auth resolution, a fake config + monitor port). No
 *     fs, no HTTP, no NATS.
 */

import { describe, expect, test } from "bun:test";

import type { PolicyFederatedNetwork } from "../../../../common/types/cortex-config";
import type { ResolveOwnAdmissionStateResult } from "../../../../common/registry/admission-state";
import type { LeafzResponse } from "../network-doctor-ports";
import {
  canBringLeafUp,
  deriveHandoffState,
  guardLeafUp,
  runHandoffStatus,
  type HandoffLegId,
  type HandoffLegStatus,
} from "../network-handoff-lib";
import type {
  HandoffHubAuthPort,
  NetworkHandoffPorts,
} from "../network-handoff-ports";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusOf(
  legs: { id: HandoffLegId; status: HandoffLegStatus }[],
  id: HandoffLegId,
): HandoffLegStatus | undefined {
  return legs.find((l) => l.id === id)?.status;
}

// ---------------------------------------------------------------------------
// deriveHandoffState — every leg combination
// ---------------------------------------------------------------------------

describe("deriveHandoffState — leg combinations", () => {
  test("nothing done: seal pending, later legs blocked, next=seal/admin", () => {
    const s = deriveHandoffState({ sealed: false, hubAuthorized: undefined, leafUp: false });
    expect(statusOf(s.legs, "seal")).toBe("pending");
    expect(statusOf(s.legs, "hub-authorize")).toBe("blocked");
    expect(statusOf(s.legs, "leaf-up")).toBe("blocked");
    expect(s.nextLeg).toBe("seal");
    expect(s.nextOwner).toBe("admin");
    expect(s.canBringLeafUp).toBe(false);
  });

  test("sealed only, hub-authorize UNKNOWN (undefined): hub-authorize pending, leaf-up blocked, next=hub-authorize/hub-owner", () => {
    const s = deriveHandoffState({ sealed: true, hubAuthorized: undefined, leafUp: false });
    expect(statusOf(s.legs, "seal")).toBe("done");
    expect(statusOf(s.legs, "hub-authorize")).toBe("pending");
    expect(statusOf(s.legs, "leaf-up")).toBe("blocked");
    expect(s.nextLeg).toBe("hub-authorize");
    expect(s.nextOwner).toBe("hub-owner");
    // fail-closed — undefined is NOT done.
    expect(s.canBringLeafUp).toBe(false);
  });

  test("sealed only, hub-authorize explicitly false: same as unknown (fail-closed)", () => {
    const s = deriveHandoffState({ sealed: true, hubAuthorized: false, leafUp: false });
    expect(statusOf(s.legs, "hub-authorize")).toBe("pending");
    expect(s.nextLeg).toBe("hub-authorize");
    expect(s.canBringLeafUp).toBe(false);
  });

  test("sealed + hub-authorized, leaf not up: leaf-up pending, next=leaf-up/member, canBringLeafUp=true", () => {
    const s = deriveHandoffState({ sealed: true, hubAuthorized: true, leafUp: false });
    expect(statusOf(s.legs, "seal")).toBe("done");
    expect(statusOf(s.legs, "hub-authorize")).toBe("done");
    expect(statusOf(s.legs, "leaf-up")).toBe("pending");
    expect(s.nextLeg).toBe("leaf-up");
    expect(s.nextOwner).toBe("member");
    expect(s.canBringLeafUp).toBe(true);
  });

  test("all three done: no outstanding leg, canBringLeafUp=true", () => {
    const s = deriveHandoffState({ sealed: true, hubAuthorized: true, leafUp: true });
    expect(s.legs.every((l) => l.status === "done")).toBe(true);
    expect(s.nextLeg).toBeUndefined();
    expect(s.nextOwner).toBeUndefined();
    expect(s.canBringLeafUp).toBe(true);
  });

  test("sealed + attested, leaf-up UNKNOWN (undefined): hub-authorize attested-done, leaf-up pending, canBringLeafUp=true", () => {
    const s = deriveHandoffState(
      { sealed: true, hubAuthorized: undefined, leafUp: undefined },
      { attested: true },
    );
    expect(statusOf(s.legs, "hub-authorize")).toBe("done");
    // leaf-up is ready (seal+hub done) but its state is unobservable → pending,
    // NOT a false "done".
    expect(statusOf(s.legs, "leaf-up")).toBe("pending");
    expect(s.legs.find((l) => l.id === "leaf-up")?.detail).toContain("not observable");
    expect(s.canBringLeafUp).toBe(true);
    expect(s.nextLeg).toBe("leaf-up");
  });

  test("legs are always exactly [seal, hub-authorize, leaf-up] in order", () => {
    const s = deriveHandoffState({ sealed: false, hubAuthorized: false, leafUp: false });
    expect(s.legs.map((l) => l.id)).toEqual(["seal", "hub-authorize", "leaf-up"]);
    expect(s.legs.map((l) => l.owner)).toEqual(["admin", "hub-owner", "member"]);
  });

  test("hub-authorize done but seal NOT done cannot happen — seal gates hub-authorize (defensive: leaf up but not sealed still blocked)", () => {
    // A pathological input: leafUp true while unsealed. Ordering must still hold —
    // both later legs read blocked, canBringLeafUp false.
    const s = deriveHandoffState({ sealed: false, hubAuthorized: true, leafUp: true });
    expect(statusOf(s.legs, "hub-authorize")).toBe("blocked");
    expect(statusOf(s.legs, "leaf-up")).toBe("blocked");
    expect(s.nextLeg).toBe("seal");
    expect(s.canBringLeafUp).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canBringLeafUp — the pure gate
// ---------------------------------------------------------------------------

describe("canBringLeafUp", () => {
  test("true when sealed AND hubAuthorized === true (no attestation needed)", () => {
    expect(canBringLeafUp(true, true)).toBe(true);
    expect(canBringLeafUp(true, false)).toBe(false);
    expect(canBringLeafUp(true, undefined)).toBe(false);
    expect(canBringLeafUp(false, true)).toBe(false);
    expect(canBringLeafUp(false, undefined)).toBe(false);
  });

  test("attestation upgrades an UNDEFINED hub-authorize (the discriminating case)", () => {
    // undefined + attested → PROCEEDS.
    expect(canBringLeafUp(true, undefined, true)).toBe(true);
    // but still needs the seal leg.
    expect(canBringLeafUp(false, undefined, true)).toBe(false);
  });

  test("attestation NEVER upgrades a REAL false hub-authorize", () => {
    expect(canBringLeafUp(true, false, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// guardLeafUp — the enforcement message
// ---------------------------------------------------------------------------

describe("guardLeafUp", () => {
  test("allows when canBringLeafUp", () => {
    const s = deriveHandoffState({ sealed: true, hubAuthorized: true, leafUp: false });
    const g = guardLeafUp(s, "metafactory-community");
    expect(g.allowed).toBe(true);
  });

  test("PROCEEDS when hub-authorize is undefined but the member attests (--hub-authorized-confirmed)", () => {
    const s = deriveHandoffState(
      { sealed: true, hubAuthorized: undefined, leafUp: false },
      { attested: true },
    );
    expect(s.canBringLeafUp).toBe(true);
    expect(guardLeafUp(s, "metafactory-community").allowed).toBe(true);
  });

  test("refuses (hub-unverifiable) when hub-authorize undefined + NO attestation — message points at --hub-authorized-confirmed", () => {
    const s = deriveHandoffState({ sealed: true, hubAuthorized: undefined, leafUp: false });
    expect(s.leafUpBlockedReason).toBe("hub-unverifiable");
    const g = guardLeafUp(s, "metafactory-community");
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.message).toContain("can't be auto-verified");
      expect(g.message).toContain("--hub-authorized-confirmed");
      expect(g.message).toContain("metafactory-community");
    }
  });

  test("refuses (hub-denied) on a REAL false hub-authorize EVEN with attestation — message says attestation cannot override", () => {
    const s = deriveHandoffState(
      { sealed: true, hubAuthorized: false, leafUp: false },
      { attested: true },
    );
    expect(s.leafUpBlockedReason).toBe("hub-denied");
    const g = guardLeafUp(s, "metafactory-community");
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.message).toContain("cannot override");
    }
  });

  test("refuses (seal-pending) when seal pending, naming seal + admin", () => {
    const s = deriveHandoffState({ sealed: false, hubAuthorized: undefined, leafUp: false });
    expect(s.leafUpBlockedReason).toBe("seal-pending");
    const g = guardLeafUp(s, "net-x");
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.message).toContain("seal");
      expect(g.message).toContain("admin");
    }
  });
});

// ---------------------------------------------------------------------------
// runHandoffStatus — driven with fake ports
// ---------------------------------------------------------------------------

function net(overrides: Partial<PolicyFederatedNetwork> = {}): PolicyFederatedNetwork {
  return {
    id: "metafactory-community",
    leaf_node: "hub",
    peers: [{ principal_id: "jc", stack_id: "jc/default" }],
    accept_subjects: ["federated.>"],
    deny_subjects: [],
    ...overrides,
  } as unknown as PolicyFederatedNetwork;
}

function admittedResult(hasSealedSecret: boolean): ResolveOwnAdmissionStateResult {
  return {
    ok: true,
    state: {
      state: hasSealedSecret ? "admitted-sealed" : "admitted-unsealed",
      networkId: "metafactory-community",
      requestId: "req-1",
      hasSealedSecret,
      peerPubkey: "PUBKEY_FIXTURE",
    },
  };
}

const STUB_HUB_AUTH: HandoffHubAuthPort = {
  resolveHubAuthorized: async () => ({
    confirmed: undefined,
    reason: "documented stub — no hub-owner marker",
  }),
};

function fakePorts(opts: {
  admission: ResolveOwnAdmissionStateResult;
  networks: PolicyFederatedNetwork[];
  leafz?: LeafzResponse;
  hubAuth?: HandoffHubAuthPort;
}): NetworkHandoffPorts {
  return {
    admission: { resolve: async () => opts.admission },
    hubAuth: opts.hubAuth ?? STUB_HUB_AUTH,
    config: { readNetworks: () => ({ networks: opts.networks }) },
    monitor: {
      resolve: () => ({ url: "http://127.0.0.1:8222", configured: true }),
      fetchLeafz: async () => opts.leafz,
    },
  };
}

describe("runHandoffStatus", () => {
  test("sealed + leaf up, hub-authorize stub: seal done, hub-authorize pending, leaf-up blocked (gated), canBringLeafUp false", async () => {
    const ports = fakePorts({
      admission: admittedResult(true),
      networks: [net()],
      leafz: { leafs: [{ name: "hub", account: "A", in_msgs: 1, out_msgs: 1 }] },
    });
    const report = await runHandoffStatus(ports, {
      networkId: "metafactory-community",
      member: "andreas",
      selfPrincipal: "andreas",
    });
    expect(statusOf(report.state.legs, "seal")).toBe("done");
    expect(statusOf(report.state.legs, "hub-authorize")).toBe("pending");
    // leaf-up is blocked because hub-authorize (its prerequisite) is not done,
    // EVEN THOUGH the fake /leafz shows an established leaf.
    expect(statusOf(report.state.legs, "leaf-up")).toBe("blocked");
    expect(report.state.canBringLeafUp).toBe(false);
  });

  test("sealed + hub-authorize confirmed + leaf up: all done", async () => {
    const ports = fakePorts({
      admission: admittedResult(true),
      networks: [net()],
      leafz: { leafs: [{ name: "hub", account: "A" }] },
      hubAuth: { resolveHubAuthorized: async () => ({ confirmed: true }) },
    });
    const report = await runHandoffStatus(ports, {
      networkId: "metafactory-community",
      member: "andreas",
      selfPrincipal: "andreas",
    });
    expect(report.state.legs.every((l) => l.status === "done")).toBe(true);
    expect(report.state.canBringLeafUp).toBe(true);
    expect(report.state.nextLeg).toBeUndefined();
  });

  test("not sealed: seal pending, note-free, next=seal", async () => {
    const ports = fakePorts({
      admission: admittedResult(false),
      networks: [net()],
      leafz: { leafs: [] },
    });
    const report = await runHandoffStatus(ports, {
      networkId: "metafactory-community",
      member: "andreas",
      selfPrincipal: "andreas",
    });
    expect(statusOf(report.state.legs, "seal")).toBe("pending");
    expect(report.state.nextLeg).toBe("seal");
  });

  test("admission read fails: adds a note, seal treated as not done", async () => {
    const ports = fakePorts({
      admission: { ok: false, reason: "registry unreachable" },
      networks: [net()],
    });
    const report = await runHandoffStatus(ports, {
      networkId: "metafactory-community",
      member: "andreas",
      selfPrincipal: "andreas",
    });
    expect(statusOf(report.state.legs, "seal")).toBe("pending");
    expect(report.notes.some((n) => n.includes("registry unreachable"))).toBe(true);
  });

  test("member != selfPrincipal: adds the self-vs-remote leaf-up caveat note", async () => {
    const ports = fakePorts({
      admission: admittedResult(true),
      networks: [net()],
      leafz: { leafs: [{ name: "hub" }] },
    });
    const report = await runHandoffStatus(ports, {
      networkId: "metafactory-community",
      member: "jc",
      selfPrincipal: "andreas",
    });
    expect(report.notes.some((n) => n.includes("not observable for member"))).toBe(true);
    // The leaf-up signal is UNKNOWN for a remote member — never a false local read.
    expect(statusOf(report.state.legs, "leaf-up") === "done").toBe(false);
  });

  test("network not configured locally: leaf-up leg cannot read, note added", async () => {
    const ports = fakePorts({
      admission: admittedResult(true),
      networks: [],
    });
    const report = await runHandoffStatus(ports, {
      networkId: "metafactory-community",
      member: "andreas",
      selfPrincipal: "andreas",
    });
    expect(report.notes.some((n) => n.includes("not configured locally"))).toBe(true);
  });
});
