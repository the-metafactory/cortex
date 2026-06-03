/**
 * F-14 — iteration kanban surface.
 *
 * Six-column board (`inbox / designing / queued / in_flight / blocked /
 * done`) per `docs/design-mc-iteration-planning.md` Decision 4. Cards
 * are either:
 *   - inbox items (upstream-imported tasks not yet attached to an
 *     iteration), or
 *   - iterations (Grove-owned planning entities, F-13 schema).
 *
 * Drag and drop uses native HTML5 (Decision 10 Q2 — no @dnd-kit). The
 * drag payload is encoded into the dataTransfer's `text/plain` channel
 * as a tiny JSON envelope so it survives the round-trip without leaking
 * the entire item record. Drop legality is decided by `lib/iteration-
 * drag.ts#canDrop`, which delegates to F-13's `canTransition` for the
 * iteration → iteration case.
 *
 * Mutation calls are stubs in this PR — F-15 wires the POST/PATCH
 * endpoints. The parent supplies `onCreateIterationFromInbox` and
 * `onMoveIteration` callbacks; this component invokes them with the
 * minimum information needed to perform the mutation. Until F-15 lands
 * those callbacks emit a toast.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import "./iteration-board.css";
import {
  buildIterationBoardLayout,
  ITERATION_BOARD_COLUMNS,
  type ColumnEntry,
  type IterationBoardColumn,
} from "../lib/iteration-board-layout";
import { canDrop, type DragSourceKind } from "../lib/iteration-drag";
import { safeSourceHref } from "../lib/safe-href";
import type {
  InboxItem,
  IterationListItem,
  IterationState,
} from "../../db/iterations";

// ---------------------------------------------------------------------------
// Drag payload — kept as a tiny JSON envelope so the drop handler doesn't
// have to scan the iterations / inbox arrays to recover the source state.
// ---------------------------------------------------------------------------

const DRAG_MIME = "application/x-grove-iteration-drag";

interface DragPayload {
  kind: DragSourceKind;
  /** Inbox item id (kind=inbox) or iteration id (kind=iteration). */
  id: string;
  /** Iteration current state (only present for kind=iteration). */
  state?: IterationState;
}

// ---------------------------------------------------------------------------
// Column display labels — kept short so a six-column row stays narrow.
// ---------------------------------------------------------------------------

const COLUMN_LABELS: Record<IterationBoardColumn, string> = {
  inbox: "Inbox",
  designing: "Designing",
  queued: "Queued",
  in_flight: "In flight",
  blocked: "Blocked",
  done: "Done",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface IterationBoardProps {
  iterations: readonly IterationListItem[];
  inboxItems: readonly InboxItem[];
  loaded: boolean;
  /** Boot error only — surfaced as a red banner above the board. */
  error: string | null;
  /**
   * Called when a card is clicked (principal wants the detail surface).
   * F-15 wires this to a real route; until then the parent shows a toast.
   * For inbox-kind clicks the `id` is the task id; for iteration-kind
   * clicks the `id` is the iteration id.
   */
  onOpen: (kind: DragSourceKind, id: string) => void;
  /**
   * Called when an inbox card is dropped on the `designing` column.
   * Parent stub for now (F-15 wires the actual POST). The parent should
   * optimistically remove the inbox item or show a toast indicating the
   * pending state.
   */
  onCreateIterationFromInbox: (inboxItemId: string) => void;
  /**
   * Called when an iteration card is dropped on a different column. The
   * caller has already passed `canTransition` — this handler does not
   * re-validate. F-15 wires the actual PATCH.
   */
  onMoveIteration: (iterationId: string, targetState: IterationBoardColumn) => void;
}

interface DropHoverState {
  /** Column the cursor is currently over, or null when no drag is active. */
  column: IterationBoardColumn | null;
  /** Decision for the active (sourceKind, sourceState, column) tuple. */
  allowed: boolean;
  reason?: string;
}

export function IterationBoard(props: IterationBoardProps) {
  const {
    iterations,
    inboxItems,
    loaded,
    error,
    onOpen,
    onCreateIterationFromInbox,
    onMoveIteration,
  } = props;

  // Compose the board layout via the pure helper. Memoised so a transition
  // burst that doesn't change row identity doesn't churn child renders.
  const layout = useMemo(
    () => buildIterationBoardLayout(iterations, inboxItems),
    [iterations, inboxItems]
  );

  // Active drag — tracked client-side so the renderer can mute the source
  // card and light up legal drop columns. Per HTML5 dataTransfer rules, the
  // payload is read on `drop`, not `dragover`, so we keep a parallel
  // ref-only mirror for the dragover hit-test.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragPayloadRef = useRef<DragPayload | null>(null);
  const [hover, setHover] = useState<DropHoverState>({ column: null, allowed: false });

  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, payload: DragPayload) => {
      // Encode payload twice: once on our private MIME so the drop handler
      // can reliably recover it, once as text/plain so DevTools / future
      // observers can inspect it. dataTransfer is finicky across browsers
      // so we avoid relying on the private MIME during dragover (Firefox
      // hides custom MIME types from dragover events).
      try {
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
        e.dataTransfer.setData("text/plain", payload.id);
        e.dataTransfer.effectAllowed = "move";
      } catch (err) {
        // Safari occasionally throws on setData under permission tightening;
        // in that case we fall back to the ref-only path. The drop handler
        // checks the ref first, so the drag still completes correctly.
        // eslint-disable-next-line no-console
        console.warn("[iteration-board] dataTransfer.setData failed:", err);
      }
      dragPayloadRef.current = payload;
      setDraggingId(payload.id);
    },
    []
  );

  const onDragEnd = useCallback(() => {
    dragPayloadRef.current = null;
    setDraggingId(null);
    setHover({ column: null, allowed: false });
  }, []);

  const onColumnDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, column: IterationBoardColumn) => {
      const payload = dragPayloadRef.current;
      if (!payload) return;
      const decision = canDrop(
        payload.kind,
        payload.state ?? null,
        column
      );
      // Always preventDefault — that's how the browser learns the column
      // is a valid drop target. The visual differentiation happens via
      // `decision.allowed` in the className.
      e.preventDefault();
      e.dataTransfer.dropEffect = decision.allowed ? "move" : "none";
      // Only update hover state when something actually changed —
      // `dragover` fires at frame rate (60Hz) and naïvely calling
      // setHover on every event re-renders every card in the board.
      // With ~100 cards this saturates the main thread during a drag.
      setHover((prev) => {
        if (
          prev.column === column &&
          prev.allowed === decision.allowed &&
          prev.reason === decision.reason
        ) {
          return prev;
        }
        return { column, allowed: decision.allowed, reason: decision.reason };
      });
    },
    []
  );

  const onColumnDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>, column: IterationBoardColumn) => {
      // dragleave fires when crossing INTO a child element too — the
      // `relatedTarget` is the element we're entering. If that element is
      // still inside the column root, we're not actually leaving the
      // column; bail to avoid the flicker that would otherwise reset
      // hover state mid-drag.
      const relatedTarget = e.relatedTarget;
      if (relatedTarget instanceof Node && e.currentTarget.contains(relatedTarget)) {
        return;
      }
      // Only clear when leaving the column we're currently tracking — a
      // dragleave triggered by an unrelated column shouldn't reset state.
      setHover((prev) => (prev.column === column ? { column: null, allowed: false } : prev));
    },
    []
  );

  const onColumnDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>, column: IterationBoardColumn) => {
      e.preventDefault();
      const payload = readPayload(e, dragPayloadRef.current);
      // Reset visual state regardless of outcome.
      dragPayloadRef.current = null;
      setDraggingId(null);
      setHover({ column: null, allowed: false });
      if (!payload) return;

      const decision = canDrop(payload.kind, payload.state ?? null, column);
      if (!decision.allowed) return;

      if (payload.kind === "inbox") {
        // Decision 5 — inbox → designing creates an iteration around the
        // inbox item. The parent stubs this in F-14; F-15 wires the POST.
        onCreateIterationFromInbox(payload.id);
        return;
      }
      // payload.kind === 'iteration'
      onMoveIteration(payload.id, column);
    },
    [onCreateIterationFromInbox, onMoveIteration]
  );

  return (
    <section className="iteration-board-section" aria-label="Iteration kanban">
      <h2>Iterations</h2>

      {error && (
        <div className="iteration-board-error" role="alert">
          Failed to load iterations: {error}
        </div>
      )}

      {!loaded ? (
        <div className="iteration-board-empty dim">Loading…</div>
      ) : (
        <div className="iteration-board">
          {ITERATION_BOARD_COLUMNS.map((column) => {
            const entries = layout[column];
            const isHovered = hover.column === column;
            const cls = [
              "iteration-board-column",
              isHovered && hover.allowed ? "drop-allowed" : "",
              isHovered && !hover.allowed ? "drop-rejected" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={column}
                className={cls}
                data-column={column}
                onDragOver={(e) => onColumnDragOver(e, column)}
                onDragLeave={(e) => onColumnDragLeave(e, column)}
                onDrop={(e) => onColumnDrop(e, column)}
                title={isHovered && !hover.allowed ? hover.reason : undefined}
              >
                <div className="iteration-board-col-header">
                  <span>{COLUMN_LABELS[column]}</span>
                  <span className="count">{entries.length}</span>
                </div>
                {entries.length === 0 ? (
                  <div className="iteration-board-empty">no items</div>
                ) : (
                  entries.map((entry) => (
                    <IterationCard
                      key={cardKey(entry)}
                      entry={entry}
                      dragging={draggingId === cardId(entry)}
                      onOpen={onOpen}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                    />
                  ))
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface IterationCardProps {
  entry: ColumnEntry;
  dragging: boolean;
  onOpen: (kind: DragSourceKind, id: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, payload: DragPayload) => void;
  onDragEnd: () => void;
}

function IterationCard({ entry, dragging, onOpen, onDragStart, onDragEnd }: IterationCardProps) {
  const isInbox = entry.kind === "inbox";
  const item = entry.item;
  const priority = item.priority;
  // Mirror `priorityLabel`'s `Number.isFinite` guard so a non-integer or
  // non-finite priority (NaN, ±Infinity) renders as the unknown class
  // rather than silently clamping to p0/p3.
  const priorityClass = Number.isFinite(priority) && Number.isInteger(priority) && priority >= 0 && priority <= 3
    ? `p${priority}`
    : "pu";
  const safeSourceUrl = safeSourceHref(item.source_url);
  const cls = [
    "iteration-card",
    priorityClass,
    dragging ? "dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const payload: DragPayload = isInbox
    ? { kind: "inbox", id: item.id }
    : { kind: "iteration", id: item.id, state: (item as IterationListItem).state };

  // The card is a div (not a button) so the HTML5 drag handle works
  // reliably across browsers. Click and keyboard activation are wired
  // explicitly so screen-reader / keyboard users can still open the
  // card. role="button" + tabIndex make it focusable; Enter / Space
  // open the detail.
  const onClick = () => onOpen(isInbox ? "inbox" : "iteration", item.id);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      className={cls}
      draggable
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onDragStart={(e) => onDragStart(e, payload)}
      onDragEnd={onDragEnd}
      data-card-id={item.id}
      data-card-kind={entry.kind}
    >
      <div className="iteration-card-title">{item.title}</div>
      <div className="iteration-card-meta">
        <span className={`priority ${priorityClass}`}>{priorityLabel(priority)}</span>
        {!isInbox && (entry.item as IterationListItem).task_count > 0 && (
          <span className="task-count">
            {(entry.item as IterationListItem).task_count} task
            {(entry.item as IterationListItem).task_count === 1 ? "" : "s"}
          </span>
        )}
        {safeSourceUrl && (
          <a
            className="source-link"
            href={safeSourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            // Don't open the detail surface when the principal clicks
            // through to GitHub — that would race the new tab.
            onClick={(e) => e.stopPropagation()}
          >
            source
          </a>
        )}
        {!isInbox && (entry.item as IterationListItem).source_system && (
          <span
            className="source-badge"
            title={`Imported from ${(entry.item as IterationListItem).source_system}`}
          >
            {(entry.item as IterationListItem).source_system}
          </span>
        )}
        {/*
          F-17 — inbox column visual hint. Tasks that arrived via the
          GitHub auto-import (webhook or principal-driven path) carry
          `source.provider === 'github'` on the InboxItem. The denorm is
          identical to the iteration-side badge above; rendering here
          gives the principal a one-glance signal that a row landed via
          the upstream pipeline rather than being typed directly.

          Per design Decision 1 ("the source link gives us a clickable
          URL on the iteration card") the badge is informational only —
          it never drives state or behaviour. Click-through stays via
          the `source-link` rendered above.

          G-1113.D.7a — branch on the provider-neutral `source.provider`,
          not the raw `source_system` column.
        */}
        {isInbox && (entry.item as InboxItem).source.provider === "github" && (
          <span
            className="source-badge gh"
            title="Auto-imported from GitHub"
            aria-label="Source: GitHub"
          >
            gh
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function priorityLabel(priority: number): string {
  if (!Number.isFinite(priority) || priority < 0) return "P?";
  return `P${priority}`;
}

function cardKey(entry: ColumnEntry): string {
  // Inbox tasks and iterations live in disjoint id spaces (tasks vs
  // iterations), but a defensive prefix keeps React keys unique even
  // if a future migration unifies them.
  return `${entry.kind}:${entry.item.id}`;
}

function cardId(entry: ColumnEntry): string {
  return entry.item.id;
}

/**
 * Recover the drag payload from the drop event. Tries the private MIME
 * first (reliable across browsers), then falls back to the ref the drag
 * handler captured (Safari / strict-permission fallback).
 */
function readPayload(
  e: React.DragEvent<HTMLDivElement>,
  fallback: DragPayload | null
): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (raw) {
      const parsed = JSON.parse(raw) as DragPayload;
      if (parsed && (parsed.kind === "inbox" || parsed.kind === "iteration") && typeof parsed.id === "string") {
        return parsed;
      }
    }
  } catch (err) {
    // JSON parse failure or dataTransfer permission error — fall through
    // to the ref. Per repo CLAUDE.md the catch is named + commented.
    // eslint-disable-next-line no-console
    console.warn("[iteration-board] drop payload parse failed:", err);
  }
  return fallback;
}
