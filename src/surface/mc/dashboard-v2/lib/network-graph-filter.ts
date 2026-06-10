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

/** The two-axis filter the Network view holds and threads through the pipeline. */
export interface NetworkFilterState {
  /** Liveness filter; `all` passes both online and offline agents. */
  state: NetworkStateFilter;
  /**
   * Capability filter; `null` passes every agent, otherwise keep only agents
   * that DECLARE this capability id.
   */
  capability: string | null;
}

/** The no-op filter: every agent passes. The view's initial filter state. */
export const DEFAULT_NETWORK_FILTER: NetworkFilterState = {
  state: "all",
  capability: null,
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
 * True when the filter narrows anything (i.e. it isn't the default all/any).
 * Drives the filter bar's "Clear" affordance + an "active filter" badge.
 */
export function isFilterActive(filter: NetworkFilterState): boolean {
  return filter.state !== "all" || filter.capability !== null;
}
