/**
 * MC-D3 (cortex#1290) — pure constellation-header projection tests.
 *
 * The constellation canvas header reads `<NETWORK> · <admin|member> · N stacks`
 * off the same `/api/networks` DTO the A1 roster panel consumes. The two
 * load-bearing invariants under test:
 *
 *   1. POSTURE VOCAB — the header says `admin` / `member` (CONTEXT.md §"Network
 *      posture"; the design's original on-screen label is renamed to admin, and
 *      the deprecated word is gated out of src/ by check-carveouts). The posture
 *      is the SAME admin-authoritative determination the Pier queue uses
 *      (`isAdminPosture`) — reused, not re-derived.
 *   2. AGGREGATE-ONLY — the header carries presence-level aggregate counts only
 *      (a distinct-present-stacks tally + the A3 confidentiality token). It never
 *      surfaces a session field, so it cannot become a session-drill into a
 *      federated peer.
 */

import { describe, expect, test } from "bun:test";
import type { NetworkMembershipDTO } from "../../api/networks";
import { buildConstellationHeader } from "../lib/network-constellation-header";

function net(over: Partial<NetworkMembershipDTO>): NetworkMembershipDTO {
  return {
    network_id: "meridian",
    leaf_node: "leaf-1",
    roster_status: "ok",
    roster_scope: "complete",
    confidentiality: { mode: "off", key_present: false, key_id: null },
    members: [],
    ...over,
  };
}

describe("buildConstellationHeader", () => {
  test("empty networks → empty header (a non-federated stack renders no header)", () => {
    expect(buildConstellationHeader([])).toEqual([]);
  });

  test("admin posture: an authoritative complete-roster read → admin", () => {
    const [row] = buildConstellationHeader([
      net({ roster_status: "ok", roster_scope: "complete" }),
    ]);
    expect(row?.posture).toBe("admin");
  });

  test("member posture: a self-scoped read → member (never admin)", () => {
    const [row] = buildConstellationHeader([
      net({ roster_status: "ok", roster_scope: "self" }),
    ]);
    expect(row?.posture).toBe("member");
  });

  test("member posture: a degraded read (unreachable) → member, never admin", () => {
    const [row] = buildConstellationHeader([
      net({ roster_status: "unreachable", roster_scope: null }),
    ]);
    expect(row?.posture).toBe("member");
  });

  test("stackCount tallies DISTINCT present {principal}/{stack} across members", () => {
    const [row] = buildConstellationHeader([
      net({
        members: [
          { principal: "andreas", verdict: "admitted-present", present_stacks: ["research", "work"], accepts: "self" },
          { principal: "jc", verdict: "admitted-present", present_stacks: ["research"], accepts: "accepted-network" },
          // duplicate principal/stack must not double-count
          { principal: "andreas", verdict: "admitted-absent", present_stacks: ["research"], accepts: "self" },
        ],
      }),
    ]);
    // andreas/research, andreas/work, jc/research → 3 distinct
    expect(row?.stackCount).toBe(3);
  });

  test("stackCount is 0 when no member has a present stack (presence ≠ membership)", () => {
    const [row] = buildConstellationHeader([
      net({
        members: [
          { principal: "jc", verdict: "admitted-absent", present_stacks: [], accepts: "accepted-network" },
        ],
      }),
    ]);
    expect(row?.stackCount).toBe(0);
  });

  test("carries the A3 confidentiality token (D4 finalizes the K-marker; render what's available)", () => {
    const [row] = buildConstellationHeader([
      net({ confidentiality: { mode: "required", key_present: true, key_id: "k7" } }),
    ]);
    expect(row?.confidentiality).toBe("encrypted-required");
  });

  test("D4 — sealed network carries the key epoch (the mockup's K7)", () => {
    const [enabled] = buildConstellationHeader([
      net({ confidentiality: { mode: "enabled", key_present: true, key_id: "k7" } }),
    ]);
    expect(enabled?.keyId).toBe("k7");
  });

  test("D4 HONESTY HINGE — no key epoch shown without a held key (off / degraded / unknown)", () => {
    // off: encryption disabled → no epoch.
    const [off] = buildConstellationHeader([
      net({ confidentiality: { mode: "off", key_present: false, key_id: null } }),
    ]);
    expect(off?.keyId).toBeNull();
    // degraded: configured to seal but NO key → never show an epoch (cleartext-with-warning).
    const [degraded] = buildConstellationHeader([
      net({ confidentiality: { mode: "required", key_present: false, key_id: "k7" } }),
    ]);
    expect(degraded?.confidentiality).toBe("degraded");
    expect(degraded?.keyId).toBeNull();
  });

  test("VOCAB GATE — posture is only ever 'admin' or 'member' (deprecated label gated)", () => {
    const rows = buildConstellationHeader([
      net({ roster_scope: "complete" }),
      net({ network_id: "tide", roster_scope: "self" }),
    ]);
    for (const r of rows) {
      expect(["admin", "member"]).toContain(r.posture);
    }
  });

  test("AGGREGATE-ONLY — a header row exposes no session field (no drill into peers)", () => {
    const [row] = buildConstellationHeader([
      net({
        members: [
          { principal: "jc", verdict: "admitted-present", present_stacks: ["research"], accepts: "accepted-network" },
        ],
      }),
    ]);
    const keys = Object.keys(row ?? {});
    // The row is a presence-level aggregate: id, posture, stack count, A3 token,
    // and the per-network key epoch (D4). All network-scoped — nothing per-session.
    expect(keys.sort()).toEqual(
      ["confidentiality", "keyId", "networkId", "posture", "stackCount"].sort(),
    );
    // Defensively assert nothing session-shaped leaked in.
    for (const k of keys) {
      expect(k.toLowerCase()).not.toContain("session");
    }
  });
});
