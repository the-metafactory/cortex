/**
 * G-1114.D.1 — NetworkView render tests (non-canvas states).
 *
 * `renderToStaticMarkup` runs the component body + `useMemo` but NOT effects, so
 * the ELK layout never runs here and `positioned` stays empty. That lets us
 * assert every state that renders WITHOUT mounting xyflow:
 *   - error / loading / empty (chosen by `pickAgentsPanelMode`); and
 *   - the `list`-but-not-yet-laid-out "Laying out topology…" transitional state
 *     (agents present, ELK still pending) — the smoke test that the view mounts
 *     without crashing even with agents.
 *
 * The xyflow CANVAS itself can't render under `renderToStaticMarkup` (it needs
 * the zustand provider + a sized DOM). Its node markup is covered by
 * network-nodes.test (the pure card inners); the live canvas is validated by the
 * `build:dashboard` gate + a manual dashboard rebuild. This limitation is the
 * same one the working-grid / panel tests note.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NetworkView } from "../components/network-view";
import type { AgentsState, AgentPresenceTile } from "../hooks/use-agents";

function tile(
  over: Partial<AgentPresenceTile> & { agent_id: string },
): AgentPresenceTile {
  const { agent_id } = over;
  return {
    key: `andreas/research/${agent_id}`,
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

function render(state: AgentsState): string {
  return renderToStaticMarkup(createElement(NetworkView, { state }));
}

describe("NetworkView (G-1114.D.1)", () => {
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

  it("mounts without crashing when agents are present (canvas deferred to layout)", () => {
    // Effects don't run under static markup, so this renders the "laying out"
    // transitional state rather than the xyflow canvas — but it proves the view
    // body + adapter `useMemo` don't throw on a populated snapshot.
    const html = render({
      loaded: true,
      error: null,
      agents: [
        tile({ agent_id: "luna", assistant_name: "Luna" }),
        tile({ agent_id: "echo", state: "offline", offline_reason: "ttl_lapse" }),
      ],
    });
    expect(html).toContain("Laying out topology");
    // The view chrome renders regardless of layout state.
    expect(html).toContain("Network");
    expect(html).toContain("topology");
  });
});
