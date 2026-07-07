/**
 * OBS-2 — tri-state HEALTH fold + RTT policy tests (ADR-0022).
 *
 * Asserts the ADR's decision verbatim: threshold values (500/2000ms), null-RTT
 * semantics (⇒ unobserved, NEVER red), fold precedence (collector-health >
 * transport-verdict > presence), and that absent inputs fold to `unobserved`
 * rather than a fabricated green/red. The final block is the parity check that
 * the fold agrees with `verdictBadge` severity — the transport-roster verdict
 * semantics MC already renders — so the two never drift.
 */

import { describe, it, expect } from "bun:test";
import {
  foldNodeHealth,
  rttHealth,
  severityHealth,
  collectorHealthOpinion,
  transportHealthOpinion,
  presenceHealthOpinion,
  transportTierFromOverlay,
  AMBER_RTT_MS,
  RED_RTT_MS,
  type NodeHealthInputs,
  type TransportTier,
} from "../lib/network-health-fold";
import {
  verdictBadge,
  TRANSPORT_VERDICTS,
  type TransportPeerOverlay,
  type TransportVerdict,
} from "../lib/network-transport-overlay";

/** A node-health input with every tier abstaining; override the tier under test. */
function inputs(over: Partial<NodeHealthInputs> = {}): NodeHealthInputs {
  return { collector: "unknown", transport: null, presence: "unknown", ...over };
}

/** A transport tier from a verdict severity + rtt (verdict stays verbatim upstream). */
function transport(severity: TransportTier["severity"], rttMs: number | null): TransportTier {
  return { severity, rttMs };
}

/** A minimal overlay row carrying a verbatim verdict + rtt, for parity/adapter tests. */
function overlay(verdict: TransportVerdict, rttMs: number | null): TransportPeerOverlay {
  return {
    key: `p/${verdict}`,
    principal: "p",
    stack: verdict,
    network: "metafactory",
    verdict,
    present: verdict === "connected" || verdict === "unregistered-present",
    rttMs,
    origin: "local",
  };
}

// ---------------------------------------------------------------------------
// RTT threshold policy — ADR-0022 §Decision (500ms amber, 2000ms red).
// ---------------------------------------------------------------------------

describe("rttHealth — ADR-0022 threshold policy", () => {
  it("pins the ADR threshold constants", () => {
    expect(AMBER_RTT_MS).toBe(500);
    expect(RED_RTT_MS).toBe(2000);
  });

  it("null RTT ⇒ unobserved (never red — 'not measured' is not 'unreachable')", () => {
    expect(rttHealth(null)).toBe("unobserved");
  });

  it("sub-amber RTT ⇒ green", () => {
    expect(rttHealth(0)).toBe("green");
    expect(rttHealth(8.4)).toBe("green");
    expect(rttHealth(499)).toBe("green");
  });

  it("amber boundary is inclusive at 500ms", () => {
    expect(rttHealth(499)).toBe("green");
    expect(rttHealth(500)).toBe("amber");
    expect(rttHealth(1999)).toBe("amber");
  });

  it("red boundary is inclusive at 2000ms", () => {
    expect(rttHealth(1999)).toBe("amber");
    expect(rttHealth(2000)).toBe("red");
    expect(rttHealth(9999)).toBe("red");
  });

  it("non-finite / negative RTT ⇒ unobserved (defensive — never a fabricated red)", () => {
    expect(rttHealth(Number.NaN)).toBe("unobserved");
    expect(rttHealth(Number.POSITIVE_INFINITY)).toBe("unobserved");
    expect(rttHealth(-1)).toBe("unobserved");
  });
});

// ---------------------------------------------------------------------------
// Per-tier opinions.
// ---------------------------------------------------------------------------

describe("collectorHealthOpinion — strongest tier", () => {
  it("healthy ⇒ green, degraded ⇒ red, unknown ⇒ unobserved", () => {
    expect(collectorHealthOpinion("healthy")).toBe("green");
    expect(collectorHealthOpinion("degraded")).toBe("red");
    expect(collectorHealthOpinion("unknown")).toBe("unobserved");
  });
});

describe("presenceHealthOpinion — weakest tier", () => {
  it("online ⇒ green, offline ⇒ amber (soft, never hard-red), unknown ⇒ unobserved", () => {
    expect(presenceHealthOpinion("online")).toBe("green");
    expect(presenceHealthOpinion("offline")).toBe("amber");
    expect(presenceHealthOpinion("unknown")).toBe("unobserved");
  });
});

describe("transportHealthOpinion — verdict severity folded with RTT", () => {
  it("null tier abstains ⇒ unobserved", () => {
    expect(transportHealthOpinion(null)).toBe("unobserved");
  });

  it("connected(ok) + null RTT ⇒ green — verdict observed, RTT merely unmeasured", () => {
    expect(transportHealthOpinion(transport("ok", null))).toBe("green");
  });

  it("RTT only ever RAISES severity above the verdict base", () => {
    expect(transportHealthOpinion(transport("ok", 100))).toBe("green");
    expect(transportHealthOpinion(transport("ok", 600))).toBe("amber");
    expect(transportHealthOpinion(transport("ok", 2500))).toBe("red");
  });

  it("a warn/alert verdict is never LOWERED by a fast/absent RTT", () => {
    expect(transportHealthOpinion(transport("warn", 10))).toBe("amber");
    expect(transportHealthOpinion(transport("warn", null))).toBe("amber");
    expect(transportHealthOpinion(transport("alert", 10))).toBe("red");
    expect(transportHealthOpinion(transport("alert", null))).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// Fold precedence — ADR-0022: collector-health > transport-verdict > presence.
// ---------------------------------------------------------------------------

describe("foldNodeHealth — precedence rule: collector-health wins", () => {
  it("degraded collector ⇒ red even when transport says connected and presence online", () => {
    expect(
      foldNodeHealth(
        inputs({ collector: "degraded", transport: transport("ok", 8), presence: "online" }),
      ),
    ).toBe("red");
  });

  it("healthy collector masks a lower-tier alarm ⇒ green (ADR intent, collector = ground truth)", () => {
    expect(
      foldNodeHealth(
        inputs({ collector: "healthy", transport: transport("alert", 2500), presence: "offline" }),
      ),
    ).toBe("green");
  });
});

describe("foldNodeHealth — precedence rule: transport wins over presence", () => {
  it("collector unknown ⇒ transport verdict decides over presence", () => {
    expect(
      foldNodeHealth(inputs({ transport: transport("alert", null), presence: "online" })),
    ).toBe("red");
    expect(
      foldNodeHealth(inputs({ transport: transport("warn", null), presence: "online" })),
    ).toBe("amber");
  });

  it("a null-RTT connected verdict still outranks presence (green over online)", () => {
    expect(
      foldNodeHealth(inputs({ transport: transport("ok", null), presence: "offline" })),
    ).toBe("green");
  });
});

describe("foldNodeHealth — precedence rule: presence decides last", () => {
  it("only presence observed ⇒ presence opinion", () => {
    expect(foldNodeHealth(inputs({ presence: "online" }))).toBe("green");
    expect(foldNodeHealth(inputs({ presence: "offline" }))).toBe("amber");
  });
});

// ---------------------------------------------------------------------------
// The cardinal rules — absent inputs, null RTT.
// ---------------------------------------------------------------------------

describe("foldNodeHealth — absent inputs ⇒ unobserved (NEVER default green/red)", () => {
  it("all tiers abstain ⇒ unobserved", () => {
    expect(foldNodeHealth(inputs())).toBe("unobserved");
  });

  it("absent collector-signal does NOT read as green", () => {
    expect(foldNodeHealth(inputs({ collector: "unknown" }))).not.toBe("green");
    expect(foldNodeHealth(inputs({ collector: "unknown" }))).toBe("unobserved");
  });

  it("null RTT with no verdict and no other signal ⇒ unobserved, never red", () => {
    const health = foldNodeHealth(inputs({ transport: null }));
    expect(health).toBe("unobserved");
    expect(health).not.toBe("red");
  });
});

// ---------------------------------------------------------------------------
// Parity — the fold agrees with transport-roster verdict semantics (verdictBadge).
// ---------------------------------------------------------------------------

describe("parity: fold ↔ verdictBadge severity (verdict semantics never drift)", () => {
  it("severityHealth mirrors the badge severity tiers", () => {
    expect(severityHealth("ok")).toBe("green");
    expect(severityHealth("warn")).toBe("amber");
    expect(severityHealth("alert")).toBe("red");
  });

  it("every verdict, sole-signal, folds to exactly its verdictBadge severity", () => {
    for (const verdict of TRANSPORT_VERDICTS) {
      const tier = transportTierFromOverlay(overlay(verdict, null));
      const folded = foldNodeHealth(inputs({ transport: tier }));
      const expected = severityHealth(verdictBadge(verdict).severity);
      expect(folded).toBe(expected);
    }
  });

  it("transportTierFromOverlay carries the verdict VERBATIM (severity via canonical badge)", () => {
    for (const verdict of TRANSPORT_VERDICTS) {
      const tier = transportTierFromOverlay(overlay(verdict, 42));
      expect(tier).not.toBeNull();
      expect(tier?.severity).toBe(verdictBadge(verdict).severity);
      expect(tier?.rttMs).toBe(42);
    }
  });

  it("null overlay ⇒ null tier (abstains)", () => {
    expect(transportTierFromOverlay(null)).toBeNull();
  });
});
