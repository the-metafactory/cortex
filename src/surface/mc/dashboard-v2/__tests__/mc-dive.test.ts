/**
 * CK-1 (cortex#1289) — constellation-click → altitude-coordinate mapping tests.
 *
 * Pins the two derivations the rest of CK-1 leans on:
 *   - the SOVEREIGNTY bit (own-local vs federated) is derived with the SAME
 *     `classifyOrigin` the node cards use — self + same-principal sibling are
 *     own-local (`federated:false`), a cross-principal peer is `federated:true`;
 *   - a selected local assistant's session tree flattens to rail SESSION targets
 *     (children included), keyed off the working projection — never fabricated.
 */

import { describe, it, expect } from "bun:test";
import type { AgentPresenceTile, AgentOrigin } from "../hooks/use-agents";
import type { WorkingAgentTile } from "../hooks/use-working-agents";
import type { StackHubNodeData } from "../lib/network-graph-adapter";
import {
  isFederatedOrigin,
  stackCoordFromHub,
  stackCoordFromTile,
  sessionTargetsForAssistant,
} from "../lib/mc-dive";

function hub(over: Partial<StackHubNodeData> & { origin: AgentOrigin }): StackHubNodeData {
  return {
    kind: "stack-hub",
    servingPrincipal: "andreas",
    principal: "andreas",
    stack: "meta-factory",
    agentCount: 1,
    stackColor: "#fff",
    ...over,
  };
}

function tile(over: Partial<AgentPresenceTile> & { origin: AgentOrigin }): AgentPresenceTile {
  return {
    key: "andreas/meta-factory/luna",
    agent_id: "luna",
    assistant_name: "Luna",
    nkey_public_key: "NKEYPUB",
    principal: "andreas",
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

function workingTile(over: Partial<WorkingAgentTile> & { agent_id: string }): WorkingAgentTile {
  return {
    agent_name: over.agent_id,
    agent_type: "head",
    primary_state_rank: 1,
    primary_state: "running",
    primary_assignment: {
      id: "a1",
      task_id: "t1",
      task_title: "primary",
      task_priority: 1,
      updated_at: "2026-07-08T00:00:00Z",
    },
    additional_active_count: 0,
    sessions: [],
    ...over,
  };
}

describe("mc-dive — sovereignty classification (isFederatedOrigin)", () => {
  it("a local origin is own-local (never federated)", () => {
    expect(isFederatedOrigin("local", "andreas")).toBe(false);
  });

  it("a same-principal sibling is own-local (DB-read aggregation, not federation)", () => {
    expect(isFederatedOrigin({ principal: "andreas", stack: "work" }, "andreas")).toBe(
      false,
    );
  });

  it("a cross-principal peer is federated", () => {
    expect(isFederatedOrigin({ principal: "jc", stack: "research" }, "andreas")).toBe(
      true,
    );
  });

  it("conservatively federated when the serving principal is unknown", () => {
    expect(isFederatedOrigin({ principal: "jc", stack: "research" }, null)).toBe(true);
  });
});

describe("mc-dive — stackCoordFromHub", () => {
  it("maps a LOCAL hub to an own-local coordinate", () => {
    expect(stackCoordFromHub(hub({ origin: "local" }), "andreas")).toEqual({
      principal: "andreas",
      stack: "meta-factory",
      federated: false,
    });
  });

  it("maps a same-principal sibling hub to own-local", () => {
    const data = hub({
      origin: { principal: "andreas", stack: "work" },
      principal: "andreas",
      stack: "work",
    });
    expect(stackCoordFromHub(data, "andreas")).toEqual({
      principal: "andreas",
      stack: "work",
      federated: false,
    });
  });

  it("maps a FOREIGN peer hub to a federated coordinate", () => {
    const data = hub({
      origin: { principal: "jc", stack: "research" },
      principal: "jc",
      stack: "research",
    });
    expect(stackCoordFromHub(data, "andreas")).toEqual({
      principal: "jc",
      stack: "research",
      federated: true,
    });
  });

  it("returns null when the hub has no resolvable principal/stack", () => {
    expect(
      stackCoordFromHub(hub({ origin: "local", principal: null, stack: null }), "andreas"),
    ).toBeNull();
  });
});

describe("mc-dive — stackCoordFromTile", () => {
  it("maps a LOCAL agent tile to its own stack (own-local)", () => {
    expect(stackCoordFromTile(tile({ origin: "local" }), "andreas")).toEqual({
      principal: "andreas",
      stack: "meta-factory",
      federated: false,
    });
  });

  it("maps a FOREIGN agent tile to the verified peer stack (federated)", () => {
    const t = tile({
      key: "jc/research/atlas",
      agent_id: "atlas",
      principal: "jc",
      stack: "research",
      origin: { principal: "jc", stack: "research" },
    });
    expect(stackCoordFromTile(t, "andreas")).toEqual({
      principal: "jc",
      stack: "research",
      federated: true,
    });
  });
});

describe("mc-dive — sessionTargetsForAssistant", () => {
  const localCoord = { principal: "andreas", stack: "meta-factory", federated: false };

  it("flattens the session tree (children included), labelling by task_title then id", () => {
    const w = workingTile({
      agent_id: "luna",
      sessions: [
        {
          session_id: "s1",
          parent_session_id: null,
          substrate: "claude-code",
          state: "running",
          started_at: "2026-07-08T00:00:00Z",
          ended_at: null,
          task_title: "root task",
          children: [
            {
              session_id: "s2",
              parent_session_id: "s1",
              substrate: "claude-code",
              state: "running",
              started_at: "2026-07-08T00:01:00Z",
              ended_at: null,
              task_title: null,
              children: [],
            },
          ],
        },
      ],
    });
    expect(sessionTargetsForAssistant([w], "luna", localCoord)).toEqual([
      { id: "s1", label: "root task" },
      { id: "s2", label: "s2" },
    ]);
  });

  it("is empty when the assistant has no working tile", () => {
    expect(sessionTargetsForAssistant([], "luna", localCoord)).toEqual([]);
  });

  it("matches a sibling-tagged tile only when the stack matches exactly", () => {
    const wRight = workingTile({
      agent_id: "luna",
      origin: { principal: "andreas", stack: "work" },
      sessions: [
        {
          session_id: "sx",
          parent_session_id: null,
          substrate: "claude-code",
          state: "running",
          started_at: "2026-07-08T00:00:00Z",
          ended_at: null,
          task_title: "sibling work",
          children: [],
        },
      ],
    });
    const siblingCoord = { principal: "andreas", stack: "work", federated: false };
    expect(sessionTargetsForAssistant([wRight], "luna", siblingCoord)).toEqual([
      { id: "sx", label: "sibling work" },
    ]);
    // A different stack coordinate must NOT pick up the sibling's sessions.
    expect(sessionTargetsForAssistant([wRight], "luna", localCoord)).toEqual([]);
  });
});
