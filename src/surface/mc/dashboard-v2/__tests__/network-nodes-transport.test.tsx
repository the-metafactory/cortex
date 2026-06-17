/**
 * P-14 U2.3 (#935) — transport-overlay node render tests.
 *
 * The pure card inners (`StackHubCard`, `AgentNodeCard`) render under
 * `renderToStaticMarkup` (no xyflow provider). Asserts the verdict badge appears
 * on a hub carrying `transportVerdict` (with the right severity class + label),
 * leaf liveness/RTT appears on an agent carrying `transportLeaf`, and BOTH are
 * absent when the overlay fields are undefined (overlay off / unobserved stack).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AgentNodeCard, StackHubCard } from "../components/network-nodes";
import type { AgentNodeData, StackHubNodeData } from "../lib/network-graph-adapter";

function hub(over: Partial<StackHubNodeData> = {}): StackHubNodeData {
  return {
    kind: "stack-hub",
    origin: "local",
    servingPrincipal: "andreas",
    principal: "andreas",
    stack: "research",
    agentCount: 2,
    stackColor: "#5b8cd4",
    ...over,
  };
}

function agent(over: Partial<AgentNodeData> = {}): AgentNodeData {
  return {
    kind: "agent",
    key: "andreas/research/luna",
    origin: "local",
    servingPrincipal: "andreas",
    agentId: "luna",
    assistantName: "Luna",
    capabilities: [],
    state: "online",
    offlineReason: null,
    lastHeartbeatAt: null,
    stackColor: "#5b8cd4",
    ...over,
  };
}

const renderHub = (d: StackHubNodeData) => renderToStaticMarkup(createElement(StackHubCard, { data: d }));
const renderAgent = (d: AgentNodeData) =>
  renderToStaticMarkup(createElement(AgentNodeCard, { data: d, now: Date.now() }));

describe("StackHubCard — verdict badge (U2.3)", () => {
  it("renders NO verdict badge when the overlay is off (undefined verdict)", () => {
    const html = renderHub(hub());
    expect(html).not.toContain("network-verdict-badge");
    expect(html).not.toContain("data-transport-verdict");
  });

  it("renders a connected badge (ok severity) when signal reports connected", () => {
    const html = renderHub(hub({ transportVerdict: "connected" }));
    expect(html).toContain("network-verdict-connected");
    expect(html).toContain('data-verdict="connected"');
    expect(html).toContain('data-severity="ok"');
    expect(html).toContain('data-transport-verdict="connected"');
    expect(html).toContain("connected");
  });

  it("renders a registered-absent badge (warn severity)", () => {
    const html = renderHub(hub({ transportVerdict: "registered-absent" }));
    expect(html).toContain("network-verdict-registered-absent");
    expect(html).toContain('data-severity="warn"');
  });

  it("renders an unregistered-present badge (alert severity, the anomaly)", () => {
    const html = renderHub(hub({ transportVerdict: "unregistered-present" }));
    expect(html).toContain("network-verdict-unregistered-present");
    expect(html).toContain('data-severity="alert"');
  });
});

describe("AgentNodeCard — leaf liveness/RTT (U2.3)", () => {
  it("renders NO leaf row when the overlay is off (undefined transportLeaf)", () => {
    const html = renderAgent(agent());
    expect(html).not.toContain("network-node-leaf");
  });

  it("renders a live leaf with RTT when signal reports it present", () => {
    const html = renderAgent(agent({ transportLeaf: { present: true, rttMs: 8.4 } }));
    expect(html).toContain("network-node-leaf-present");
    expect(html).toContain('data-leaf-present="true"');
    expect(html).toContain("leaf 8.4ms");
  });

  it("renders 'no leaf' for an absent leaf (registered-absent peer)", () => {
    const html = renderAgent(agent({ transportLeaf: { present: false, rttMs: null } }));
    expect(html).toContain("network-node-leaf-absent");
    expect(html).toContain('data-leaf-present="false"');
    expect(html).toContain("no leaf");
  });

  it("shows a — RTT when the leaf is present but RTT unreported", () => {
    const html = renderAgent(agent({ transportLeaf: { present: true, rttMs: null } }));
    expect(html).toContain("network-node-leaf-present");
    expect(html).toContain("leaf —");
  });
});
