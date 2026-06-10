/**
 * G-1114.D.5 — Network FILTER BAR.
 *
 * A small presentational bar above the graph canvas: a state toggle
 * (All / Online / Offline) + a capability dropdown (Any capability / one of the
 * declared capabilities) + a Clear affordance (shown only when a filter is
 * active) + a Cmd+K spotlight hint.
 *
 * Pure / state-lifted: the filter state lives in `network-view` (so it can feed
 * both the graph adapter and the spotlight off ONE filtered snapshot); this
 * component just renders the controls and calls back on change. No xyflow import,
 * so it stays in the MAIN bundle (never the lazy network-canvas chunk) and renders
 * under `renderToStaticMarkup` in tests.
 *
 * CSS lives in styles/global.css under .network-filter-bar.
 */

import { Keycap } from "./keycap";
import {
  isFilterActive,
  type NetworkFilterState,
  type NetworkStateFilter,
  type NetworkScopeFilter,
} from "../lib/network-graph-filter";

const STATE_OPTIONS: readonly { value: NetworkStateFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "online", label: "Online" },
  { value: "offline", label: "Offline" },
];

// E.4 — the scope toggle: show federated peers, or focus on this stack only.
const SCOPE_OPTIONS: readonly { value: NetworkScopeFilter; label: string }[] = [
  { value: "include-federated", label: "All stacks" },
  { value: "local-only", label: "This stack" },
];

export interface NetworkFilterBarProps {
  filter: NetworkFilterState;
  /** The distinct capability ids to offer in the dropdown (sorted upstream). */
  capabilityOptions: readonly string[];
  onStateChange: (state: NetworkStateFilter) => void;
  /** `null` clears the capability filter (the "Any capability" option). */
  onCapabilityChange: (capability: string | null) => void;
  /** E.4 — flip federation scope (include foreign peers vs this stack only). */
  onScopeChange: (scope: NetworkScopeFilter) => void;
  onClear: () => void;
  /** Open the Cmd+K spotlight (the hint button is also a click target). */
  onOpenSpotlight: () => void;
}

export function NetworkFilterBar({
  filter,
  capabilityOptions,
  onStateChange,
  onCapabilityChange,
  onScopeChange,
  onClear,
  onOpenSpotlight,
}: NetworkFilterBarProps) {
  const active = isFilterActive(filter);
  return (
    <div className="network-filter-bar" role="toolbar" aria-label="Network filters">
      <div className="network-filter-group" role="group" aria-label="Liveness filter">
        <span className="network-filter-label">State</span>
        {STATE_OPTIONS.map((opt) => {
          const on = filter.state === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              className={`network-filter-state-btn${on ? " on" : ""}`}
              aria-pressed={on}
              data-state-filter={opt.value}
              onClick={() => onStateChange(opt.value)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div className="network-filter-group" role="group" aria-label="Federation scope filter">
        <span className="network-filter-label">Scope</span>
        {SCOPE_OPTIONS.map((opt) => {
          const on = filter.scope === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              className={`network-filter-scope-btn${on ? " on" : ""}`}
              aria-pressed={on}
              data-scope-filter={opt.value}
              onClick={() => onScopeChange(opt.value)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div className="network-filter-group">
        <label className="network-filter-label" htmlFor="network-capability-filter">
          Capability
        </label>
        <select
          id="network-capability-filter"
          className="network-filter-select"
          value={filter.capability ?? ""}
          aria-label="Filter by capability"
          onChange={(e) =>
            onCapabilityChange(e.target.value === "" ? null : e.target.value)
          }
        >
          <option value="">Any capability</option>
          {capabilityOptions.map((cap) => (
            <option key={cap} value={cap}>
              {cap}
            </option>
          ))}
        </select>
      </div>

      {active && (
        <button
          type="button"
          className="network-filter-clear"
          onClick={onClear}
        >
          Clear filters
        </button>
      )}

      <button
        type="button"
        className="network-filter-spotlight"
        onClick={onOpenSpotlight}
        title="Find an agent (⌘K / Ctrl+K)"
      >
        <span aria-hidden="true">⌕</span> Find agent
        <span className="network-filter-kbd" aria-hidden="true">
          <Keycap>⌘</Keycap>
          <Keycap>K</Keycap>
        </span>
      </button>
    </div>
  );
}
