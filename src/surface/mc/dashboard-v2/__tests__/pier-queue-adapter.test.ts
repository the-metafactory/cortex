/**
 * MC-B1 (cortex#1278) — unit tests for the pure Pier-queue selection adapter.
 *
 * The Pier queue is the ADMIN posture: PENDING admission requests for the
 * networks the serving principal ADMINS, awaiting Tier-2 grant (ADR-0015 /
 * ADR-0018; CONTEXT.md §172). The load-bearing property is the TRUST BOUNDARY —
 * pending is surfaced ONLY for a network whose admin-authoritative (`complete`)
 * roster read succeeded. A `self`-scoped or degraded read must NEVER leak a
 * pending entry: for a network you only MEMBER, the pending queue is not yours
 * to see. DOM-free.
 */

import { describe, it, expect } from "bun:test";
import { selectPierQueue, isAdminPosture } from "../lib/pier-queue-adapter";
import type { NetworkMembershipDTO, MembershipMemberDTO } from "../../api/networks";

function member(
  over: Partial<MembershipMemberDTO> & { principal: string },
): MembershipMemberDTO {
  return {
    verdict: "pending",
    present_stacks: [],
    accepts: "not-accepted",
    ...over,
  };
}

function net(over: Partial<NetworkMembershipDTO> & { network_id: string }): NetworkMembershipDTO {
  return {
    leaf_node: `${over.network_id}-leaf`,
    roster_status: "ok",
    roster_scope: "complete",
    members: [],
    confidentiality: { mode: "off", key_present: false, key_id: null },
    ...over,
  };
}

describe("isAdminPosture", () => {
  it("is true ONLY for an ok + complete (admin-authoritative) roster read", () => {
    expect(isAdminPosture(net({ network_id: "n", roster_status: "ok", roster_scope: "complete" }))).toBe(true);
  });

  it("is false for a self-scoped read (member posture — pending not yours to see)", () => {
    expect(isAdminPosture(net({ network_id: "n", roster_status: "ok", roster_scope: "self" }))).toBe(false);
  });

  it("is false for every degraded read (unreachable / unauthorized / not_configured)", () => {
    expect(isAdminPosture(net({ network_id: "n", roster_status: "unreachable", roster_scope: null }))).toBe(false);
    expect(isAdminPosture(net({ network_id: "n", roster_status: "unauthorized", roster_scope: null }))).toBe(false);
    expect(isAdminPosture(net({ network_id: "n", roster_status: "not_configured", roster_scope: null }))).toBe(false);
  });
});

describe("selectPierQueue", () => {
  it("surfaces pending requests for an admin (complete) network", () => {
    const q = selectPierQueue([
      net({
        network_id: "alpha",
        roster_scope: "complete",
        members: [
          member({ principal: "andreas", verdict: "admitted-present", present_stacks: ["research"] }),
          member({ principal: "jc", verdict: "pending", present_stacks: ["main"] }),
          member({ principal: "remy", verdict: "pending" }),
        ],
      }),
    ]);
    expect(q.adminNetworkCount).toBe(1);
    expect(q.nonAdminNetworkCount).toBe(0);
    expect(q.totalPending).toBe(2);
    expect(q.groups).toHaveLength(1);
    expect(q.groups[0]!.networkId).toBe("alpha");
    expect(q.groups[0]!.leafNode).toBe("alpha-leaf");
    expect(q.groups[0]!.requests.map((r) => r.principal)).toEqual(["jc", "remy"]);
    // carries the requester's observed presence (informational — may be online pre-admission)
    expect(q.groups[0]!.requests[0]!.presentStacks).toEqual(["main"]);
  });

  it("includes ONLY pending members — admitted/absent/unadmitted are excluded", () => {
    const q = selectPierQueue([
      net({
        network_id: "alpha",
        members: [
          member({ principal: "a", verdict: "admitted-present", present_stacks: ["s"] }),
          member({ principal: "b", verdict: "absent-offline" }),
          member({ principal: "c", verdict: "present-but-unadmitted", present_stacks: ["x"] }),
          member({ principal: "d", verdict: "pending" }),
        ],
      }),
    ]);
    expect(q.totalPending).toBe(1);
    expect(q.groups[0]!.requests.map((r) => r.principal)).toEqual(["d"]);
  });

  it("TRUST BOUNDARY: never leaks pending from a self-scoped network", () => {
    const q = selectPierQueue([
      net({
        network_id: "beta",
        roster_status: "ok",
        roster_scope: "self",
        // even if the DTO somehow carried a pending member, a self read is not
        // admin-authoritative — it must NOT appear in the admin queue.
        members: [member({ principal: "intruder", verdict: "pending" })],
      }),
    ]);
    expect(q.totalPending).toBe(0);
    expect(q.groups).toHaveLength(0);
    expect(q.adminNetworkCount).toBe(0);
    expect(q.nonAdminNetworkCount).toBe(1);
  });

  it("TRUST BOUNDARY: never leaks pending from a degraded (failed) read", () => {
    for (const status of ["unreachable", "unauthorized", "not_configured"] as const) {
      const q = selectPierQueue([
        net({
          network_id: "gamma",
          roster_status: status,
          roster_scope: null,
          members: [member({ principal: "ghost", verdict: "pending" })],
        }),
      ]);
      expect(q.totalPending).toBe(0);
      expect(q.groups).toHaveLength(0);
      expect(q.nonAdminNetworkCount).toBe(1);
    }
  });

  it("counts admin vs non-admin networks across a mixed set, queueing only the admin ones", () => {
    const q = selectPierQueue([
      net({ network_id: "admin1", roster_scope: "complete", members: [member({ principal: "p1", verdict: "pending" })] }),
      net({ network_id: "admin2", roster_scope: "complete", members: [] }), // admin, but empty queue
      net({ network_id: "member1", roster_status: "ok", roster_scope: "self", members: [] }),
      net({ network_id: "broken1", roster_status: "unreachable", roster_scope: null, members: [] }),
    ]);
    expect(q.adminNetworkCount).toBe(2);
    expect(q.nonAdminNetworkCount).toBe(2);
    expect(q.totalPending).toBe(1);
    // only networks WITH >=1 pending become groups
    expect(q.groups.map((g) => g.networkId)).toEqual(["admin1"]);
  });

  it("returns an empty queue for no networks", () => {
    expect(selectPierQueue([])).toEqual({
      groups: [],
      totalPending: 0,
      adminNetworkCount: 0,
      nonAdminNetworkCount: 0,
    });
  });

  it("does not mutate its input", () => {
    const input = [
      net({ network_id: "alpha", members: [member({ principal: "p", verdict: "pending" })] }),
    ];
    const snapshot = JSON.stringify(input);
    selectPierQueue(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
