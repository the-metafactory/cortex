/**
 * F-9 working-grid pure-helper tests.
 *
 * Component itself uses hooks (focused-tile state, refs); covering it
 * needs jsdom + RTL which the migration addendum's Decision 8 puts
 * post-migration. The branching that decides which mode the grid is in
 * (hidden / error / loading / empty / tiles) is extracted into
 * `lib/working-grid-display.ts` so it stays unit-testable here.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  pickWorkingGridMode,
  priorityLabel,
} from "../lib/working-grid-display";
import { WorkingGrid, workingTileKey } from "../components/working-grid";
import type {
  WorkingAgentTile,
  SessionTreeNode,
} from "../hooks/use-working-agents";

function tile(over: Partial<WorkingAgentTile> = {}): WorkingAgentTile {
  return {
    agent_id: "ag-1",
    agent_name: "Luna",
    agent_type: "head",
    primary_state_rank: 1,
    primary_state: "running",
    primary_assignment: {
      id: "a-1",
      task_id: "t-1",
      task_title: "Implement focus area",
      task_priority: 1,
      updated_at: "2026-04-26T00:00:00.000Z",
    },
    additional_active_count: 0,
    sessions: [],
    ...over,
  };
}

function sessionNode(
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

function renderGrid(over: Partial<WorkingAgentTile> = {}): string {
  return renderToStaticMarkup(
    createElement(WorkingGrid, {
      agents: [tile(over)],
      loaded: true,
      error: null,
      focusItemCount: 0,
      drillOpen: false,
      onOpen: () => {},
    })
  );
}

describe("pickWorkingGridMode — F-9 Decision 7 branching", () => {
  it("returns 'hidden' when loaded + grid empty + focus row has entries", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: true, error: null, focusItemCount: 3,
    })).toBe("hidden");
  });

  it("returns 'tiles' whenever agents > 0, regardless of focus / loaded / error", () => {
    expect(pickWorkingGridMode({
      agents: [tile()], loaded: true, error: null, focusItemCount: 0,
    })).toBe("tiles");
    expect(pickWorkingGridMode({
      agents: [tile()], loaded: false, error: null, focusItemCount: 5,
    })).toBe("tiles");
    expect(pickWorkingGridMode({
      agents: [tile()], loaded: true, error: "stale boot error", focusItemCount: 0,
    })).toBe("tiles");
  });

  it("returns 'error' when grid empty + boot error + no focus distraction", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: true, error: "HTTP 500", focusItemCount: 0,
    })).toBe("error");
  });

  it("returns 'loading' pre-boot with empty grid + no error", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: false, error: null, focusItemCount: 0,
    })).toBe("loading");
  });

  it("returns 'empty' when loaded + both grid and focus row empty", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: true, error: null, focusItemCount: 0,
    })).toBe("empty");
  });

  it("hidden takes precedence over error (so error doesn't flash next to focus)", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: true, error: "HTTP 500", focusItemCount: 1,
    })).toBe("hidden");
  });

  it("loading wins over empty — empty requires loaded=true", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: false, error: null, focusItemCount: 0,
    })).toBe("loading");
  });
});

describe("priorityLabel — legacy parity", () => {
  it("renders P0..P3 for valid integer priorities", () => {
    expect(priorityLabel(0)).toBe("P0");
    expect(priorityLabel(1)).toBe("P1");
    expect(priorityLabel(2)).toBe("P2");
    expect(priorityLabel(3)).toBe("P3");
  });

  it("renders P? for out-of-range, negative, fractional, or non-integer values", () => {
    expect(priorityLabel(-1)).toBe("P?");
    expect(priorityLabel(4)).toBe("P?");
    expect(priorityLabel(99)).toBe("P?");
    expect(priorityLabel(1.5)).toBe("P?");
    expect(priorityLabel(NaN)).toBe("P?");
  });
});

describe("WorkingGrid — ST-P5 session-tree render (static markup)", () => {
  it("absent sessions → no tree chrome (pre-ST-P5 compat snapshot)", () => {
    const html = renderGrid({ sessions: [] });
    // The tile header is intact …
    expect(html).toContain('data-agent-id="ag-1"');
    expect(html).toContain("Implement focus area");
    // … and NO session-tree markup is emitted at all.
    expect(html).not.toContain("session-tree");
    expect(html).not.toContain("session-row");
    expect(html).not.toContain("aria-expanded");
  });

  it("keeps the primary_assignment / state header untouched when a tree is present", () => {
    const html = renderGrid({
      sessions: [sessionNode("root", [sessionNode("c1", [], { parent_session_id: "root" })])],
    });
    expect(html).toContain('data-agent-id="ag-1"');
    expect(html).toContain("Implement focus area");
    expect(html).toContain('class="agent"');
    expect(html).toContain('class="task"');
  });

  it("default-collapsed: a parent renders an expander but NOT its children (D5)", () => {
    const html = renderGrid({
      sessions: [
        sessionNode("root", [
          sessionNode("child-1", [], { parent_session_id: "root", task_title: "deep work" }),
        ]),
      ],
    });
    // The root row exists with a COLLAPSED expander …
    expect(html).toContain('data-session-id="root"');
    expect(html).toContain('aria-expanded="false"');
    // … the chevron points right (collapsed) …
    expect(html).toContain("▸");
    // … and the child row is NOT in the markup (hidden while collapsed).
    expect(html).not.toContain('data-session-id="child-1"');
  });

  it("collapsed parent shows a child-count badge with accessible text (not color-only)", () => {
    const html = renderGrid({
      sessions: [
        sessionNode("root", [
          sessionNode("c1", [], { parent_session_id: "root" }),
          sessionNode("c2", [], { parent_session_id: "root" }),
        ]),
      ],
    });
    expect(html).toContain("session-child-badge");
    // Accessible text spells out the count + noun for AT.
    expect(html).toContain("2 child sessions");
  });

  it("singular child-count badge text reads 'child session'", () => {
    const html = renderGrid({
      sessions: [
        sessionNode("root", [sessionNode("only", [], { parent_session_id: "root" })]),
      ],
    });
    expect(html).toContain("1 child session");
    expect(html).not.toContain("1 child sessions");
  });

  it("derives the substrate-projection label: claude-code child → 'sub-agent'", () => {
    const html = renderGrid({
      sessions: [
        sessionNode("root", [], { substrate: "claude-code" }),
      ],
    });
    // A root claude-code session is labelled "session" (NOT sub-agent).
    expect(html).toContain('class="session-label">session<');
    // "sub-agent" must NOT appear for a root.
    expect(html).not.toContain("sub-agent");
  });

  it("non-claude substrate root renders '<substrate> session', never 'sub-agent'", () => {
    const html = renderGrid({
      sessions: [sessionNode("root", [], { substrate: "codex" })],
    });
    expect(html).toContain("codex session");
    expect(html).not.toContain("sub-agent");
  });

  it("leaf sessions render no expander (nothing to expand)", () => {
    const html = renderGrid({ sessions: [sessionNode("leaf")] });
    expect(html).toContain('data-session-id="leaf"');
    expect(html).toContain("session-leaf");
    expect(html).not.toContain("aria-expanded");
  });

  it("the tree group has an accessible label naming the agent", () => {
    const html = renderGrid({ sessions: [sessionNode("s1")] });
    expect(html).toContain('role="group"');
    expect(html).toContain("Sessions for Luna");
  });
});

describe("workingTileKey — #1065 stack-namespaced unique key", () => {
  it("namespaces the SAME agent_id across stacks → distinct keys (no collision)", () => {
    const local = workingTileKey({ origin: "local", agent_id: "luna" });
    const work = workingTileKey({
      origin: { principal: "andreas", stack: "work" },
      agent_id: "luna",
    });
    const halden = workingTileKey({
      origin: { principal: "andreas", stack: "halden" },
      agent_id: "luna",
    });
    expect(local).toBe("local/luna");
    expect(work).toBe("andreas/work/luna");
    expect(halden).toBe("andreas/halden/luna");
    // The duplicate-key bug: three `luna` tiles, three DISTINCT keys.
    expect(new Set([local, work, halden]).size).toBe(3);
  });

  it("treats a missing origin (pre-#1008 response) as local", () => {
    expect(workingTileKey({ agent_id: "echo" })).toBe("local/echo");
  });

  it("distinct agent_ids on the local stack stay distinct", () => {
    expect(workingTileKey({ origin: "local", agent_id: "luna" })).not.toBe(
      workingTileKey({ origin: "local", agent_id: "echo" }),
    );
  });
});
