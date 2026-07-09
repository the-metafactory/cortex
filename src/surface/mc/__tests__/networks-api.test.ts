/**
 * MC-A1 (cortex#1275) — `handleListNetworks` tests.
 *
 * Drives the handler directly over a stub `NetworksView` + `AgentPresenceView`
 * (the minimal read-only contracts; no bus, no registry, no HTTP). Covers the
 * graceful no-federation path, the admitted ⋈ presence reconciliation, the
 * self-scoped anomaly-suppression (the registry-Q3-prerequisite reality), the
 * authoritative anomaly path, and read-failure degradation (never 5xx).
 */

import { describe, it, expect } from "bun:test";
import {
  handleListNetworks,
  type NetworksView,
  type ListNetworksResponse,
} from "../api/networks";
import type { NetworkConfidentialityPosture } from "../../../common/crypto/network-encryption-policy";
import type {
  AgentPresenceSnapshotRecord,
  AgentPresenceView,
} from "../api/agents";
import type { ResolveAdmittedRosterResult } from "../../../bus/agent-network/admission-read";
import {
  summarizeAcceptancePolicy,
  resolvePeerAcceptance,
} from "../../../bus/agent-network/peer-acceptance";

function presenceView(
  records: AgentPresenceSnapshotRecord[],
): AgentPresenceView {
  return { getAgents: () => records };
}

function rec(
  over: Partial<AgentPresenceSnapshotRecord> & { agentId: string },
): AgentPresenceSnapshotRecord {
  const { agentId } = over;
  return {
    key: `andreas/main/${agentId}`,
    origin: "local",
    nkeyPublicKey: `N${agentId}`,
    assistantName: null,
    principal: "andreas",
    stack: "main",
    capabilities: [],
    state: "online",
    lastSeenAt: 1000,
    ...over,
  };
}

/** Default posture for the stubs that don't exercise confidentiality (off, no key). */
const CLEARTEXT: NetworkConfidentialityPosture = {
  mode: "off",
  keyPresent: false,
  keyId: null,
};

function view(
  rosters: Record<string, ResolveAdmittedRosterResult>,
  localPrincipal = "andreas",
  confidentiality: Record<string, NetworkConfidentialityPosture> = {},
): NetworksView {
  return {
    localPrincipal,
    networks: () =>
      Object.keys(rosters).map((networkId) => ({
        networkId,
        leafNode: `${networkId}-leaf`,
        confidentiality: confidentiality[networkId] ?? CLEARTEXT,
      })),
    resolveAdmittedRoster: (networkId) =>
      Promise.resolve(
        rosters[networkId] ?? {
          ok: false,
          reason: "not_configured",
          detail: "no roster",
        },
      ),
  };
}

async function body(res: Response): Promise<ListNetworksResponse> {
  return (await res.json()) as ListNetworksResponse;
}

describe("handleListNetworks — graceful states", () => {
  it("view === null → empty networks list (no federation configured)", async () => {
    const res = await handleListNetworks(null, null);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ networks: [] });
  });

  it("a throwing admission provider degrades to unreachable, never 5xx", async () => {
    const throwingView: NetworksView = {
      localPrincipal: "andreas",
      networks: () => [
        { networkId: "research-collab", leafNode: "rc-leaf", confidentiality: CLEARTEXT },
      ],
      resolveAdmittedRoster: () => Promise.reject(new Error("transport boom")),
    };
    const res = await handleListNetworks(
      throwingView,
      presenceView([rec({ agentId: "luna" })]),
    );
    expect(res.status).toBe(200);
    const net = (await body(res)).networks[0]!;
    expect(net.roster_status).toBe("unreachable");
    expect(net.members).toEqual([
      {
        principal: "andreas",
        verdict: "admitted-present",
        present_stacks: ["main"],
        accepts: "self",
      },
    ]);
  });

  it("read failure degrades to a self-only membership, never 5xx", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: false,
          reason: "unreachable",
          detail: "registry down",
        },
      }),
      presenceView([rec({ agentId: "luna" })]),
    );
    expect(res.status).toBe(200);
    const out = await body(res);
    const net = out.networks[0]!;
    expect(net.roster_status).toBe("unreachable");
    expect(net.roster_scope).toBeNull();
    // Self is still a member (joined stack) + present.
    expect(net.members).toEqual([
      {
        principal: "andreas",
        verdict: "admitted-present",
        present_stacks: ["main"],
        accepts: "self",
      },
    ]);
  });
});

describe("handleListNetworks — authoritative reconciliation", () => {
  it("admitted peer present → admitted-present; admitted peer absent (no receipt seam) → absent-offline", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: true,
          roster: { admitted: ["jc", "zeta"], pending: [], authoritative: true },
        },
      }),
      presenceView([
        rec({ agentId: "luna" }), // andreas/main present
        rec({
          agentId: "echo",
          origin: { kind: "foreign", principal: "jc", stack: "research" },
        }),
      ]),
    );
    const net = (await body(res)).networks[0]!;
    expect(net.roster_scope).toBe("complete");
    const byPrincipal = Object.fromEntries(net.members.map((m) => [m.principal, m.verdict]));
    expect(byPrincipal).toEqual({
      andreas: "admitted-present",
      jc: "admitted-present",
      zeta: "absent-offline",
    });
  });

  it("FS-6 — splits absent into offline (heard) vs unheard (never heard) off the receipt seam", async () => {
    // Two admitted peers, both absent. `zeta` we have HEARD before (a receipt);
    // `nyx` we have NEVER heard. The verdict must honestly distinguish them.
    const base = view({
      "research-collab": {
        ok: true,
        roster: { admitted: ["zeta", "nyx"], pending: [], authoritative: true },
      },
    });
    const heard = new Set(["zeta"]);
    const withReceipts: NetworksView = {
      ...base,
      receivedPresenceFrom: (principal) => heard.has(principal),
    };
    const res = await handleListNetworks(
      withReceipts,
      presenceView([rec({ agentId: "luna" })]), // only andreas/main present
    );
    const net = (await body(res)).networks[0]!;
    const byPrincipal = Object.fromEntries(net.members.map((m) => [m.principal, m.verdict]));
    expect(byPrincipal).toEqual({
      andreas: "admitted-present",
      zeta: "absent-offline", // heard before → offline
      nyx: "absent-unheard", // never heard → unheard (import/cred gap)
    });
  });

  it("present foreign principal admitted to NO network → present-but-unadmitted (anomaly)", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: true,
          roster: { admitted: ["jc"], pending: [], authoritative: true },
        },
      }),
      presenceView([
        rec({ agentId: "luna" }),
        rec({
          agentId: "x",
          origin: { kind: "foreign", principal: "mallory", stack: "s" },
        }),
      ]),
    );
    const net = (await body(res)).networks[0]!;
    expect(net.members).toContainEqual({
      principal: "mallory",
      verdict: "present-but-unadmitted",
      present_stacks: ["s"],
      accepts: "not-accepted",
    });
  });

  it("pending admission request surfaces as pending", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: true,
          roster: { admitted: [], pending: ["newcomer"], authoritative: true },
        },
      }),
      presenceView([rec({ agentId: "luna" })]),
    );
    const net = (await body(res)).networks[0]!;
    expect(net.members).toContainEqual({
      principal: "newcomer",
      verdict: "pending",
      present_stacks: [],
      accepts: "not-accepted",
    });
  });
});

describe("handleListNetworks — confidentiality posture carry-through (MC-A3, ADR-0019/0018)", () => {
  it("carries the per-network posture through to the wire DTO (camelCase → snake_case)", async () => {
    const res = await handleListNetworks(
      view(
        {
          "research-collab": {
            ok: true,
            roster: { admitted: [], pending: [], authoritative: true },
          },
        },
        "andreas",
        {
          "research-collab": {
            mode: "required",
            keyPresent: true,
            keyId: "research-collab/k1",
          },
        },
      ),
      presenceView([rec({ agentId: "luna" })]),
    );
    const net = (await body(res)).networks[0]!;
    expect(net.confidentiality).toEqual({
      mode: "required",
      key_present: true,
      key_id: "research-collab/k1",
    });
  });

  it("defaults to a cleartext posture when none is configured", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: true,
          roster: { admitted: [], pending: [], authoritative: true },
        },
      }),
      presenceView([rec({ agentId: "luna" })]),
    );
    const net = (await body(res)).networks[0]!;
    expect(net.confidentiality).toEqual({
      mode: "off",
      key_present: false,
      key_id: null,
    });
  });

  it("posture is independent of a degraded roster read (still carried on a self-only read)", async () => {
    const res = await handleListNetworks(
      view(
        {
          "research-collab": {
            ok: false,
            reason: "unreachable",
            detail: "registry down",
          },
        },
        "andreas",
        {
          "research-collab": { mode: "enabled", keyPresent: false, keyId: null },
        },
      ),
      presenceView([rec({ agentId: "luna" })]),
    );
    const net = (await body(res)).networks[0]!;
    // Roster read failed, but the config-derived posture is still honestly carried
    // (configured-to-seal, NO key — a degraded/cleartext posture, never "encrypted").
    expect(net.roster_status).toBe("unreachable");
    expect(net.confidentiality).toEqual({
      mode: "enabled",
      key_present: false,
      key_id: null,
    });
  });
});

describe("handleListNetworks — self-scoped read suppresses anomalies (registry-Q3 reality)", () => {
  it("does NOT flag present peers as anomalies when the roster is self-only", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: true,
          // self-only read: we know we're admitted, but NOT the peer roster.
          roster: { admitted: ["andreas"], pending: [], authoritative: false },
        },
      }),
      presenceView([
        rec({ agentId: "luna" }),
        rec({
          agentId: "echo",
          origin: { kind: "foreign", principal: "jc", stack: "research" },
        }),
      ]),
    );
    const net = (await body(res)).networks[0]!;
    expect(net.roster_scope).toBe("self");
    // jc is present but must NOT be flagged unadmitted — we can't prove it.
    expect(net.members.some((m) => m.verdict === "present-but-unadmitted")).toBe(false);
    expect(net.members.map((m) => m.principal)).toEqual(["andreas"]);
  });
});

describe("handleListNetworks — per-principal acceptance (MC-A2, the second trust layer)", () => {
  it("defaults to self/not-accepted when the view supplies no acceptsPeer resolver", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: true,
          roster: { admitted: ["jc"], pending: [], authoritative: true },
        },
      }),
      presenceView([rec({ agentId: "luna" })]),
    );
    const net = (await body(res)).networks[0]!;
    const accepts = Object.fromEntries(net.members.map((m) => [m.principal, m.accepts]));
    expect(accepts).toEqual({ andreas: "self", jc: "not-accepted" });
  });

  it("carries the live acceptance verdict per member (network-wide vs named vs deny)", async () => {
    const summary = summarizeAcceptancePolicy([
      {
        capability: "a.b",
        scopes: ["federated"],
        accept: { kind: "network", network: "research-collab" },
      },
      {
        capability: "c.d",
        scopes: ["federated"],
        accept: { kind: "principals", principals: ["zeta"] },
      },
    ]);
    const v: NetworksView = {
      localPrincipal: "andreas",
      networks: () => [
        { networkId: "research-collab", leafNode: "rc-leaf", confidentiality: CLEARTEXT },
        { networkId: "other-net", leafNode: "on-leaf", confidentiality: CLEARTEXT },
      ],
      resolveAdmittedRoster: (networkId) =>
        Promise.resolve(
          networkId === "research-collab"
            ? { ok: true, roster: { admitted: ["jc"], pending: [], authoritative: true } }
            : { ok: true, roster: { admitted: ["zeta"], pending: [], authoritative: true } },
        ),
      acceptsPeer: (networkId, member) =>
        resolvePeerAcceptance(summary, networkId, member, "andreas"),
    };
    const out = await handleListNetworks(v, presenceView([rec({ agentId: "luna" })]));
    const nets = (await body(out)).networks;
    const rc = nets.find((n) => n.network_id === "research-collab")!;
    const other = nets.find((n) => n.network_id === "other-net")!;
    const rcAccepts = Object.fromEntries(rc.members.map((m) => [m.principal, m.accepts]));
    const otherAccepts = Object.fromEntries(other.members.map((m) => [m.principal, m.accepts]));
    // research-collab is offered whole-roster → every peer accepted-network.
    expect(rcAccepts).toEqual({ andreas: "self", jc: "accepted-network" });
    // other-net is NOT whole-roster, but zeta is named → accepted-named.
    expect(otherAccepts).toEqual({ andreas: "self", zeta: "accepted-named" });
  });
});
