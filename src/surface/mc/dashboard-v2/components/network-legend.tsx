/**
 * G-1114.D.1 — Network graph legend.
 *
 * A small fixed key explaining the node states the canvas renders: online,
 * offline (graceful), and the distinct TTL-lapse ("no heartbeat" — the agent
 * went silent, possibly crashed) treatment. Pure presentational — no xyflow
 * context — so it renders standalone in tests and inside the canvas alike.
 */

export function NetworkLegend() {
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
    </div>
  );
}
