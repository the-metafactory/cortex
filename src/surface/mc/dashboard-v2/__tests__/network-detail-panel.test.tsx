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
import { createElement } from "react";
import { NetworkDetailPanel } from "../components/network-detail-panel";
import type { NetworkDetailPanelProps } from "../components/network-detail-panel";
import type { AgentPresenceTile } from "../hooks/use-agents";
import type { AgentDispatchActivity } from "../lib/network-detail-display";

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
