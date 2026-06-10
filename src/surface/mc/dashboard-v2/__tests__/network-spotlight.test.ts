/**
 * G-1114.D.5 — Network spotlight match/rank tests.
 *
 * The spotlight finds an agent by assistant name / agent id / capability and
 * SELECTS its node. The match/rank logic is pure (a query + the agents snapshot
 * → a ranked list of {key, ...} hits) so it's unit-testable without a DOM, the
 * same pure/wrapper split D.1-4 use. Also covers the Cmd+K / Esc key helpers.
 */

import { describe, it, expect } from "bun:test";
import {
  searchAgents,
  isSpotlightOpenChord,
  type SpotlightHit,
} from "../lib/network-spotlight";
import type { AgentPresenceTile } from "../hooks/use-agents";

function tile(
  over: Partial<AgentPresenceTile> & { agent_id: string },
): AgentPresenceTile {
  const { agent_id } = over;
  return {
    key: `andreas/research/${agent_id}`,
    assistant_name: null,
    nkey_public_key: `N${agent_id}`,
    principal: "andreas",
    stack: "research",
    capabilities: [],
    state: "online",
    offline_reason: null,
    started_at: null,
    last_heartbeat_at: null,
    last_seen_at: 1000,
    ...over,
  };
}

const luna = tile({
  agent_id: "luna",
  assistant_name: "Luna",
  capabilities: ["review.code", "review.design"],
});
const echo = tile({
  agent_id: "echo",
  assistant_name: "Echo",
  capabilities: ["review.code"],
});
const sage = tile({
  agent_id: "sage",
  assistant_name: "Sage",
  state: "offline",
  offline_reason: "ttl_lapse",
  capabilities: ["moderate"],
});
const all = [luna, echo, sage];

function keys(hits: SpotlightHit[]): string[] {
  return hits.map((h) => h.key);
}

describe("searchAgents — empty query (G-1114.D.5)", () => {
  it("returns every agent (in snapshot order) for an empty query", () => {
    expect(keys(searchAgents(all, ""))).toEqual([
      "andreas/research/luna",
      "andreas/research/echo",
      "andreas/research/sage",
    ]);
  });

  it("returns every agent for a whitespace-only query", () => {
    expect(searchAgents(all, "   ")).toHaveLength(3);
  });

  it("returns an empty list for an empty snapshot", () => {
    expect(searchAgents([], "luna")).toEqual([]);
  });
});

describe("searchAgents — match by name (G-1114.D.5)", () => {
  it("matches the assistant name, case-insensitively", () => {
    expect(keys(searchAgents(all, "lun"))).toEqual(["andreas/research/luna"]);
    expect(keys(searchAgents(all, "LUNA"))).toEqual(["andreas/research/luna"]);
  });

  it("falls back to agent id when assistant_name is null", () => {
    const anon = tile({ agent_id: "zeta", assistant_name: null });
    expect(keys(searchAgents([anon], "zeta"))).toEqual(["andreas/research/zeta"]);
  });
});

describe("searchAgents — match by id (G-1114.D.5)", () => {
  it("matches the agent id", () => {
    expect(keys(searchAgents(all, "echo"))).toEqual(["andreas/research/echo"]);
  });
});

describe("searchAgents — match by capability (G-1114.D.5)", () => {
  it("matches a declared capability", () => {
    // review.code is on luna and echo
    expect(keys(searchAgents(all, "review.code")).sort()).toEqual(
      ["andreas/research/echo", "andreas/research/luna"].sort(),
    );
  });

  it("matches a capability substring", () => {
    expect(keys(searchAgents(all, "moderate"))).toEqual(["andreas/research/sage"]);
  });
});

describe("searchAgents — ranking (G-1114.D.5)", () => {
  it("ranks a name-prefix match above a mid-string / capability match", () => {
    // query "re": "review.*" capability hits, but no name starts with "re".
    // Add an agent whose NAME starts with "re" — it should rank first.
    const rex = tile({ agent_id: "rex", assistant_name: "Rex", capabilities: [] });
    const hits = searchAgents([luna, echo, rex], "re");
    expect(hits[0]!.key).toBe("andreas/research/rex");
  });

  it("ranks an exact id match at the top", () => {
    const hits = searchAgents(all, "luna");
    expect(hits[0]!.key).toBe("andreas/research/luna");
  });
});

describe("searchAgents — no match (G-1114.D.5)", () => {
  it("returns an empty list when nothing matches", () => {
    expect(searchAgents(all, "nonexistent-xyz")).toEqual([]);
  });
});

describe("searchAgents — hit shape (G-1114.D.5)", () => {
  it("carries the key, display name, id, and state for the result row", () => {
    const [hit] = searchAgents([luna], "luna");
    expect(hit).toEqual({
      key: "andreas/research/luna",
      agentId: "luna",
      displayName: "Luna",
      state: "online",
      capabilities: ["review.code", "review.design"],
    });
  });

  it("uses agent id as the display name when assistant_name is null", () => {
    const anon = tile({ agent_id: "zeta", assistant_name: null });
    const [hit] = searchAgents([anon], "zeta");
    expect(hit!.displayName).toBe("zeta");
  });

  it("never leaks session-interior fields onto a hit (ADR-0007)", () => {
    const [hit] = searchAgents([luna], "luna");
    expect(Object.keys(hit!).sort()).toEqual(
      ["agentId", "capabilities", "displayName", "key", "state"].sort(),
    );
  });
});

describe("isSpotlightOpenChord (G-1114.D.5)", () => {
  it("matches Cmd+K (meta)", () => {
    expect(isSpotlightOpenChord({ metaKey: true, ctrlKey: false, key: "k" })).toBe(true);
  });

  it("matches Ctrl+K", () => {
    expect(isSpotlightOpenChord({ metaKey: false, ctrlKey: true, key: "k" })).toBe(true);
  });

  it("is case-insensitive on the key", () => {
    expect(isSpotlightOpenChord({ metaKey: true, ctrlKey: false, key: "K" })).toBe(true);
  });

  it("does not match a bare 'k'", () => {
    expect(isSpotlightOpenChord({ metaKey: false, ctrlKey: false, key: "k" })).toBe(false);
  });

  it("does not match Cmd+other", () => {
    expect(isSpotlightOpenChord({ metaKey: true, ctrlKey: false, key: "j" })).toBe(false);
  });
});
