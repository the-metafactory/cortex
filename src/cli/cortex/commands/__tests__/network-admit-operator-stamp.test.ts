/**
 * cortex#1598 (epic #1595 slice 2, C3) — the admit fold's OPERATOR-MODE
 * probe-then-stamp. After a scoped-mint seal returns an `operator` block, the
 * fold probes the hub resolver (fake {@link HubAccountProbePort}) and stamps
 * `hub_authorized_at` ONLY on a positive probe — NEVER blind (R4/R7).
 *
 * Driven at the fold level (`runNetworkAdmit` over fake ports) so the decision
 * logic — probe present → stamp, probe absent/throwing → NOT stamp, simple seal
 * → skip the probe entirely — is asserted without any real HTTP / nsc.
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "@nats-io/nkeys";

import { runNetworkAdmit, type AdmitInputs } from "../network-admit-lib";
import type { AdmitPorts, AdmitSealOutcome } from "../network-admit-ports";
import { materialFromSeedString } from "../../../../bus/stack-provisioning";

const MATERIAL = materialFromSeedString(new TextDecoder().decode(createUser().getSeed()));
const FED_ACCOUNT_PUB = "A" + "D".repeat(55);
const SIGNING_KEY_PUB = "A" + "B".repeat(55);

interface FoldRecorder {
  ports: AdmitPorts;
  sealCalls: number;
  probeCalls: { fedAccountPubKey: string }[];
  authorizeCalls: string[];
}

function makeAdmitPorts(opts: {
  sealOutcome: AdmitSealOutcome;
  probe?: { present: boolean; reason?: string } | "throw";
  authorizeThrows?: boolean;
}): FoldRecorder {
  const probeCalls: { fedAccountPubKey: string }[] = [];
  const authorizeCalls: string[] = [];
  let sealCalls = 0;

  const ports: AdmitPorts = {
    registry: {
      getRequest: async (requestId: string) => ({
        outcome: "ok" as const,
        row: { request_id: requestId, principal_id: "alice", status: "PENDING", peer_pubkey: "MEMBERPUB", network_id: "metafactory" },
      }),
      listRequests: async () => ({ outcome: "ok" as const, rows: [] }),
      postDecision: async () => ({ outcome: "ok" as const, principalId: "alice" }),
    },
    discord: {
      assignRole: async () => ({ status: "skipped" as const, warning: "" }),
    },
    seal: {
      sealMember: async () => {
        sealCalls += 1;
        return opts.sealOutcome;
      },
    },
    hubProbe: {
      probeAccountOnHub: async ({ fedAccountPubKey }) => {
        probeCalls.push({ fedAccountPubKey });
        if (opts.probe === "throw") throw new Error("monitor blew up");
        return opts.probe ?? { present: false };
      },
      postAuthorize: async (requestId: string) => {
        authorizeCalls.push(requestId);
        if (opts.authorizeThrows === true) throw new Error("registry 500");
      },
    },
  };
  return {
    ports,
    get sealCalls() {
      return sealCalls;
    },
    probeCalls,
    authorizeCalls,
  };
}

function operatorSealed(): AdmitSealOutcome {
  return { status: "sealed", steps: ["scoped user minted"], operator: { fedAccountPubKey: FED_ACCOUNT_PUB, signingKeyPubKey: SIGNING_KEY_PUB } };
}

function admitInputs(): AdmitInputs {
  return {
    requestId: "req-42",
    registryUrl: "http://localhost:9999",
    material: MATERIAL,
    rosterOnly: false,
    sealOnly: false,
    hubConfigPath: "/fake/hub.conf",
    adminSeedPath: "/fake/admin.nk",
  };
}

describe("cortex#1598 — admit fold probe-then-stamp (C3)", () => {
  test("operator seal + account visible on the resolver → stamps hub_authorized_at", async () => {
    const r = makeAdmitPorts({ sealOutcome: operatorSealed(), probe: { present: true } });
    const report = await runNetworkAdmit(admitInputs(), r.ports);

    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("expected ok");
    expect(r.probeCalls).toEqual([{ fedAccountPubKey: FED_ACCOUNT_PUB }]);
    expect(r.authorizeCalls).toEqual(["req-42"]);
    expect(report.sealOutcome.hubAuthorizedStamped).toBe(true);
    expect(report.sealOutcome.steps.join("\n")).toContain("hub_authorized_at stamped");
  });

  test("operator seal + account NOT visible → does NOT stamp, informative step", async () => {
    const r = makeAdmitPorts({ sealOutcome: operatorSealed(), probe: { present: false, reason: "not propagated" } });
    const report = await runNetworkAdmit(admitInputs(), r.ports);

    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("expected ok");
    expect(r.probeCalls.length).toBe(1);
    expect(r.authorizeCalls.length).toBe(0);
    expect(report.sealOutcome.hubAuthorizedStamped).toBe(false);
    expect(report.sealOutcome.steps.join("\n")).toContain("NOT stamped");
    expect(report.sealOutcome.steps.join("\n")).toContain("not propagated");
  });

  test("a throwing probe is treated as NOT present (fail-safe) — no stamp", async () => {
    const r = makeAdmitPorts({ sealOutcome: operatorSealed(), probe: "throw" });
    const report = await runNetworkAdmit(admitInputs(), r.ports);
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("expected ok");
    expect(r.authorizeCalls.length).toBe(0);
    expect(report.sealOutcome.hubAuthorizedStamped).toBe(false);
  });

  test("a stamp failure leaves hubAuthorizedStamped false + a re-run hint", async () => {
    const r = makeAdmitPorts({ sealOutcome: operatorSealed(), probe: { present: true }, authorizeThrows: true });
    const report = await runNetworkAdmit(admitInputs(), r.ports);
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("expected ok");
    expect(r.authorizeCalls).toEqual(["req-42"]);
    expect(report.sealOutcome.hubAuthorizedStamped).toBe(false);
    expect(report.sealOutcome.steps.join("\n")).toContain("cortex network authorize");
  });

  test("a SIMPLE (non-operator) seal never probes or stamps", async () => {
    const simple: AdmitSealOutcome = { status: "sealed", steps: ["psk written"] };
    const r = makeAdmitPorts({ sealOutcome: simple, probe: { present: true } });
    const report = await runNetworkAdmit(admitInputs(), r.ports);
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("expected ok");
    expect(r.probeCalls.length).toBe(0);
    expect(r.authorizeCalls.length).toBe(0);
    expect(report.sealOutcome.hubAuthorizedStamped).toBeUndefined();
  });
});
