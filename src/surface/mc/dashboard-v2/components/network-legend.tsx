/**
 * G-1114.D.1 — Network graph legend.
 *
 * A small fixed key explaining the node states the canvas renders: online,
 * offline (graceful), and the distinct TTL-lapse ("no heartbeat" — the agent
 * went silent, possibly crashed) treatment. Pure presentational — no xyflow
 * context — so it renders standalone in tests and inside the canvas alike.
 *
 * #1068 — additionally lists the per-stack COLORS present in the snapshot: one
 * swatch + `{principal}/{stack}` label per stack, using the same deterministic
 * `stackColor` the hubs/agents/edges carry. So the principal can map a color back
 * to a stack at a glance. The stack rows are passed in (derived from the graph)
 * so the legend stays a pure presentational component.
 */

/** One stack entry in the legend: its color swatch + its `{principal}/{stack}` label. */
export interface NetworkLegendStack {
  /** Stable id (the hub node id) — used as the React key. */
  id: string;
  /** Display label, e.g. `andreas/work` or `local`. */
  label: string;
  /** The stack's deterministic color (from `stackColor`). */
  color: string;
}

export interface NetworkLegendProps {
  /** #1068 — the stacks present in the snapshot (one swatch each). Empty → no stack rows. */
  stacks?: readonly NetworkLegendStack[];
}

export function NetworkLegend({ stacks = [] }: NetworkLegendProps) {
  return (
    <div className="network-legend" aria-label="Legend">
      <span className="network-legend-item">
        <span className="network-legend-swatch swatch-online" aria-hidden="true" />
        online
      </span>
      <span className="network-legend-item">
        <span className="network-legend-swatch swatch-offline" aria-hidden="true" />
        offline
      </span>
      <span className="network-legend-item">
        <span
          className="network-legend-swatch swatch-ttl-lapse"
          aria-hidden="true"
        />
        no heartbeat
      </span>
      {stacks.length > 0 && (
        <span className="network-legend-stacks" aria-label="Stacks">
          {stacks.map((s) => (
            <span className="network-legend-item" key={s.id}>
              <span
                className="network-legend-swatch network-legend-swatch-stack"
                style={{ background: s.color }}
                aria-hidden="true"
              />
              {s.label}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
