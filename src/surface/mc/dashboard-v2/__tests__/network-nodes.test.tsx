/**
 * G-1114.D.1 — custom node render tests.
 *
 * Targets the PURE presentational inners (`AgentNodeCard`, `StackHubCard`) +
 * the Legend — the parts that render without xyflow's zustand provider, so they
 * work under `renderToStaticMarkup` (the test env has no DOM). The handle-adding
 * wrappers (`AgentNode`/`StackHubNode`) are exercised by the canvas at runtime,
 * not here (they require the provider — covered by the build gate + the manual
 * dashboard rebuild).
 *
 * These re-cover the C.4 panel's presence rendering (online / offline / TTL-lapse
 * / capability chips) on the new node card, since the graph replaced the panel.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  AgentNodeCard,
  StackHubCard,
} from "../components/network-nodes";
import { NetworkLegend } from "../components/network-legend";
import type {
  AgentNodeData,
  StackHubNodeData,
} from "../lib/network-graph-adapter";

function agentData(over: Partial<AgentNodeData> = {}): AgentNodeData {
  return {
    kind: "agent",
    key: "andreas/research/luna",
    origin: "local",
    agentId: "luna",
    assistantName: "Luna",
    capabilities: [],
    state: "online",
    offlineReason: null,
    lastHeartbeatAt: null,
    ...over,
  };
}

function renderAgent(data: AgentNodeData, now = Date.now()): string {
  return renderToStaticMarkup(createElement(AgentNodeCard, { data, now }));
}

describe("AgentNodeCard (G-1114.D.1)", () => {
  it("renders an online agent with name, id, capabilities, and state", () => {
    const html = renderAgent(
      agentData({
        capabilities: ["review.code", "review.design"],
        state: "online",
        lastHeartbeatAt: Date.now(),
      }),
    );
    expect(html).toContain("Luna");
    expect(html).toContain("luna");
    expect(html).toContain("review.code");
    expect(html).toContain("review.design");
    expect(html).toContain("online");
    expect(html).toContain('data-agent-id="luna"');
    expect(html).toContain('data-state="online"');
    expect(html).toContain('data-node-kind="agent"');
  });

  it("falls back to agentId when assistantName is null", () => {
    const html = renderAgent(agentData({ assistantName: null, agentId: "echo" }));
    expect(html).toContain("echo");
  });

  it("renders each capability as a distinct chip, not a comma blob", () => {
    const html = renderAgent(
      agentData({ capabilities: ["review.code", "review.design", "moderate"] }),
    );
    const chips = (html.match(/network-node-cap"/g) ?? []).length;
    expect(chips).toBe(3);
    expect(html).not.toContain("review.code, review.design");
  });

  it("renders the no-capabilities placeholder", () => {
    const html = renderAgent(agentData({ capabilities: [] }));
    expect(html).toContain("no capabilities declared");
    expect(html).toContain("network-node-cap-none");
  });

  it("renders a TTL-lapsed agent as 'no heartbeat' / 'last seen' with the warning treatment", () => {
    const now = Date.now();
    const html = renderAgent(
      agentData({
        agentId: "sage",
        assistantName: "Sage",
        state: "offline",
        offlineReason: "ttl_lapse",
        lastHeartbeatAt: now - 6 * 60_000,
      }),
      now,
    );
    expect(html).toContain('data-state="offline"');
    expect(html).toContain('data-offline-reason="ttl_lapse"');
    expect(html).toContain("network-node-ttl-lapse");
    expect(html).toContain("no heartbeat");
    expect(html).toContain("last seen");
    expect(html).toContain("network-node-reason-ttl-lapse");
  });

  it("renders a graceful shutdown distinctly from a TTL lapse", () => {
    const html = renderAgent(
      agentData({
        agentId: "echo",
        state: "offline",
        offlineReason: "shutdown",
      }),
    );
    expect(html).toContain('data-state="offline"');
    expect(html).toContain("shut down");
    expect(html).not.toContain("network-node-ttl-lapse");
    expect(html).not.toContain("no heartbeat");
    expect(html).not.toContain("last seen");
  });

  it("does not render an offline reason for an online agent", () => {
    const html = renderAgent(
      agentData({ state: "online", lastHeartbeatAt: Date.now() }),
    );
    expect(html).not.toContain("network-node-reason");
    expect(html).not.toContain("last seen");
  });
});

describe("StackHubCard (G-1114.D.1)", () => {
  function renderHub(data: StackHubNodeData): string {
    return renderToStaticMarkup(createElement(StackHubCard, { data }));
  }

  it("renders the principal/stack label and agent count", () => {
    const html = renderHub({
      kind: "stack-hub",
      origin: "local",
      principal: "andreas",
      stack: "research",
      agentCount: 3,
    });
    expect(html).toContain("andreas/research");
    expect(html).toContain("3 agents");
    expect(html).toContain('data-node-kind="stack-hub"');
  });

  it("singularises the agent count for a single agent", () => {
    const html = renderHub({
      kind: "stack-hub",
      origin: "local",
      principal: "andreas",
      stack: "research",
      agentCount: 1,
    });
    expect(html).toContain("1 agent");
    expect(html).not.toContain("1 agents");
  });

  it("degrades to a 'stack' label when principal/stack are unknown", () => {
    const html = renderHub({
      kind: "stack-hub",
      origin: "local",
      principal: null,
      stack: null,
      agentCount: 0,
    });
    expect(html).toContain("stack");
  });

  it("marks the LOCAL hub distinctly from a federated hub (E.4)", () => {
    const html = renderHub({
      kind: "stack-hub",
      origin: "local",
      principal: "andreas",
      stack: "research",
      agentCount: 2,
    });
    expect(html).toContain('data-hub-origin="local"');
    expect(html).toContain("network-node-hub-local");
    expect(html).not.toContain("network-node-hub-foreign");
    // a local hub's eyebrow is plain "stack", not "federated stack"
    expect(html).not.toContain("federated stack");
  });

  it("renders a FOREIGN hub with the federated eyebrow + distinct treatment (E.4)", () => {
    const html = renderHub({
      kind: "stack-hub",
      origin: { principal: "jc", stack: "research" },
      principal: "jc",
      stack: "research",
      agentCount: 1,
    });
    expect(html).toContain('data-hub-origin="foreign"');
    expect(html).toContain("network-node-hub-foreign");
    expect(html).toContain("federated stack");
    expect(html).toContain("jc/research");
  });
});

describe("AgentNodeCard — federated provenance (G-1114.E.4)", () => {
  it("renders a local agent with no provenance badge + a local origin marker", () => {
    const html = renderAgent(agentData({ origin: "local" }));
    expect(html).toContain('data-agent-origin="local"');
    expect(html).not.toContain("network-node-foreign");
    expect(html).not.toContain("network-node-provenance");
  });

  it("renders a FOREIGN agent distinctly with a `{principal}/{stack}` provenance badge", () => {
    const html = renderAgent(
      agentData({
        key: "jc/research/sage",
        agentId: "sage",
        assistantName: "Sage",
        origin: { principal: "jc", stack: "research" },
      }),
    );
    expect(html).toContain('data-agent-origin="foreign"');
    expect(html).toContain("network-node-foreign");
    expect(html).toContain("network-node-provenance");
    expect(html).toContain("jc/research");
    // accessible label names it a federated peer
    expect(html).toContain("federated peer jc/research");
  });
});

describe("NetworkLegend (G-1114.D.1)", () => {
  it("renders the online / offline / no-heartbeat key", () => {
    const html = renderToStaticMarkup(createElement(NetworkLegend));
    expect(html).toContain("online");
    expect(html).toContain("offline");
    expect(html).toContain("no heartbeat");
    expect(html).toContain("swatch-online");
    expect(html).toContain("swatch-offline");
    expect(html).toContain("swatch-ttl-lapse");
  });
});

describe("AgentNodeCard — F.2 hover highlight", () => {
  it("is unlit by default (no highlighted class / data attr)", () => {
    const html = renderAgent(agentData({ capabilities: ["review.code"] }));
    expect(html).not.toContain("network-node-highlighted");
    expect(html).not.toContain('data-highlighted');
  });

  it("renders the highlighted treatment when `highlighted` is set", () => {
    const html = renderToStaticMarkup(
      createElement(AgentNodeCard, {
        data: agentData({ capabilities: ["review.code"] }),
        highlighted: true,
      }),
    );
    expect(html).toContain("network-node-highlighted");
    expect(html).toContain('data-highlighted="true"');
  });

  it("marks each capability with data-capability for hover targeting", () => {
    const html = renderAgent(
      agentData({ capabilities: ["review.code", "design"] }),
    );
    expect(html).toContain('data-capability="review.code"');
    expect(html).toContain('data-capability="design"');
  });

  it("lights only the capability in highlightedCapabilities", () => {
    const html = renderToStaticMarkup(
      createElement(AgentNodeCard, {
        data: agentData({ capabilities: ["review.code", "design"] }),
        highlightedCapabilities: new Set(["review.code"]),
      }),
    );
    const lit = (html.match(/network-node-cap-highlighted/g) ?? []).length;
    expect(lit).toBe(1);
  });
});
