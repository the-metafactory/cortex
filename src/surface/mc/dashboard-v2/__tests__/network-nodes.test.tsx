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
  FederatedPeerCard,
} from "../components/network-nodes";
import { NetworkLegend } from "../components/network-legend";
import type {
  AgentNodeData,
  StackHubNodeData,
  FederatedPeerNodeData,
} from "../lib/network-graph-adapter";

function agentData(over: Partial<AgentNodeData> = {}): AgentNodeData {
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
  // Default the serving principal to `andreas` (matching the local fixtures), so
  // `origin: "local"` classifies `self` and a `jc/*` origin classifies `foreign`.
  // Tests that exercise the #1008 sibling path override it explicitly.
  function renderHub(over: Partial<StackHubNodeData> & { kind: "stack-hub" }): string {
    const data: StackHubNodeData = {
      servingPrincipal: "andreas",
      origin: "local",
      principal: null,
      stack: null,
      agentCount: 0,
      stackColor: "#5b8cd4",
      ...over,
    };
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

  it("renders a SAME-PRINCIPAL local SIBLING hub as LOCAL, not federated (#1008)", () => {
    // A sibling stack reached via DB-read aggregation carries an OBJECT origin
    // whose principal === the serving principal. It must read as a "stack" hub
    // (local visual), NOT "federated stack" — the bug this fixes.
    const html = renderHub({
      kind: "stack-hub",
      origin: { principal: "andreas", stack: "work" },
      servingPrincipal: "andreas",
      principal: "andreas",
      stack: "work",
      agentCount: 2,
    });
    expect(html).toContain('data-hub-origin="local"');
    expect(html).toContain('data-hub-category="sibling"');
    expect(html).toContain("network-node-hub-sibling");
    expect(html).not.toContain("network-node-hub-foreign");
    expect(html).not.toContain("federated stack");
    // still labelled with its own {principal}/{stack}
    expect(html).toContain("andreas/work");
  });

  it("classifies a CROSS-PRINCIPAL hub as foreign even with the same stack name (#1008)", () => {
    const html = renderHub({
      kind: "stack-hub",
      origin: { principal: "jc", stack: "work" },
      servingPrincipal: "andreas",
      principal: "jc",
      stack: "work",
      agentCount: 1,
    });
    expect(html).toContain('data-hub-category="foreign"');
    expect(html).toContain("federated stack");
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

  it("renders a SAME-PRINCIPAL local SIBLING agent as LOCAL, no federated badge (#1008)", () => {
    const html = renderAgent(
      agentData({
        key: "andreas/work/echo",
        agentId: "echo",
        assistantName: "Echo",
        origin: { principal: "andreas", stack: "work" },
        servingPrincipal: "andreas",
      }),
    );
    expect(html).toContain('data-agent-origin="local"');
    expect(html).toContain('data-agent-category="sibling"');
    expect(html).not.toContain("network-node-foreign");
    expect(html).not.toContain("network-node-provenance");
    expect(html).not.toContain("federated peer");
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

describe("#1068 — per-stack color", () => {
  it("the agent card carries its stack color as --stack-color + data attr", () => {
    const html = renderAgent(agentData({ stackColor: "#2e8b7a" }));
    expect(html).toContain("--stack-color:#2e8b7a");
    expect(html).toContain('data-stack-color="#2e8b7a"');
  });

  it("the hub card carries its stack color as --stack-color + data attr", () => {
    const html = renderToStaticMarkup(
      createElement(StackHubCard, {
        data: {
          kind: "stack-hub",
          origin: "local",
          servingPrincipal: "andreas",
          principal: "andreas",
          stack: "research",
          agentCount: 1,
          stackColor: "#d4915b",
        } satisfies StackHubNodeData,
      }),
    );
    expect(html).toContain("--stack-color:#d4915b");
    expect(html).toContain('data-stack-color="#d4915b"');
  });

  it("the legend renders a swatch + label per stack passed in", () => {
    const html = renderToStaticMarkup(
      createElement(NetworkLegend, {
        stacks: [
          { id: "__stack__", label: "local", color: "#5b8cd4" },
          { id: "__stack__:jc/research", label: "jc/research", color: "#2e8b7a" },
        ],
      }),
    );
    expect(html).toContain("network-legend-swatch-stack");
    expect(html).toContain("local");
    expect(html).toContain("jc/research");
    expect(html).toContain("background:#5b8cd4");
    expect(html).toContain("background:#2e8b7a");
  });
});

describe("#1068 — hub-subtree selection (a11y + emphasis/dim)", () => {
  it("a non-interactive hub (no toggle handler) carries no role/aria-pressed", () => {
    const html = renderToStaticMarkup(
      createElement(StackHubCard, {
        data: {
          kind: "stack-hub",
          origin: "local",
          servingPrincipal: "andreas",
          principal: "andreas",
          stack: "research",
          agentCount: 1,
          stackColor: "#5b8cd4",
        } satisfies StackHubNodeData,
      }),
    );
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain("aria-pressed");
  });

  it("an interactive selected hub stamps role=button, aria-pressed=true, data-selected", () => {
    const html = renderToStaticMarkup(
      createElement(StackHubCard, {
        data: {
          kind: "stack-hub",
          origin: "local",
          servingPrincipal: "andreas",
          principal: "andreas",
          stack: "research",
          agentCount: 1,
          stackColor: "#5b8cd4",
        } satisfies StackHubNodeData,
        selected: true,
        onToggleSelect: () => {},
      }),
    );
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain("network-node-selected");
  });

  it("a dimmed (non-selected, selection active) hub carries data-dimmed + the dim class", () => {
    const html = renderToStaticMarkup(
      createElement(StackHubCard, {
        data: {
          kind: "stack-hub",
          origin: "local",
          servingPrincipal: "andreas",
          principal: "andreas",
          stack: "research",
          agentCount: 1,
          stackColor: "#5b8cd4",
        } satisfies StackHubNodeData,
        dimmed: true,
        onToggleSelect: () => {},
      }),
    );
    expect(html).toContain('data-dimmed="true"');
    expect(html).toContain("network-node-dimmed");
    expect(html).toContain('aria-pressed="false"');
  });

  it("an emphasized agent (in the selected subtree) carries data-selected + the emphasis class", () => {
    const html = renderToStaticMarkup(
      createElement(AgentNodeCard, {
        data: agentData(),
        subtreeEmphasized: true,
      }),
    );
    expect(html).toContain('data-selected="true"');
    expect(html).toContain("network-node-selected");
  });

  it("a dimmed agent (outside the selected subtree) carries data-dimmed + the dim class", () => {
    const html = renderToStaticMarkup(
      createElement(AgentNodeCard, {
        data: agentData(),
        dimmed: true,
      }),
    );
    expect(html).toContain('data-dimmed="true"');
    expect(html).toContain("network-node-dimmed");
  });
});

describe("FederatedPeerCard (MC-D4 — absent admitted peer)", () => {
  function render(over: Partial<FederatedPeerNodeData> = {}): string {
    const data: FederatedPeerNodeData = {
      kind: "federated-peer",
      principal: "jc",
      verdict: "absent-offline",
      networkId: "mfnet",
      ...over,
    };
    return renderToStaticMarkup(createElement(FederatedPeerCard, { data }));
  }

  it("renders a dimmed federated-peer node labelled with the peer principal", () => {
    const html = render();
    expect(html).toContain('data-node-kind="federated-peer"');
    expect(html).toContain('data-fed-peer-principal="jc"');
    expect(html).toContain('data-fed-peer-absent="true"');
    // The principal id is the visible label.
    expect(html).toContain(">jc<");
    // FS-6 — an offline peer carries the `federated · offline` sublabel + token.
    expect(html).toContain("federated · offline");
    expect(html).toContain('data-fed-peer-absence="offline"');
    // The muted orb class (no glow — styled in CSS).
    expect(html).toContain("network-node-orb-fed-peer");
    // An accessible name marking it admitted + offline.
    expect(html).toContain("federated peer (admitted, offline)");
  });

  it("carries the membership verdict as a data attribute", () => {
    const html = render({ verdict: "absent-offline" });
    expect(html).toContain('data-fed-peer-verdict="absent-offline"');
  });

  it("FS-6 — an UNHEARD peer renders the distinct check-import/cred reason", () => {
    // The absent-unheard case: we are DEAF to this peer (never received its
    // federated presence). It must read distinct from a plain offline peer —
    // different eyebrow, different stable absence token, a danger tone class.
    const html = render({ verdict: "absent-unheard" });
    expect(html).toContain('data-fed-peer-verdict="absent-unheard"');
    expect(html).toContain('data-fed-peer-absence="unheard"');
    expect(html).toContain("federated · unheard");
    expect(html).toContain("tone-danger");
    expect(html).toContain("federated peer (admitted, unheard)");
    // NOT the offline label.
    expect(html).not.toContain("federated · offline");
  });

  it("renders a cross-network glyph so it reads as a federated (not local) node", () => {
    // MC-D4 vis2: the absent peer must look DELIBERATELY different from a local
    // agent orb — a small cross-network glyph (⇄) marks the federation boundary.
    const html = render();
    expect(html).toContain("⇄");
    // The glyph sits in its own decorative span, aria-hidden (label carries meaning).
    expect(html).toContain("network-fed-peer-glyph");
  });

  it("keeps the peer principal as the primary label", () => {
    const html = render({ principal: "vincent" });
    expect(html).toContain(">vincent<");
    expect(html).toContain('data-fed-peer-principal="vincent"');
  });

  it("renders the eyebrow EXACTLY ONCE (no duplicate label chrome)", () => {
    // netui-fedpeer-polish2 regression guard: the live `jc` orb was showing its
    // sublabel TWICE — the intended styled eyebrow PLUS a second, lowercase copy
    // in a bordered box (React Flow's default-node chrome leaking through when the
    // custom node type doesn't render cleanly). The card must emit its eyebrow
    // once and rely solely on the custom `network-fed-peer-eyebrow` element.
    const html = render();
    const eyebrows = html.match(/network-fed-peer-eyebrow/g) ?? [];
    expect(eyebrows).toHaveLength(1);
    const sublabels = html.match(/federated · offline/g) ?? [];
    expect(sublabels).toHaveLength(1);
    // The card must NOT hand React Flow a default `label` prop it would render
    // as a second (bordered, lowercase) label box.
    expect(html).not.toContain('data-label');
  });
});
