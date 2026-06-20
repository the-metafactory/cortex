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

describe("StackHubCard — #1089 P4 signal-optional liveness enrichment", () => {
  // OQ4: a `registered-absent` verdict (registered, no live leaf) renders the
  // peer hub MUTED — render it, don't omit it: the principal wants to see WHO is
  // on the network, live or not. Muting is opacity/dim (a11y — never hue alone).
  // A foreign peer hub fixture: origin + principal/stack agree (as the adapter
  // builds them), and `servingPrincipal` stays this stack's principal so the hub
  // classifies cross-principal `foreign`.
  const peerHub = (over: Partial<StackHubNodeData> = {}): StackHubNodeData =>
    hub({ origin: { principal: "jc", stack: "research" }, principal: "jc", stack: "research", ...over });

  it("mutes the hub when signal reports registered-absent (no live leaf)", () => {
    const html = renderHub(peerHub({ transportVerdict: "registered-absent" }));
    expect(html).toContain("network-node-hub-muted");
    expect(html).toContain('data-transport-muted="true"');
    // Still rendered (not omitted) — the warn badge still names the verdict.
    expect(html).toContain("network-verdict-registered-absent");
  });

  // The `unregistered-present` anomaly (a live leaf with NO registry entry — the
  // security-relevant case, reality \ intent) is surfaced as an anomaly on the
  // hub, beyond the alert-severity badge: an explicit anomaly affordance the
  // Network view can flag distinctly.
  it("flags the hub as an anomaly when signal reports unregistered-present", () => {
    const html = renderHub(peerHub({ transportVerdict: "unregistered-present" }));
    expect(html).toContain("network-node-hub-anomaly");
    expect(html).toContain('data-transport-anomaly="true"');
    expect(html).toContain("network-verdict-unregistered-present");
  });

  // A `connected` verdict is healthy: neither muted nor flagged anomaly.
  it("neither mutes nor flags a connected hub", () => {
    const html = renderHub(hub({ transportVerdict: "connected" }));
    expect(html).not.toContain("network-node-hub-muted");
    expect(html).not.toContain("network-node-hub-anomaly");
    expect(html).not.toContain('data-transport-muted');
    expect(html).not.toContain('data-transport-anomaly');
  });

  // LOAD-BEARING (design §4 signal-optional): with signal NOT installed there is
  // no transport verdict, so a FEDERATED PEER hub must still render from cortex's
  // own federated presence — no badge, no muted/anomaly treatment, no errors.
  it("renders a federated peer with NO verdict — no badge, no mute, no anomaly", () => {
    const html = renderHub(peerHub());
    // The peer still renders as a federated stack hub.
    expect(html).toContain("network-node-hub-foreign");
    expect(html).toContain("federated stack");
    expect(html).toContain("jc/research");
    // No signal-sourced treatment whatsoever.
    expect(html).not.toContain("network-verdict-badge");
    expect(html).not.toContain("network-node-hub-muted");
    expect(html).not.toContain("network-node-hub-anomaly");
    expect(html).not.toContain('data-transport-verdict');
    expect(html).not.toContain('data-transport-muted');
    expect(html).not.toContain('data-transport-anomaly');
  });

  // A muted hub is conveyed accessibly: the muted state is reflected in the hub's
  // data attributes (a11y/automation can read it), not by colour alone.
  it("exposes the muted state on a data attribute (a11y, not hue-only)", () => {
    const html = renderHub(hub({ transportVerdict: "registered-absent" }));
    expect(html).toContain('data-transport-muted="true"');
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
