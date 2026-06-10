/**
 * G-1114.D.4 — Network detail-panel selection-logic tests.
 *
 * Covers the pure selection helpers extracted into `lib/network-detail-display.ts`
 * (the panel's component render is covered separately in
 * `network-detail-panel.test.tsx` via `renderToStaticMarkup`). These assert the
 * load-bearing select / deselect / auto-close-on-disappear behaviour AND the
 * lifecycle-only dispatch join — without a DOM.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveSelectedAgent,
  selectAgentDispatchActivity,
  agentKeyFromClickedNode,
} from "../lib/network-detail-display";
import type { AgentPresenceTile } from "../hooks/use-agents";
import type { WorkingAgentTile } from "../hooks/use-working-agents";

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

function workingTile(
  over: Partial<WorkingAgentTile> & { agent_id: string },
): WorkingAgentTile {
  return {
    agent_name: over.agent_id,
    agent_type: "head",
    primary_state_rank: 1,
    primary_state: "running",
    primary_assignment: {
      id: "assign-1",
      task_id: "task-1",
      task_title: "Build the thing",
      task_priority: 1,
      updated_at: "2026-06-11T00:00:00.000Z",
    },
    additional_active_count: 0,
    ...over,
  };
}

describe("resolveSelectedAgent (G-1114.D.4)", () => {
  const agents = [
    tile({ agent_id: "luna", assistant_name: "Luna" }),
    tile({ agent_id: "echo", assistant_name: "Echo" }),
  ];

  it("returns null when nothing is selected", () => {
    expect(resolveSelectedAgent(agents, null)).toBeNull();
  });

  it("returns the live tile for a selected, present agent", () => {
    const got = resolveSelectedAgent(agents, "andreas/research/luna");
    expect(got).not.toBeNull();
    expect(got!.agent_id).toBe("luna");
    expect(got!.assistant_name).toBe("Luna");
  });

  it("reads the LIVE tile, not a stale copy (presence update reflected)", () => {
    // The selected agent went offline in the latest snapshot — resolving against
    // the new snapshot returns the offline tile, so the panel reflects it live.
    const refreshed = [
      tile({
        agent_id: "luna",
        assistant_name: "Luna",
        state: "offline",
        offline_reason: "ttl_lapse",
      }),
      tile({ agent_id: "echo", assistant_name: "Echo" }),
    ];
    const got = resolveSelectedAgent(refreshed, "andreas/research/luna");
    expect(got!.state).toBe("offline");
    expect(got!.offline_reason).toBe("ttl_lapse");
  });

  it("auto-closes (returns null) when the selected agent disappears from the snapshot", () => {
    const shrunk = [tile({ agent_id: "echo", assistant_name: "Echo" })];
    expect(resolveSelectedAgent(shrunk, "andreas/research/luna")).toBeNull();
  });

  it("returns null for a key that was never in the snapshot", () => {
    expect(resolveSelectedAgent(agents, "andreas/research/ghost")).toBeNull();
  });

  it("returns null against an empty snapshot", () => {
    expect(resolveSelectedAgent([], "andreas/research/luna")).toBeNull();
  });
});

describe("agentKeyFromClickedNode (G-1114.D.4)", () => {
  it("returns the agent key for an agent node", () => {
    expect(
      agentKeyFromClickedNode({ type: "agent", id: "andreas/research/luna" }),
    ).toBe("andreas/research/luna");
  });

  it("returns null for the stack-hub node (hub click deselects, no agent panel)", () => {
    expect(
      agentKeyFromClickedNode({ type: "stackHub", id: "__stack__" }),
    ).toBeNull();
  });
});

describe("selectAgentDispatchActivity (G-1114.D.4)", () => {
  it("returns null when the agent has no active working-grid tile (idle)", () => {
    expect(selectAgentDispatchActivity([], "luna")).toBeNull();
  });

  it("projects ONLY lifecycle metadata for an actively-dispatched agent", () => {
    const activity = selectAgentDispatchActivity(
      [
        workingTile({
          agent_id: "luna",
          primary_state: "running",
          additional_active_count: 2,
        }),
      ],
      "luna",
    );
    expect(activity).not.toBeNull();
    expect(activity!.primaryState).toBe("running");
    expect(activity!.taskTitle).toBe("Build the thing");
    expect(activity!.taskPriority).toBe(1);
    expect(activity!.additionalActiveCount).toBe(2);
    expect(activity!.updatedAt).toBe("2026-06-11T00:00:00.000Z");
  });

  it("matches by agent_id, ignoring other agents' tiles", () => {
    const activity = selectAgentDispatchActivity(
      [
        workingTile({ agent_id: "echo" }),
        workingTile({
          agent_id: "luna",
          primary_assignment: {
            id: "a2",
            task_id: "t2",
            task_title: "Luna's task",
            task_priority: 0,
            updated_at: "2026-06-11T01:00:00.000Z",
          },
        }),
      ],
      "luna",
    );
    expect(activity!.taskTitle).toBe("Luna's task");
    expect(activity!.taskPriority).toBe(0);
  });

  it("carries no session-interior fields — only the lifecycle projection keys", () => {
    const activity = selectAgentDispatchActivity(
      [workingTile({ agent_id: "luna" })],
      "luna",
    );
    // The ADR-0007 boundary: the activity shape has EXACTLY the lifecycle keys,
    // no prompt / tool-call / diff / transcript surface.
    expect(Object.keys(activity!).sort()).toEqual(
      [
        "additionalActiveCount",
        "primaryState",
        "taskPriority",
        "taskTitle",
        "updatedAt",
      ].sort(),
    );
  });
});
