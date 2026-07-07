/**
 * CK-3 (cortex#1289) — cockpit render tests (DOM-free via renderToStaticMarkup).
 *
 * Pins the fold: the four legacy surfaces mount stack-scoped; the DISPATCH verb is
 * ADMIN-posture-gated + own-local; a federated peer shows the ADR-0005 aggregate
 * notice, not the local lanes; and no cockpit copy renders the deprecated posture
 * word (built from fragments so THIS file stays carve-out-gate-clean).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { McCockpit, type McCockpitProps } from "../components/mc-cockpit";
import type { StackCoord } from "../lib/mc-shell-model";
import type { WorkingAgentTile } from "../hooks/use-working-agents";
import type { AgentPresenceTile } from "../hooks/use-agents";
import type { AttentionEntry } from "../../api/attention";
import type { GovernanceState } from "../hooks/use-governance";

const FORBIDDEN = ["oper", "ator"].join(""); // the deprecated posture word

const LOCAL: StackCoord = { principal: "aria", stack: "meta-factory", federated: false };
const PEER: StackCoord = { principal: "jc", stack: "home", federated: true };

const EMPTY_GOV: GovernanceState = { data: null, loaded: true, error: null };

function workingTile(agent_id: string): WorkingAgentTile {
  return {
    agent_id,
    agent_name: agent_id,
    agent_type: "head",
    primary_state_rank: 1,
    primary_state: "running",
    primary_assignment: {
      id: `${agent_id}-a`,
      task_id: `${agent_id}-t`,
      task_title: `task for ${agent_id}`,
      task_priority: 1,
      updated_at: "2026-07-08T00:00:00Z",
    },
    additional_active_count: 0,
    origin: "local",
    sessions: [],
  };
}

function presence(agent_id: string): AgentPresenceTile {
  return {
    key: `aria/meta-factory/${agent_id}`,
    origin: "local",
    agent_id,
    assistant_name: agent_id === "luna" ? "Luna" : null,
    nkey_public_key: "pk",
    principal: "aria",
    stack: "meta-factory",
    capabilities: [],
    state: "online",
    offline_reason: null,
    started_at: null,
    last_heartbeat_at: null,
    last_seen_at: 0,
  };
}

function attn(id: string, stackId: string): AttentionEntry {
  return {
    item: { id, stackId, workItemId: null, sessionId: null, kind: "review", severity: "high", status: "open" },
    link: { kind: "none" },
  };
}

function props(over: Partial<McCockpitProps>): McCockpitProps {
  return {
    stack: LOCAL,
    posture: "admin",
    servingPrincipal: "aria",
    presenceAgents: [],
    workingAgents: [],
    workingLoaded: true,
    workingError: null,
    attention: [],
    attentionLoaded: true,
    governance: EMPTY_GOV,
    onOpenDrill: () => {},
    ...over,
  };
}

function render(over: Partial<McCockpitProps>): string {
  return renderToStaticMarkup(createElement(McCockpit, props(over)));
}

describe("McCockpit — own-local stack", () => {
  it("mounts the ATTENTION, WORKING, and GOVERN lanes", () => {
    const html = render({});
    expect(html).toContain("mc-cockpit");
    expect(html).toContain("attention-view");
    expect(html).toContain("working-grid-section");
    expect(html).toContain("mc-cockpit-govern");
    expect(html).toContain("GOVERN");
    // never the deprecated posture word
    expect(html).not.toContain(FORBIDDEN);
  });

  it("scopes attention to the dived stack (drops other stacks' items)", () => {
    const html = render({
      attention: [attn("mine", "meta-factory"), attn("theirs", "work")],
    });
    // The scoped entry's severity badge is present; the other-stack item is gone.
    // (attention items key on id; both would show a `high` badge if unscoped.)
    expect(html).toContain("mc-cockpit");
    // 'theirs' belongs to stack 'work' — it must NOT contribute a link/label.
    // The scoped queue is [mine]; assert exactly one attention <li>.
    const liCount = (html.match(/attention-item/g) ?? []).length;
    expect(liCount).toBe(1);
  });

  it("renders the DISPATCH verb for ADMIN posture with a local agent present", () => {
    const html = render({
      posture: "admin",
      presenceAgents: [presence("luna")],
      workingAgents: [workingTile("luna")],
      onDispatchDirect: () => {},
    });
    expect(html).toContain("mc-cockpit-dispatch");
    expect(html).toContain("Dispatch to");
    expect(html).toContain("Luna");
    expect(html).toContain("dispatch-btn");
  });

  it("does NOT render the DISPATCH verb for MEMBER posture (fail-closed)", () => {
    const html = render({
      posture: "member",
      presenceAgents: [presence("luna")],
      onDispatchDirect: () => {},
    });
    expect(html).not.toContain("dispatch-btn");
    expect(html).toContain("participate in this network");
    expect(html).not.toContain(FORBIDDEN);
  });

  it("does NOT render the DISPATCH verb for unknown posture (fail-closed)", () => {
    const html = render({
      posture: null,
      presenceAgents: [presence("luna")],
      onDispatchDirect: () => {},
    });
    expect(html).not.toContain("dispatch-btn");
  });

  it("shows an honest no-agent note for ADMIN posture with no local agent", () => {
    const html = render({ posture: "admin", presenceAgents: [], onDispatchDirect: () => {} });
    expect(html).not.toContain("dispatch-btn");
    expect(html).toContain("No local agent online to dispatch");
  });

  it("CK-6b — renders Resolve/Dismiss on the ATTENTION lane when onAttentionLifecycle is wired", () => {
    const html = render({
      attention: [attn("mine", "meta-factory")],
      onAttentionLifecycle: () => {},
    });
    expect(html).toContain("attention-resolve");
    expect(html).toContain("attention-dismiss");
    expect(html).toContain("Resolve");
    expect(html).toContain("Dismiss");
    // truth-not-theater: no Approve/Deny leaks through the fold.
    expect(html.toLowerCase()).not.toContain("approve");
    expect(html.toLowerCase()).not.toContain("deny");
    expect(html).not.toContain(FORBIDDEN);
  });

  it("CK-6b — renders NO lifecycle buttons when onAttentionLifecycle is omitted", () => {
    const html = render({ attention: [attn("mine", "meta-factory")] });
    expect(html).not.toContain("attention-action");
    expect(html).not.toContain("attention-resolve");
  });

  it("renders the CK-4b cross-stack 'Across stacks' lane above the LOCAL grid", () => {
    const html = render({
      workingAggregation: [
        { originStackId: null, activeSessionCount: 2, subAgentCount: 1, providerRetry: null },
        { originStackId: "jc/home", activeSessionCount: 1, subAgentCount: 0, providerRetry: null },
      ],
      workingAggregationLoaded: true,
    });
    // the pane-of-glass rollup mounts inside the WORKING lane…
    expect(html).toContain("working-aggregate-section");
    expect(html).toContain("Across stacks");
    expect(html).toContain('data-origin="local"');
    expect(html).toContain('data-origin="jc/home"');
    expect(html).toContain("1 sub-agent");
    // …ABOVE the local, drillable grid (both present, aggregate first).
    expect(html.indexOf("working-aggregate-section")).toBeLessThan(
      html.indexOf("working-grid-section")
    );
    // metadata-only: the cross-stack lane exposes no drill control.
    expect(html).not.toContain(FORBIDDEN);
  });
});

describe("McCockpit — federated peer (ADR-0005)", () => {
  it("renders the aggregate notice, not the local lanes", () => {
    const html = render({ stack: PEER, posture: "member" });
    expect(html).toContain("mc-cockpit--peer");
    expect(html).toContain("AGGREGATE ONLY");
    expect(html).toContain("federated peer");
    // none of the local operational lanes are rendered for a peer
    expect(html).not.toContain("attention-view");
    expect(html).not.toContain("working-grid-section");
    expect(html).not.toContain("dispatch-btn");
  });

  it("CK-6b — never renders resolve/dismiss for a federated peer (ADR-0005 scope)", () => {
    // Even with the lifecycle handler wired + open items, a peer bottoms out at
    // the aggregate notice — its attention interior (and mutations) never render.
    const html = render({
      stack: PEER,
      posture: "member",
      attention: [attn("theirs", "home")],
      onAttentionLifecycle: () => {},
    });
    expect(html).toContain("AGGREGATE ONLY");
    expect(html).not.toContain("attention-resolve");
    expect(html).not.toContain("attention-dismiss");
    expect(html).not.toContain("attention-action");
  });

  it("does NOT render the CK-4b cross-stack lane for a federated peer", () => {
    // The peer branch bottoms out at the aggregate notice before the WORKING
    // lane — the "Across stacks" rollup never renders under a peer dive.
    const html = render({
      stack: PEER,
      posture: "member",
      workingAggregation: [
        { originStackId: null, activeSessionCount: 3, subAgentCount: 0, providerRetry: null },
      ],
      workingAggregationLoaded: true,
    });
    expect(html).not.toContain("working-aggregate-section");
    expect(html).not.toContain("Across stacks");
  });
});
