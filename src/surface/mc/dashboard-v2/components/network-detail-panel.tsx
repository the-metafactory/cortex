/**
 * G-1114.D.4 — Network node DETAIL PANEL.
 *
 * A PURE side panel that opens when a principal clicks an agent node in the
 * Network graph. It shows that agent's presence + capabilities + a LIGHT
 * dispatch-activity pointer — and nothing else.
 *
 * ## ADR-0007 boundary (load-bearing)
 *
 * This panel renders presence + capabilities + dispatch **lifecycle metadata**
 * ONLY: identity, online/offline state (with the TTL-lapse-vs-graceful
 * distinction), capabilities, last-heartbeat, and — IF the agent is actively
 * dispatched — its current primary task title + priority + active count, joined
 * from the working-agents projection. It NEVER renders session interiors: no
 * prompts, no tool calls, no diffs, no transcripts. Those live in the dispatch
 * surface, behind their own auth, and never enter the network graph. The
 * "recent activity" section is a POINTER (a "view in working grid" link), not a
 * window into the session.
 *
 * ## Why pure
 *
 * The panel takes the resolved agent tile + dispatch activity + callbacks as
 * props (no hooks, no xyflow, no data fetching). That keeps it in the MAIN
 * bundle (it imports only `agents-display` helpers + types — never the
 * xyflow/elk engine, so it doesn't bloat the lazy network-canvas chunk) AND
 * unit-testable under `renderToStaticMarkup` without a DOM, mirroring the
 * network-nodes card inners. The selection/auto-close logic lives in
 * `lib/network-detail-display.ts` (also pure); `network-view` wires the two
 * together against the live `useAgents` snapshot.
 */

import {
  formatRelativeTime,
  formatCapabilities,
  offlineReasonLabel,
  isTtlLapse,
  isForeignOrigin,
  originProvenanceLabel,
} from "../lib/agents-display";
import type { AgentPresenceTile } from "../hooks/use-agents";
import type { AgentDispatchActivity } from "../lib/network-detail-display";
import { DispatchButton } from "./dispatch-button";

/** Match the working-grid priority label (P0–P3, P? out-of-range). */
function priorityLabel(p: number): string {
  if (Number.isInteger(p) && p >= 0 && p <= 3) return `P${p}`;
  return "P?";
}

export interface NetworkDetailPanelProps {
  /** The live, snapshot-resolved agent tile to show. */
  agent: AgentPresenceTile;
  /**
   * The agent's dispatch-lifecycle activity (joined from the working-agents
   * projection), or `null` when the agent isn't actively dispatched (idle).
   * LIFECYCLE METADATA ONLY — never session interiors (ADR-0007).
   */
  dispatch: AgentDispatchActivity | null;
  /** Close the panel (deselect). */
  onClose: () => void;
  /**
   * Jump to the working grid (where the dispatch lifecycle lives in full).
   * Optional — when omitted, the "view in working grid" affordance is hidden.
   */
  onViewInWorkingGrid?: () => void;
  /**
   * G-1114.F.3 — "dispatch direct" affordance. When provided AND the agent is
   * LOCAL, the panel renders a confirm-gated "Dispatch to {agent}" button that
   * calls this back; the caller wires it to the EXISTING dispatch path
   * (`POST /api/sessions` with `agentId`) — F.3 reuses that path, it does not
   * invent a new one. Omitted → no dispatch affordance.
   *
   * A FOREIGN (federated peer) agent NEVER gets the live button: the dispatch
   * path writes to the LOCAL stack's DB + spawns a LOCAL subprocess, so it
   * cannot target a peer principal's agent. The panel shows a disabled
   * "federated peer — direct dispatch via its stack" future-state instead.
   */
  onDispatchDirect?: (agent: AgentPresenceTile) => void;
  /** True while a dispatch-direct request is in flight (disables the button). */
  dispatchBusy?: boolean;
  /**
   * G-1114.F.2 — cross-component hover. The panel reports the hovered target
   * (a capability badge → `{kind:"capability"}`, the agent identity →
   * `{kind:"agent"}`, mouse-leave → `null`) so the view can highlight matching
   * agent nodes in the graph. Optional — omitted disables hover reporting.
   */
  onHoverCapability?: (capability: string | null) => void;
  /** G-1114.F.2 — capabilities to render as HIGHLIGHTED (lit by the active hover). */
  highlightedCapabilities?: ReadonlySet<string>;
  /** Injectable clock for deterministic relative-time tests. */
  now?: number;
}

/**
 * The pure detail panel. Renders nothing privileged: presence + capabilities +
 * a light dispatch pointer. A fixed side panel, closeable.
 */
export function NetworkDetailPanel({
  agent,
  dispatch,
  onClose,
  onViewInWorkingGrid,
  onDispatchDirect,
  dispatchBusy = false,
  onHoverCapability,
  highlightedCapabilities,
  now = Date.now(),
}: NetworkDetailPanelProps) {
  const offline = agent.state === "offline";
  const ttlLapse = offline && isTtlLapse(agent.offline_reason);
  const reasonLabel = offline ? offlineReasonLabel(agent.offline_reason) : null;
  const name = agent.assistant_name ?? agent.agent_id;
  const caps = formatCapabilities(agent.capabilities);
  // E.4: a FOREIGN (federated peer) agent shows its origin + a "activity not
  // local" note instead of a dispatch join (#909 — working-agents is local-only).
  const foreign = isForeignOrigin(agent.origin);
  const provenance = originProvenanceLabel(agent.origin);

  return (
    <aside
      className={
        "network-detail-panel" +
        (ttlLapse ? " network-detail-ttl-lapse" : "") +
        (foreign ? " network-detail-foreign" : "")
      }
      data-agent-id={agent.agent_id}
      data-state={agent.state}
      data-agent-origin={foreign ? "foreign" : "local"}
      aria-label={`Agent detail — ${name}`}
    >
      <header className="network-detail-header">
        <div className="network-detail-identity">
          <span className="network-detail-name">{name}</span>
          <span className="network-detail-id dim">{agent.agent_id}</span>
          {foreign && provenance && (
            <span className="network-detail-provenance" title={`federated peer — ${provenance}`}>
              <span className="network-detail-federated-badge" aria-hidden="true">
                ⇄
              </span>
              federated peer · {provenance}
            </span>
          )}
        </div>
        <button
          type="button"
          className="network-detail-close"
          onClick={onClose}
          aria-label="Close detail panel"
        >
          ✕
        </button>
      </header>

      {/* Presence ----------------------------------------------------------- */}
      <section className="network-detail-section network-detail-presence">
        <span className="network-detail-section-label dim">presence</span>
        <div className="network-detail-liveness">
          <span
            className={`network-detail-state state-${agent.state}`}
            title={offline ? `offline: ${reasonLabel}` : "online"}
          >
            {agent.state}
          </span>
          {offline && (
            <span
              className={
                "network-detail-reason dim" +
                (ttlLapse ? " network-detail-reason-ttl-lapse" : "")
              }
            >
              {reasonLabel}
            </span>
          )}
        </div>
        <span className="network-detail-heartbeat dim">
          {ttlLapse ? "last seen " : "heartbeat "}
          {formatRelativeTime(agent.last_heartbeat_at, now)}
        </span>
      </section>

      {/* Capabilities ------------------------------------------------------- */}
      <section className="network-detail-section network-detail-caps-section">
        <span className="network-detail-section-label dim">capabilities</span>
        <div className="network-detail-caps">
          {caps.map((badge, i) =>
            badge.placeholder ? (
              <span key="__none__" className="network-detail-cap-none dim">
                {badge.label}
              </span>
            ) : (
              // F.2 — each real capability badge is a hover target: entering it
              // reports the capability up so the view lights every agent node
              // that declares it; leaving clears. `highlightedCapabilities`
              // marks a badge lit when a sibling hover (e.g. an agent-node
              // hover) selected this capability.
              <span
                key={`${badge.label}-${i}`}
                className={
                  "network-detail-cap" +
                  (highlightedCapabilities?.has(badge.label)
                    ? " network-detail-cap-highlighted"
                    : "")
                }
                data-capability={badge.label}
                onMouseEnter={
                  onHoverCapability
                    ? () => onHoverCapability(badge.label)
                    : undefined
                }
                onMouseLeave={
                  onHoverCapability ? () => onHoverCapability(null) : undefined
                }
              >
                {badge.label}
              </span>
            ),
          )}
        </div>
      </section>

      {/* Dispatch lifecycle (LIGHT — pointer only, never interiors) ---------
          E.4 / #909: a FOREIGN peer agent shows NO local dispatch activity —
          working-agents is the LOCAL stack's projection, never joined for a
          foreign agent. The principal sees that the activity simply isn't local,
          not an empty "idle" that would misrepresent a busy peer. */}
      <section className="network-detail-section network-detail-activity">
        <span className="network-detail-section-label dim">recent activity</span>
        {foreign ? (
          <span className="network-detail-foreign-activity dim">
            Federated peer — activity not local.
          </span>
        ) : dispatch ? (
          <div className="network-detail-dispatch">
            <div className="network-detail-dispatch-line">
              <span
                className={`network-detail-dispatch-state state-${dispatch.primaryState}`}
              >
                {dispatch.primaryState}
              </span>
              <span className="network-detail-dispatch-priority dim">
                {priorityLabel(dispatch.taskPriority)}
              </span>
              <span className="network-detail-dispatch-task">
                {dispatch.taskTitle}
              </span>
            </div>
            {dispatch.additionalActiveCount > 0 && (
              <span className="network-detail-dispatch-more dim">
                +{dispatch.additionalActiveCount} more active
              </span>
            )}
            <span className="network-detail-dispatch-updated dim">
              updated {formatRelativeTime(Date.parse(dispatch.updatedAt), now)}
            </span>
          </div>
        ) : (
          <span className="network-detail-dispatch-idle dim">
            No active dispatch.
          </span>
        )}
        {/* The working grid is the LOCAL stack's dispatch surface — the pointer
            is meaningless for a foreign peer agent (#909), so it's hidden. */}
        {!foreign && onViewInWorkingGrid && (
          <button
            type="button"
            className="network-detail-grid-link"
            onClick={onViewInWorkingGrid}
          >
            View in working grid →
          </button>
        )}
      </section>

      {/* Dispatch direct (F.3) ---------------------------------------------
          A LOCAL agent gets a confirm-gated "Dispatch to {agent}" button that
          REUSES the existing dispatch path (`POST /api/sessions` with
          `agentId`) — the same confirmation popover the task-row Dispatch uses,
          so no auth/confirm step is bypassed. A FOREIGN peer agent CANNOT be
          dispatched to from here (the dispatch path is LOCAL-only — it writes
          this stack's DB + spawns a local subprocess), so it shows a disabled
          future-state rather than a half-working cross-principal dispatch. */}
      {onDispatchDirect && (
        <section className="network-detail-section network-detail-dispatch-direct">
          <span className="network-detail-section-label dim">dispatch</span>
          {foreign ? (
            <span
              className="network-detail-dispatch-direct-foreign dim"
              data-dispatch-direct="foreign-disabled"
            >
              Federated peer — direct dispatch happens on its own stack
              {provenance ? ` (${provenance})` : ""}.
            </span>
          ) : (
            <DispatchButton
              className="network-detail-dispatch-direct-btn"
              agentLabel={name}
              busy={dispatchBusy}
              onConfirm={() => onDispatchDirect(agent)}
            />
          )}
        </section>
      )}

      {/*
        ADR-0007 boundary: this panel intentionally stops here. It shows
        presence + capabilities + dispatch LIFECYCLE METADATA (state, task,
        priority, counts) and a pointer to the working grid — NEVER session
        interiors (prompts, tool calls, diffs, transcripts). Those never enter
        the network graph.
      */}
    </aside>
  );
}
