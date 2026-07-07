/**
 * CK-2 (cortex#1289, plan-mc-future-state §4.A) — pure stack-detail cockpit-header
 * model tests.
 *
 * Pins the three CK-2 derivations:
 *   1. capability ROLLUP — the deduped union of every on-stack agent's declared
 *      capabilities, first-seen order (reusing the capability-match index);
 *   2. the LOCAL vs FEDERATED-PEER variant (a peer is aggregate-only, ADR-0005);
 *   3. the transport-verdict chip — the VERBATIM verdict string + its severity,
 *      and the honest `unobserved` when signal is dark (NEVER default-green).
 */

import { describe, it, expect } from "bun:test";
import type { AgentPresenceTile } from "../hooks/use-agents";
import type { StackCoord } from "../lib/mc-shell-model";
import type {
  TransportOverlay,
  TransportPeerOverlay,
  TransportVerdict,
} from "../lib/network-transport-overlay";
import {
  agentsOnStack,
  stackCapabilities,
  stackPresence,
  stackVariant,
  stackVerdictChip,
  buildStackHeader,
} from "../lib/mc-stack-header";

// ── Fixtures ────────────────────────────────────────────────────────────────

function agent(
  over: Partial<AgentPresenceTile> & { agent_id: string },
): AgentPresenceTile {
  const principal = over.principal ?? "aria";
  const stack = over.stack ?? "atlas";
  return {
    key: `${principal}/${stack}/${over.agent_id}`,
    origin: "local",
    assistant_name: null,
    nkey_public_key: `nk-${over.agent_id}`,
    principal,
    stack,
    capabilities: [],
    state: "online",
    offline_reason: null,
    started_at: null,
    last_heartbeat_at: null,
    last_seen_at: 0,
    ...over,
  };
}

const LOCAL_STACK: StackCoord = {
  principal: "aria",
  stack: "atlas",
  federated: false,
};
const PEER_STACK: StackCoord = {
  principal: "jc",
  stack: "research",
  federated: true,
};

function overlay(rows: TransportPeerOverlay[]): TransportOverlay {
  return { byKey: new Map(rows.map((r) => [r.key, r])), networks: [] };
}

function peerRow(
  principal: string,
  stack: string,
  verdict: TransportVerdict,
  rttMs: number | null = null,
): TransportPeerOverlay {
  return {
    key: `${principal}/${stack}`,
    principal,
    stack,
    network: "tide",
    verdict,
    present: verdict !== "registered-absent",
    rttMs,
    origin: "local",
  };
}

// A serving-principal `aria` snapshot: two own-local (self) agents on atlas, plus
// a cross-principal federated peer agent living on jc/research.
const SERVING = "aria";
const SNAPSHOT: AgentPresenceTile[] = [
  agent({ agent_id: "halo", capabilities: ["review.code", "deploy"] }),
  agent({
    agent_id: "sable",
    capabilities: ["deploy", "lit.review"],
    state: "offline",
  }),
  agent({
    agent_id: "remy",
    origin: { principal: "jc", stack: "research" },
    capabilities: ["research", "review.code"],
  }),
];

// ── agentsOnStack ─────────────────────────────────────────────────────────────

describe("agentsOnStack", () => {
  it("keeps only the agents resolving to the dived stack (own-local)", () => {
    const on = agentsOnStack(SNAPSHOT, LOCAL_STACK, SERVING);
    expect(on.map((a) => a.agent_id).sort()).toEqual(["halo", "sable"]);
  });

  it("resolves a federated peer's agents by origin, not the serving fields", () => {
    const on = agentsOnStack(SNAPSHOT, PEER_STACK, SERVING);
    expect(on.map((a) => a.agent_id)).toEqual(["remy"]);
  });

  it("is empty for a stack no agent lives on", () => {
    const on = agentsOnStack(SNAPSHOT, { principal: "aria", stack: "ghost", federated: false }, SERVING);
    expect(on).toEqual([]);
  });
});

// ── stackCapabilities (the rollup) ────────────────────────────────────────────

describe("stackCapabilities", () => {
  it("rolls up the deduped union in first-seen order", () => {
    const on = agentsOnStack(SNAPSHOT, LOCAL_STACK, SERVING);
    // halo → [review.code, deploy]; sable → [deploy, lit.review]
    expect(stackCapabilities(on)).toEqual(["review.code", "deploy", "lit.review"]);
  });

  it("returns an empty rollup when no agent declares a capability", () => {
    const on = [agent({ agent_id: "mute", capabilities: [] })];
    expect(stackCapabilities(on)).toEqual([]);
  });

  it("does not double-count a capability two agents share", () => {
    const on = agentsOnStack(SNAPSHOT, LOCAL_STACK, SERVING);
    const caps = stackCapabilities(on);
    expect(caps.filter((c) => c === "deploy")).toHaveLength(1);
  });
});

// ── stackVariant ──────────────────────────────────────────────────────────────

describe("stackVariant", () => {
  it("is `local` for an own-local stack", () => {
    expect(stackVariant(LOCAL_STACK)).toBe("local");
  });
  it("is `peer` for a federated stack (aggregate-only, ADR-0005)", () => {
    expect(stackVariant(PEER_STACK)).toBe("peer");
  });
});

// ── stackPresence ─────────────────────────────────────────────────────────────

describe("stackPresence", () => {
  it("counts online vs total for the on-stack agents", () => {
    const on = agentsOnStack(SNAPSHOT, LOCAL_STACK, SERVING);
    // halo online, sable offline
    expect(stackPresence(on)).toEqual({ online: 1, total: 2 });
  });
});

// ── stackVerdictChip (verbatim + severity + unobserved) ───────────────────────

describe("stackVerdictChip", () => {
  it("carries signal's verdict VERBATIM with its severity when observed", () => {
    const ov = overlay([peerRow("aria", "atlas", "connected", 8.4)]);
    const chip = stackVerdictChip(ov, LOCAL_STACK);
    expect(chip.observed).toBe(true);
    if (!chip.observed) throw new Error("expected observed");
    expect(chip.badge.label).toBe("connected"); // verbatim
    expect(chip.badge.verdict).toBe("connected");
    expect(chip.badge.severity).toBe("ok");
    expect(chip.rttMs).toBe(8.4);
  });

  it("maps registered-absent → warn and unregistered-present → alert (verbatim label)", () => {
    const warn = stackVerdictChip(
      overlay([peerRow("aria", "atlas", "registered-absent")]),
      LOCAL_STACK,
    );
    const alert = stackVerdictChip(
      overlay([peerRow("aria", "atlas", "unregistered-present")]),
      LOCAL_STACK,
    );
    if (!warn.observed || !alert.observed) throw new Error("expected observed");
    expect([warn.badge.label, warn.badge.severity]).toEqual(["registered-absent", "warn"]);
    expect([alert.badge.label, alert.badge.severity]).toEqual(["unregistered-present", "alert"]);
  });

  it("is honestly `unobserved` when signal has no row for the stack (never green)", () => {
    const chip = stackVerdictChip(overlay([]), LOCAL_STACK);
    expect(chip).toEqual({ observed: false });
  });

  it("does not read a peer's verdict as this stack's (keys on principal/stack)", () => {
    // A verdict for jc/research must not answer for aria/atlas.
    const chip = stackVerdictChip(overlay([peerRow("jc", "research", "connected")]), LOCAL_STACK);
    expect(chip).toEqual({ observed: false });
  });
});

// ── buildStackHeader (integration) ────────────────────────────────────────────

describe("buildStackHeader", () => {
  it("assembles the LOCAL stack header (bare label, rolled-up caps, observed verdict)", () => {
    const ov = overlay([peerRow("aria", "atlas", "connected", 8.4)]);
    const model = buildStackHeader(SNAPSHOT, LOCAL_STACK, ov, SERVING);
    expect(model.label).toBe("atlas");
    expect(model.variant).toBe("local");
    expect(model.capabilities).toEqual(["review.code", "deploy", "lit.review"]);
    expect(model.presence).toEqual({ online: 1, total: 2 });
    expect(model.verdict.observed).toBe(true);
  });

  it("assembles the FEDERATED-PEER header (provenance label, peer variant, aggregate caps)", () => {
    const model = buildStackHeader(SNAPSHOT, PEER_STACK, overlay([]), SERVING);
    expect(model.label).toBe("jc/research"); // {principal}/{stack} provenance
    expect(model.variant).toBe("peer");
    // aggregate rollup of the peer's agents only
    expect(model.capabilities).toEqual(["research", "review.code"]);
    expect(model.presence).toEqual({ online: 1, total: 1 });
    // signal dark for the peer → honest unobserved, never fabricated green
    expect(model.verdict).toEqual({ observed: false });
  });
});
