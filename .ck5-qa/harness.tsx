/**
 * CK-5 browser-QA harness (throwaway — not committed).
 *
 * Mounts the REAL BusTrafficStrip + the REAL federated-edge classes inside a
 * `.mc-skin` container across the three acceptance states so a real browser can
 * verify: (1) live flow animates, (2) zero-flow renders STATIC, (3) toggles
 * actually change the rendered state (the #1070 inert-feature class). Imports the
 * shipped constellation CSS so the skin resolves exactly as in the app.
 */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { BusTrafficStrip } from "../src/surface/mc/dashboard-v2/components/bus-traffic-strip";
import {
  computeTrafficModel,
  idleTrafficModel,
  type TrafficEvent,
} from "../src/surface/mc/dashboard-v2/lib/bus-traffic";
import "../src/surface/mc/dashboard-v2/styles/constellation.css";
import "../src/surface/mc/dashboard-v2/components/constellation-canvas.css";

// An ACTIVE model: mixed D/A/H frames in the last second → ~ real throughput.
const now = 10_000;
const activeEvents: TrafficEvent[] = [
  ...Array.from({ length: 8 }, (_, i) => ({ t: now - i * 60, scope: "d" as const })),
  ...Array.from({ length: 5 }, (_, i) => ({ t: now - i * 90, scope: "a" as const })),
  ...Array.from({ length: 2 }, (_, i) => ({ t: now - i * 120, scope: "h" as const })),
];
const activeModel = computeTrafficModel(activeEvents, now, 5_000);
const idle = idleTrafficModel(5_000);

function FedEdge({ live }: { live: boolean }) {
  return (
    <svg width="220" height="40" style={{ overflow: "visible" }}>
      <path
        d="M 10 20 L 210 20"
        className={live ? "edge-live--fed" : "edge-fed-static"}
        style={{ stroke: "var(--tide)", strokeWidth: 2, fill: "none" }}
      />
    </svg>
  );
}

function Harness() {
  const [live, setLive] = useState(true);
  const [atmo, setAtmo] = useState(true);
  return (
    <div className="mc-skin" style={{ padding: 24, minHeight: "100vh" }}>
      <h3 style={{ color: "var(--fg)", fontFamily: "var(--mono)" }}>CK-5 QA</h3>

      <p style={{ color: "var(--dim)" }}>ACTIVE model — live edge (should MARCH):</p>
      <FedEdge live={true} />
      <div data-qa="strip-active">
        <BusTrafficStrip
          model={activeModel}
          live={live}
          liveTraffic={live}
          atmosphere={atmo}
          onToggleLiveTraffic={setLive}
          onToggleAtmosphere={setAtmo}
        />
      </div>

      <p style={{ color: "var(--dim)", marginTop: 24 }}>
        ZERO-FLOW (idle) — edge STATIC + strip shows &ldquo;no bus activity&rdquo;:
      </p>
      <FedEdge live={false} />
      <div data-qa="strip-idle">
        <BusTrafficStrip
          model={idle}
          live={false}
          liveTraffic={true}
          atmosphere={true}
          onToggleLiveTraffic={() => {}}
          onToggleAtmosphere={() => {}}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
