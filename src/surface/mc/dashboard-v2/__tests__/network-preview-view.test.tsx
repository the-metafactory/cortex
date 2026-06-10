/**
 * G-1114.B.4 — render tests for the live agents panel (replaced the Phase A
 * stub). Renders via `renderToStaticMarkup` (which runs the component's hooks)
 * and asserts the panel projects the agents state: list rows with identity,
 * capabilities, state, and heartbeat; the empty state; and the boot-error path.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NetworkPreviewView } from "../components/network-preview-view";
import type { AgentsState } from "../hooks/use-agents";
import type { AgentPresenceTile } from "../hooks/use-agents";

function tile(over: Partial<AgentPresenceTile> & { agent_id: string }): AgentPresenceTile {
  const { agent_id } = over;
  return {
    key: `andreas/research/${agent_id}`,
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

function render(state: AgentsState): string {
  return renderToStaticMarkup(createElement(NetworkPreviewView, { state }));
}

describe("NetworkPreviewView — live agents panel (G-1114.B.4)", () => {
  it("renders the loading state before first load", () => {
    const html = render({ agents: [], loaded: false, error: null });
    expect(html).toContain("Loading");
  });

  it("renders the empty state when loaded with no agents", () => {
    const html = render({ agents: [], loaded: true, error: null });
    expect(html).toContain("No agents observed yet");
  });

  it("renders the boot-error state", () => {
    const html = render({ agents: [], loaded: false, error: "HTTP 500" });
    expect(html).toContain("HTTP 500");
  });

  it("renders an online agent with assistant name, id, capabilities, and state", () => {
    const html = render({
      loaded: true,
      error: null,
      agents: [
        tile({
          agent_id: "luna",
          assistant_name: "Luna",
          capabilities: ["review.code", "review.design"],
          state: "online",
          last_heartbeat_at: Date.now(),
        }),
      ],
    });
    expect(html).toContain("Luna");
    expect(html).toContain("luna");
    expect(html).toContain("review.code");
    expect(html).toContain("review.design");
    expect(html).toContain("online");
    expect(html).toContain('data-agent-id="luna"');
    expect(html).toContain('data-state="online"');
  });

  it("falls back to agent_id when assistant_name is null", () => {
    const html = render({
      loaded: true,
      error: null,
      agents: [tile({ agent_id: "echo", assistant_name: null })],
    });
    expect(html).toContain("echo");
  });

  it("renders an offline agent and notes no-capabilities", () => {
    const html = render({
      loaded: true,
      error: null,
      agents: [
        tile({
          agent_id: "echo",
          assistant_name: "Echo",
          state: "offline",
          offline_reason: "graceful-shutdown",
          capabilities: [],
        }),
      ],
    });
    expect(html).toContain("offline");
    expect(html).toContain('data-state="offline"');
    expect(html).toContain("no capabilities declared");
  });

  it("renders one row per agent", () => {
    const html = render({
      loaded: true,
      error: null,
      agents: [
        tile({ agent_id: "luna", assistant_name: "Luna" }),
        tile({ agent_id: "echo", assistant_name: "Echo" }),
        tile({ agent_id: "sage", assistant_name: "Sage" }),
      ],
    });
    const rowCount = (html.match(/agents-panel-row /g) ?? []).length;
    expect(rowCount).toBe(3);
  });
});
