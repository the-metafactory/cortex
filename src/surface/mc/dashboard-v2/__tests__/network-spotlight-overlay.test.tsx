/**
 * G-1114.D.5 — NetworkSpotlight overlay + buildAgentCommands tests.
 *
 * The spotlight REUSES the MC-base CommandPalette. These cover:
 *   - `buildAgentCommands` (pure): one command per agent, label encodes
 *     name+id+capabilities, group carries liveness, `run()` selects the key +
 *     closes;
 *   - the overlay render: when open, it shows the agents; when closed, it renders
 *     nothing (CommandPalette returns null);
 *   - selection: invoking a command's `run` calls `onSelect` with the agent key
 *     and `onClose` (the Enter/click → select-node path D.4 consumes).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  NetworkSpotlight,
  buildAgentCommands,
} from "../components/network-spotlight";
import type { NetworkSpotlightProps } from "../components/network-spotlight";
import type { AgentPresenceTile } from "../hooks/use-agents";

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

const luna = tile({
  agent_id: "luna",
  assistant_name: "Luna",
  capabilities: ["review.code", "review.design"],
});
const sage = tile({
  agent_id: "sage",
  assistant_name: "Sage",
  state: "offline",
  offline_reason: "ttl_lapse",
  capabilities: ["moderate"],
});

function render(over: Partial<NetworkSpotlightProps> = {}): string {
  const props: NetworkSpotlightProps = {
    open: true,
    onClose: () => {},
    agents: [luna, sage],
    onSelect: () => {},
    ...over,
  };
  return renderToStaticMarkup(createElement(NetworkSpotlight, props));
}

describe("buildAgentCommands (G-1114.D.5)", () => {
  it("maps one command per agent, keyed by the registry key", () => {
    const cmds = buildAgentCommands([luna, sage], () => {}, () => {});
    expect(cmds.map((c) => c.id)).toEqual([
      "andreas/research/luna",
      "andreas/research/sage",
    ]);
  });

  it("encodes name + id + capabilities into the searchable label", () => {
    const [cmd] = buildAgentCommands([luna], () => {}, () => {});
    expect(cmd!.label).toContain("Luna");
    expect(cmd!.label).toContain("luna");
    expect(cmd!.label).toContain("review.code");
    expect(cmd!.label).toContain("review.design");
  });

  it("falls back to the agent id as the display name", () => {
    const anon = tile({ agent_id: "zeta", assistant_name: null });
    const [cmd] = buildAgentCommands([anon], () => {}, () => {});
    expect(cmd!.label).toContain("zeta");
  });

  it("carries liveness in the command group", () => {
    const cmds = buildAgentCommands([luna, sage], () => {}, () => {});
    expect(cmds[0]!.group).toBe("online");
    expect(cmds[1]!.group).toBe("offline");
  });

  it("run() selects the agent key and closes the spotlight", () => {
    const selectedKeys: string[] = [];
    let closed = false;
    const cmds = buildAgentCommands(
      [luna],
      (k) => {
        selectedKeys.push(k);
      },
      () => {
        closed = true;
      },
    );
    cmds[0]!.run();
    expect(selectedKeys).toEqual(["andreas/research/luna"]);
    expect(closed).toBe(true);
  });

  it("never embeds a session interior in the label (ADR-0007)", () => {
    const [cmd] = buildAgentCommands([luna], () => {}, () => {});
    for (const forbidden of ["prompt", "transcript", "diff", "tool_call"]) {
      expect(cmd!.label.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("NetworkSpotlight overlay (G-1114.D.5)", () => {
  it("renders nothing when closed", () => {
    const html = render({ open: false });
    expect(html).toBe("");
  });

  it("renders the agents when open", () => {
    const html = render({ open: true });
    expect(html).toContain("Luna");
    expect(html).toContain("Sage");
    // The reused CommandPalette overlay chrome.
    expect(html).toContain("cmdk");
  });

  it("renders the empty list copy when there are no agents", () => {
    const html = render({ open: true, agents: [] });
    expect(html).toContain("no matches");
  });
});
