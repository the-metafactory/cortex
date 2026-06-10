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
import {
  pickAgentsPanelMode,
  formatRelativeTime,
  formatCapabilities,
  offlineReasonLabel,
  isTtlLapse,
} from "../lib/agents-display";

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
          {state.agents.map((a) => {
            const offline = a.state === "offline";
            const ttlLapse = offline && isTtlLapse(a.offline_reason);
            // The offline qualifier shown beside the OFFLINE label: a graceful
            // reason ("shut down") or the inferred TTL lapse ("no heartbeat").
            const reasonLabel = offline
              ? offlineReasonLabel(a.offline_reason)
              : null;
            return (
              <li
                key={a.key}
                className={
                  `agents-panel-row agents-panel-row-${a.state}` +
                  (ttlLapse ? " agents-panel-row-ttl-lapse" : "")
                }
                data-agent-id={a.agent_id}
                data-state={a.state}
                data-offline-reason={offline ? (a.offline_reason ?? "") : undefined}
                aria-label={`${a.assistant_name ?? a.agent_id} — ${
                  offline ? `offline (${reasonLabel})` : "online"
                }`}
              >
                <div className="agents-panel-identity">
                  <span className="agents-panel-name">
                    {a.assistant_name ?? a.agent_id}
                  </span>
                  <span className="agents-panel-id dim">{a.agent_id}</span>
                </div>
                <div className="agents-panel-caps">
                  {formatCapabilities(a.capabilities).map((badge, i) =>
                    badge.placeholder ? (
                      <span key="__none__" className="agents-panel-cap-none dim">
                        {badge.label}
                      </span>
                    ) : (
                      // Key on label+index: the capability schema doesn't enforce
                      // uniqueness, so a duplicate label must not collide on the key.
                      <span key={`${badge.label}-${i}`} className="agents-panel-cap">
                        {badge.label}
                      </span>
                    )
                  )}
                </div>
                <div className="agents-panel-liveness">
                  <span
                    className={`agents-panel-state state-${a.state}`}
                    title={offline ? `offline: ${reasonLabel}` : "online"}
                  >
                    {a.state}
                  </span>
                  {offline && (
                    <span
                      className={
                        "agents-panel-reason dim" +
                        (ttlLapse ? " agents-panel-reason-ttl-lapse" : "")
                      }
                    >
                      {reasonLabel}
                    </span>
                  )}
                  <span className="agents-panel-heartbeat dim">
                    {/* For a TTL-lapse the last heartbeat is the "last seen"
                        signal the principal cares about ("last seen 6m ago"). */}
                    {ttlLapse ? "last seen " : ""}
                    {formatRelativeTime(a.last_heartbeat_at, now)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
