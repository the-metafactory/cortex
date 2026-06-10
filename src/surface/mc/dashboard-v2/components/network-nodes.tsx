/**
 * G-1114.D.1 — custom React Flow node components for the Network graph.
 *
 * Two node types: the synthetic **stack-hub** (the layout centre, labelled
 * `{principal}/{stack}`) and the **agent** card (identity + capability chips +
 * online/offline state with the TTL-lapse-vs-graceful distinction + last
 * heartbeat). The agent card reuses the SAME display helpers + class-name
 * language as the C.4 panel (`agents-display.ts`) so the graph and the legacy
 * panel read identically.
 *
 * ## Why each node is split inner / wrapper
 *
 * xyflow's `<Handle>` requires the ReactFlow zustand provider in its ancestry,
 * so it can't render under `renderToStaticMarkup` (the test env has no DOM /
 * provider). Each node is therefore split:
 *   - a PURE presentational inner (`AgentNodeCard` / `StackHubCard`) — just the
 *     card markup, no `Handle` — which the tests render directly; and
 *   - a thin wrapper (`AgentNode` / `StackHubNode`) the canvas registers, which
 *     adds the connection `Handle`s and delegates to the inner.
 *
 * ADR-0007: the card shows presence + lifecycle only (identity, capabilities,
 * state, reason, heartbeat) — NEVER session interiors.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  formatRelativeTime,
  formatCapabilities,
  offlineReasonLabel,
  isTtlLapse,
  isForeignOrigin,
  originProvenanceLabel,
} from "../lib/agents-display";
import type {
  AgentNodeData,
  StackHubNodeData,
} from "../lib/network-graph-adapter";
import { isAgentHighlighted } from "../lib/capability-highlight";
import { useNetworkHover } from "../lib/network-hover-context";

// --- Stack hub -------------------------------------------------------------

export interface StackHubCardProps {
  data: StackHubNodeData;
}

/** Pure presentational stack-hub card (no `Handle`; unit-testable). */
export function StackHubCard({ data }: StackHubCardProps) {
  const label =
    data.principal && data.stack
      ? `${data.principal}/${data.stack}`
      : (data.stack ?? data.principal ?? "stack");
  // E.4: a FOREIGN (federated peer) hub renders distinctly from YOUR local hub —
  // a "federated" eyebrow + a dimmer/bordered treatment via the modifier class.
  const foreign = isForeignOrigin(data.origin);
  return (
    <div
      className={
        "network-node network-node-hub" +
        (foreign ? " network-node-hub-foreign" : " network-node-hub-local")
      }
      data-node-kind="stack-hub"
      data-hub-origin={foreign ? "foreign" : "local"}
    >
      <span className="network-hub-eyebrow dim">
        {foreign ? "federated stack" : "stack"}
      </span>
      <span className="network-hub-label">{label}</span>
      <span className="network-hub-count dim">
        {data.agentCount} agent{data.agentCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/** xyflow node wrapper for the stack hub — adds the source handle. */
export function StackHubNode({ data }: NodeProps) {
  return (
    <>
      <StackHubCard data={data as unknown as StackHubNodeData} />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
      />
    </>
  );
}

// --- Agent -----------------------------------------------------------------

export interface AgentNodeCardProps {
  data: AgentNodeData;
  /** Injectable clock for deterministic relative-time tests. */
  now?: number;
  /**
   * G-1114.F.2 — true when this agent is lit by the active cross-component
   * hover (e.g. the principal hovered a capability this agent declares).
   * Defaults false; pure prop so the card stays unit-testable.
   */
  highlighted?: boolean;
  /** G-1114.F.2 — capabilities to render lit (the hovered capability). */
  highlightedCapabilities?: ReadonlySet<string>;
  /** G-1114.F.2 — report a capability-badge hover up (or `null` on leave). */
  onHoverCapability?: (capability: string | null) => void;
  /** G-1114.F.2 — report an agent hover up (or `null` on leave). */
  onHoverAgent?: (agentKey: string | null) => void;
}

/** Pure presentational agent card (no `Handle`; unit-testable). */
export function AgentNodeCard({
  data,
  now = Date.now(),
  highlighted = false,
  highlightedCapabilities,
  onHoverCapability,
  onHoverAgent,
}: AgentNodeCardProps) {
  const offline = data.state === "offline";
  const ttlLapse = offline && isTtlLapse(data.offlineReason);
  const reasonLabel = offline ? offlineReasonLabel(data.offlineReason) : null;
  const name = data.assistantName ?? data.agentId;
  // E.4: a FOREIGN agent renders distinctly — a "federated" border/dimmer
  // treatment (modifier class) + a provenance badge (`jc/research`) showing where
  // the peer agent actually lives.
  const foreign = isForeignOrigin(data.origin);
  const provenance = originProvenanceLabel(data.origin);

  return (
    <div
      className={
        `network-node network-node-agent network-node-${data.state}` +
        (ttlLapse ? " network-node-ttl-lapse" : "") +
        (foreign ? " network-node-foreign" : "") +
        (highlighted ? " network-node-highlighted" : "")
      }
      data-node-kind="agent"
      data-agent-id={data.agentId}
      data-state={data.state}
      data-agent-origin={foreign ? "foreign" : "local"}
      data-highlighted={highlighted ? "true" : undefined}
      data-offline-reason={offline ? (data.offlineReason ?? "") : undefined}
      aria-label={
        `${name} — ${offline ? `offline (${reasonLabel})` : "online"}` +
        (provenance ? ` — federated peer ${provenance}` : "")
      }
      onMouseEnter={onHoverAgent ? () => onHoverAgent(data.key) : undefined}
      onMouseLeave={onHoverAgent ? () => onHoverAgent(null) : undefined}
    >
      <div className="network-node-identity">
        <span className="network-node-name">{name}</span>
        <span className="network-node-id dim">{data.agentId}</span>
        {foreign && provenance && (
          <span className="network-node-provenance" title={`federated peer — ${provenance}`}>
            <span className="network-node-federated-badge" aria-hidden="true">
              ⇄
            </span>
            {provenance}
          </span>
        )}
      </div>

      <div className="network-node-caps">
        {formatCapabilities(data.capabilities).map((badge, i) =>
          badge.placeholder ? (
            <span key="__none__" className="network-node-cap-none dim">
              {badge.label}
            </span>
          ) : (
            <span
              key={`${badge.label}-${i}`}
              className={
                "network-node-cap" +
                (highlightedCapabilities?.has(badge.label)
                  ? " network-node-cap-highlighted"
                  : "")
              }
              data-capability={badge.label}
              onMouseEnter={
                onHoverCapability
                  ? (e) => {
                      // The badge hover is more specific than the card hover —
                      // stop the card's onMouseEnter from also firing an agent
                      // hover that would clobber the capability target.
                      e.stopPropagation();
                      onHoverCapability(badge.label);
                    }
                  : undefined
              }
              onMouseLeave={
                onHoverCapability
                  ? (e) => {
                      e.stopPropagation();
                      onHoverCapability(null);
                    }
                  : undefined
              }
            >
              {badge.label}
            </span>
          ),
        )}
      </div>

      <div className="network-node-liveness">
        <span
          className={`network-node-state state-${data.state}`}
          title={offline ? `offline: ${reasonLabel}` : "online"}
        >
          {data.state}
        </span>
        {offline && (
          <span
            className={
              "network-node-reason dim" +
              (ttlLapse ? " network-node-reason-ttl-lapse" : "")
            }
          >
            {reasonLabel}
          </span>
        )}
        <span className="network-node-heartbeat dim">
          {ttlLapse ? "last seen " : ""}
          {formatRelativeTime(data.lastHeartbeatAt, now)}
        </span>
      </div>
    </div>
  );
}

/** xyflow node wrapper for an agent — adds the target handle + F.2 hover wiring.
 *
 * xyflow constructs node components itself, so highlight can't be prop-drilled
 * in; the wrapper reads the shared hover context (main bundle) and projects the
 * highlight + hover callbacks onto the pure card. */
export function AgentNode({ data }: NodeProps) {
  const agentData = data as unknown as AgentNodeData;
  const { highlight, setHoverTarget } = useNetworkHover();
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <AgentNodeCard
        data={agentData}
        highlighted={isAgentHighlighted(highlight, agentData.key)}
        highlightedCapabilities={
          // Only pass lit caps when SOME capability is lit, so a resting render
          // doesn't allocate per node.
          highlight.capabilities.size > 0 ? highlight.capabilities : undefined
        }
        onHoverCapability={(cap) =>
          setHoverTarget(cap === null ? null : { kind: "capability", capability: cap })
        }
        onHoverAgent={(key) =>
          setHoverTarget(key === null ? null : { kind: "agent", agentKey: key })
        }
      />
    </>
  );
}
