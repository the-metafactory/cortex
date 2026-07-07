/**
 * CK-3 (cortex#1289) — pure re-scope lib tests. Pins that the cockpit narrows the
 * whole-dashboard snapshots to the DIVED stack, that a federated coord fails closed
 * (ADR-0005), and that governance summary/alarm re-derive honestly from the
 * filtered rows.
 */

import { describe, it, expect } from "bun:test";
import {
  scopeWorkingTiles,
  scopeAttention,
  scopeGovernance,
  cockpitDispatchAgent,
} from "../lib/mc-cockpit-scope";
import type { StackCoord } from "../lib/mc-shell-model";
import type { WorkingAgentTile } from "../hooks/use-working-agents";
import type { AgentPresenceTile, AgentOrigin } from "../hooks/use-agents";
import type { AttentionEntry } from "../../api/attention";
import type { GovernanceResponse } from "../../api/governance";
import type {
  GovernanceVerdictRow,
  GovernanceDenialRow,
} from "../../db/governance";

const LOCAL: StackCoord = { principal: "aria", stack: "meta-factory", federated: false };
const SIBLING: StackCoord = { principal: "aria", stack: "work", federated: false };
const PEER: StackCoord = { principal: "jc", stack: "home", federated: true };

// ── working tiles ──────────────────────────────────────────────────────────

function tile(agent_id: string, origin: AgentOrigin): WorkingAgentTile {
  return {
    agent_id,
    agent_name: agent_id,
    agent_type: "head",
    primary_state_rank: 1,
    primary_state: "running",
    primary_assignment: {
      id: `${agent_id}-a`,
      task_id: `${agent_id}-t`,
      task_title: "t",
      task_priority: 1,
      updated_at: "2026-07-08T00:00:00Z",
    },
    additional_active_count: 0,
    origin,
    sessions: [],
  };
}

describe("scopeWorkingTiles", () => {
  it("keeps local-origin tiles + sibling tiles matching the dived stack", () => {
    const tiles = [
      tile("luna", "local"),
      tile("echo", { principal: "aria", stack: "work" }),
      tile("sage", { principal: "jc", stack: "home" }),
    ];
    // Diving into the serving (local) stack: local tiles are own-local by
    // construction; the foreign-sibling tagged tile for `work` is not this stack.
    const scoped = scopeWorkingTiles(tiles, LOCAL).map((t) => t.agent_id);
    expect(scoped).toEqual(["luna"]);
  });

  it("matches a sibling stack by {principal, stack}", () => {
    const tiles = [
      tile("luna", "local"),
      tile("echo", { principal: "aria", stack: "work" }),
    ];
    const scoped = scopeWorkingTiles(tiles, SIBLING).map((t) => t.agent_id);
    // local tile is own-local (matches any own-local dive per CK-1 semantics);
    // echo is the sibling `work` stack's.
    expect(scoped.sort()).toEqual(["echo", "luna"]);
  });

  it("fails closed for a federated peer coord (ADR-0005)", () => {
    const tiles = [tile("sage", { principal: "jc", stack: "home" })];
    expect(scopeWorkingTiles(tiles, PEER)).toEqual([]);
  });
});

// ── attention ────────────────────────────────────────────────────────────────

function attn(id: string, stackId: string): AttentionEntry {
  return {
    item: {
      id,
      stackId,
      workItemId: null,
      sessionId: null,
      kind: "review",
      severity: "normal",
      status: "open",
    },
    link: { kind: "none" },
  };
}

describe("scopeAttention", () => {
  it("filters entries by AttentionItem.stackId", () => {
    const entries = [
      attn("a", "meta-factory"),
      attn("b", "work"),
      attn("c", "meta-factory"),
    ];
    const scoped = scopeAttention(entries, LOCAL).map((e) => e.item.id);
    expect(scoped).toEqual(["a", "c"]);
  });

  it("fails closed for a federated peer coord", () => {
    const entries = [attn("a", "home")];
    expect(scopeAttention(entries, PEER)).toEqual([]);
  });
});

// ── governance ───────────────────────────────────────────────────────────────

function verdict(
  over: Partial<GovernanceVerdictRow> & { id: string },
): GovernanceVerdictRow {
  return {
    envelopeId: `${over.id}-env`,
    layer: "resolved",
    decision: "allow",
    name: "act",
    tool: null,
    reason: null,
    resolvedBy: null,
    principal: "aria",
    stack: "meta-factory",
    createdAt: 1_000_000,
    ...over,
  };
}

function denial(
  over: Partial<GovernanceDenialRow> & { id: string },
): GovernanceDenialRow {
  return {
    envelopeId: `${over.id}-env`,
    kind: "denied",
    reasonKind: "authz",
    isRefusal: false,
    principalId: null,
    capability: null,
    envelopeSubject: null,
    detail: null,
    principal: "aria",
    stack: "meta-factory",
    createdAt: 1_000_000,
    ...over,
  };
}

const NOW = 2_000_000;
const RECENT = NOW - 100; // inside 24h
const OLD = NOW - 200_000; // > 24h ago

function govResponse(over: Partial<GovernanceResponse>): GovernanceResponse {
  return {
    verdicts: [],
    summary: { total: 0, allows: 0, denials: 0, defers: 0, byLayer: { l0: 0, tribunal: 0, gate: 0, resolved: 0 }, denials24h: 0 },
    denials: [],
    denialSummary: { total: 0, refusals: 0, otherDenials: 0, byReasonKind: {}, denials24h: 0 },
    alarm: { tier: "none", denials24h: 0, note: "" },
    windowDays: 30,
    listCap: 200,
    ...over,
  };
}

describe("scopeGovernance", () => {
  it("filters verdict + denial rows to the dived stack and re-derives the summary", () => {
    const data = govResponse({
      verdicts: [
        verdict({ id: "v1", stack: "meta-factory", decision: "allow" }),
        verdict({ id: "v2", stack: "meta-factory", decision: "deny", createdAt: RECENT }),
        verdict({ id: "v3", stack: "work", decision: "deny", createdAt: RECENT }), // other stack
        verdict({ id: "v4", stack: null }), // untagged — excluded
      ],
      denials: [
        denial({ id: "d1", stack: "meta-factory", isRefusal: true, createdAt: RECENT }),
        denial({ id: "d2", stack: "work" }), // other stack
      ],
    });
    const scoped = scopeGovernance(data, LOCAL, NOW);
    expect(scoped.verdicts.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(scoped.summary.total).toBe(2);
    expect(scoped.summary.allows).toBe(1);
    expect(scoped.summary.denials).toBe(1);
    expect(scoped.summary.denials24h).toBe(1); // v2 is a recent deny
    expect(scoped.denials.map((d) => d.id)).toEqual(["d1"]);
    expect(scoped.denialSummary.total).toBe(1);
    expect(scoped.denialSummary.refusals).toBe(1);
  });

  it("re-derives the alarm tier from combined 24h denials (>=5 => high)", () => {
    const verdicts: GovernanceVerdictRow[] = [];
    for (let i = 0; i < 3; i++) {
      verdicts.push(verdict({ id: `v${i}`, decision: "deny", createdAt: RECENT }));
    }
    const denials: GovernanceDenialRow[] = [];
    for (let i = 0; i < 2; i++) {
      denials.push(denial({ id: `d${i}`, createdAt: RECENT }));
    }
    const scoped = scopeGovernance(govResponse({ verdicts, denials }), LOCAL, NOW);
    expect(scoped.alarm.tier).toBe("high"); // 3 + 2 = 5
    expect(scoped.alarm.denials24h).toBe(5);
  });

  it("does not count denials older than 24h in the alarm", () => {
    const scoped = scopeGovernance(
      govResponse({ verdicts: [verdict({ id: "v", decision: "deny", createdAt: OLD })] }),
      LOCAL,
      NOW,
    );
    expect(scoped.summary.denials24h).toBe(0);
    expect(scoped.alarm.tier).toBe("none");
  });

  it("fails closed for a federated peer coord", () => {
    const data = govResponse({ verdicts: [verdict({ id: "v", stack: "home", principal: "jc" })] });
    const scoped = scopeGovernance(data, PEER, NOW);
    expect(scoped.verdicts).toEqual([]);
    expect(scoped.summary.total).toBe(0);
  });
});

// ── dispatch target ──────────────────────────────────────────────────────────

function presence(
  over: Partial<AgentPresenceTile> & { agent_id: string },
): AgentPresenceTile {
  return {
    key: `k-${over.agent_id}`,
    origin: "local",
    assistant_name: null,
    nkey_public_key: "pk",
    principal: "aria",
    stack: "meta-factory",
    capabilities: [],
    state: "online",
    offline_reason: null,
    started_at: null,
    last_heartbeat_at: null,
    last_seen_at: 0,
    ...over,
  };
}

describe("cockpitDispatchAgent", () => {
  it("prefers an online local agent on the dived stack", () => {
    const agents = [
      presence({ agent_id: "offlineone", state: "offline" }),
      presence({ agent_id: "luna", state: "online", assistant_name: "Luna" }),
    ];
    const target = cockpitDispatchAgent(agents, LOCAL, "aria");
    expect(target?.tile.agent_id).toBe("luna");
    expect(target?.label).toBe("Luna");
  });

  it("returns null when the stack has no local presence agent", () => {
    const agents = [
      presence({ agent_id: "sage", origin: { principal: "jc", stack: "home" }, principal: "jc", stack: "home" }),
    ];
    expect(cockpitDispatchAgent(agents, LOCAL, "aria")).toBeNull();
  });

  it("returns null for a federated peer coord (dispatch is local-only)", () => {
    const agents = [presence({ agent_id: "luna" })];
    expect(cockpitDispatchAgent(agents, PEER, "aria")).toBeNull();
  });
});
