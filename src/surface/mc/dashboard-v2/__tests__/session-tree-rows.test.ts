/**
 * ST-P5 — tree → flat-render-rows expansion helper.
 *
 * `flattenSessionTree(forest, expanded)` walks the session forest depth-first
 * and emits ONLY the rows currently visible given the expansion Set (keyed by
 * `session_id`). Per D5 the default is COLLAPSED: a node's children appear only
 * when the node's id is in `expanded`. Each row carries:
 *   - `node`        — the SessionTreeNode
 *   - `depth`       — 0 for roots, +1 per nesting level (drives indent)
 *   - `hasChildren` — whether this node has any child sessions
 *   - `isExpanded`  — whether this node is currently expanded
 *   - `childCount`  — number of DIRECT children (for the collapsed badge)
 *
 * Pure + DOM-free so the expansion logic is unit-testable without a renderer.
 */

import { describe, it, expect } from "bun:test";
import { flattenSessionTree, toggleExpanded } from "../lib/session-tree-rows";
import type { SessionTreeNode } from "../hooks/use-working-agents";

function node(
  id: string,
  children: SessionTreeNode[] = [],
  over: Partial<SessionTreeNode> = {}
): SessionTreeNode {
  return {
    session_id: id,
    parent_session_id: null,
    substrate: "claude-code",
    state: "running",
    started_at: "2026-06-11T00:00:00.000Z",
    ended_at: null,
    agent_name: "Luna",
    task_title: `work ${id}`,
    children,
    ...over,
  };
}

describe("flattenSessionTree — D5 default-collapsed expansion", () => {
  it("empty forest → no rows", () => {
    expect(flattenSessionTree([], new Set())).toEqual([]);
  });

  it("flat roots (no children) → one row each at depth 0", () => {
    const rows = flattenSessionTree([node("a"), node("b")], new Set());
    expect(rows.map((r) => r.node.session_id)).toEqual(["a", "b"]);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
    expect(rows.every((r) => r.hasChildren === false)).toBe(true);
    expect(rows.every((r) => r.childCount === 0)).toBe(true);
  });

  it("collapsed parent hides its children (default per D5)", () => {
    const tree = [node("root", [node("child1"), node("child2")])];
    const rows = flattenSessionTree(tree, new Set()); // nothing expanded
    expect(rows.map((r) => r.node.session_id)).toEqual(["root"]);
    const root = rows[0]!;
    expect(root.hasChildren).toBe(true);
    expect(root.isExpanded).toBe(false);
    expect(root.childCount).toBe(2);
  });

  it("expanded parent reveals its direct children at depth+1", () => {
    const tree = [node("root", [node("child1"), node("child2")])];
    const rows = flattenSessionTree(tree, new Set(["root"]));
    expect(rows.map((r) => r.node.session_id)).toEqual([
      "root",
      "child1",
      "child2",
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
    expect(rows[0]!.isExpanded).toBe(true);
  });

  it("deep nesting: only expanded ancestors reveal descendants", () => {
    const tree = [
      node("root", [node("mid", [node("leaf")])]),
    ];
    // root expanded, mid collapsed → leaf stays hidden
    let rows = flattenSessionTree(tree, new Set(["root"]));
    expect(rows.map((r) => r.node.session_id)).toEqual(["root", "mid"]);
    expect(rows[1]!.hasChildren).toBe(true);
    expect(rows[1]!.isExpanded).toBe(false);

    // root + mid expanded → leaf visible at depth 2
    rows = flattenSessionTree(tree, new Set(["root", "mid"]));
    expect(rows.map((r) => r.node.session_id)).toEqual(["root", "mid", "leaf"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("expanding a leaf has no effect (no children to reveal)", () => {
    const rows = flattenSessionTree([node("a")], new Set(["a"]));
    expect(rows.map((r) => r.node.session_id)).toEqual(["a"]);
    expect(rows[0]!.hasChildren).toBe(false);
    // A leaf is never reported as expanded — there is nothing to expand.
    expect(rows[0]!.isExpanded).toBe(false);
  });

  it("preserves sibling + child input order", () => {
    const tree = [
      node("r1", [node("r1c2"), node("r1c1")]),
      node("r2"),
    ];
    const rows = flattenSessionTree(tree, new Set(["r1"]));
    expect(rows.map((r) => r.node.session_id)).toEqual([
      "r1",
      "r1c2",
      "r1c1",
      "r2",
    ]);
  });

  it("multiple expanded roots interleave correctly", () => {
    const tree = [
      node("a", [node("a1")]),
      node("b", [node("b1")]),
    ];
    const rows = flattenSessionTree(tree, new Set(["a", "b"]));
    expect(rows.map((r) => r.node.session_id)).toEqual(["a", "a1", "b", "b1"]);
  });
});

describe("toggleExpanded — immutable, copy-on-write expansion state", () => {
  it("adds an id when absent (collapsed → expanded)", () => {
    const next = toggleExpanded(new Set(), "s1");
    expect(next.has("s1")).toBe(true);
  });

  it("removes an id when present (expanded → collapsed)", () => {
    const next = toggleExpanded(new Set(["s1"]), "s1");
    expect(next.has("s1")).toBe(false);
  });

  it("returns a NEW Set (does not mutate the input — React re-render)", () => {
    const prev = new Set(["s1"]);
    const next = toggleExpanded(prev, "s2");
    expect(next).not.toBe(prev);
    expect(prev.has("s2")).toBe(false); // input untouched
    expect(next.has("s2")).toBe(true);
  });

  it("toggling preserves other ids (expansion of one row is independent)", () => {
    const next = toggleExpanded(new Set(["a", "b"]), "a");
    expect(next.has("a")).toBe(false);
    expect(next.has("b")).toBe(true);
  });
});
