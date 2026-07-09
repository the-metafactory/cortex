/**
 * G-1114.D.1 — custom React Flow node components for the Network graph.
 *
 * MC-D1 (netui-constellation) — these nodes render as glowing CIRCLES (an orb +
 * a label BELOW it), not cards/boxes: the star-map aesthetic. The stack-hub is a
 * larger bright cyan core with a "◦ YOU ARE HERE" pill on the serving stack; the
 * agents are smaller teal orbs ringed around it. The circle + glow live in
 * `constellation-canvas.css` (`.network-node-orb`, keyed by `data-state` /
 * origin / attention). The DOM still carries EVERY data attribute + class + text
 * the presence model needs (identity, capabilities, state, reason, heartbeat) —
 * this is a restyle, not a re-model — so the C.4 display language + tests hold.
 *
 * Two node types: the synthetic **stack-hub** (the cluster core, labelled
 * `{principal}/{stack}`) and the **agent** orb (identity + capability chips +
 * online/offline state with the TTL-lapse-vs-graceful distinction + last
 * heartbeat). Both reuse the SAME display helpers + class-name language as the
 * C.4 panel (`agents-display.ts`).
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

import type { CSSProperties } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  formatRelativeTime,
  formatCapabilities,
  offlineReasonLabel,
  isTtlLapse,
  classifyOrigin,
  isLocalCategory,
  originProvenanceLabel,
} from "../lib/agents-display";
import type {
  AgentNodeData,
  StackHubNodeData,
  FederatedPeerNodeData,
} from "../lib/network-graph-adapter";
import { isAgentHighlighted } from "../lib/capability-highlight";
import { useNetworkHover } from "../lib/network-hover-context";
import {
  hasSubtreeSelection,
  isInSubtreeHighlight,
} from "../lib/network-subtree-highlight";
import { verdictBadge, formatRtt } from "../lib/network-transport-overlay";
import { federatedAbsenceReason } from "../lib/network-membership-adapter";

// --- Stack hub -------------------------------------------------------------

export interface StackHubCardProps {
  data: StackHubNodeData;
  /**
   * #1068 — true when THIS hub is the selected one (its subtree is highlighted).
   * Drives `aria-pressed`/`data-selected` + the emphasis outline. Defaults false.
   */
  selected?: boolean;
  /**
   * #1068 — true when SOME OTHER hub is selected, so this hub is outside the
   * active subtree and should DIM. Conveyed by opacity, not hue (a11y). Defaults
   * false (no selection → no dimming).
   */
  dimmed?: boolean;
  /**
   * #1068 — toggle this hub's selection on click / Enter / Space. Wired by the
   * node wrapper to the hover context; omitted in isolation tests (the card then
   * renders without the interactive affordance).
   */
  onToggleSelect?: () => void;
}

/** Pure presentational stack-hub card (no `Handle`; unit-testable). */
export function StackHubCard({
  data,
  selected = false,
  dimmed = false,
  onToggleSelect,
}: StackHubCardProps) {
  const label =
    data.principal && data.stack
      ? `${data.principal}/${data.stack}`
      : (data.stack ?? data.principal ?? "stack");
  // #1008: classify against the serving principal — `self`/`sibling` are LOCAL
  // (same principal, same box; a sibling reached via DB-read aggregation), only
  // a CROSS-PRINCIPAL `foreign` peer is "federated". This is the fix for local
  // siblings mislabeled "FEDERATED STACK": a sibling now renders as a "stack"
  // hub with the local visual, identical to your own stack's treatment.
  const category = classifyOrigin(data.origin, data.servingPrincipal);
  const foreign = !isLocalCategory(category);
  // MC-D3 (#1290) — the SELF stack (the serving stack, `origin === "local"`) is
  // the constellation's "● YOU ARE HERE" anchor. Only the serving stack — NOT a
  // same-principal sibling (DB-read aggregation) — earns the anchor, so it gates
  // on the literal local origin, not `isLocalCategory` (which also covers
  // siblings). Presence-level marker; renders in any context, styled as the
  // glowing anchor only under `.mc-skin`.
  const isSelfStack = data.origin === "local";
  // U2.3 — signal's intent⋈reality verdict for this stack (present only when the
  // transport overlay is on AND signal observed it). Taken verbatim from signal.
  const badge =
    data.transportVerdict !== undefined ? verdictBadge(data.transportVerdict) : null;
  // #1089 P4 — signal-OPTIONAL liveness enrichment. WHEN signal is present its
  // folded transport verdict keys two hub treatments (OQ4); when signal is absent
  // `transportVerdict` is undefined and BOTH stay false, so the hub renders purely
  // from cortex's own federated presence — strictly additive, no signal dependency.
  //   - `registered-absent` (registered, no live leaf) → MUTE the hub: render it
  //     (the principal wants to see WHO is on the network, live or not — OQ4: muted,
  //     not omitted), but dimmed so a transport-dead peer doesn't read as live.
  //   - `unregistered-present` (a live leaf with no registry entry — reality \ intent)
  //     → flag an ANOMALY: the security-relevant case gets an explicit affordance
  //     beyond the alert badge so the Network view can surface it distinctly.
  // Muting/anomaly are conveyed by class + `data-*` (opacity/treatment), never hue
  // alone (a11y). `connected` is healthy → neither.
  const transportMuted = data.transportVerdict === "registered-absent";
  const transportAnomaly = data.transportVerdict === "unregistered-present";
  // #1068 — the hub is a toggle button for its subtree selection. When
  // interactive (a toggle handler is wired), it's focusable + Enter/Space
  // activates it; the selected/dimmed state is on `aria-pressed` + `data-*` +
  // opacity/outline (never hue alone — a11y).
  const interactive = onToggleSelect !== undefined;
  return (
    <div
      className={
        "network-node network-node-hub" +
        (foreign ? " network-node-hub-foreign" : " network-node-hub-local") +
        ` network-node-hub-${category}` +
        (selected ? " network-node-selected" : "") +
        (dimmed ? " network-node-dimmed" : "") +
        // #1089 P4 — signal-optional transport treatments (additive; only when a
        // verdict is folded in). registered-absent → muted, unregistered-present → anomaly.
        (transportMuted ? " network-node-hub-muted" : "") +
        (transportAnomaly ? " network-node-hub-anomaly" : "")
      }
      // #1068 — the stack's deterministic color, exposed as a CSS custom property
      // the hub styling references for its accent/border. ADDITIVE: the shape
      // treatments (solid/dashed border, eyebrow) come from the classes above.
      style={{ "--stack-color": data.stackColor } as CSSProperties}
      data-node-kind="stack-hub"
      data-stack-color={data.stackColor}
      data-hub-origin={foreign ? "foreign" : "local"}
      data-hub-category={category}
      data-selected={selected ? "true" : undefined}
      data-dimmed={dimmed ? "true" : undefined}
      data-transport-verdict={data.transportVerdict ?? undefined}
      // #1089 P4 — a11y/automation can read the transport treatment off the hub
      // without relying on colour. Undefined (no `true`) when signal is absent.
      data-transport-muted={transportMuted ? "true" : undefined}
      data-transport-anomaly={transportAnomaly ? "true" : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? selected : undefined}
      aria-label={
        interactive
          ? `${label} stack — ${selected ? "selected; activate to clear" : "activate to highlight its agents"}`
          : undefined
      }
      onClick={onToggleSelect}
      onKeyDown={
        interactive
          ? (e) => {
              // Enter/Space toggles the subtree selection (keyboard a11y). Stop
              // Space from scrolling the canvas.
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggleSelect();
              }
            }
          : undefined
      }
    >
      {/* MC-D1 — the "◦ YOU ARE HERE" pill floats ABOVE the hub orb. */}
      {isSelfStack && (
        <span className="network-hub-you-are-here" data-you-are-here="true">
          <span aria-hidden="true">◦</span> YOU ARE HERE
        </span>
      )}
      {/* MC-D1 — the glowing hub core: a bright cyan circle with a thin ring and
          a centred diamond glyph. The glow hue is the inline `--stack-color`. */}
      <span className="network-node-orb network-node-orb-hub" aria-hidden="true">
        <span className="network-node-orb-glyph">◆</span>
      </span>
      {/* MC-D1 — label block BELOW the orb: eyebrow · name · sub-count. */}
      <span className="network-node-below">
        <span className="network-hub-eyebrow dim">
          {foreign ? "federated stack" : "stack"}
        </span>
        <span className="network-hub-label">{label}</span>
        {badge && (
          <span
            className={badge.className}
            data-verdict={badge.verdict}
            data-severity={badge.severity}
            title={badge.title}
          >
            {badge.label}
          </span>
        )}
        <span className="network-hub-count dim">
          {data.agentCount} agent{data.agentCount === 1 ? "" : "s"}
        </span>
      </span>
    </div>
  );
}

/** xyflow node wrapper for the stack hub — adds the source handle + #1068 the
 * subtree-selection wiring (read off the shared hover context, same as the agent
 * wrapper reads the capability highlight). */
export function StackHubNode({ id, data }: NodeProps) {
  const { selection, toggleHubSelection } = useNetworkHover();
  const selected = selection.selectedHubId === id;
  // Dim a NON-selected hub only when SOME hub is selected (a selection is active
  // and this hub isn't in its subtree — a hub is never inside another hub's).
  const dimmed = hasSubtreeSelection(selection) && !selected;
  return (
    <>
      <StackHubCard
        data={data as unknown as StackHubNodeData}
        selected={selected}
        dimmed={dimmed}
        onToggleSelect={() => toggleHubSelection(id)}
      />
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
  /**
   * #1068 — true when this agent is in the SELECTED hub's subtree (emphasized).
   * Distinct from the capability-hover `highlighted`; both end up emphasizing the
   * card. Defaults false.
   */
  subtreeEmphasized?: boolean;
  /**
   * #1068 — true when a hub subtree is selected and this agent is OUTSIDE it, so
   * it DIMS. Conveyed by opacity (a11y — not hue). Defaults false.
   */
  dimmed?: boolean;
}

/** Pure presentational agent card (no `Handle`; unit-testable). */
export function AgentNodeCard({
  data,
  now = Date.now(),
  highlighted = false,
  highlightedCapabilities,
  onHoverCapability,
  onHoverAgent,
  subtreeEmphasized = false,
  dimmed = false,
}: AgentNodeCardProps) {
  const offline = data.state === "offline";
  const ttlLapse = offline && isTtlLapse(data.offlineReason);
  const reasonLabel = offline ? offlineReasonLabel(data.offlineReason) : null;
  const name = data.assistantName ?? data.agentId;
  // #1008: classify against the serving principal. Only a CROSS-PRINCIPAL
  // `foreign` peer renders distinctly (dashed border + "federated peer" badge);
  // a SAME-PRINCIPAL local `sibling` (DB-read aggregation) renders LOCAL like
  // your own agents — it is the principal's own stack, not a federation.
  const category = classifyOrigin(data.origin, data.servingPrincipal);
  const foreign = category === "foreign";
  // The provenance label (`{principal}/{stack}`) is only surfaced for a true
  // foreign peer — a local sibling reads as one of your own agents.
  const provenance = foreign ? originProvenanceLabel(data.origin) : null;

  return (
    <div
      className={
        `network-node network-node-agent network-node-${data.state}` +
        (ttlLapse ? " network-node-ttl-lapse" : "") +
        (foreign ? " network-node-foreign" : "") +
        (highlighted ? " network-node-highlighted" : "") +
        (subtreeEmphasized ? " network-node-selected" : "") +
        (dimmed ? " network-node-dimmed" : "")
      }
      // #1068 — the agent shares its stack's color (same as its hub), exposed as
      // `--stack-color` and applied as a left accent border, grouping the card
      // with its hub. ADDITIVE over the foreign dashed-border treatment.
      style={{ "--stack-color": data.stackColor } as CSSProperties}
      data-node-kind="agent"
      data-agent-id={data.agentId}
      data-state={data.state}
      data-stack-color={data.stackColor}
      data-agent-origin={foreign ? "foreign" : "local"}
      data-agent-category={category}
      data-highlighted={highlighted ? "true" : undefined}
      data-selected={subtreeEmphasized ? "true" : undefined}
      data-dimmed={dimmed ? "true" : undefined}
      data-offline-reason={offline ? (data.offlineReason ?? "") : undefined}
      aria-label={
        `${name} — ${offline ? `offline (${reasonLabel})` : "online"}` +
        (provenance ? ` — federated peer ${provenance}` : "")
      }
      onMouseEnter={onHoverAgent ? () => onHoverAgent(data.key) : undefined}
      onMouseLeave={onHoverAgent ? () => onHoverAgent(null) : undefined}
    >
      {/* MC-D1 — the agent orb: a small teal circle with a thin glowing ring.
          online = bright ring + pulse; offline/ttl-lapse = dimmed/amber (keyed
          off the wrapper's `network-node-{state}` / `-ttl-lapse` classes in CSS).
          The "!" attention dot surfaces a TTL-lapse (silent drop). */}
      <span className="network-node-orb network-node-orb-agent" aria-hidden="true">
        {ttlLapse && <span className="network-node-attention">!</span>}
      </span>
      <div className="network-node-below">
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
        {/* U2.3 — leaf liveness + RTT from signal's transport roster (overlay on
            + signal observed this stack). Sourced from signal, never re-derived. */}
        {data.transportLeaf !== undefined && (
          <span
            className={
              "network-node-leaf" +
              (data.transportLeaf.present
                ? " network-node-leaf-present"
                : " network-node-leaf-absent")
            }
            data-leaf-present={data.transportLeaf.present ? "true" : "false"}
            data-leaf-rtt={data.transportLeaf.rttMs ?? undefined}
            title={
              data.transportLeaf.present
                ? `leaf live — RTT ${formatRtt(data.transportLeaf.rttMs)}`
                : "leaf not present"
            }
          >
            {data.transportLeaf.present
              ? `leaf ${formatRtt(data.transportLeaf.rttMs)}`
              : "no leaf"}
          </span>
        )}
      </div>
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
  const { highlight, setHoverTarget, selection } = useNetworkHover();
  // #1068 — subtree selection: this agent is EMPHASIZED when it's in the selected
  // hub's subtree, DIMMED when a hub is selected and this agent is outside it.
  const inSubtree = isInSubtreeHighlight(selection, agentData.key);
  const subtreeActive = hasSubtreeSelection(selection);
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
        subtreeEmphasized={subtreeActive && inSubtree}
        dimmed={subtreeActive && !inSubtree}
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

// --- Federated peer (MC-D4: absent admitted peer) --------------------------

export interface FederatedPeerCardProps {
  data: FederatedPeerNodeData;
}

/**
 * MC-D4 — pure presentational card for an ABSENT admitted federated peer.
 *
 * The peer principal is on the network roster (admitted) but has NO present agent
 * tile. MC-D4 vis2 makes it clearly VISIBLE + DISTINCT (its first cut was a faint
 * ~0.6-opacity grey dot that vanished on the near-black canvas): the orb now
 * carries a DASHED ring in a desaturated federation-accent (violet/indigo —
 * distinct from the bright-cyan local hub and every per-stack color), a subtle
 * glow, a cross-network glyph (`⇄`), and a `federated · absent` sublabel above the
 * peer principal. It reads as "you are federated with this principal; their stack
 * just isn't live right now" — deliberately NOT a local agent circle.
 *
 * Presence-level only (ADR-0007): identity + membership verdict, never a session
 * interior. Not interactive — an absent peer has nothing local to open. Split
 * inner/wrapper like the other nodes (the wrapper adds the xyflow `Handle`).
 */
export function FederatedPeerCard({ data }: FederatedPeerCardProps) {
  // FS-6 (cortex#1821) — the honest absence reason (offline vs unheard) drives
  // the eyebrow + a tone class, so an admitted peer we are DEAF to (unheard —
  // import/cred gap) reads distinct from a peer that merely went offline.
  const reason = federatedAbsenceReason(data.verdict);
  return (
    <div
      className={`network-node network-node-fed-peer network-node-fed-peer-absent tone-${reason.tone}`}
      data-node-kind="federated-peer"
      data-fed-peer-principal={data.principal}
      data-fed-peer-verdict={data.verdict}
      data-fed-peer-absent="true"
      data-fed-peer-absence={reason.token}
      aria-label={`${data.principal} — federated peer (admitted, ${reason.token})`}
    >
      {/* A dashed federation-accent ring with a cross-network glyph — visible and
          deliberately distinct from a local agent orb (which is a solid cyan
          circle). The subtle glow + dashed treatment live in
          constellation-canvas.css. */}
      <span
        className="network-node-orb network-node-orb-fed-peer"
        aria-hidden="true"
      >
        <span className="network-fed-peer-glyph">⇄</span>
      </span>
      <span className="network-node-below">
        <span className="network-fed-peer-eyebrow dim">{reason.eyebrow}</span>
        <span className="network-fed-peer-label">{data.principal}</span>
      </span>
    </div>
  );
}

/**
 * xyflow node wrapper for an absent federated peer — adds the target handle so
 * the dotted anchor edge from the local hub lands on it. Purely presentational
 * (no hover/selection wiring — an absent peer is inert).
 */
export function FederatedPeerNode({ data }: NodeProps) {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <FederatedPeerCard data={data as unknown as FederatedPeerNodeData} />
    </>
  );
}
