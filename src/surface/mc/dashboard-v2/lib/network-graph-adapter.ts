/**
 * G-1114.D.2 — graph data adapter (registry snapshot → React Flow graph).
 * G-1114.E.3 — + FEDERATED multi-hub grouping by verified origin.
 *
 * Pure projection from the agents-panel snapshot (`AgentPresenceTile[]`, the
 * same data `useAgents` feeds the panel) into the React Flow `nodes`/`edges`
 * shape the Network graph view (G-1114.D.1) renders. Kept out of the React tree
 * so the mapping is unit-testable without a DOM — the canvas component consumes
 * the output and hands it to ELK (G-1114.D.3) for positioning.
 *
 * ## Topology — local hub + one hub per federated peer stack (E.3)
 *
 * Phase D shipped a SINGLE stack-root hub with every agent fanned around it.
 * Phase E folds trust-verified FOREIGN peer agents into the same snapshot (each
 * tile carries an `origin`: `"local"` or the peer's `{principal,stack}`), so the
 * graph now shows:
 *
 *   - the LOCAL stack-hub (the reserved `__stack__` id) — YOUR stack, distinguished;
 *   - one FOREIGN stack-hub per distinct `{principal}/{stack}` an agent's verified
 *     origin names (id `__stack__:{principal}/{stack}`);
 *
 * with each agent clustered under ITS OWN stack's hub via a `hub → agent` edge.
 * The grouping key is the agent's VERIFIED origin (`{principal}/{stack}` for a
 * foreign agent, the local hub for a local agent) — the ADR-0003 roster
 * membership, NOT an attacker-controlled wire token. A local-only snapshot lays
 * out byte-identically to Phase D (one hub, the local one).
 *
 * The hubs are derived, not agents: the local hub id is reserved (`__stack__`)
 * and each foreign hub id is namespaced under `__stack__:` + the peer's
 * `{principal}/{stack}` — neither can collide with an agent key
 * (`{principal}/{stack}/{agent_id}`).
 *
 * ADR-0007: nodes carry presence + lifecycle metadata only (identity,
 * capabilities, state, offline reason, heartbeat, ORIGIN) — NEVER session
 * interiors. A foreign agent's origin is presence-level provenance, not an
 * interior. #909: foreign agents show NO local dispatch activity — the detail
 * panel renders "federated peer — activity not local" for them.
 */

import type { AgentPresenceTile, AgentOrigin } from "../hooks/use-agents";
import type { NetworkMembershipDTO } from "../hooks/use-networks";
import type {
  TransportOverlay,
  TransportVerdict,
} from "./network-transport-overlay";
import { overlayForStack } from "./network-transport-overlay";
import { stackColor } from "./stack-color";
import { classifyOrigin, isLocalCategory } from "./agents-display";

/** Reserved id for the synthetic LOCAL stack-root hub node (never a valid agent key). */
export const STACK_HUB_NODE_ID = "__stack__";

/** Prefix for a synthetic FOREIGN stack-hub id (`__stack__:{principal}/{stack}`). */
export const FOREIGN_HUB_ID_PREFIX = "__stack__:";

/**
 * MC-D4 — prefix for a synthetic ABSENT-federated-peer placeholder node id
 * (`__fed__:{principal}`). Namespaced under a reserved prefix so it can never
 * collide with an agent key (`{principal}/{stack}/{agent_id}`) NOR a stack-hub id
 * (`__stack__` / `__stack__:…`). One node per admitted-but-absent peer PRINCIPAL —
 * an absent peer has no present stack/agent tile to derive a hub from, so it's
 * keyed on the principal alone.
 */
export const FEDERATED_PEER_ID_PREFIX = "__fed__:";

/** MC-D4 — the synthetic id for the absent-federated-peer node of `principal`. */
export function federatedPeerIdForPrincipal(principal: string): string {
  return `${FEDERATED_PEER_ID_PREFIX}${principal}`;
}

/**
 * Compute the hub node id for an agent's origin.
 *   - `"local"` → the reserved {@link STACK_HUB_NODE_ID}.
 *   - `{principal,stack}` → `__stack__:{principal}/{stack}` — namespaced under the
 *     reserved prefix so it can never collide with an agent key.
 */
export function hubIdForOrigin(origin: AgentOrigin): string {
  return origin === "local"
    ? STACK_HUB_NODE_ID
    : `${FOREIGN_HUB_ID_PREFIX}${origin.principal}/${origin.stack}`;
}

/** React Flow node `data` payload for a synthetic stack-root hub. */
export interface StackHubNodeData {
  kind: "stack-hub";
  /**
   * G-1114.E.3 — hub provenance. `"local"` for YOUR stack's hub (distinguished),
   * or the peer's `{principal,stack}` for a federated stack-hub (rendered
   * distinctly + carrying the provenance label).
   */
  origin: AgentOrigin;
  /**
   * #1008 — the SERVING stack's principal, derived from the snapshot's
   * `"local"`-origin agents (the serving stack's own identity). `null` when the
   * snapshot has no local agent to derive it from (a foreign-only snapshot). The
   * card pairs this with `origin` via `classifyOrigin` to tell a SAME-PRINCIPAL
   * local sibling (DB-read aggregation) from a CROSS-PRINCIPAL federated peer —
   * so a sibling renders as a "stack" hub, not a "federated stack".
   */
  servingPrincipal: string | null;
  /** `{principal}` the stack belongs to. */
  principal: string | null;
  /** `{stack}` label. */
  stack: string | null;
  /** Count of agents attached to this hub. */
  agentCount: number;
  /**
   * #1068 — the deterministic per-stack color for this hub, derived from
   * `origin` via `stackColor` (the LOCAL stack gets the reserved signature hue,
   * each peer a stable palette color). Used as the hub's accent/border. ADDITIVE:
   * the local/sibling/foreign shape treatments (solid/dashed border, eyebrow)
   * stay — color is a legibility aid, never the only signal.
   */
  stackColor: string;
  /**
   * P-14 U2.3 (#935) — signal's intent⋈reality VERDICT for this stack, when the
   * transport overlay is on AND signal observed this `{principal}/{stack}`.
   * Undefined → no overlay / no observation (the hub renders no verdict badge).
   * SOURCED FROM SIGNAL — never re-derived (the badge mapping keys off this).
   */
  transportVerdict?: TransportVerdict;
}

/** React Flow node `data` payload for one agent. */
export interface AgentNodeData {
  kind: "agent";
  /** Stable registry key (`{principal}/{stack}/{agent_id}`). */
  key: string;
  /**
   * G-1114.E.4 — federation provenance: `"local"` for a stack-own agent, or the
   * verified `{principal,stack}` of a foreign peer agent. Drives the foreign
   * node's distinct visuals + provenance label (`jc/research`). Presence-level
   * metadata, never an interior (ADR-0007).
   */
  origin: AgentOrigin;
  /**
   * #1008 — the SERVING stack's principal (see {@link StackHubNodeData.servingPrincipal}).
   * Lets the card classify a same-principal local SIBLING agent apart from a
   * cross-principal FOREIGN peer via `classifyOrigin` — a sibling renders local,
   * only a true foreign peer renders federated.
   */
  servingPrincipal: string | null;
  /** Logical agent id (`luna`, `echo`, …). */
  agentId: string;
  /** Soma assistant name, or `null` (falls back to `agentId` at render). */
  assistantName: string | null;
  /** Declared capability set (latest observed). */
  capabilities: readonly string[];
  /** Liveness state. */
  state: "online" | "offline";
  /** Offline reason (`ttl_lapse` / `shutdown` / …) when offline; else `null`. */
  offlineReason: string | null;
  /** Epoch-ms of the last `agent.heartbeat` observed, or `null`. */
  lastHeartbeatAt: number | null;
  /**
   * #1068 — the deterministic per-stack color for THIS agent's stack (the same
   * `stackColor(origin)` its hub carries — a local agent shares the local
   * signature hue, a foreign peer shares its stack's color). Drives the agent
   * card's accent/left-border. ADDITIVE — the foreign dashed-border + provenance
   * badge stay; color groups the card visually with its hub.
   */
  stackColor: string;
  /**
   * P-14 U2.3 (#935) — leaf LIVENESS for this agent's stack, when the transport
   * overlay is on AND signal observed the stack. `present` is the live-link flag,
   * `rttMs` the round-trip from signal's leaf roster (null when unreported).
   * Undefined → no overlay / no observation. SOURCED FROM SIGNAL — never re-derived.
   */
  transportLeaf?: { present: boolean; rttMs: number | null };
}

/**
 * MC-D4 — React Flow node `data` payload for an ABSENT admitted federated peer.
 *
 * The principal is admitted to the network (an ADR-0018 roster member) but has NO
 * present agent tile — `buildNetworkGraph` derives its hubs from present tiles, so
 * without this the principal can't see the federation they're part of. This node
 * is a DIMMED placeholder: a muted grey ring, no glow, labelled with the peer
 * principal id and a `federated · absent` sublabel. Presence-level metadata only
 * (ADR-0007) — it carries the principal and its membership verdict, never a
 * session interior. It is never drillable (absent = nothing local to open).
 */
export interface FederatedPeerNodeData {
  kind: "federated-peer";
  /** The admitted-but-absent peer PRINCIPAL id (e.g. `jc`). The node label. */
  principal: string;
  /**
   * The membership verdict for this peer on its network (from the roster ⋈
   * presence reconciliation). Always an absent-family verdict here (the peer has
   * no present stacks); carried so the card can nuance the sublabel if needed.
   */
  verdict: string;
  /** The network id this peer is admitted to (first-seen when a peer spans several). */
  networkId: string;
}

/** Discriminated union of every node `data` shape in the graph. */
export type NetworkNodeData =
  | StackHubNodeData
  | AgentNodeData
  | FederatedPeerNodeData;

/** A React-Flow-shaped node BEFORE ELK assigns a position (position is 0,0). */
export interface NetworkGraphNode {
  id: string;
  /** Custom node type registered on the canvas (`stackHub` | `agent` | `federatedPeer`). */
  type: "stackHub" | "agent" | "federatedPeer";
  data: NetworkNodeData;
  position: { x: number; y: number };
}

/**
 * P-14 U2.3 (#935) — transport health/lag an edge can carry when the Network
 * view's transport overlay is on. SOURCED FROM SIGNAL (the projected
 * `system.transport.*` family — signal's P-13.B verdicts), never re-derived
 * here. Additive + optional, so a graph built without the overlay is
 * byte-identical to the pre-U2.3 shape.
 */
export interface NetworkEdgeTransportData {
  /** Signal's intent⋈reality verdict for the target leaf's stack. */
  verdict: "connected" | "registered-absent" | "unregistered-present";
  /** Leaf liveness (true when signal reports the leaf present). */
  present: boolean;
  /** Round-trip time (ms) from signal's leaf roster, or null when unreported. */
  rttMs: number | null;
}

/**
 * A React-Flow-shaped edge (hub → agent for the stack-local cut).
 *
 * G-1114.E.3 grew this to federated multi-hub edges; U2.3 widens it additively
 * with an OPTIONAL `data.transport` health/lag payload (present only when the
 * transport overlay is on AND signal observed the target's stack). The base
 * `{id,source,target}` is unchanged — a no-overlay build never sets `data`.
 */
export interface NetworkGraphEdge {
  id: string;
  source: string;
  target: string;
  /**
   * Edge `data` payload.
   *   - `stackColor` (#1068) — the hub's stack color, so the hub→agent connector
   *     strokes in the stack's hue (set at build time for every edge).
   *   - `federated` (MC-D3 #1290) — true when this edge wires a CROSS-PRINCIPAL
   *     federated peer's hub→agent (`classifyOrigin` → `foreign`). The
   *     constellation skin draws a federated edge dashed + flowing
   *     (`.edge-live--fed`) and labels it `federated · admitted peer`; a local or
   *     same-principal-sibling edge is `false`/absent (solid). Presence-level
   *     provenance, never a session field.
   *   - `transport` (U2.3) — optional health/lag overlay payload, sourced from
   *     signal (present only when the transport overlay is on).
   */
  data?: {
    stackColor?: string;
    federated?: boolean;
    /**
     * MC-D4 — true when this edge wires the local stack hub to an ABSENT
     * admitted-federated-peer placeholder node. Styled as a DOTTED federated link
     * (distinct from the solid local hub→agent edge AND from the dashed present-
     * peer `federated` edge), marking "admitted but no live presence". Never
     * animates (absent = no flow).
     */
    federatedAbsent?: boolean;
    transport?: NetworkEdgeTransportData;
  };
}

/** The adapter's output: nodes + edges, pre-layout. */
export interface NetworkGraph {
  nodes: NetworkGraphNode[];
  edges: NetworkGraphEdge[];
}

/**
 * #1008 — derive the SERVING stack's principal from the snapshot.
 *
 * A `"local"`-origin agent's tile carries the serving stack's own
 * principal/stack (it IS a stack-own agent), so the serving principal is the
 * `principal` of the first `"local"` agent. Returns `null` when no local agent
 * is present (a foreign-only snapshot) — then no object origin can be proven a
 * same-principal sibling, so classification falls back to "foreign".
 *
 * Derived client-side from the existing DTO rather than widening `/api/agents`
 * to carry a serving-principal field — the `"local"` tiles already encode it.
 */
export function deriveServingPrincipal(
  agents: readonly AgentPresenceTile[],
): string | null {
  for (const a of agents) {
    if (a.origin === "local") return a.principal;
  }
  return null;
}

/** The `{principal}/{stack}` an agent's origin resolves to (for hub grouping). */
function originScope(a: AgentPresenceTile): { principal: string; stack: string } {
  // A foreign agent's origin carries the peer's verified {principal,stack}; a
  // local agent's origin scope is its own tile's principal/stack (the local hub).
  return a.origin === "local"
    ? { principal: a.principal, stack: a.stack }
    : { principal: a.origin.principal, stack: a.origin.stack };
}

/**
 * Project the agents snapshot into a React-Flow graph.
 *
 * - **Empty snapshot →** an empty graph (`{ nodes: [], edges: [] }`). The view
 *   renders its empty state rather than a lone hub with nothing attached.
 * - **Non-empty →** one stack-hub node per distinct origin stack (the LOCAL hub
 *   plus one per federated peer `{principal}/{stack}`), one agent node per tile,
 *   and one `hub → agent` edge wiring each agent to ITS OWN stack's hub.
 *
 * ## Hub ordering + grouping (E.3)
 *
 * Agents are grouped by their VERIFIED origin (`hubIdForOrigin`): a local agent
 * lands under the reserved `__stack__` hub, a foreign agent under its peer's
 * `__stack__:{principal}/{stack}` hub. Hubs are emitted FIRST (local hub first
 * when present, then foreign hubs in first-seen order) so ELK has the cluster
 * roots up front; agent nodes follow in snapshot order. A local-only snapshot is
 * byte-identical to Phase D (a single `__stack__` hub).
 *
 * ## MC-D4 — absent admitted federated peers
 *
 * `agents` derives hubs from PRESENT tiles only, so an admitted-but-ABSENT peer
 * (a roster member with no `present_stacks`, e.g. `jc` before its stack comes up)
 * draws NO node — the principal can't see the federation they belong to. When the
 * optional `networks` roster is supplied, this ALSO emits a DIMMED
 * "federated peer" placeholder node per admitted non-local peer that has NO
 * present tile already in the graph, wired to the LOCAL stack hub by a DOTTED
 * federated-absent edge. The present-peer folding (E.3) is untouched — a present
 * foreign peer keeps rendering as its own stack hub; only truly-absent admitted
 * peers get a placeholder. When `networks` is omitted (or carries no absent
 * non-local member), the graph is byte-identical to the pre-D4 shape.
 *
 * Pure and order-preserving for the agents within a snapshot, so the layout is
 * deterministic for a given snapshot.
 */
export function buildNetworkGraph(
  agents: readonly AgentPresenceTile[],
  networks: readonly NetworkMembershipDTO[] = [],
): NetworkGraph {
  if (agents.length === 0) {
    // No present tiles → no LOCAL stack hub to anchor an absent-peer placeholder
    // to. Render the empty state rather than floating unanchored placeholders.
    return { nodes: [], edges: [] };
  }

  // #1008 — derive the SERVING principal from the snapshot's `"local"`-origin
  // agents: a local agent's tile carries the serving stack's own principal. We
  // thread it onto every node so the cards can tell a SAME-PRINCIPAL local
  // sibling (DB-read aggregation, `origin.principal === serving`) from a
  // CROSS-PRINCIPAL federated peer (`origin.principal !== serving`) — the fix
  // for siblings mislabeled "federated stack". `null` when the snapshot has no
  // local agent (a foreign-only snapshot), in which case an object origin can't
  // be proven a sibling and classifies conservatively as foreign.
  const servingPrincipal = deriveServingPrincipal(agents);

  // First pass: bucket agents by their origin hub id, preserving first-seen order
  // of hubs and snapshot order of agents within each hub.
  interface HubBucket {
    hubId: string;
    origin: AgentOrigin;
    principal: string;
    stack: string;
    agents: AgentPresenceTile[];
  }
  const buckets = new Map<string, HubBucket>();
  for (const a of agents) {
    const hubId = hubIdForOrigin(a.origin);
    let bucket = buckets.get(hubId);
    if (!bucket) {
      const scope = originScope(a);
      bucket = {
        hubId,
        origin: a.origin,
        principal: scope.principal,
        stack: scope.stack,
        agents: [],
      };
      buckets.set(hubId, bucket);
    }
    bucket.agents.push(a);
  }

  // Emit the LOCAL hub first (when present) so YOUR stack reads as the anchor,
  // then the foreign hubs in first-seen order.
  const orderedBuckets = [...buckets.values()].sort((x, y) => {
    const xLocal = x.hubId === STACK_HUB_NODE_ID ? 0 : 1;
    const yLocal = y.hubId === STACK_HUB_NODE_ID ? 0 : 1;
    return xLocal - yLocal; // stable sort keeps first-seen order within a tier
  });

  const nodes: NetworkGraphNode[] = [];
  const edges: NetworkGraphEdge[] = [];

  for (const bucket of orderedBuckets) {
    // #1068 — the stack's deterministic color, derived from the bucket's verified
    // origin. The hub, every agent in the bucket, and every hub→agent edge share
    // it, so a stack reads as one colored cluster. ADDITIVE over the shape/label
    // treatments — never the only signal.
    const color = stackColor(bucket.origin);
    // MC-D3 (#1290) — federation provenance for this stack's edges. A
    // CROSS-PRINCIPAL `foreign` peer's hub→agent edges draw dashed + flowing
    // (admitted-peer bus relationship); the LOCAL hub and a same-principal
    // SIBLING (DB-read aggregation) draw solid. Same `classifyOrigin` the node
    // cards use, so edge + node agree on what "federated" means.
    const federated = !isLocalCategory(
      classifyOrigin(bucket.origin, servingPrincipal),
    );
    nodes.push({
      id: bucket.hubId,
      type: "stackHub",
      position: { x: 0, y: 0 },
      data: {
        kind: "stack-hub",
        origin: bucket.origin,
        servingPrincipal,
        principal: bucket.principal ?? null,
        stack: bucket.stack ?? null,
        agentCount: bucket.agents.length,
        stackColor: color,
      },
    });
    for (const a of bucket.agents) {
      nodes.push({
        id: a.key,
        type: "agent",
        position: { x: 0, y: 0 },
        data: {
          kind: "agent",
          key: a.key,
          origin: a.origin,
          servingPrincipal,
          agentId: a.agent_id,
          assistantName: a.assistant_name,
          capabilities: a.capabilities,
          state: a.state,
          offlineReason: a.offline_reason,
          lastHeartbeatAt: a.last_heartbeat_at,
          stackColor: color,
        },
      });
      edges.push({
        id: `hub-${a.key}`,
        source: bucket.hubId,
        target: a.key,
        data: { stackColor: color, federated },
      });
    }
  }

  // MC-D4 — emit a DIMMED placeholder per admitted-but-ABSENT federated peer:
  // a roster member that is NOT the local principal AND has no present agent tile
  // already in the graph. Anchored to the LOCAL stack hub by a DOTTED
  // federated-absent edge, so the principal sees the federation they belong to
  // even before the peer's stack comes up. No-op when `networks` is empty or every
  // member is local/present — the graph stays byte-identical to the pre-D4 shape.
  appendAbsentFederatedPeers(nodes, edges, networks, servingPrincipal);

  return { nodes, edges };
}

/**
 * MC-D4 — the principal ids that ALREADY have a stack-hub OR agent node in the
 * graph (present locally or as a present foreign peer). An admitted peer whose
 * principal is in this set is NOT absent — it's already rendered as its stack —
 * so no placeholder is emitted for it.
 */
function presentPrincipals(nodes: readonly NetworkGraphNode[]): Set<string> {
  const present = new Set<string>();
  for (const n of nodes) {
    if (n.data.kind === "stack-hub") {
      if (n.data.principal !== null) present.add(n.data.principal);
    } else if (n.data.kind === "agent") {
      // A local agent's principal is its origin scope; a foreign agent's is its
      // origin's principal. `key` is `{principal}/{stack}/{agent_id}` — the first
      // segment is the principal either way.
      const principal = n.data.key.split("/")[0];
      if (principal !== undefined && principal.length > 0) present.add(principal);
    }
  }
  return present;
}

/**
 * MC-D4 — mutate `nodes`/`edges` in place, appending one dimmed federated-peer
 * placeholder node + one dotted anchor edge per admitted-but-absent non-local
 * peer. The anchor is the LOCAL stack hub ({@link STACK_HUB_NODE_ID}); when the
 * graph has no local hub (a foreign-only snapshot) there's nothing to anchor to,
 * so no placeholders are emitted.
 *
 * A peer is a candidate when, across all supplied networks, its `principal` is
 * NOT the serving principal AND NOT already present in the graph AND it has no
 * `present_stacks` on that network membership row. De-duplicated by principal
 * (first-seen network wins), and emitted in first-seen order, so the layout stays
 * deterministic.
 */
function appendAbsentFederatedPeers(
  nodes: NetworkGraphNode[],
  edges: NetworkGraphEdge[],
  networks: readonly NetworkMembershipDTO[],
  servingPrincipal: string | null,
): void {
  if (networks.length === 0) return;
  // The placeholder anchors to the LOCAL hub; without one there's nothing to
  // connect to (a foreign-only snapshot) — skip rather than float unanchored.
  const hasLocalHub = nodes.some(
    (n) => n.data.kind === "stack-hub" && n.id === STACK_HUB_NODE_ID,
  );
  if (!hasLocalHub) return;

  const present = presentPrincipals(nodes);
  const emitted = new Set<string>();

  for (const net of networks) {
    for (const m of net.members) {
      if (m.principal === servingPrincipal) continue; // the local principal
      if (present.has(m.principal)) continue; // already a present stack/agent
      if (m.present_stacks.length > 0) continue; // has live presence → not absent
      if (emitted.has(m.principal)) continue; // de-dupe across networks
      emitted.add(m.principal);

      const id = federatedPeerIdForPrincipal(m.principal);
      nodes.push({
        id,
        type: "federatedPeer",
        position: { x: 0, y: 0 },
        data: {
          kind: "federated-peer",
          principal: m.principal,
          verdict: m.verdict,
          networkId: net.network_id,
        },
      });
      edges.push({
        id: `fed-absent-${m.principal}`,
        source: STACK_HUB_NODE_ID,
        target: id,
        data: { federatedAbsent: true },
      });
    }
  }
}

/** #1068 — one legend entry: a stack's hub id, display label, and color. */
export interface LegendStack {
  /** The hub node id (stable React key + identity). */
  id: string;
  /** Display label — `{principal}/{stack}`, or `local` for the self stack. */
  label: string;
  /** The stack's deterministic color (the hub's `stackColor`). */
  color: string;
}

/**
 * #1068 — collect the per-stack legend entries from a built graph: one row per
 * stack-hub node, carrying its `{principal}/{stack}` label (or `local` for the
 * self stack) and its deterministic color. Hub emission order is preserved
 * (local first, then peers in first-seen order — see {@link buildNetworkGraph}),
 * so the legend reads in the same order the hubs lay out.
 *
 * Pure + DOM-free so it's unit-tested without a browser; the legend component
 * takes the result and renders swatches.
 */
export function collectLegendStacks(graph: NetworkGraph): LegendStack[] {
  const out: LegendStack[] = [];
  for (const node of graph.nodes) {
    if (node.data.kind !== "stack-hub") continue;
    const d = node.data;
    const label =
      d.origin === "local"
        ? "local"
        : d.principal && d.stack
          ? `${d.principal}/${d.stack}`
          : (d.stack ?? d.principal ?? node.id);
    out.push({ id: node.id, label, color: d.stackColor });
  }
  return out;
}

/**
 * P-14 U2.3 (#935) — overlay signal's transport health onto a built graph.
 *
 * A PURE, additive widening: returns a NEW graph whose stack-hub nodes carry the
 * `transportVerdict`, agent nodes carry `transportLeaf` liveness/RTT, and
 * hub→agent edges carry `data.transport` — all keyed by `{principal}/{stack}` and
 * taken VERBATIM from the {@link TransportOverlay} (signal's projected verdicts;
 * never re-derived here). A node/edge whose stack signal did not observe is
 * returned UNCHANGED (no `transport*` fields), so a non-hub stack — or any leaf
 * signal didn't report — reads exactly as the un-overlaid graph.
 *
 * Kept separate from {@link buildNetworkGraph} so the base projection stays
 * overlay-free + byte-identical to pre-U2.3, and the fold is independently
 * unit-testable against fixtures.
 */
export function applyTransportOverlay(
  graph: NetworkGraph,
  overlay: TransportOverlay,
): NetworkGraph {
  const nodes = graph.nodes.map((node): NetworkGraphNode => {
    if (node.data.kind === "stack-hub") {
      const peer = overlayForStack(overlay, node.data.principal, node.data.stack);
      if (peer === null) return node;
      return {
        ...node,
        data: { ...node.data, transportVerdict: peer.verdict },
      };
    }
    // MC-D4 — an absent-federated-peer placeholder carries no leaf/stack to
    // overlay (it's admitted-but-absent, no live transport); return it unchanged.
    if (node.data.kind === "federated-peer") return node;
    // An agent node's leaf liveness keys on the agent's ORIGIN stack (a foreign
    // peer's leaf lives on ITS stack, exactly like its hub grouping). originScope
    // resolves a foreign origin's {principal,stack}; a local agent's own.
    const origin = node.data.origin;
    const principal = origin === "local" ? node.data.key.split("/")[0]! : origin.principal;
    const stack = origin === "local" ? node.data.key.split("/")[1]! : origin.stack;
    const peer = overlayForStack(overlay, principal, stack);
    if (peer === null) return node;
    return {
      ...node,
      data: {
        ...node.data,
        transportLeaf: { present: peer.present, rttMs: peer.rttMs },
      },
    };
  });

  const edges = graph.edges.map((edge): NetworkGraphEdge => {
    // The edge target is the agent key (`{principal}/{stack}/{agent_id}`); the
    // overlay keys on `{principal}/{stack}`. Resolve via the target node's data.
    const targetNode = graph.nodes.find((n) => n.id === edge.target);
    if (targetNode === undefined || targetNode.data.kind !== "agent") return edge;
    const origin = targetNode.data.origin;
    const principal =
      origin === "local" ? targetNode.data.key.split("/")[0]! : origin.principal;
    const stack =
      origin === "local" ? targetNode.data.key.split("/")[1]! : origin.stack;
    const peer = overlayForStack(overlay, principal, stack);
    if (peer === null) return edge;
    return {
      ...edge,
      data: {
        // Preserve the #1068 per-stack color the base build set; the overlay
        // only ADDS the transport payload.
        ...edge.data,
        transport: {
          verdict: peer.verdict,
          present: peer.present,
          rttMs: peer.rttMs,
        },
      },
    };
  });

  return { nodes, edges };
}
