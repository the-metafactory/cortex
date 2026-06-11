/**
 * ST-P4 — unit tests for the PURE session-tree assembler
 * (`lib/session-tree.ts`). Pins the flat→tree fold, multi-level nesting, the
 * orphaned-parent→root rule, the cycle guard (self-edge + multi-node loop), and
 * the empty case. No DB — the function is pure.
 */

import { describe, it, expect } from "bun:test";
import {
  assembleSessionTree,
  type FlatSessionRow,
  type SessionTreeNode,
} from "../lib/session-tree";

function row(
  session_id: string,
  parent_session_id: string | null,
  extra: Partial<FlatSessionRow> = {}
): FlatSessionRow {
  return {
    session_id,
    parent_session_id,
    substrate: "claude-code",
    state: "running",
    started_at: "2026-06-11T00:00:00.000Z",
    ended_at: null,
    agent_name: "luna",
    task_title: "t",
    ...extra,
  };
}

/** Collect session_ids in a stable pre-order walk for order assertions. */
function ids(nodes: SessionTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: SessionTreeNode[]) => {
    for (const n of ns) {
      out.push(n.session_id);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

describe("assembleSessionTree", () => {
  it("returns [] for an empty input", () => {
    expect(assembleSessionTree([])).toEqual([]);
  });

  it("returns a single agent-rooted session as one root with no children", () => {
    const tree = assembleSessionTree([row("s1", null)]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.session_id).toBe("s1");
    expect(tree[0]!.parent_session_id).toBeNull();
    expect(tree[0]!.children).toEqual([]);
  });

  it("nests a child under its in-set parent (flat → tree)", () => {
    const tree = assembleSessionTree([row("parent", null), row("child", "parent")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.session_id).toBe("parent");
    expect(tree[0]!.children.map((c) => c.session_id)).toEqual(["child"]);
  });

  it("assembles multi-level nesting (root → child → grandchild)", () => {
    const tree = assembleSessionTree([
      row("root", null),
      row("child", "root"),
      row("grandchild", "child"),
    ]);
    expect(tree).toHaveLength(1);
    expect(ids(tree)).toEqual(["root", "child", "grandchild"]);
    const child = tree[0]!.children[0]!;
    expect(child.session_id).toBe("child");
    expect(child.children.map((c) => c.session_id)).toEqual(["grandchild"]);
  });

  it("treats a row with an out-of-set parent as a ROOT (orphaned parent → root, never dropped)", () => {
    // `child`'s parent `gone` is not in the list (terminal/pruned/other agent).
    const tree = assembleSessionTree([row("child", "gone"), row("sibling", null)]);
    expect(tree).toHaveLength(2);
    const byId = new Map(tree.map((n) => [n.session_id, n]));
    expect(byId.has("child")).toBe(true);
    expect(byId.has("sibling")).toBe(true);
    // The orphaned child still renders (as a root) — it keeps its original
    // parent_session_id for provenance but stands at the forest root.
    expect(byId.get("child")!.parent_session_id).toBe("gone");
  });

  it("preserves input order for roots and for children", () => {
    const tree = assembleSessionTree([
      row("r1", null),
      row("r2", null),
      row("c-b", "r1"),
      row("c-a", "r1"),
    ]);
    expect(tree.map((n) => n.session_id)).toEqual(["r1", "r2"]);
    expect(tree[0]!.children.map((n) => n.session_id)).toEqual(["c-b", "c-a"]);
  });

  it("is cycle-safe for a self-edge (parent === self) — node becomes a root, no hang", () => {
    const tree = assembleSessionTree([row("loner", "loner")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.session_id).toBe("loner");
    // Self-edge severed for rendering.
    expect(tree[0]!.children).toEqual([]);
  });

  it("is cycle-safe for a 2-node loop (a→b→a) — both surface, no infinite recursion", () => {
    const tree = assembleSessionTree([row("a", "b"), row("b", "a")]);
    // Neither is naturally a root; the cycle guard re-promotes one so BOTH
    // sessions still render and the walk terminates.
    const flatIds = new Set(ids(tree));
    expect(flatIds.has("a")).toBe(true);
    expect(flatIds.has("b")).toBe(true);
    expect(ids(tree).length).toBe(2); // each appears exactly once
  });

  it("carries lifecycle metadata through (no interiors) — state, substrate, timestamps, labels", () => {
    const tree = assembleSessionTree([
      row("s", null, {
        substrate: "codex",
        state: "dispatched",
        started_at: "2026-06-11T01:02:03.000Z",
        ended_at: "2026-06-11T01:05:00.000Z",
        agent_name: "andreas",
        task_title: "review PR",
      }),
    ]);
    const n = tree[0]!;
    expect(n.substrate).toBe("codex");
    expect(n.state).toBe("dispatched");
    expect(n.started_at).toBe("2026-06-11T01:02:03.000Z");
    expect(n.ended_at).toBe("2026-06-11T01:05:00.000Z");
    expect(n.agent_name).toBe("andreas");
    expect(n.task_title).toBe("review PR");
  });
});
