/**
 * F-9 working-agent grid (MIG-5 port) + ST-P5 session-tree render.
 *
 * Renders one tile per agent with at least one active-non-blocked
 * assignment, server-sorted by `primary_state_rank ASC, updated_at DESC`.
 * Tile click opens the F-7 drill-down on the primary assignment;
 * `+N` badge is inert per Decision 6.
 *
 * ST-P5 (refactor §7): each tile now also renders the owning agent's SESSION
 * TREE beneath its (unchanged) primary_assignment/state header — root sessions
 * listed, child sessions nested with an indent + an expander. Per D5 the tree is
 * DEFAULT-COLLAPSED: a node's children appear only when its expander is toggled
 * (chevron + child-count badge while collapsed). Each session's display word is
 * the DERIVED substrate-projection label (`substrateLabel` — "sub-agent" appears
 * ONLY here, as the Claude-Code lens for a child session; the model says child
 * session). Empty/absent `sessions` ⇒ the tile renders exactly as pre-ST-P5.
 *
 * Empty-state behaviour (Decision 7):
 *   - section hidden when focus row has entries AND grid is empty
 *     (don't distract from "needs attention")
 *   - "No agents working right now." when both grid and focus row are empty
 *
 * Keyboard: arrow keys navigate tiles when one is focused, Enter opens
 * the drill-down. Gated on the drill-down being closed (mirrors F-8 /
 * legacy F-9 listener discipline). Session-tree expanders are native
 * <button>s — Enter/Space toggle them for free (G-1114.F a11y bar).
 */

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import "./working-grid.css";
import { priorityBorderClass } from "../lib/block-reason";
import { pickWorkingGridMode, priorityLabel } from "../lib/working-grid-display";
import {
  flattenSessionTree,
  toggleExpanded,
  type SessionTreeRow,
} from "../lib/session-tree-rows";
import { substrateLabel } from "../lib/substrate-label";
import { resolveTraceDeepLink } from "../lib/working-trace-deeplink";
import type {
  WorkingAgentTile,
  SessionTreeNode,
} from "../hooks/use-working-agents";

/**
 * CK-8 — the signal-trace timeline source, LAZY-imported so its fetch + the
 * `sideband-timeline` mapper land in the SAME split chunk the drill-down already
 * pays for (never the working-grid entry bundle). Reused verbatim: it fetches
 * `/api/observability/traces/{id}/timeline`, renders the trace rows, and degrades
 * HONESTLY on a `SidebandError` (interior-absent line + backend `deep_link`).
 */
const SidebandSource = lazy(() => import("./sideband-source"));

/**
 * #1065 — a globally-unique React key for a working tile. The pane-of-glass
 * aggregation (#1008) surfaces the SAME `agent_id` across stacks (e.g. `luna`
 * on meta-factory + work + halden + community), so keying on the bare
 * `agent_id` collides → duplicate-key warnings + reconciliation hazard. Namespace
 * by the tile's origin stack, mirroring the network-graph node-id convention:
 *   - `"local"`            → `local/{agent_id}`
 *   - `{principal, stack}` → `{principal}/{stack}/{agent_id}`
 */
export function workingTileKey(tile: Pick<WorkingAgentTile, "origin" | "agent_id">): string {
  const scope =
    !tile.origin || tile.origin === "local"
      ? "local"
      : `${tile.origin.principal}/${tile.origin.stack}`;
  return `${scope}/${tile.agent_id}`;
}

export interface WorkingGridProps {
  agents: WorkingAgentTile[];
  loaded: boolean;
  error: string | null;
  /**
   * True when the focus row has any items. Drives the Decision 7
   * "hide entirely" branch when the grid is empty alongside a focus row.
   */
  focusItemCount: number;
  /** Don't hijack arrow keys while the F-7 drill-down is open. */
  drillOpen: boolean;
  /** Called with the primary assignment id when a tile is activated. */
  onOpen: (assignmentId: string) => void;
}

export function WorkingGrid({
  agents,
  loaded,
  error,
  focusItemCount,
  drillOpen,
  onOpen,
}: WorkingGridProps) {
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // ST-P5 (D5) — expansion state local to the grid, keyed by session_id. Because
  // the key is the stable session_id, expansion SURVIVES poll refreshes: a
  // refetch that re-supplies the same session keeps its row expanded (the Set is
  // never reset on data change).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const onToggleExpand = useCallback((sessionId: string) => {
    setExpanded((prev) => toggleExpanded(prev, sessionId));
  }, []);

  // Clamp the focused index when the grid shrinks underneath us.
  useEffect(() => {
    if (focusedIdx >= agents.length) setFocusedIdx(-1);
  }, [agents.length, focusedIdx]);

  // Keep the actual DOM focus in sync with focusedIdx (so arrow keys
  // chain — the next keydown still fires on a focused tile).
  useEffect(() => {
    if (focusedIdx < 0) return;
    const el = tileRefs.current[focusedIdx];
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIdx]);

  const onTileKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (drillOpen) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx(Math.min(idx + 1, agents.length - 1));
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx(Math.max(idx - 1, 0));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const a = agents[idx];
      if (a) onOpen(a.primary_assignment.id);
      return;
    }
  }, [agents, drillOpen, onOpen]);

  const mode = pickWorkingGridMode({ agents, loaded, error, focusItemCount });
  if (mode === "hidden") return null;

  return (
    <section className="working-grid-section" aria-label="Working agents">
      <h2>Working</h2>
      {mode === "error" && <div className="working-grid-error">⚠ {error}</div>}
      {mode === "loading" && <div className="working-grid-empty">Loading…</div>}
      {mode === "empty" && (
        <div className="working-grid-empty">No agents working right now.</div>
      )}
      {mode === "tiles" && (
        <div className="working-grid">
          {agents.map((a, idx) => (
            <div className="working-tile-wrap" key={workingTileKey(a)}>
              <button
                ref={(el) => { tileRefs.current[idx] = el; }}
                type="button"
                className={`working-tile ${priorityBorderClass(a.primary_assignment.task_priority)}${idx === focusedIdx ? " focused" : ""}`}
                onClick={() => onOpen(a.primary_assignment.id)}
                onKeyDown={(e) => onTileKeyDown(e, idx)}
                onFocus={() => setFocusedIdx(idx)}
                data-agent-id={a.agent_id}
              >
                <div className="agent">{a.agent_name}</div>
                <div className="task">{a.primary_assignment.task_title}</div>
                <div className="meta">
                  {priorityLabel(a.primary_assignment.task_priority)}
                  {" · "}
                  <span className={`state-${a.primary_state}`}>{a.primary_state}</span>
                </div>
                {a.additional_active_count > 0 && (
                  <div
                    className="badge"
                    title={`${a.additional_active_count} additional active assignment(s)`}
                    aria-hidden="true"
                  >
                    +{a.additional_active_count}
                  </div>
                )}
              </button>
              <SessionTree
                sessions={a.sessions}
                agentName={a.agent_name}
                expanded={expanded}
                onToggleExpand={onToggleExpand}
              />
              <WorkingTraceDrill
                taskId={a.primary_assignment.task_id}
                origin={a.origin}
                agentName={a.agent_name}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface SessionTreeProps {
  sessions: SessionTreeNode[];
  agentName: string;
  expanded: ReadonlySet<string>;
  onToggleExpand: (sessionId: string) => void;
}

/**
 * The per-agent session tree, rendered as a flat indented list (a nested list
 * with expander buttons — the simplest correct ARIA per the task's a11y note,
 * preferred over a full tree-grid role). Absent/empty ⇒ renders nothing so the
 * tile is byte-identical to pre-ST-P5.
 */
function SessionTree({
  sessions,
  agentName,
  expanded,
  onToggleExpand,
}: SessionTreeProps) {
  // Empty/compat: no tree chrome at all when the agent has no open sessions.
  if (!sessions || sessions.length === 0) return null;

  const rows = flattenSessionTree(sessions, expanded);

  return (
    <ul
      className="session-tree"
      role="group"
      aria-label={`Sessions for ${agentName}`}
    >
      {rows.map((row) => (
        <SessionTreeItem
          key={row.node.session_id}
          row={row}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </ul>
  );
}

interface SessionTreeItemProps {
  row: SessionTreeRow;
  onToggleExpand: (sessionId: string) => void;
}

function SessionTreeItem({ row, onToggleExpand }: SessionTreeItemProps) {
  const { node, depth, hasChildren, isExpanded, childCount } = row;
  // The derived substrate-projection label — the ONLY place "sub-agent" appears.
  const label = substrateLabel(node.substrate, node.parent_session_id !== null);
  // Indent by depth. Inline style is the only depth-driven value; everything
  // else is class-based (the indent is data, not a fixed set of CSS classes).
  const indentStyle = { ["--depth" as string]: String(depth) };

  return (
    <li
      className="session-row"
      style={indentStyle}
      data-session-id={node.session_id}
      data-depth={depth}
    >
      {hasChildren ? (
        // Native <button>: Enter/Space toggle for free (no hover-only
        // affordance). aria-expanded announces the state to AT.
        <button
          type="button"
          className="session-expander"
          aria-expanded={isExpanded}
          onClick={() => onToggleExpand(node.session_id)}
        >
          <span className="chevron" aria-hidden="true">
            {isExpanded ? "▾" : "▸"}
          </span>
          <span className="session-label">{label}</span>
          {!isExpanded && (
            <span className="session-child-badge">
              {/* Accessible text, not color-only: AT reads the count + noun. */}
              <span className="sr-only">
                {childCount} child {childCount === 1 ? "session" : "sessions"}
              </span>
              <span aria-hidden="true">{childCount}</span>
            </span>
          )}
        </button>
      ) : (
        // Leaf: no expander. A non-interactive labelled row.
        <span className="session-leaf">
          <span className="chevron-spacer" aria-hidden="true" />
          <span className="session-label">{label}</span>
        </span>
      )}
      {node.state && (
        <span className={`session-state state-${node.state}`}>{node.state}</span>
      )}
    </li>
  );
}

interface WorkingTraceDrillProps {
  /** The tile's primary-assignment task id — carries the anchor correlation_id. */
  taskId: string;
  /** The tile's origin — drives the local-only scoping (ADR-0005). */
  origin: WorkingAgentTile["origin"];
  /** Owning agent display name — for the trace panel's aria-label. */
  agentName: string;
}

/**
 * CK-8 — the task→signal-trace deep link on a WORKING row.
 *
 * Three honest states, decided by `resolveTraceDeepLink` (pure):
 *   - LOCAL, correlatable  → a "View signal trace" toggle that lazily mounts
 *     `SidebandSource` for the derived trace_id. The trace timeline, its
 *     `SidebandError` degrade, and the backend `deep_link` exit are all owned
 *     downstream by `SidebandSource` — this component just opens it.
 *   - CROSS-STACK          → an HONEST degrade line ("trace lives on ⟨stack⟩ —
 *     open its MC"). NOT a link: the loopback proxy can't resolve a peer's trace
 *     on this daemon (ADR-0005 / truth-not-theater — never a dead affordance).
 *   - NONE (local, non-anchored) → nothing. There is no correlatable trace, so
 *     honest absence is rendering no affordance at all.
 */
function WorkingTraceDrill({ taskId, origin, agentName }: WorkingTraceDrillProps) {
  const [open, setOpen] = useState(false);
  const link = resolveTraceDeepLink({ taskId, origin });

  if (link.kind === "none") return null;

  if (link.kind === "cross-stack") {
    return (
      <div className="working-trace working-trace-degrade" role="note">
        <span className="working-trace-degrade-mark" aria-hidden="true">⟿</span>
        trace lives on {link.stackLabel} — open its MC
      </div>
    );
  }

  // Local + correlatable: the real drill affordance.
  return (
    <div className="working-trace">
      <button
        type="button"
        className="working-trace-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
        {open ? "Hide signal trace" : "View signal trace"}
      </button>
      {open && (
        <div
          className="working-trace-panel"
          role="log"
          aria-label={`Signal trace for ${agentName}`}
        >
          <Suspense
            fallback={
              <div className="drill-log-wrap">
                <div className="drill-log-empty">Loading trace…</div>
              </div>
            }
          >
            <SidebandSource correlationId={link.traceId} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
