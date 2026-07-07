/**
 * MC-D2 (cortex#1289) — shell-chrome pure-model tests.
 *
 * Pins the navigation + posture logic behind the command bar + altitude rail:
 *   - posture derivation (admin iff complete-roster read; member otherwise) and
 *     the load-bearing vocabulary (`admin`/`member`, never the deprecated label);
 *   - per-network posture at the root is `null` (no single posture to report);
 *   - breadcrumb derivation (root always present; network appends a segment);
 *   - drill / ascend / segment navigation;
 *   - rail stop reachability (networks always reachable, network gated on data,
 *     deeper levels are honest `future` stubs).
 */

import { describe, it, expect } from "bun:test";
import type { NetworkMembershipDTO } from "../hooks/use-networks";
import {
  ALTITUDE_LEVELS,
  ALTITUDE_META,
  ROOT_SELECTION,
  networkPosture,
  selectedNetworkPosture,
  buildBreadcrumb,
  drillToNetwork,
  ascendToRoot,
  diveToStack,
  selectAssistant,
  openSession,
  ascendToLevel,
  stackReachesSession,
  stackLabel,
  navigateToSegment,
  stopReachability,
  type AltitudeSelection,
  type StackCoord,
} from "../lib/mc-shell-model";

/** A dived OWN-LOCAL stack coordinate (SESSION-reachable). */
function localStack(over: Partial<StackCoord> = {}): StackCoord {
  return { principal: "andreas", stack: "meta-factory", federated: false, ...over };
}

/** A dived FEDERATED peer stack coordinate (SESSION-capped at ASSISTANT). */
function peerStack(over: Partial<StackCoord> = {}): StackCoord {
  return { principal: "jc", stack: "research", federated: true, ...over };
}

function net(
  over: Partial<NetworkMembershipDTO> & { network_id: string },
): NetworkMembershipDTO {
  return {
    leaf_node: `${over.network_id}-leaf`,
    roster_status: "ok",
    roster_scope: "complete",
    members: [],
    confidentiality: { mode: "off", key_present: false, key_id: null },
    ...over,
  };
}

describe("MC-D2 shell model — posture", () => {
  it("admin iff the admin-authoritative (complete) roster read succeeded", () => {
    expect(
      networkPosture(net({ network_id: "meridian", roster_scope: "complete" })),
    ).toBe("admin");
  });

  it("member for a self-scoped read (not authoritative — fail-closed)", () => {
    expect(
      networkPosture(net({ network_id: "tide", roster_scope: "self" })),
    ).toBe("member");
  });

  it("member for any degraded/unauthorized/unreachable read", () => {
    for (const status of ["unreachable", "unauthorized", "not_configured"] as const) {
      expect(
        networkPosture(
          net({ network_id: "x", roster_status: status, roster_scope: null }),
        ),
      ).toBe("member");
    }
  });

  it("never emits the deprecated posture term — only admin/member", () => {
    // Built from fragments so this source file carries no literal deprecated
    // token (the vocabulary gate is grep-based); the guard stays real.
    const FORBIDDEN = ["oper", "ator"].join("");
    const values = [
      networkPosture(net({ network_id: "a", roster_scope: "complete" })),
      networkPosture(net({ network_id: "b", roster_scope: "self" })),
    ];
    expect(values).toEqual(["admin", "member"]);
    expect(values).not.toContain(FORBIDDEN);
  });
});

describe("MC-D2 shell model — selected posture", () => {
  const networks = [
    net({ network_id: "meridian", roster_scope: "complete" }),
    net({ network_id: "tide", roster_scope: "self" }),
  ];

  it("is null at the 10k-ft root (no single network → no single posture)", () => {
    expect(selectedNetworkPosture(networks, ROOT_SELECTION)).toBeNull();
  });

  it("reports the drilled-into network's posture", () => {
    expect(
      selectedNetworkPosture(networks, drillToNetwork("meridian")),
    ).toBe("admin");
    expect(selectedNetworkPosture(networks, drillToNetwork("tide"))).toBe(
      "member",
    );
  });

  it("is null when the selected network is no longer present", () => {
    expect(
      selectedNetworkPosture(networks, drillToNetwork("vanished")),
    ).toBeNull();
  });
});

describe("MC-D2 shell model — breadcrumb", () => {
  it("root selection yields only NETWORK·OF·NETWORKS", () => {
    const crumbs = buildBreadcrumb(ROOT_SELECTION);
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({
      label: "NETWORK·OF·NETWORKS",
      level: "networks",
      networkId: null,
    });
  });

  it("a drilled network appends a second segment", () => {
    const crumbs = buildBreadcrumb(drillToNetwork("meridian"));
    expect(crumbs).toHaveLength(2);
    expect(crumbs[1]).toMatchObject({
      label: "meridian",
      level: "network",
      networkId: "meridian",
    });
  });
});

describe("MC-D2 shell model — navigation", () => {
  it("drillToNetwork sets network level + id, clearing deeper coords", () => {
    expect(drillToNetwork("meridian")).toEqual({
      level: "network",
      networkId: "meridian",
      stack: null,
      assistantId: null,
      sessionId: null,
    });
  });

  it("ascendToRoot returns the 10k-ft root", () => {
    expect(ascendToRoot()).toEqual(ROOT_SELECTION);
  });

  it("navigateToSegment ascends on the root segment, drills on a network segment", () => {
    const [root, network] = buildBreadcrumb(drillToNetwork("meridian"));
    expect(navigateToSegment(root!)).toEqual(ROOT_SELECTION);
    expect(navigateToSegment(network!)).toEqual(drillToNetwork("meridian"));
  });
});

describe("MC-D2 shell model — rail stop reachability", () => {
  const root: AltitudeSelection = ROOT_SELECTION;

  it("the current level is `current`", () => {
    expect(stopReachability("networks", root, 2)).toBe("current");
    expect(stopReachability("network", drillToNetwork("meridian"), 2)).toBe(
      "current",
    );
  });

  it("networks is always reachable from a deeper level", () => {
    expect(
      stopReachability("networks", drillToNetwork("meridian"), 2),
    ).toBe("reachable");
  });

  it("network is reachable iff ≥1 network is joined", () => {
    expect(stopReachability("network", root, 2)).toBe("reachable");
    expect(stopReachability("network", root, 0)).toBe("future");
  });

  it("stack/assistant/session are future until a stack is dived", () => {
    // At NETWORK level (no stack dived) the deeper stops have no backing coord.
    const atNetwork = drillToNetwork("meridian");
    for (const lvl of ["stack", "assistant", "session"] as const) {
      expect(stopReachability(lvl, atNetwork, 9)).toBe("future");
    }
  });
});

describe("CK-1 shell model — dive-to-stack reachability (data-driven)", () => {
  it("STACK + ASSISTANT go live once a LOCAL stack is dived", () => {
    const sel = diveToStack("meridian", localStack());
    expect(stopReachability("stack", sel, 2)).toBe("current");
    expect(stopReachability("assistant", sel, 2)).toBe("reachable");
    // NETWORKS/NETWORK stay reachable above.
    expect(stopReachability("networks", sel, 2)).toBe("reachable");
    expect(stopReachability("network", sel, 2)).toBe("reachable");
  });

  it("STACK + ASSISTANT go live for a FEDERATED peer too (aggregate metadata)", () => {
    const sel = diveToStack("meridian", peerStack());
    expect(stopReachability("stack", sel, 2)).toBe("current");
    expect(stopReachability("assistant", sel, 2)).toBe("reachable");
  });

  it("SESSION is reachable ONLY on an OWN-LOCAL stack", () => {
    const local = diveToStack("meridian", localStack());
    expect(stopReachability("session", local, 2)).toBe("reachable");
  });

  it("SESSION stays FUTURE for a federated peer — it bottoms out at STACK/ASSISTANT", () => {
    const peer = diveToStack("meridian", peerStack());
    expect(stopReachability("session", peer, 2)).toBe("future");
    // The invariant, stated as the boundary: the deepest reachable federated
    // stop is ASSISTANT; SESSION (and anything below) is unreachable.
    expect(stopReachability("assistant", peer, 2)).toBe("reachable");
    expect(stopReachability("session", peer, 2)).not.toBe("reachable");
  });

  it("SESSION stays FUTURE when no stack is dived", () => {
    expect(stopReachability("session", ROOT_SELECTION, 2)).toBe("future");
    expect(stopReachability("session", drillToNetwork("meridian"), 2)).toBe(
      "future",
    );
  });

  it("stackReachesSession: true for own-local, false for federated/absent", () => {
    expect(stackReachesSession(localStack())).toBe(true);
    expect(stackReachesSession(peerStack())).toBe(false);
    expect(stackReachesSession(null)).toBe(false);
  });
});

describe("CK-1 shell model — session gating (openSession)", () => {
  it("opens a session on an own-local stack", () => {
    const base = selectAssistant(diveToStack("meridian", localStack()), "luna");
    const sel = openSession(base, "sess-123");
    expect(sel).not.toBeNull();
    expect(sel).toEqual({
      level: "session",
      networkId: "meridian",
      stack: localStack(),
      assistantId: "luna",
      sessionId: "sess-123",
    });
  });

  it("REFUSES to open a session on a federated peer stack (ADR-0005 defense in depth)", () => {
    const base = selectAssistant(diveToStack("meridian", peerStack()), "atlas");
    expect(openSession(base, "sess-xyz")).toBeNull();
  });

  it("REFUSES to open a session when no stack is dived", () => {
    expect(openSession(drillToNetwork("meridian"), "sess-xyz")).toBeNull();
  });
});

describe("CK-1 shell model — assistant selection + ascend", () => {
  it("selectAssistant advances to ASSISTANT, preserving the stack, clearing session", () => {
    const dived = diveToStack("meridian", localStack());
    const withSession = openSession(
      selectAssistant(dived, "luna"),
      "sess-1",
    )!;
    // Re-selecting the assistant from the session-level selection clears session.
    const sel = selectAssistant(withSession, "luna");
    expect(sel).toEqual({
      level: "assistant",
      networkId: "meridian",
      stack: localStack(),
      assistantId: "luna",
      sessionId: null,
    });
  });

  it("ascendToLevel truncates every coordinate deeper than the target", () => {
    const deep = openSession(
      selectAssistant(diveToStack("meridian", localStack()), "luna"),
      "sess-1",
    )!;
    expect(ascendToLevel(deep, "stack")).toEqual({
      level: "stack",
      networkId: "meridian",
      stack: localStack(),
      assistantId: null,
      sessionId: null,
    });
    expect(ascendToLevel(deep, "network")).toEqual(drillToNetwork("meridian"));
    expect(ascendToLevel(deep, "networks")).toEqual(ROOT_SELECTION);
  });
});

describe("MC-D2 shell model — altitude metadata", () => {
  it("names all five levels in 10k-ft → deepest order", () => {
    expect(ALTITUDE_LEVELS).toEqual([
      "networks",
      "network",
      "stack",
      "assistant",
      "session",
    ]);
  });

  it("only the NETWORKS root carries an altitude annotation", () => {
    expect(ALTITUDE_META.networks.altLabel).toBe("10k ft");
    expect(ALTITUDE_META.network.altLabel).toBeUndefined();
  });
});

describe("CK-1 shell model — deep breadcrumb + stackLabel", () => {
  it("stackLabel is bare stack for local, principal/stack for federated", () => {
    expect(stackLabel(localStack())).toBe("meta-factory");
    expect(stackLabel(peerStack())).toBe("jc/research");
  });

  it("grows a segment per dived coordinate (network → stack → assistant → session)", () => {
    const sel = openSession(
      selectAssistant(diveToStack("meridian", localStack()), "luna"),
      "sess-1",
    )!;
    const crumbs = buildBreadcrumb(sel);
    expect(crumbs.map((c) => c.level)).toEqual([
      "networks",
      "network",
      "stack",
      "assistant",
      "session",
    ]);
    expect(crumbs.map((c) => c.label)).toEqual([
      "NETWORK·OF·NETWORKS",
      "meridian",
      "meta-factory",
      "luna",
      "sess-1",
    ]);
  });

  it("a federated stack segment shows principal/stack and has no session below it", () => {
    const sel = selectAssistant(diveToStack("meridian", peerStack()), "atlas");
    const crumbs = buildBreadcrumb(sel);
    expect(crumbs.map((c) => c.level)).toEqual([
      "networks",
      "network",
      "stack",
      "assistant",
    ]);
    const stackSeg = crumbs.find((c) => c.level === "stack")!;
    expect(stackSeg.label).toBe("jc/research");
  });

  it("navigateToSegment round-trips every deep segment back to its exact selection", () => {
    const sel = openSession(
      selectAssistant(diveToStack("meridian", localStack()), "luna"),
      "sess-1",
    )!;
    const crumbs = buildBreadcrumb(sel);
    // Clicking the deepest (session) segment reconstructs the full selection.
    expect(navigateToSegment(crumbs[crumbs.length - 1]!)).toEqual(sel);
    // Clicking the stack segment reconstructs the stack-level selection.
    expect(navigateToSegment(crumbs[2]!)).toEqual(
      diveToStack("meridian", localStack()),
    );
  });
});
