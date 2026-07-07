/**
 * CK-5 (cortex#1292) — the bottom BUS TRAFFIC STRIP (mockup @505).
 *
 * Renders throughput (`env/s`) + the D/A/H scope-count legend + a live-flow
 * ticker, all off the SAME `BusTrafficModel` the canvas dash-flow and atmosphere
 * consume — never a second feed (decision D-10). Pure presentational: the model,
 * the `live` gate, and the reduced-motion flag come in as props.
 *
 * TRUTH-NOT-THEATER (invariant 2): when the model is idle (`!active`) — or the
 * principal has liveTraffic off, or the OS asked for reduced motion — the strip
 * shows a STATIC "no bus activity" state with no ticker animation. Motion is
 * never fabricated.
 */

import type { BusTrafficModel, TrafficScope } from "../lib/bus-traffic";
import { formatThroughput } from "../lib/bus-traffic";

export interface BusTrafficStripProps {
  /** The aggregate model from `useBusTraffic`. */
  model: BusTrafficModel;
  /**
   * Whether motion is permitted: liveTraffic toggle ON ∧ not reduced-motion. The
   * ticker only animates when this is true AND the model is `active`.
   */
  live: boolean;
  /** liveTraffic toggle state (for the control button label / pressed state). */
  liveTraffic: boolean;
  /** atmosphere toggle state. */
  atmosphere: boolean;
  onToggleLiveTraffic: (next: boolean) => void;
  onToggleAtmosphere: (next: boolean) => void;
}

const SCOPE_META: Record<TrafficScope, { label: string; title: string }> = {
  d: { label: "D", title: "Deterministic — system / state envelopes" },
  a: { label: "A", title: "Agentic — agent / session / dispatch activity" },
  h: { label: "H", title: "Human — attention / approval / governance" },
};

export function BusTrafficStrip({
  model,
  live,
  liveTraffic,
  atmosphere,
  onToggleLiveTraffic,
  onToggleAtmosphere,
}: BusTrafficStripProps) {
  const flowing = live && model.active;

  return (
    <div
      className="mc-bus-strip"
      data-active={model.active ? "true" : "false"}
      data-live={flowing ? "true" : "false"}
      aria-label="Bus traffic"
      role="group"
    >
      {/* Throughput readout — the honest env/s. */}
      <span className="mc-bus-throughput" aria-live="polite">
        <span className="mc-bus-metric-value" data-testid="bus-throughput">
          {formatThroughput(model)}
        </span>
      </span>

      {/* Live-flow ticker: a marching pip lane that only moves when real flow is
          present AND motion is permitted. Idle ⇒ a static "no bus activity" pip. */}
      <span
        className="mc-bus-ticker"
        data-flowing={flowing ? "true" : "false"}
        aria-hidden="true"
      >
        {flowing ? (
          <span className="mc-bus-ticker-track">
            {/* Two copies so the -50% translate loops seamlessly (ticker keyframe). */}
            <span className="mc-bus-ticker-run">{"· ".repeat(24)}</span>
            <span className="mc-bus-ticker-run">{"· ".repeat(24)}</span>
          </span>
        ) : (
          <span className="mc-bus-ticker-idle">no bus activity</span>
        )}
      </span>

      {/* D/A/H scope-count legend — same buckets as the constellation attention
          coding, colored by the --d/--a/--h tokens. */}
      <span className="mc-bus-scopes" aria-label="Scope counts">
        {(Object.keys(SCOPE_META) as TrafficScope[]).map((s) => (
          <span
            key={s}
            className={`mc-bus-scope mc-bus-scope-${s}`}
            title={SCOPE_META[s].title}
            data-testid={`bus-scope-${s}`}
          >
            <span className="mc-bus-scope-key" aria-hidden="true" />
            <span className="mc-bus-scope-label">{SCOPE_META[s].label}</span>
            <span className="mc-bus-scope-count">{model.counts[s]}</span>
          </span>
        ))}
      </span>

      {/* Motion toggles — liveTraffic + atmosphere. Buttons, not switches, so
          they carry aria-pressed for the toggle semantics. */}
      <span className="mc-bus-toggles">
        <button
          type="button"
          className="mc-bus-toggle"
          aria-pressed={liveTraffic}
          onClick={() => onToggleLiveTraffic(!liveTraffic)}
          title="Animate edges + ticker from real bus flow"
        >
          live traffic
        </button>
        <button
          type="button"
          className="mc-bus-toggle"
          aria-pressed={atmosphere}
          onClick={() => onToggleAtmosphere(!atmosphere)}
          title="Atmospheric glow layer behind the constellation"
        >
          atmosphere
        </button>
      </span>
    </div>
  );
}
