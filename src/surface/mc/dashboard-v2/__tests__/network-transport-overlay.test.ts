/**
 * P-14 U2.3 (#935) — transport overlay fold + verdict→badge mapping tests.
 *
 * The overlay folds signal's projected `system.transport.*` rows into a per-stack
 * verdict + leaf liveness/RTT model, then maps each verdict to its badge. The
 * fixtures mirror signal's OWN roster oracle (`signal transport roster`,
 * src/cli/transport-roster.test.ts): jc/default connected @8.4ms,
 * andreas/macbook-pro registered-absent, intruder/ghost unregistered-present.
 * That cross-repo fidelity is the acceptance criterion — the MC overlay verdicts
 * must match the CLI's. cortex SOURCES these verdicts from signal; it never
 * re-derives them (proven here: a drift's `to` is carried through verbatim).
 */

import { describe, it, expect } from "bun:test";
import {
  buildTransportOverlay,
  overlayForStack,
  verdictBadge,
  formatRtt,
  isTransportVerdict,
  EMPTY_TRANSPORT_OVERLAY,
  TRANSPORT_VERDICTS,
} from "../lib/network-transport-overlay";
import type { TransportRosterEventRow } from "../../api/observability-tab";

const NET = "metafactory-community";

/** A transport row with a sane default timestamp (newer rows have larger ts). */
function row(over: Partial<TransportRosterEventRow> & { type: string }): TransportRosterEventRow {
  return {
    id: crypto.randomUUID(),
    stackId: NET,
    timestamp: "2026-06-12T00:00:00.000Z",
    payload: {},
    // P-14 U3.3 — default to a LOCAL origin (these U2.3 fixtures predate the
    // federated fold). Foreign-origin fixtures pass `origin` explicitly.
    origin: "local",
    ...over,
  };
}

/** A `liveness_drift` row asserting `to` for a peer (signal's authoritative verdict). */
function drift(
  principal: string,
  stack: string,
  to: string,
  over: Partial<TransportRosterEventRow> = {},
): TransportRosterEventRow {
  return row({
    type: "system.transport.liveness_drift",
    payload: {
      action: "liveness_drift",
      network: NET,
      reason: `peer ${principal}/${stack} → ${to}`,
      attributes: { peer: `${principal}/${stack}`, principal, stack, from: null, to },
    },
    ...over,
  });
}

/** A `leaf_connect` row carrying a live leaf with RTT. */
function leafConnect(
  principal: string,
  stack: string,
  rtt_ms: number | null,
  over: Partial<TransportRosterEventRow> = {},
): TransportRosterEventRow {
  return row({
    type: "system.transport.leaf_connect",
    payload: {
      action: "leaf_connect",
      network: NET,
      leaf: { principal, stack, network: NET, rtt_ms, frames: { in_msgs: 0, out_msgs: 0, in_bytes: 0, out_bytes: 0 } },
    },
    ...over,
  });
}

/** A `leaf_disconnect` row (a leaf vanished — carries no live RTT). */
function leafDisconnect(
  principal: string,
  stack: string,
  over: Partial<TransportRosterEventRow> = {},
): TransportRosterEventRow {
  return row({
    type: "system.transport.leaf_disconnect",
    payload: {
      action: "leaf_disconnect",
      network: NET,
      leaf: { principal, stack, network: NET, rtt_ms: null, frames: { in_msgs: 0, out_msgs: 0, in_bytes: 0, out_bytes: 0 } },
    },
    ...over,
  });
}

// ---------------------------------------------------------------------------

describe("buildTransportOverlay — fold (U2.3)", () => {
  it("returns the empty overlay for no rows", () => {
    const o = buildTransportOverlay([]);
    expect(o.byKey.size).toBe(0);
    expect(o.networks).toEqual([]);
  });

  it("matches signal's roster oracle: connected/registered-absent/unregistered-present", () => {
    // The drift envelopes carry signal's reconciled verdicts; the connect carries
    // jc's live RTT — exactly the roster CLI's three-peer fixture.
    const o = buildTransportOverlay([
      drift("jc", "default", "connected"),
      leafConnect("jc", "default", 8.4),
      drift("andreas", "macbook-pro", "registered-absent"),
      drift("intruder", "ghost", "unregistered-present"),
    ]);

    expect(
      Object.fromEntries([...o.byKey.values()].map((p) => [p.key, p.verdict])),
    ).toEqual({
      "jc/default": "connected",
      "andreas/macbook-pro": "registered-absent",
      "intruder/ghost": "unregistered-present",
    });

    // The connected peer carries the live RTT (sourced from the leaf body).
    const jc = overlayForStack(o, "jc", "default");
    expect(jc).not.toBeNull();
    expect(jc!.present).toBe(true);
    expect(jc!.rttMs).toBe(8.4);
    expect(jc!.network).toBe(NET);

    // The registered-absent peer has no live leaf.
    const andreas = overlayForStack(o, "andreas", "macbook-pro");
    expect(andreas!.present).toBe(false);
    expect(andreas!.rttMs).toBeNull();

    expect(o.networks).toEqual([NET]);
  });

  it("a liveness_drift's verdict is taken VERBATIM (never re-derived)", () => {
    // Even with a contradicting leaf_connect present, the newest drift wins —
    // proving the overlay carries signal's verdict, it doesn't recompute one.
    const o = buildTransportOverlay([
      drift("jc", "default", "registered-absent", { timestamp: "2026-06-12T00:00:02.000Z" }),
      leafConnect("jc", "default", 5.0, { timestamp: "2026-06-12T00:00:01.000Z" }),
    ]);
    const jc = overlayForStack(o, "jc", "default");
    // Drift (authoritative) holds registered-absent despite a connect row existing.
    expect(jc!.verdict).toBe("registered-absent");
  });

  it("newest registered-absent drift suppresses an older connect's leaf (no resurrection)", () => {
    // A peer just drifted registered-absent; its prior leaf_connect row is still
    // in the 200-row window. The stale connect must NOT flip presence back on or
    // backfill RTT — the newest authoritative event (the drift) wins.
    const o = buildTransportOverlay([
      drift("jc", "default", "registered-absent", { timestamp: "2026-06-12T00:00:02.000Z" }),
      leafConnect("jc", "default", 5.0, { timestamp: "2026-06-12T00:00:01.000Z" }),
    ]);
    const jc = overlayForStack(o, "jc", "default")!;
    expect(jc.verdict).toBe("registered-absent");
    expect(jc.present).toBe(false);
    expect(jc.rttMs).toBeNull();
  });

  it("newest leaf_disconnect suppresses an older connect's leaf (no resurrection)", () => {
    // A leaf vanished (disconnect newest); its earlier connect row lingers in the
    // window. Presence stays false and RTT stays null — the disconnect wins.
    const o = buildTransportOverlay([
      leafDisconnect("jc", "default", { timestamp: "2026-06-12T00:00:02.000Z" }),
      leafConnect("jc", "default", 5.0, { timestamp: "2026-06-12T00:00:01.000Z" }),
    ]);
    const jc = overlayForStack(o, "jc", "default")!;
    expect(jc.verdict).toBe("registered-absent");
    expect(jc.present).toBe(false);
    expect(jc.rttMs).toBeNull();
  });

  it("newest registered-absent drift + empty roster_snapshot still suppresses a stale connect", () => {
    // Drift newest, then an empty snapshot (peer not listed), then a stale connect.
    // The connect must still not resurrect presence/RTT.
    const o = buildTransportOverlay([
      drift("jc", "default", "registered-absent", { timestamp: "2026-06-12T00:00:03.000Z" }),
      row({
        type: "system.transport.roster_snapshot",
        timestamp: "2026-06-12T00:00:02.000Z",
        payload: { action: "roster_snapshot", network: NET, leaves: [] },
      }),
      leafConnect("jc", "default", 7.2, { timestamp: "2026-06-12T00:00:01.000Z" }),
    ]);
    const jc = overlayForStack(o, "jc", "default")!;
    expect(jc.verdict).toBe("registered-absent");
    expect(jc.present).toBe(false);
    expect(jc.rttMs).toBeNull();
  });

  it("a genuine newest leaf_connect still shows present + RTT (not over-suppressed)", () => {
    // No absent verdict is newer; the live connect must keep present:true + its RTT.
    const o = buildTransportOverlay([
      leafConnect("jc", "default", 6.1, { timestamp: "2026-06-12T00:00:02.000Z" }),
    ]);
    const jc = overlayForStack(o, "jc", "default")!;
    expect(jc.present).toBe(true);
    expect(jc.rttMs).toBe(6.1);
  });

  it("a newest connected drift still backfills RTT from its older connect row", () => {
    // The connected verdict is present:true; its accompanying (older) connect row
    // must still backfill the live RTT — presence-resolution only locks ABSENCE.
    const o = buildTransportOverlay([
      drift("jc", "default", "connected", { timestamp: "2026-06-12T00:00:02.000Z" }),
      leafConnect("jc", "default", 8.4, { timestamp: "2026-06-12T00:00:01.000Z" }),
    ]);
    const jc = overlayForStack(o, "jc", "default")!;
    expect(jc.verdict).toBe("connected");
    expect(jc.present).toBe(true);
    expect(jc.rttMs).toBe(8.4);
  });

  it("newest drift wins over an older drift for the same key (newest-first pass)", () => {
    const o = buildTransportOverlay([
      drift("jc", "default", "connected", { timestamp: "2026-06-12T00:00:05.000Z" }),
      drift("jc", "default", "registered-absent", { timestamp: "2026-06-12T00:00:01.000Z" }),
    ]);
    expect(overlayForStack(o, "jc", "default")!.verdict).toBe("connected");
  });

  it("folds a roster_snapshot's leaves into connected verdicts with RTT", () => {
    const o = buildTransportOverlay([
      row({
        type: "system.transport.roster_snapshot",
        payload: {
          action: "roster_snapshot",
          network: NET,
          leaves: [
            { principal: "jc", stack: "default", network: NET, rtt_ms: 8.4, frames: { in_msgs: 1, out_msgs: 1, in_bytes: 1, out_bytes: 1 } },
            { principal: "echo", stack: "research", network: NET, rtt_ms: null, frames: { in_msgs: 0, out_msgs: 0, in_bytes: 0, out_bytes: 0 } },
          ],
        },
      }),
    ]);
    expect(overlayForStack(o, "jc", "default")!.verdict).toBe("connected");
    expect(overlayForStack(o, "jc", "default")!.rttMs).toBe(8.4);
    expect(overlayForStack(o, "echo", "research")!.present).toBe(true);
    expect(overlayForStack(o, "echo", "research")!.rttMs).toBeNull();
  });

  it("a leaf_disconnect seeds registered-absent (a leaf vanished)", () => {
    const o = buildTransportOverlay([
      row({
        type: "system.transport.leaf_disconnect",
        payload: {
          action: "leaf_disconnect",
          network: NET,
          leaf: { principal: "jc", stack: "default", network: NET, rtt_ms: null, frames: { in_msgs: 0, out_msgs: 0, in_bytes: 0, out_bytes: 0 } },
        },
      }),
    ]);
    const jc = overlayForStack(o, "jc", "default");
    expect(jc!.verdict).toBe("registered-absent");
    expect(jc!.present).toBe(false);
  });

  it("skips unreadable rows (poison payload / unknown type) without throwing", () => {
    const o = buildTransportOverlay([
      row({ type: "system.transport.liveness_drift", payload: {} }), // no attributes
      row({ type: "system.transport.something_else", payload: { foo: 1 } }),
      drift("jc", "default", "connected"),
    ]);
    expect(o.byKey.size).toBe(1);
    expect(overlayForStack(o, "jc", "default")!.verdict).toBe("connected");
  });

  it("overlayForStack returns null for a never-observed stack", () => {
    const o = buildTransportOverlay([drift("jc", "default", "connected")]);
    expect(overlayForStack(o, "nobody", "nowhere")).toBeNull();
    expect(overlayForStack(o, null, "default")).toBeNull();
  });

  it("EMPTY_TRANSPORT_OVERLAY is shape-compatible (empty map + networks)", () => {
    expect(EMPTY_TRANSPORT_OVERLAY.byKey.size).toBe(0);
    expect(EMPTY_TRANSPORT_OVERLAY.networks).toEqual([]);
  });
});

describe("verdictBadge — verdict→badge mapping (U2.3)", () => {
  it("maps connected → ok / connected label / class", () => {
    const b = verdictBadge("connected");
    expect(b.severity).toBe("ok");
    expect(b.label).toBe("connected");
    expect(b.className).toContain("network-verdict-connected");
    expect(b.title).toContain("intent ∩ reality");
  });

  it("maps registered-absent → warn", () => {
    const b = verdictBadge("registered-absent");
    expect(b.severity).toBe("warn");
    expect(b.className).toContain("network-verdict-registered-absent");
    expect(b.title).toContain("no live leaf");
  });

  it("maps unregistered-present → alert (the security anomaly)", () => {
    const b = verdictBadge("unregistered-present");
    expect(b.severity).toBe("alert");
    expect(b.className).toContain("network-verdict-unregistered-present");
    expect(b.title.toLowerCase()).toContain("anomaly");
  });

  it("is total over every verdict in TRANSPORT_VERDICTS", () => {
    for (const v of TRANSPORT_VERDICTS) {
      const b = verdictBadge(v);
      expect(b.verdict).toBe(v);
      expect(["ok", "warn", "alert"]).toContain(b.severity);
    }
  });
});

describe("formatRtt + isTransportVerdict (U2.3)", () => {
  it("formats RTT to one decimal with an ms suffix, — when null", () => {
    expect(formatRtt(8.4)).toBe("8.4ms");
    expect(formatRtt(12)).toBe("12ms");
    expect(formatRtt(null)).toBe("—");
  });

  it("guards signal's three verdict strings, rejects junk", () => {
    expect(isTransportVerdict("connected")).toBe(true);
    expect(isTransportVerdict("registered-absent")).toBe(true);
    expect(isTransportVerdict("unregistered-present")).toBe(true);
    expect(isTransportVerdict("flapping")).toBe(false);
    expect(isTransportVerdict(null)).toBe(false);
  });
});

describe("buildTransportOverlay — ORIGIN BADGE (P-14 U3.3)", () => {
  it("carries a local row's origin through to the overlay (default)", () => {
    const o = buildTransportOverlay([drift("jc", "default", "connected")]);
    expect(overlayForStack(o, "jc", "default")!.origin).toBe("local");
  });

  it("carries a FOREIGN peer's origin badge through to the overlay", () => {
    const o = buildTransportOverlay([
      drift("joel", "research", "connected", { origin: { kind: "foreign", peer: "joel/research" } }),
      leafConnect("joel", "research", 11.2, { origin: { kind: "foreign", peer: "joel/research" } }),
    ]);
    const joel = overlayForStack(o, "joel", "research")!;
    expect(joel.origin).toEqual({ kind: "foreign", peer: "joel/research" });
    // The verdict + RTT still fold normally — origin is additive attribution.
    expect(joel.verdict).toBe("connected");
    expect(joel.rttMs).toBe(11.2);
  });

  it("a foreign verdict is NEVER downgraded to local (foreign badge is monotonic)", () => {
    // Defensive: even if a local-origin candidate for the same key arrived after
    // a foreign one (subject-disjoint paths make this unreachable in prod), the
    // overlay must keep the foreign attribution — a peer verdict shown as local
    // substrate health is the exact failure the badge exists to prevent.
    const o = buildTransportOverlay([
      // newest-first: foreign drift, then an older same-key local connect
      drift("joel", "research", "connected", {
        origin: { kind: "foreign", peer: "joel/research" },
        timestamp: "2026-06-12T00:00:02.000Z",
      }),
      leafConnect("joel", "research", 9.0, {
        origin: "local",
        timestamp: "2026-06-12T00:00:01.000Z",
      }),
    ]);
    expect(overlayForStack(o, "joel", "research")!.origin).toEqual({
      kind: "foreign",
      peer: "joel/research",
    });
  });

  it("local and foreign peers in the same roster keep distinct badges", () => {
    const o = buildTransportOverlay([
      drift("andreas", "meta-factory", "connected", { origin: "local" }),
      drift("joel", "research", "connected", { origin: { kind: "foreign", peer: "joel/research" } }),
    ]);
    expect(overlayForStack(o, "andreas", "meta-factory")!.origin).toBe("local");
    expect(overlayForStack(o, "joel", "research")!.origin).toEqual({
      kind: "foreign",
      peer: "joel/research",
    });
  });
});
