/**
 * G-1114.D.5 — network graph FILTER tests.
 *
 * Asserts the pure filter that narrows the agents snapshot before it feeds the
 * graph adapter: a state filter (online / offline / all), a capability filter
 * (show only agents declaring a chosen capability), the two combined, the empty
 * result, and the capability-option derivation (the distinct, sorted capability
 * set offered in the filter bar's dropdown).
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_NETWORK_FILTER,
  filterAgents,
  collectCapabilityOptions,
  isFilterActive,
  type NetworkFilterState,
} from "../lib/network-graph-filter";
import type { AgentPresenceTile } from "../hooks/use-agents";

function tile(
  over: Partial<AgentPresenceTile> & { agent_id: string },
): AgentPresenceTile {
  const { agent_id } = over;
  return {
    key: `andreas/research/${agent_id}`,
    origin: "local",
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
  state: "online",
  capabilities: ["review.code", "review.design"],
});
const echo = tile({
  agent_id: "echo",
  assistant_name: "Echo",
  state: "online",
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

describe("filterAgents — state filter (G-1114.D.5)", () => {
  it("returns every agent for the default (all) filter", () => {
    expect(filterAgents(all, DEFAULT_NETWORK_FILTER)).toEqual(all);
  });

  it("'all' state passes online and offline alike", () => {
    const out = filterAgents(all, { state: "all", capability: null, scope: "include-federated" });
    expect(out).toHaveLength(3);
  });

  it("'online' keeps only online agents", () => {
    const out = filterAgents(all, { state: "online", capability: null, scope: "include-federated" });
    expect(out.map((a) => a.agent_id)).toEqual(["luna", "echo"]);
  });

  it("'offline' keeps only offline agents", () => {
    const out = filterAgents(all, { state: "offline", capability: null, scope: "include-federated" });
    expect(out.map((a) => a.agent_id)).toEqual(["sage"]);
  });

  it("preserves snapshot order (deterministic layout input)", () => {
    const out = filterAgents([echo, luna, sage], { state: "online", capability: null, scope: "include-federated" });
    expect(out.map((a) => a.agent_id)).toEqual(["echo", "luna"]);
  });
});

describe("filterAgents — capability filter (G-1114.D.5)", () => {
  it("null capability passes every agent", () => {
    const out = filterAgents(all, { state: "all", capability: null, scope: "include-federated" });
    expect(out).toHaveLength(3);
  });

  it("keeps only agents declaring the chosen capability", () => {
    const out = filterAgents(all, { state: "all", capability: "review.code", scope: "include-federated" });
    expect(out.map((a) => a.agent_id)).toEqual(["luna", "echo"]);
  });

  it("returns an empty result when no agent declares the capability", () => {
    const out = filterAgents(all, { state: "all", capability: "deploy", scope: "include-federated" });
    expect(out).toEqual([]);
  });

  it("a capability declared by exactly one agent narrows to that agent", () => {
    const out = filterAgents(all, { state: "all", capability: "moderate", scope: "include-federated" });
    expect(out.map((a) => a.agent_id)).toEqual(["sage"]);
  });
});

describe("filterAgents — combined state + capability (G-1114.D.5)", () => {
  it("applies both filters (AND)", () => {
    // online AND review.code → luna, echo (sage is offline; sage lacks review.code anyway)
    const out = filterAgents(all, { state: "online", capability: "review.code", scope: "include-federated" });
    expect(out.map((a) => a.agent_id)).toEqual(["luna", "echo"]);
  });

  it("can produce an empty result from the intersection", () => {
    // offline AND review.code → none (sage is offline but only has 'moderate')
    const out = filterAgents(all, { state: "offline", capability: "review.code", scope: "include-federated" });
    expect(out).toEqual([]);
  });

  it("offline AND moderate → sage", () => {
    const out = filterAgents(all, { state: "offline", capability: "moderate", scope: "include-federated" });
    expect(out.map((a) => a.agent_id)).toEqual(["sage"]);
  });
});

describe("filterAgents — edge cases (G-1114.D.5)", () => {
  it("an empty snapshot yields an empty result for any filter", () => {
    expect(filterAgents([], { state: "online", capability: "review.code", scope: "include-federated" })).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [...all];
    filterAgents(input, { state: "online", capability: null, scope: "include-federated" });
    expect(input).toEqual(all);
  });
});

describe("collectCapabilityOptions (G-1114.D.5)", () => {
  it("returns the distinct capabilities across all agents, sorted", () => {
    expect(collectCapabilityOptions(all)).toEqual([
      "moderate",
      "review.code",
      "review.design",
    ]);
  });

  it("de-duplicates a capability declared by several agents", () => {
    // review.code is on both luna and echo — appears once.
    const opts = collectCapabilityOptions(all);
    expect(opts.filter((c) => c === "review.code")).toHaveLength(1);
  });

  it("returns an empty list when no agent declares a capability", () => {
    expect(collectCapabilityOptions([tile({ agent_id: "x", capabilities: [] })])).toEqual([]);
  });

  it("returns an empty list for an empty snapshot", () => {
    expect(collectCapabilityOptions([])).toEqual([]);
  });
});

describe("isFilterActive (G-1114.D.5)", () => {
  it("is false for the default filter", () => {
    expect(isFilterActive(DEFAULT_NETWORK_FILTER)).toBe(false);
  });

  it("is true when a state filter is set", () => {
    expect(isFilterActive({ state: "online", capability: null, scope: "include-federated" })).toBe(true);
  });

  it("is true when a capability filter is set", () => {
    expect(isFilterActive({ state: "all", capability: "review.code", scope: "include-federated" })).toBe(true);
  });
});
