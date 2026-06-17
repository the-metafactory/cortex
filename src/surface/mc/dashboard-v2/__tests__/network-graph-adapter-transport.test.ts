/**
 * P-14 U2.3 (#935) — NetworkGraphEdge transport widening tests.
 *
 * Asserts `applyTransportOverlay` folds signal's transport overlay onto a built
 * graph ADDITIVELY: stack-hub nodes gain `transportVerdict`, agent nodes gain
 * `transportLeaf` liveness/RTT, hub→agent edges gain `data.transport` — all keyed
 * by `{principal}/{stack}` and taken verbatim from the overlay (sourced from
 * signal). A stack signal didn't observe is left UNCHANGED. The base
 * `buildNetworkGraph` shape is untouched (the widening is opt-in).
 */

import { describe, it, expect } from "bun:test";
import {
  buildNetworkGraph,
  applyTransportOverlay,
  STACK_HUB_NODE_ID,
  type AgentNodeData,
  type StackHubNodeData,
} from "../lib/network-graph-adapter";
import { buildTransportOverlay } from "../lib/network-transport-overlay";
import type { TransportRosterEventRow } from "../../api/observability-tab";
import type { AgentPresenceTile } from "../hooks/use-agents";

function tile(over: Partial<AgentPresenceTile> & { agent_id: string }): AgentPresenceTile {
  const { agent_id } = over;
  return {
    key: `andreas/research/${agent_id}`,
    origin: "local",
    assistant_name: null,
    nkey_public_key: `N${agent_id.toUpperCase()}`,
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

function foreignTile(
  over: Partial<AgentPresenceTile> & { agent_id: string; principal: string; stack: string },
): AgentPresenceTile {
  const { agent_id, principal, stack } = over;
  return tile({
    ...over,
    key: `${principal}/${stack}/${agent_id}`,
    principal,
    stack,
    origin: { principal, stack },
  });
}

function driftRow(principal: string, stack: string, to: string): TransportRosterEventRow {
  return {
    id: crypto.randomUUID(),
    type: "system.transport.liveness_drift",
    stackId: "net",
    timestamp: "2026-06-12T00:00:00.000Z",
    payload: {
      action: "liveness_drift",
      network: "net",
      reason: "x",
      attributes: { peer: `${principal}/${stack}`, principal, stack, from: null, to },
    },
    // P-14 U3.3 — local origin (these are this stack's own hub fixtures).
    origin: "local",
  };
}

function connectRow(principal: string, stack: string, rtt: number): TransportRosterEventRow {
  return {
    id: crypto.randomUUID(),
    type: "system.transport.leaf_connect",
    stackId: "net",
    timestamp: "2026-06-12T00:00:00.000Z",
    payload: {
      action: "leaf_connect",
      network: "net",
      leaf: { principal, stack, network: "net", rtt_ms: rtt, frames: { in_msgs: 0, out_msgs: 0, in_bytes: 0, out_bytes: 0 } },
    },
    origin: "local",
  };
}

describe("NetworkGraphEdge — base shape unchanged without overlay (U2.3)", () => {
  it("buildNetworkGraph emits edges with NO transport field (pre-U2.3 byte-shape)", () => {
    const g = buildNetworkGraph([tile({ agent_id: "luna" })]);
    expect(g.edges.length).toBe(1);
    // #1068 — the edge carries `data.stackColor` (the per-stack hue) at build
    // time, but NO `transport` payload without the overlay.
    expect(g.edges[0]!.data?.transport).toBeUndefined();
    expect(typeof g.edges[0]!.data?.stackColor).toBe("string");
  });
});

describe("applyTransportOverlay — additive widening (U2.3)", () => {
  it("widens the LOCAL hub node with signal's verdict + the agent with leaf liveness/RTT", () => {
    const base = buildNetworkGraph([tile({ agent_id: "luna" })]);
    // andreas/research is connected @8.4ms per signal.
    const overlay = buildTransportOverlay([
      driftRow("andreas", "research", "connected"),
      connectRow("andreas", "research", 8.4),
    ]);
    const g = applyTransportOverlay(base, overlay);

    const hub = g.nodes.find((n) => n.id === STACK_HUB_NODE_ID)!;
    expect((hub.data as StackHubNodeData).transportVerdict).toBe("connected");

    const agent = g.nodes.find((n) => n.id === "andreas/research/luna")!;
    const leaf = (agent.data as AgentNodeData).transportLeaf;
    expect(leaf).toEqual({ present: true, rttMs: 8.4 });

    const edge = g.edges.find((e) => e.target === "andreas/research/luna")!;
    expect(edge.data?.transport).toEqual({ verdict: "connected", present: true, rttMs: 8.4 });
  });

  it("leaves a node/edge UNCHANGED when signal did not observe its stack", () => {
    const base = buildNetworkGraph([tile({ agent_id: "luna" })]);
    // Overlay observes a DIFFERENT stack — nothing to paint onto andreas/research.
    const overlay = buildTransportOverlay([driftRow("jc", "default", "connected")]);
    const g = applyTransportOverlay(base, overlay);

    const hub = g.nodes.find((n) => n.id === STACK_HUB_NODE_ID)!;
    expect((hub.data as StackHubNodeData).transportVerdict).toBeUndefined();
    const agent = g.nodes.find((n) => n.id === "andreas/research/luna")!;
    expect((agent.data as AgentNodeData).transportLeaf).toBeUndefined();
    // #1068 — the edge keeps its per-stack color but gains NO transport payload.
    expect(
      g.edges.find((e) => e.target === "andreas/research/luna")!.data?.transport,
    ).toBeUndefined();
  });

  it("keys a FOREIGN peer's leaf on its ORIGIN stack (not the local hub)", () => {
    const base = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      foreignTile({ agent_id: "sage", principal: "jc", stack: "default" }),
    ]);
    const overlay = buildTransportOverlay([
      driftRow("jc", "default", "unregistered-present"),
    ]);
    const g = applyTransportOverlay(base, overlay);

    // The foreign hub (jc/default) carries the anomaly verdict.
    const foreignHub = g.nodes.find(
      (n) => n.data.kind === "stack-hub" && (n.data as StackHubNodeData).stack === "default",
    )!;
    expect((foreignHub.data as StackHubNodeData).transportVerdict).toBe("unregistered-present");

    // The foreign agent's edge carries the foreign stack's verdict.
    const sageEdge = g.edges.find((e) => e.target === "jc/default/sage")!;
    expect(sageEdge.data?.transport?.verdict).toBe("unregistered-present");

    // The LOCAL hub (andreas/research) is untouched — signal didn't observe it.
    const localHub = g.nodes.find((n) => n.id === STACK_HUB_NODE_ID)!;
    expect((localHub.data as StackHubNodeData).transportVerdict).toBeUndefined();
  });

  it("an empty overlay returns the graph functionally unchanged (no transport fields)", () => {
    const base = buildNetworkGraph([tile({ agent_id: "luna" })]);
    const g = applyTransportOverlay(base, buildTransportOverlay([]));
    const hub = g.nodes.find((n) => n.id === STACK_HUB_NODE_ID)!;
    expect((hub.data as StackHubNodeData).transportVerdict).toBeUndefined();
    // #1068 — color survives; no transport payload added by an empty overlay.
    expect(g.edges[0]!.data?.transport).toBeUndefined();
  });
});
