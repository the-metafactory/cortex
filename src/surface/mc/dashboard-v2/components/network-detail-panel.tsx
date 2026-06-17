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
  classifyOrigin,
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
   * #1008 — the SERVING stack's principal (derived by the view from the snapshot's
   * `"local"`-origin agents via `deriveServingPrincipal`). The panel pairs it with
   * `agent.origin` through `classifyOrigin` to distinguish a SAME-PRINCIPAL local
   * SIBLING (DB-read aggregation) from a CROSS-PRINCIPAL federated peer — so a
   * sibling renders LOCAL here, exactly as it does on the graph node, rather than
   * re-showing the "federated peer" mislabel the binary guard produced. `null`
   * when the snapshot has no local agent (a foreign-only snapshot) → an object
   * origin classifies conservatively as foreign.
   */
  servingPrincipal: string | null;
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
  servingPrincipal,
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
  // #1008: classify against the serving principal — only a CROSS-PRINCIPAL
  // `foreign` peer gets the "federated peer" badge + the "activity not local"
  // treatment. A SAME-PRINCIPAL local `sibling` (DB-read aggregation) renders
  // LOCAL here, matching its graph node — the fix for siblings re-showing the
  // "FEDERATED" mislabel on click-through.
  const category = classifyOrigin(agent.origin, servingPrincipal);
  const foreign = category === "foreign";
  // Provenance (`{principal}/{stack}`) is only surfaced for a true foreign peer;
  // a sibling reads as one of your own agents.
  const provenance = foreign ? originProvenanceLabel(agent.origin) : null;
  // #1008: ONLY the serving stack's OWN agents are locally dispatchable + carry a
  // local working-grid join. A SIBLING agent — though same-principal + LOCAL in
  // label — lives in ANOTHER stack's DB; the dispatch path writes THIS stack's DB
  // + spawns a local subprocess, so it can't target a sibling any more than a
  // foreign peer. So the dispatch-join, working-grid link, and dispatch-direct
  // button gate on `self`, not merely "not foreign". The sibling's own-stack
  // provenance label (for the not-local activity note) is computed unconditionally
  // for the non-self branches.
  const self = category === "self";
  const ownStackLabel = originProvenanceLabel(agent.origin);

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
          E.4 / #909 / #1008: only the SERVING stack's OWN agents carry a local
          working-agents join. A FOREIGN peer OR a same-principal SIBLING agent
          lives on ANOTHER stack — its activity is not in this stack's projection,
          so we show an origin-appropriate "not local" note rather than an empty
          "idle" that would misrepresent a busy peer/sibling. */}
      <section className="network-detail-section network-detail-activity">
        <span className="network-detail-section-label dim">recent activity</span>
        {!self ? (
          <span
            className={
              "network-detail-nonlocal-activity dim" +
              (foreign ? " network-detail-foreign-activity" : " network-detail-sibling-activity")
            }
            data-activity-origin={foreign ? "foreign" : "sibling"}
          >
            {foreign
              ? "Federated peer — activity not local."
              : `Local sibling stack — activity lives on its own stack${ownStackLabel ? ` (${ownStackLabel})` : ""}.`}
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
        {/* The working grid is THIS stack's dispatch surface — the pointer is
            meaningless for a foreign peer (#909) OR a sibling on another stack
            (#1008), so it's shown only for the serving stack's own agents. */}
        {self && onViewInWorkingGrid && (
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
          The SERVING stack's OWN agent gets a confirm-gated "Dispatch to {agent}"
          button that REUSES the existing dispatch path (`POST /api/sessions` with
          `agentId`) — the same confirmation popover the task-row Dispatch uses,
          so no auth/confirm step is bypassed. A FOREIGN peer OR a same-principal
          SIBLING agent CANNOT be dispatched to from here (the dispatch path is
          LOCAL-to-this-stack — it writes THIS stack's DB + spawns a local
          subprocess, so it can't target an agent that lives on another stack),
          so it shows a future-state note rather than a half-working dispatch. */}
      {onDispatchDirect && (
        <section className="network-detail-section network-detail-dispatch-direct">
          <span className="network-detail-section-label dim">dispatch</span>
          {!self ? (
            <span
              className="network-detail-dispatch-direct-foreign dim"
              data-dispatch-direct={foreign ? "foreign-disabled" : "sibling-disabled"}
            >
              {foreign
                ? `Federated peer — direct dispatch happens on its own stack${provenance ? ` (${provenance})` : ""}.`
                : `Local sibling stack — direct dispatch happens on its own stack${ownStackLabel ? ` (${ownStackLabel})` : ""}.`}
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
