/**
 * G-1114.B.4 — live agents panel (replaces the Phase A preview stub).
 *
 * Renders the stack-local runtime agent-presence registry: one row per agent
 * with its assistant name, agent id, declared capabilities, online/offline
 * state, and last-heartbeat relative time. Data comes from `GET /api/agents`
 * via `useAgents`; live updates ride the additive `agent.presence` WS frame, so
 * agents pop up on boot and drop off when they go offline — the Phase B
 * value line.
 *
 * This is the simple PANEL. The rich React Flow + ELK topology graph is Phase D
 * (G-1114.D); cross-stack federated peers are Phase E. This view is deliberately
 * stack-local only.
 */

import { useState } from "react";
import type { AgentsState } from "../hooks/use-agents";
import { pickAgentsPanelMode, formatRelativeTime } from "../lib/agents-display";

export interface NetworkPreviewViewProps {
  state: AgentsState;
}

export function NetworkPreviewView({ state }: NetworkPreviewViewProps) {
  // One `now` per render so every row's relative time is computed against the
  // same instant (no row-to-row drift within a paint).
  const [now] = useState(() => Date.now());
  const mode = pickAgentsPanelMode(state);

  return (
    <section
      className="scaffold-section agents-panel-view"
      aria-label="Agents (stack-local presence)"
    >
      <h2>Agents</h2>
      <p className="dim agents-panel-subtitle">
        Stack-local agent <strong>presence</strong> — which agents are up and
        consuming the bus, their declared capabilities, and their liveness. The
        cross-stack topology graph arrives in G-1114.D.
      </p>

      {mode === "error" && (
        <div className="agents-panel-error">⚠ {state.error}</div>
      )}
      {mode === "loading" && (
        <div className="agents-panel-empty">Loading…</div>
      )}
      {mode === "empty" && (
        <div className="agents-panel-empty">No agents observed yet.</div>
      )}
      {mode === "list" && (
        <ul className="agents-panel-list" aria-label="Agents">
          {state.agents.map((a) => (
            <li
              key={a.key}
              className={`agents-panel-row agents-panel-row-${a.state}`}
              data-agent-id={a.agent_id}
              data-state={a.state}
            >
              <div className="agents-panel-identity">
                <span className="agents-panel-name">
                  {a.assistant_name ?? a.agent_id}
                </span>
                <span className="agents-panel-id dim">{a.agent_id}</span>
              </div>
              <div className="agents-panel-caps">
                {a.capabilities.length === 0 ? (
                  <span className="dim">no capabilities declared</span>
                ) : (
                  a.capabilities.map((cap) => (
                    <span key={cap} className="agents-panel-cap">
                      {cap}
                    </span>
                  ))
                )}
              </div>
              <div className="agents-panel-liveness">
                <span
                  className={`agents-panel-state state-${a.state}`}
                  title={
                    a.state === "offline" && a.offline_reason
                      ? `offline: ${a.offline_reason}`
                      : a.state
                  }
                >
                  {a.state}
                </span>
                <span className="agents-panel-heartbeat dim">
                  {formatRelativeTime(a.last_heartbeat_at, now)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
