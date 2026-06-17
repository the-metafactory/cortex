/**
 * #1068 — highlight-subtree-on-hub-select tests.
 *
 * `subtreeHighlightSet(graph, hubId)` must return EXACTLY the hub + its agents +
 * its hub→agent edges (and nothing from sibling/foreign stacks); the toggle/
 * clear logic must select a fresh hub, deselect on a re-click of the same hub,
 * and clear on a `null` (empty-canvas) click; a foreign hub must light only its
 * OWN subtree.
 */

import { describe, it, expect } from "bun:test";
import {
  buildNetworkGraph,
  STACK_HUB_NODE_ID,
  FOREIGN_HUB_ID_PREFIX,
} from "../lib/network-graph-adapter";
import {
  subtreeHighlightSet,
  toggleHubSelection,
  isInSubtreeHighlight,
  hasSubtreeSelection,
  EMPTY_SUBTREE_SELECTION,
} from "../lib/network-subtree-highlight";
import type { AgentPresenceTile } from "../hooks/use-agents";

function base(agent_id: string): Omit<AgentPresenceTile, "key" | "principal" | "stack" | "origin"> {
  return {
    agent_id,
    assistant_name: null,
    nkey_public_key: `N${agent_id.toUpperCase()}`,
    capabilities: [],
    state: "online",
    offline_reason: null,
    started_at: null,
    last_heartbeat_at: null,
    last_seen_at: 1000,
  };
}

function tile(over: { agent_id: string }): AgentPresenceTile {
  return {
    key: `andreas/research/${over.agent_id}`,
    principal: "andreas",
    stack: "research",
    origin: "local",
    ...base(over.agent_id),
  };
}

function siblingTile(agent_id: string, stack: string): AgentPresenceTile {
  return {
    key: `andreas/${stack}/${agent_id}`,
    principal: "andreas",
    stack,
    origin: { principal: "andreas", stack },
    ...base(agent_id),
  };
}

function foreignTile(agent_id: string, principal: string, stack: string): AgentPresenceTile {
  return {
    key: `${principal}/${stack}/${agent_id}`,
    principal,
    stack,
    origin: { principal, stack },
    ...base(agent_id),
  };
}

describe("subtreeHighlightSet (#1068)", () => {
  it("returns exactly the hub + its agents + its edges (local hub)", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      tile({ agent_id: "echo" }),
    ]);
    const set = subtreeHighlightSet(g, STACK_HUB_NODE_ID);
    // hub + 2 agent ids + 2 edge ids = 5
    expect(set.has(STACK_HUB_NODE_ID)).toBe(true);
    expect(set.has("andreas/research/luna")).toBe(true);
    expect(set.has("andreas/research/echo")).toBe(true);
    expect(set.has("hub-andreas/research/luna")).toBe(true);
    expect(set.has("hub-andreas/research/echo")).toBe(true);
    expect(set.size).toBe(5);
  });

  it("a foreign hub lights ONLY its own subtree, not other stacks'", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }), // local
      siblingTile("echo", "work"), // andreas/work
      foreignTile("sage", "jc", "research"), // jc/research
    ]);
    const foreignHubId = `${FOREIGN_HUB_ID_PREFIX}jc/research`;
    const set = subtreeHighlightSet(g, foreignHubId);

    // The foreign hub + its one agent + its one edge.
    expect(set.has(foreignHubId)).toBe(true);
    expect(set.has("jc/research/sage")).toBe(true);
    expect(set.has("hub-jc/research/sage")).toBe(true);
    expect(set.size).toBe(3);

    // NOTHING from the local or sibling stacks leaks in.
    expect(set.has(STACK_HUB_NODE_ID)).toBe(false);
    expect(set.has("andreas/research/luna")).toBe(false);
    expect(set.has("andreas/work/echo")).toBe(false);
    expect(set.has(`${FOREIGN_HUB_ID_PREFIX}andreas/work`)).toBe(false);
  });

  it("a hub with no agents lights only itself", () => {
    // No graph has a childless hub in practice (the adapter only synthesises a
    // hub when an agent groups under it), so assert the helper's defensiveness
    // directly against a hand-built single-node graph.
    const set = subtreeHighlightSet(
      { nodes: [{ id: "h", type: "stackHub", position: { x: 0, y: 0 }, data: {} as never }], edges: [] },
      "h",
    );
    expect([...set]).toEqual(["h"]);
  });

  it("an unknown / non-existent id lights nothing", () => {
    const g = buildNetworkGraph([tile({ agent_id: "luna" })]);
    expect(subtreeHighlightSet(g, "no-such-hub").size).toBe(0);
  });
});

describe("toggleHubSelection (#1068)", () => {
  const g = buildNetworkGraph([
    tile({ agent_id: "luna" }),
    foreignTile("sage", "jc", "research"),
  ]);
  const foreignHubId = `${FOREIGN_HUB_ID_PREFIX}jc/research`;

  it("selects a fresh hub + computes its highlight set", () => {
    const next = toggleHubSelection(EMPTY_SUBTREE_SELECTION, STACK_HUB_NODE_ID, g);
    expect(next.selectedHubId).toBe(STACK_HUB_NODE_ID);
    expect(hasSubtreeSelection(next)).toBe(true);
    expect(isInSubtreeHighlight(next, "andreas/research/luna")).toBe(true);
    expect(isInSubtreeHighlight(next, "jc/research/sage")).toBe(false);
  });

  it("re-clicking the SAME hub clears the selection", () => {
    const selected = toggleHubSelection(EMPTY_SUBTREE_SELECTION, STACK_HUB_NODE_ID, g);
    const cleared = toggleHubSelection(selected, STACK_HUB_NODE_ID, g);
    expect(cleared.selectedHubId).toBeNull();
    expect(cleared.highlightIds.size).toBe(0);
    expect(hasSubtreeSelection(cleared)).toBe(false);
  });

  it("#1070 regression — toggling the SAME hub TWICE in one click cancels to EMPTY", () => {
    // The shipped-but-inert bug: a hub click fired the toggle from BOTH the hub
    // card's own `onClick` AND React Flow's bubbling `onNodeClick`, so the
    // selection went EMPTY → selected → EMPTY within one event tick and the
    // highlight never stuck. This pins WHY exactly ONE handler may toggle: a
    // double application of the same-id toggle is a no-op. The fix removes the
    // second (onNodeClick) toggle so a single click lands on `selected`.
    const once = toggleHubSelection(EMPTY_SUBTREE_SELECTION, STACK_HUB_NODE_ID, g);
    const twice = toggleHubSelection(once, STACK_HUB_NODE_ID, g);
    expect(once.selectedHubId).toBe(STACK_HUB_NODE_ID); // single click → selected
    expect(hasSubtreeSelection(once)).toBe(true);
    expect(twice.selectedHubId).toBeNull(); // double toggle → back to nothing
    expect(hasSubtreeSelection(twice)).toBe(false);
    expect(twice).toEqual(EMPTY_SUBTREE_SELECTION);
  });

  it("clicking a DIFFERENT hub switches the selection", () => {
    const first = toggleHubSelection(EMPTY_SUBTREE_SELECTION, STACK_HUB_NODE_ID, g);
    const second = toggleHubSelection(first, foreignHubId, g);
    expect(second.selectedHubId).toBe(foreignHubId);
    expect(isInSubtreeHighlight(second, "jc/research/sage")).toBe(true);
    expect(isInSubtreeHighlight(second, "andreas/research/luna")).toBe(false);
  });

  it("a null click (empty canvas) clears the selection", () => {
    const selected = toggleHubSelection(EMPTY_SUBTREE_SELECTION, STACK_HUB_NODE_ID, g);
    const cleared = toggleHubSelection(selected, null, g);
    expect(cleared).toEqual(EMPTY_SUBTREE_SELECTION);
  });

  it("the resting selection highlights nothing + reports no active selection", () => {
    expect(hasSubtreeSelection(EMPTY_SUBTREE_SELECTION)).toBe(false);
    expect(isInSubtreeHighlight(EMPTY_SUBTREE_SELECTION, STACK_HUB_NODE_ID)).toBe(false);
  });
});
