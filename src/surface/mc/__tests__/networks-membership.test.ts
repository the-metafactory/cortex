/**
 * MC-A1 (cortex#1275) — unit tests for the pure membership-reconciliation logic
 * (intent roster ⋈ presence reality → verdict). No HTTP, no registry, no bus.
 *
 * The load-bearing trust property under test: the registry roster is the SOURCE
 * OF TRUTH for membership (ADR-0018 Q3); presence only decides present/absent;
 * capabilities never enter the picture; and presence is keyed by VERIFIED
 * origin, never a wire token.
 */

import { describe, it, expect } from "bun:test";
import {
  reconcileNetworkMembership,
  derivePresentStacksByPrincipal,
  foreignPresentPrincipals,
} from "../api/networks-membership";
import type { AgentPresenceSnapshotRecord } from "../api/agents";

function present(
  entries: Record<string, string[]>,
): Map<string, readonly string[]> {
  return new Map(Object.entries(entries));
}

function rec(
  over: Partial<AgentPresenceSnapshotRecord> & { agentId: string },
): AgentPresenceSnapshotRecord {
  const { agentId } = over;
  return {
    key: `andreas/research/${agentId}`,
    origin: "local",
    nkeyPublicKey: `N${agentId}`,
    assistantName: null,
    principal: "andreas",
    stack: "research",
    capabilities: [],
    state: "online",
    lastSeenAt: 1000,
    ...over,
  };
}

describe("reconcileNetworkMembership — verdict semantics", () => {
  it("admitted + present → admitted-present (with present stacks)", () => {
    const members = reconcileNetworkMembership({
      admitted: ["jc"],
      presentStacksByPrincipal: present({ jc: ["research"] }),
    });
    expect(members).toEqual([
      { principal: "jc", verdict: "admitted-present", presentStacks: ["research"] },
    ]);
  });

  it("admitted + absent, no receipt ledger → absent-offline (conservative default)", () => {
    // FS-6 — without `everReceivedPresence` the absent family collapses to
    // absent-offline: we never over-claim "unheard" (a config gap) unless we can
    // prove we truly heard nothing.
    const members = reconcileNetworkMembership({
      admitted: ["jc"],
      presentStacksByPrincipal: present({}),
    });
    expect(members).toEqual([
      { principal: "jc", verdict: "absent-offline", presentStacks: [] },
    ]);
  });

  // --- FS-6 (cortex#1821): honest absence — the 3 verdict cases -------------

  it("FS-6 live: admitted + present → admitted-present (receipt ledger irrelevant)", () => {
    const members = reconcileNetworkMembership({
      admitted: ["jc"],
      presentStacksByPrincipal: present({ jc: ["research"] }),
      // Even with a receipt, a PRESENT peer is present — the ledger only splits
      // the ABSENT family.
      everReceivedPresence: new Set(["jc"]),
    });
    expect(members).toEqual([
      { principal: "jc", verdict: "admitted-present", presentStacks: ["research"] },
    ]);
  });

  it("FS-6 offline: admitted + absent + PREVIOUSLY-received → absent-offline (heard, went stale)", () => {
    const members = reconcileNetworkMembership({
      admitted: ["jc"],
      presentStacksByPrincipal: present({}),
      everReceivedPresence: new Set(["jc"]), // we HAVE heard jc before
    });
    expect(members).toEqual([
      { principal: "jc", verdict: "absent-offline", presentStacks: [] },
    ]);
  });

  it("FS-6 unheard: admitted + absent + NEVER-received → absent-unheard (deaf to it — import/cred gap)", () => {
    const members = reconcileNetworkMembership({
      admitted: ["jc"],
      presentStacksByPrincipal: present({}),
      everReceivedPresence: new Set<string>(), // never heard jc
    });
    expect(members).toEqual([
      { principal: "jc", verdict: "absent-unheard", presentStacks: [] },
    ]);
  });

  it("FS-6 mixed roster: splits offline vs unheard per-peer off the same ledger", () => {
    const members = reconcileNetworkMembership({
      admitted: ["heard-peer", "deaf-peer", "live-peer"],
      presentStacksByPrincipal: present({ "live-peer": ["main"] }),
      everReceivedPresence: new Set(["heard-peer", "live-peer"]),
    });
    expect(members).toEqual([
      { principal: "heard-peer", verdict: "absent-offline", presentStacks: [] },
      { principal: "deaf-peer", verdict: "absent-unheard", presentStacks: [] },
      { principal: "live-peer", verdict: "admitted-present", presentStacks: ["main"] },
    ]);
  });

  it("present but on no roster + flagged a candidate → present-but-unadmitted (anomaly)", () => {
    const members = reconcileNetworkMembership({
      admitted: ["andreas"],
      presentStacksByPrincipal: present({ andreas: ["main"], mallory: ["x"] }),
      anomalyCandidates: ["mallory"],
    });
    expect(members).toContainEqual({
      principal: "mallory",
      verdict: "present-but-unadmitted",
      presentStacks: ["x"],
    });
  });

  it("pending request not yet admitted → pending", () => {
    const members = reconcileNetworkMembership({
      admitted: ["andreas"],
      presentStacksByPrincipal: present({ andreas: ["main"] }),
      pending: ["newcomer"],
    });
    expect(members).toContainEqual({
      principal: "newcomer",
      verdict: "pending",
      presentStacks: [],
    });
  });
});

describe("reconcileNetworkMembership — precedence + determinism", () => {
  it("admitted wins over pending on overlap (roster is authoritative)", () => {
    const members = reconcileNetworkMembership({
      admitted: ["jc"],
      presentStacksByPrincipal: present({ jc: ["research"] }),
      pending: ["jc"], // also (stale) pending → must not double-list
    });
    expect(members).toHaveLength(1);
    expect(members[0]).toEqual({
      principal: "jc",
      verdict: "admitted-present",
      presentStacks: ["research"],
    });
  });

  it("a candidate that is admitted is NOT an anomaly", () => {
    const members = reconcileNetworkMembership({
      admitted: ["jc"],
      presentStacksByPrincipal: present({ jc: ["research"] }),
      anomalyCandidates: ["jc"],
    });
    expect(members.filter((m) => m.verdict === "present-but-unadmitted")).toHaveLength(0);
  });

  it("an anomaly candidate that is NOT present is dropped (no phantom anomalies)", () => {
    const members = reconcileNetworkMembership({
      admitted: ["andreas"],
      presentStacksByPrincipal: present({ andreas: ["main"] }),
      anomalyCandidates: ["ghost"], // not present → not an anomaly
    });
    expect(members.map((m) => m.principal)).toEqual(["andreas"]);
  });

  it("orders admitted (roster order) → pending → anomalies; dedupes present stacks", () => {
    const members = reconcileNetworkMembership({
      admitted: ["b", "a"],
      presentStacksByPrincipal: present({
        a: ["s2", "s1", "s1"],
        b: ["s1"],
        c: ["x"],
      }),
      pending: ["p"],
      anomalyCandidates: ["c"],
    });
    expect(members.map((m) => m.principal)).toEqual(["b", "a", "p", "c"]);
    // a's stacks deduped + sorted
    expect(members.find((m) => m.principal === "a")?.presentStacks).toEqual(["s1", "s2"]);
  });

  it("capabilities never confer membership — an absent member with no presence stays absent regardless of any capability facet", () => {
    // The helper has no capability input at all; this asserts the contract by
    // construction — membership is roster ⋈ presence only.
    const members = reconcileNetworkMembership({
      admitted: ["offerer"],
      presentStacksByPrincipal: present({}),
    });
    expect(members[0]?.verdict).toBe("absent-offline");
  });
});

describe("derivePresentStacksByPrincipal — verified-origin keying", () => {
  it("keys a local agent under the SERVING principal + its own stack", () => {
    const map = derivePresentStacksByPrincipal(
      [rec({ agentId: "luna", origin: "local", principal: "andreas", stack: "main" })],
      "andreas",
    );
    expect(map.get("andreas")).toEqual(["main"]);
  });

  it("keys a foreign agent under its VERIFIED origin, NOT the wire principal/stack", () => {
    const map = derivePresentStacksByPrincipal(
      [
        rec({
          agentId: "echo",
          origin: { kind: "foreign", principal: "jc", stack: "research" },
          // wire fields a peer could spoof — must be IGNORED:
          principal: "spoofed",
          stack: "spoofed-stack",
        }),
      ],
      "andreas",
    );
    expect(map.get("jc")).toEqual(["research"]);
    expect(map.has("spoofed")).toBe(false);
  });

  it("excludes offline agents from presence", () => {
    const map = derivePresentStacksByPrincipal(
      [rec({ agentId: "luna", state: "offline", offlineReason: "shutdown" })],
      "andreas",
    );
    expect(map.size).toBe(0);
  });

  it("merges multiple agents of a principal across stacks (sorted unique)", () => {
    const map = derivePresentStacksByPrincipal(
      [
        rec({ agentId: "a", origin: { kind: "foreign", principal: "jc", stack: "s2" } }),
        rec({ agentId: "b", origin: { kind: "foreign", principal: "jc", stack: "s1" } }),
        rec({ agentId: "c", origin: { kind: "foreign", principal: "jc", stack: "s1" } }),
      ],
      "andreas",
    );
    expect(map.get("jc")).toEqual(["s1", "s2"]);
  });
});

describe("foreignPresentPrincipals", () => {
  it("returns present cross-principal ids, excluding the serving principal, sorted", () => {
    const out = foreignPresentPrincipals(
      present({ andreas: ["main"], jc: ["research"], zeta: ["x"] }),
      "andreas",
    );
    expect(out).toEqual(["jc", "zeta"]);
  });
});
