/**
 * FLG-1 (docs/plan-mc-future-state.md §4.D) — `handleGetHandoff` tests.
 *
 * Two things this file locks down:
 *   1. The three-valued attestation (invariant 9 / Sage #1499): `confirmed=true`
 *      upgrades an `undefined` hub-authorize signal to done, but NEVER a real
 *      `false` — a hub-DENIED network stays blocked through the endpoint even
 *      under confirmed=true.
 *   2. The no-interiors SHAPE guard (invariant 1 — the daemon analog of
 *      `worker/src/__tests__/dashboard-snapshot-contract.test.ts`): the
 *      `HandoffStatusDTO` and its legs carry ONLY the allow-listed metadata keys
 *      at every position. This is how the read "flows through the DashboardSnapshot
 *      guard" on the daemon side — a metadata-only contract, asserted here.
 */

import { describe, it, expect } from "bun:test";
import {
  handleGetHandoff,
  type HandoffView,
  type HandoffSignalsResult,
  type HandoffStatusDTO,
} from "../handoff";
import type { HandoffSignals } from "../../../../cli/cortex/commands/network-handoff-lib";

/** A stub view resolving fixed signals for one network id (else `null`). */
function stubView(
  networkId: string,
  signals: HandoffSignals,
  notes: string[] = [],
): HandoffView {
  return {
    localPrincipal: "andreas",
    resolveHandoffSignals: (net): Promise<HandoffSignalsResult | null> =>
      Promise.resolve(net === networkId ? { signals, notes } : null),
  };
}

async function body(res: Response): Promise<HandoffStatusDTO> {
  return (await res.json()) as HandoffStatusDTO;
}

describe("handleGetHandoff — availability", () => {
  it("503s when no handoff view is wired (no federation)", async () => {
    const res = await handleGetHandoff(null, {
      networkId: "research",
      member: "andreas",
      confirmed: false,
    });
    expect(res.status).toBe(503);
  });

  it("404s for a network this stack has not joined", async () => {
    const view = stubView("research", { sealed: true, hubAuthorized: true, leafUp: true });
    const res = await handleGetHandoff(view, {
      networkId: "not-joined",
      member: "andreas",
      confirmed: false,
    });
    expect(res.status).toBe(404);
  });
});

describe("handleGetHandoff — 3-leg state", () => {
  it("reports all legs done + no next owner when the join is complete", async () => {
    const view = stubView("research", { sealed: true, hubAuthorized: true, leafUp: true });
    const dto = await body(
      await handleGetHandoff(view, { networkId: "research", member: "andreas", confirmed: false }),
    );
    expect(dto.legs.map((l) => l.status)).toEqual(["done", "done", "done"]);
    expect(dto.next_leg).toBeNull();
    expect(dto.next_owner).toBeNull();
    expect(dto.can_bring_leaf_up).toBe(true);
    expect(dto.leaf_up_blocked_reason).toBeNull();
  });

  it("names the admin as the next owner when the seal leg is pending", async () => {
    const view = stubView("research", { sealed: false, hubAuthorized: undefined, leafUp: undefined });
    const dto = await body(
      await handleGetHandoff(view, { networkId: "research", member: "andreas", confirmed: false }),
    );
    expect(dto.legs[0]!.status).toBe("pending"); // seal
    expect(dto.next_owner).toBe("admin");
    expect(dto.can_bring_leaf_up).toBe(false);
    expect(dto.leaf_up_blocked_reason).toBe("seal-pending");
  });

  it("blocks leaf-up as hub-unverifiable when the hub signal is undefined", async () => {
    const view = stubView("research", { sealed: true, hubAuthorized: undefined, leafUp: undefined });
    const dto = await body(
      await handleGetHandoff(view, { networkId: "research", member: "andreas", confirmed: false }),
    );
    expect(dto.next_owner).toBe("hub-owner");
    expect(dto.can_bring_leaf_up).toBe(false);
    expect(dto.leaf_up_blocked_reason).toBe("hub-unverifiable");
    expect(dto.hub_attestable).toBe(true); // undefined ⇒ attestable
    expect(dto.attested).toBe(false);
  });
});

describe("handleGetHandoff — three-valued attestation (Sage #1499)", () => {
  it("confirmed=true UPGRADES an undefined hub-authorize signal to done", async () => {
    const view = stubView("research", { sealed: true, hubAuthorized: undefined, leafUp: undefined });
    const dto = await body(
      await handleGetHandoff(view, { networkId: "research", member: "andreas", confirmed: true }),
    );
    // The hub leg is now treated done via the attestation → leaf-up is unblocked
    // and the next move is the MEMBER (leaf-up), not the hub owner.
    const hubLeg = dto.legs.find((l) => l.id === "hub-authorize")!;
    expect(hubLeg.status).toBe("done");
    expect(dto.can_bring_leaf_up).toBe(true);
    expect(dto.leaf_up_blocked_reason).toBeNull();
    expect(dto.next_owner).toBe("member");
    expect(dto.attested).toBe(true);
    expect(dto.hub_attestable).toBe(true); // the raw signal is still undefined
  });

  it("confirmed=true NEVER upgrades a real `false` (hub-denied stays blocked)", async () => {
    // The load-bearing guarantee: a real NOT-authorized signal is a hard
    // negative a member attestation cannot override.
    const view = stubView("research", { sealed: true, hubAuthorized: false, leafUp: undefined });
    const dto = await body(
      await handleGetHandoff(view, { networkId: "research", member: "andreas", confirmed: true }),
    );
    const hubLeg = dto.legs.find((l) => l.id === "hub-authorize")!;
    expect(hubLeg.status).not.toBe("done"); // still pending — NOT upgraded
    expect(dto.can_bring_leaf_up).toBe(false);
    expect(dto.leaf_up_blocked_reason).toBe("hub-denied");
    // And the glass must NOT be told this is attestable — no override affordance
    // for a hard denial.
    expect(dto.hub_attestable).toBe(false);
  });
});

describe("handleGetHandoff — notes pass through", () => {
  it("surfaces the gathered degradation notes verbatim", async () => {
    const view = stubView(
      "research",
      { sealed: true, hubAuthorized: undefined, leafUp: undefined },
      ["hub-authorize leg: registry unreachable"],
    );
    const dto = await body(
      await handleGetHandoff(view, { networkId: "research", member: "andreas", confirmed: false }),
    );
    expect(dto.notes).toEqual(["hub-authorize leg: registry unreachable"]);
  });
});

// ---------------------------------------------------------------------------
// No-interiors SHAPE guard — the daemon analog of the worker's
// dashboard-snapshot-contract.test.ts. Asserts the DTO carries ONLY the
// allow-listed metadata keys at every position. A new field that could leak an
// interior / secret fails HERE, consciously (grow the allow-list = a real edit).
// ---------------------------------------------------------------------------

const DTO_KEYS = new Set([
  "network_id", "member", "legs", "next_leg", "next_owner",
  "can_bring_leaf_up", "leaf_up_blocked_reason", "hub_attestable", "attested", "notes",
]);
const LEG_KEYS = new Set(["id", "title", "status", "owner", "detail"]);

function assertKeys(obj: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unexpected = Object.keys(obj).filter((k) => !allowed.has(k));
  expect([label, unexpected]).toEqual([label, []]);
}

describe("handleGetHandoff — no-interiors SHAPE guard (invariant 1)", () => {
  it("the DTO + its legs carry only the allow-listed metadata keys", async () => {
    // Exercise a state that populates the optional fields (blocked reason, a
    // non-null next owner) so the walk sees them.
    const view = stubView(
      "research",
      { sealed: true, hubAuthorized: false, leafUp: undefined },
      ["leaf-up leg: not observable"],
    );
    const dto = await body(
      await handleGetHandoff(view, { networkId: "research", member: "andreas", confirmed: false }),
    );
    assertKeys(dto as unknown as Record<string, unknown>, DTO_KEYS, "HandoffStatusDTO");
    expect(dto.legs.length).toBe(3);
    for (const leg of dto.legs) {
      assertKeys(leg as unknown as Record<string, unknown>, LEG_KEYS, `legs[${leg.id}]`);
    }
    // notes is a string[] — no nested objects that could smuggle a key.
    expect(dto.notes.every((n) => typeof n === "string")).toBe(true);
  });
});
