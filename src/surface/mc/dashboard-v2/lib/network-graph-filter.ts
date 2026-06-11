/**
 * G-1114.D.5 — network graph FILTER (pure).
 *
 * Narrows the agents snapshot BEFORE it reaches the graph adapter
 * (`buildNetworkGraph`). The pipeline is:
 *
 *   agents snapshot → filterAgents(agents, filter) → buildNetworkGraph(filtered)
 *                   → ELK layout → React Flow canvas
 *
 * Keeping the filter as a pure `(agents, filter) → agents` function (rather than
 * folding it into the adapter) means it's trivially unit-testable without a DOM,
 * AND it composes cleanly: the same filtered snapshot also feeds the D.5 spotlight
 * search, so filter + spotlight see one consistent set of agents.
 *
 * Two orthogonal axes, AND-combined:
 *   - **state** — `online` / `offline` / `all` (the agent's last explicit liveness).
 *   - **capability** — `null` (any) or a single capability id; keep agents that
 *     DECLARE it.
 *
 * The filter never touches the synthetic stack-hub (it isn't an agent — it's
 * synthesised by the adapter from whatever agents survive the filter). When the
 * filter empties the agent set, the adapter returns an empty graph and the view
 * shows its empty state, exactly as it does for a genuinely empty snapshot.
 *
 * ADR-0007: this operates on presence + lifecycle fields only — never session
 * interiors (there are none on the tile to begin with).
 */

import type { AgentPresenceTile } from "../hooks/use-agents";

/** The state-axis options offered in the filter bar. */
export type NetworkStateFilter = "all" | "online" | "offline";

/**
 * G-1114.E.4 — the SCOPE-axis options: whether to show federated peer agents.
 *   - `"include-federated"` — show local AND foreign agents (federation visible).
 *   - `"local-only"`        — hide every foreign agent (focus on YOUR stack).
 *
 * The DEFAULT is `"include-federated"`: federation is opt-in at the bus layer
 * (E.1), so once a peer's agents are actually in the snapshot the principal opted
 * in — showing them by default makes that federation visible (the whole point of
 * Phase E). `"local-only"` is the deliberate focus filter that cleanly removes
 * foreign agents from the view (the §4.5 acceptance criterion).
 */
export type NetworkScopeFilter = "include-federated" | "local-only";

/** The filter the Network view holds and threads through the pipeline. */
export interface NetworkFilterState {
  /** Liveness filter; `all` passes both online and offline agents. */
  state: NetworkStateFilter;
  /**
   * Capability filter; `null` passes every agent, otherwise keep only agents
   * that DECLARE this capability id.
   */
  capability: string | null;
  /**
   * Federation scope; `include-federated` passes local + foreign, `local-only`
   * drops every foreign agent. Defaults to `include-federated`.
   */
  scope: NetworkScopeFilter;
  /**
   * P-14 U2.3 (#935) — TRANSPORT OVERLAY toggle. When true, the view folds
   * signal's projected `system.transport.*` verdicts + leaf liveness/RTT onto the
   * graph (hub verdict badges + agent leaf liveness/RTT). Off by default — the
   * overlay is an opt-in lens, not the graph's baseline. This is a RENDER toggle,
   * not an agent predicate: unlike `state`/`capability`/`scope` it never filters
   * the agent set (see {@link isFilterActive} — it doesn't count it as "active").
   *
   * OPTIONAL (additive over the pre-U2.3 shape): `undefined` reads as "off", so a
   * partial filter literal (e.g. a pre-existing test fixture) is still valid and
   * the overlay simply stays off. `DEFAULT_NETWORK_FILTER` sets it explicitly.
   */
  transportOverlay?: boolean;
}

/** The no-op filter: every agent passes. The view's initial filter state. */
export const DEFAULT_NETWORK_FILTER: NetworkFilterState = {
  state: "all",
  capability: null,
  scope: "include-federated",
  transportOverlay: false,
};

/**
 * Apply the two-axis filter to the agents snapshot.
 *
 * Pure + order-preserving: the survivors keep their snapshot (registry) order, so
 * the downstream layout stays deterministic. Returns a NEW array — never mutates
 * the input. An empty input (or a filter that excludes everything) yields `[]`.
 */
export function filterAgents(
  agents: readonly AgentPresenceTile[],
  filter: NetworkFilterState,
): AgentPresenceTile[] {
  return agents.filter((a) => {
    if (filter.state === "online" && a.state !== "online") return false;
    if (filter.state === "offline" && a.state !== "offline") return false;
    if (filter.capability !== null && !a.capabilities.includes(filter.capability)) {
      return false;
    }
    // E.4 scope: `local-only` drops every foreign agent (cleanly removing the
    // federation from the view — the §4.5 acceptance criterion). A foreign agent
    // is one whose origin is not the `"local"` string.
    if (filter.scope === "local-only" && a.origin !== "local") return false;
    return true;
  });
}

/**
 * Collect the distinct capability ids declared across the snapshot, sorted, for
 * the filter bar's capability dropdown. De-duplicates capabilities declared by
 * several agents (one option each). An empty / capability-less snapshot yields
 * `[]` (the dropdown renders only the "any capability" default).
 *
 * Sorted for a stable, scannable option list (the registry order is per-agent;
 * the option list wants a single global order).
 */
export function collectCapabilityOptions(
  agents: readonly AgentPresenceTile[],
): string[] {
  const set = new Set<string>();
  for (const a of agents) {
    for (const cap of a.capabilities) set.add(cap);
  }
  return [...set].sort();
}

/**
 * True when the filter narrows anything (i.e. it isn't the default
 * all/any/include-federated). Drives the filter bar's "Clear" affordance + an
 * "active filter" badge.
 */
export function isFilterActive(filter: NetworkFilterState): boolean {
  return (
    filter.state !== "all" ||
    filter.capability !== null ||
    filter.scope !== "include-federated"
  );
}
