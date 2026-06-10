/**
 * G-1114.D.4 — NetworkDetailPanel render tests.
 *
 * The panel is a PURE component (no hooks / no xyflow), so it renders under
 * `renderToStaticMarkup` like the network-nodes card inners. These assert the
 * presence / capability / dispatch-activity rendering across online / offline /
 * TTL-lapse / idle / missing-data states — AND the ADR-0007 no-interiors
 * boundary (the panel never surfaces prompts / tool calls / diffs).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, isValidElement, type ReactElement } from "react";
import { NetworkDetailPanel } from "../components/network-detail-panel";
import type { NetworkDetailPanelProps } from "../components/network-detail-panel";
import { DispatchButton } from "../components/dispatch-button";
import type { AgentPresenceTile } from "../hooks/use-agents";
import type { AgentDispatchActivity } from "../lib/network-detail-display";

/**
 * Render the panel to its element tree (no DOM) and walk it to find the reused
 * F-19 `DispatchButton` child, so we can exercise the panel's `onConfirm`
 * wiring (the seam where F.3 reuses the existing dispatch action) without a DOM
 * harness. Returns the DispatchButton element, or null when none is rendered.
 */
function findDispatchButton(root: ReactElement): ReactElement | null {
  // Render the function component one level to get its returned tree.
  const Comp = root.type as (props: unknown) => ReactElement;
  const tree = Comp(root.props);
  const found: ReactElement[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isValidElement(node)) return;
    if (node.type === DispatchButton) found.push(node);
    const kids = (node.props as { children?: unknown }).children;
    if (kids !== undefined) visit(kids);
  };
  visit(tree);
  return found[0] ?? null;
}

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

function dispatchActivity(
  over: Partial<AgentDispatchActivity> = {},
): AgentDispatchActivity {
  return {
    primaryState: "running",
    taskTitle: "Build the thing",
    taskPriority: 1,
    updatedAt: "2026-06-11T00:00:00.000Z",
    additionalActiveCount: 0,
    ...over,
  };
}

function render(
  over: Partial<NetworkDetailPanelProps> & { agent: AgentPresenceTile },
): string {
  const props: NetworkDetailPanelProps = {
    dispatch: null,
    onClose: () => {},
    now: Date.now(),
    ...over,
  };
  return renderToStaticMarkup(createElement(NetworkDetailPanel, props));
}

describe("NetworkDetailPanel — presence (G-1114.D.4)", () => {
  it("renders an online agent's name, id, and online state", () => {
    const html = render({
      agent: tile({
        agent_id: "luna",
        assistant_name: "Luna",
        state: "online",
        last_heartbeat_at: Date.now(),
      }),
    });
    expect(html).toContain("Luna");
    expect(html).toContain("luna");
    expect(html).toContain("online");
    expect(html).toContain('data-agent-id="luna"');
    expect(html).toContain('data-state="online"');
    expect(html).toContain("heartbeat");
  });

  it("falls back to agent_id when assistant_name is null", () => {
    const html = render({ agent: tile({ agent_id: "echo", assistant_name: null }) });
    expect(html).toContain("echo");
  });

  it("renders a TTL-lapsed agent as 'no heartbeat' / 'last seen' with the warning treatment", () => {
    const now = Date.now();
    const html = render({
      agent: tile({
        agent_id: "sage",
        assistant_name: "Sage",
        state: "offline",
        offline_reason: "ttl_lapse",
        last_heartbeat_at: now - 6 * 60_000,
      }),
      now,
    });
    expect(html).toContain('data-state="offline"');
    expect(html).toContain("network-detail-ttl-lapse");
    expect(html).toContain("no heartbeat");
    expect(html).toContain("last seen");
    expect(html).toContain("network-detail-reason-ttl-lapse");
  });

  it("renders a graceful shutdown distinctly from a TTL lapse", () => {
    const html = render({
      agent: tile({
        agent_id: "echo",
        state: "offline",
        offline_reason: "shutdown",
      }),
    });
    expect(html).toContain("shut down");
    expect(html).not.toContain("network-detail-ttl-lapse");
    expect(html).not.toContain("no heartbeat");
  });

  it("does not render an offline reason for an online agent", () => {
    const html = render({
      agent: tile({ agent_id: "luna", state: "online", last_heartbeat_at: Date.now() }),
    });
    expect(html).not.toContain("network-detail-reason");
  });
});

describe("NetworkDetailPanel — capabilities (G-1114.D.4)", () => {
  it("renders each capability as a distinct chip", () => {
    const html = render({
      agent: tile({
        agent_id: "luna",
        capabilities: ["review.code", "review.design", "moderate"],
      }),
    });
    const chips = (html.match(/network-detail-cap"/g) ?? []).length;
    expect(chips).toBe(3);
    expect(html).toContain("review.code");
    expect(html).not.toContain("review.code, review.design");
  });

  it("renders the no-capabilities placeholder", () => {
    const html = render({ agent: tile({ agent_id: "luna", capabilities: [] }) });
    expect(html).toContain("no capabilities declared");
    expect(html).toContain("network-detail-cap-none");
  });
});

describe("NetworkDetailPanel — dispatch activity (G-1114.D.4)", () => {
  it("renders the active-dispatch lifecycle line when dispatched", () => {
    const html = render({
      agent: tile({ agent_id: "luna" }),
      dispatch: dispatchActivity({
        primaryState: "running",
        taskTitle: "Wire the panel",
        taskPriority: 0,
        additionalActiveCount: 2,
      }),
    });
    expect(html).toContain("running");
    expect(html).toContain("Wire the panel");
    expect(html).toContain("P0");
    expect(html).toContain("+2 more active");
    expect(html).toContain("updated");
  });

  it("renders the idle line when the agent has no active dispatch", () => {
    const html = render({ agent: tile({ agent_id: "luna" }), dispatch: null });
    expect(html).toContain("No active dispatch");
  });

  it("omits the 'more active' line when there are no additional assignments", () => {
    const html = render({
      agent: tile({ agent_id: "luna" }),
      dispatch: dispatchActivity({ additionalActiveCount: 0 }),
    });
    expect(html).not.toContain("more active");
  });

  it("renders the 'view in working grid' link only when the callback is provided", () => {
    const without = render({ agent: tile({ agent_id: "luna" }) });
    expect(without).not.toContain("View in working grid");

    const withLink = render({
      agent: tile({ agent_id: "luna" }),
      onViewInWorkingGrid: () => {},
    });
    expect(withLink).toContain("View in working grid");
  });
});

describe("NetworkDetailPanel — ADR-0007 boundary (G-1114.D.4)", () => {
  it("never renders session-interior surfaces (prompts / tool calls / diffs)", () => {
    const html = render({
      agent: tile({
        agent_id: "luna",
        capabilities: ["review.code"],
      }),
      dispatch: dispatchActivity(),
      onViewInWorkingGrid: () => {},
    });
    // The panel is presence + caps + lifecycle metadata + a pointer. None of the
    // session-interior vocabulary should ever appear in its markup.
    for (const forbidden of [
      "prompt",
      "tool_call",
      "tool call",
      "transcript",
      "diff",
      "stdout",
      "message-content",
    ]) {
      expect(html.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("exposes a close affordance", () => {
    const html = render({ agent: tile({ agent_id: "luna" }) });
    expect(html).toContain("network-detail-close");
    expect(html).toContain("Close detail panel");
  });
});

const FOREIGN_ORIGIN = { principal: "jc", stack: "research" } as const;

describe("NetworkDetailPanel — F.3 dispatch-direct affordance", () => {
  it("omits the dispatch section when no onDispatchDirect is provided", () => {
    const html = render({ agent: tile({ agent_id: "luna" }) });
    expect(html).not.toContain("network-detail-dispatch-direct");
  });

  it("renders the confirm-gated Dispatch button for a LOCAL agent", () => {
    const html = render({
      agent: tile({ agent_id: "luna", assistant_name: "Luna", origin: "local" }),
      onDispatchDirect: () => {},
    });
    expect(html).toContain("network-detail-dispatch-direct");
    // The reused F-19 DispatchButton (carries the Cancel/Confirm popover gate).
    expect(html).toContain("network-detail-dispatch-direct-btn");
    expect(html).toContain("Dispatch");
    // The agent label flows through to the (closed) popover prompt wiring.
    expect(html).not.toContain("foreign-disabled");
  });

  it("invokes onDispatchDirect with the agent when the DispatchButton confirms", () => {
    // The panel wires `onConfirm={() => onDispatchDirect(agent)}` onto the
    // reused DispatchButton. Exercise that wiring directly: build the panel
    // element, pull the DispatchButton child, fire its onConfirm.
    const agent = tile({ agent_id: "luna", assistant_name: "Luna", origin: "local" });
    const calls: AgentPresenceTile[] = [];
    const el = createElement(NetworkDetailPanel, {
      agent,
      dispatch: null,
      onClose: () => {},
      onDispatchDirect: (a) => {
        calls.push(a);
      },
    });
    const btn = findDispatchButton(el);
    expect(btn).not.toBeNull();
    // Fire the button's onConfirm — the panel's wiring should call back with the
    // agent, REUSING the existing dispatch action (no new path invented).
    (btn!.props as { onConfirm: () => void }).onConfirm();
    expect(calls).toEqual([agent]);
  });

  it("shows a disabled FUTURE-STATE (no live button) for a FOREIGN peer agent", () => {
    const html = render({
      agent: tile({
        agent_id: "echo",
        assistant_name: "Echo",
        origin: FOREIGN_ORIGIN,
      }),
      onDispatchDirect: () => {},
    });
    expect(html).toContain("network-detail-dispatch-direct");
    expect(html).toContain("foreign-disabled");
    expect(html).toContain("Federated peer");
    expect(html).toContain("jc/research");
    // No live DispatchButton for a foreign peer — the local-only dispatch path
    // must not be wired to a cross-principal target.
    expect(html).not.toContain("network-detail-dispatch-direct-btn");
  });

  it("marks the button busy while a dispatch-direct is in flight", () => {
    const html = render({
      agent: tile({ agent_id: "luna", origin: "local" }),
      onDispatchDirect: () => {},
      dispatchBusy: true,
    });
    // F-19 DispatchButton renders "…" + a disabled button while busy.
    expect(html).toContain("disabled");
  });
});

describe("NetworkDetailPanel — F.2 capability hover", () => {
  it("marks each real capability badge with its data-capability for hover", () => {
    const html = render({
      agent: tile({ agent_id: "luna", capabilities: ["review.code", "design"] }),
      onHoverCapability: () => {},
    });
    expect(html).toContain('data-capability="review.code"');
    expect(html).toContain('data-capability="design"');
  });

  it("lights a capability badge that is in highlightedCapabilities", () => {
    const html = render({
      agent: tile({ agent_id: "luna", capabilities: ["review.code", "design"] }),
      highlightedCapabilities: new Set(["design"]),
    });
    // Exactly the lit badge gets the highlighted modifier.
    const lit = (html.match(/network-detail-cap-highlighted/g) ?? []).length;
    expect(lit).toBe(1);
  });
});
