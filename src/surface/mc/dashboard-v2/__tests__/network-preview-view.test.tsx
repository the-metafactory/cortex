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

  // --- G-1114.C.4: capability badges + offline-state rendering --------------

  it("renders each capability as a distinct badge chip, not a comma string", () => {
    const html = render({
      loaded: true,
      error: null,
      agents: [
        tile({
          agent_id: "luna",
          capabilities: ["review.code", "review.design", "moderate"],
        }),
      ],
    });
    const chipCount = (html.match(/agents-panel-cap"/g) ?? []).length;
    expect(chipCount).toBe(3);
    // Not rendered as a single comma-joined blob.
    expect(html).not.toContain("review.code, review.design");
  });

  it("renders the empty-capabilities placeholder for an agent with no caps", () => {
    const html = render({
      loaded: true,
      error: null,
      agents: [tile({ agent_id: "echo", capabilities: [] })],
    });
    expect(html).toContain("no capabilities declared");
    expect(html).toContain("agents-panel-cap-none");
  });

  it("renders a TTL-lapsed agent as a timed-out 'no heartbeat' / 'last seen' row", () => {
    const lastBeat = Date.now() - 6 * 60_000; // 6 minutes ago
    const html = render({
      loaded: true,
      error: null,
      agents: [
        tile({
          agent_id: "sage",
          assistant_name: "Sage",
          state: "offline",
          offline_reason: "ttl_lapse",
          last_heartbeat_at: lastBeat,
        }),
      ],
    });
    expect(html).toContain('data-state="offline"');
    expect(html).toContain('data-offline-reason="ttl_lapse"');
    expect(html).toContain("agents-panel-row-ttl-lapse");
    expect(html).toContain("no heartbeat");
    expect(html).toContain("last seen");
    // The TTL-lapse reason gets the warning treatment, not the graceful one.
    expect(html).toContain("agents-panel-reason-ttl-lapse");
  });

  it("renders a gracefully shut-down agent distinctly from a TTL lapse", () => {
    const html = render({
      loaded: true,
      error: null,
      agents: [
        tile({
          agent_id: "echo",
          assistant_name: "Echo",
          state: "offline",
          offline_reason: "shutdown",
        }),
      ],
    });
    expect(html).toContain('data-state="offline"');
    expect(html).toContain('data-offline-reason="shutdown"');
    expect(html).toContain("shut down");
    // A graceful shutdown is NOT the TTL-lapse warning treatment.
    expect(html).not.toContain("agents-panel-row-ttl-lapse");
    expect(html).not.toContain("no heartbeat");
    expect(html).not.toContain("last seen");
  });

  it("maps restart and error reasons to their own labels", () => {
    const restart = render({
      loaded: true,
      error: null,
      agents: [tile({ agent_id: "r", state: "offline", offline_reason: "restart" })],
    });
    expect(restart).toContain("restarting");

    const errored = render({
      loaded: true,
      error: null,
      agents: [tile({ agent_id: "e", state: "offline", offline_reason: "error" })],
    });
    expect(errored).toContain("errored");
  });

  it("does not show an offline reason or 'last seen' qualifier for an online agent", () => {
    const html = render({
      loaded: true,
      error: null,
      agents: [tile({ agent_id: "luna", state: "online", last_heartbeat_at: Date.now() })],
    });
    expect(html).not.toContain("agents-panel-reason");
    expect(html).not.toContain("last seen");
  });
});
