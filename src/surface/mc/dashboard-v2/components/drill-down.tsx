/**
 * F-7 drill-down overlay (V4-flavoured per migration addendum Decision 7).
 *
 * Owns the modal shell, the keyboard shortcuts (Esc / `]` / `[` / `f`),
 * and the focus-mode toggle. Composes <DrillHeader/>, <DrillLog/>, and
 * <DrillInput/> below.
 *
 * Single drill-down at a time per F-7 Decision 9. The parent (App)
 * passes the selected `assignmentId`; null hides the overlay.
 */

import { useEffect, useRef } from "react";
import "./drill-down.css";
import { CurationToolbar } from "./curation-toolbar";
import { DrillHeader } from "./drill-header";
import { DrillLog } from "./drill-log";
import { DrillInput } from "./drill-input";
import { useDrillEvents } from "../hooks/use-drill-events";
import type { WsClient } from "../hooks/use-websocket";
import type { AssignmentListItem } from "../../db/assignments";

export interface DrillDownProps {
  /** When null, the overlay is closed and renders nothing. */
  assignmentId: string | null;
  /** All blocked assignments in focus order, for `]`/`[` navigation. */
  focusItems: AssignmentListItem[];
  /** Currently-known assignment metadata (resolved from assignments map). */
  assignment: AssignmentListItem | null;
  ws: WsClient;
  onClose: () => void;
  /** Cycle to a different assignment ID (called by `]`/`[`). */
  onCycle: (assignmentId: string) => void;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  /** Called when the operator submits text/images. Returns errors via the input. */
  onSendInput: (assignmentId: string, text: string, images?: Array<{ media_type: string; data: string }>) => Promise<void>;
  /**
   * F-16 — invoked when the operator clicks the iteration chip in
   * the drill-header. Threaded through to <DrillHeader/>; the App
   * owner navigates to the kanban-detail view for that iteration id.
   */
  onOpenIteration?: (iterationId: string) => void;
}

export function DrillDown({
  assignmentId,
  focusItems,
  assignment,
  ws,
  onClose,
  onCycle,
  focusMode,
  onToggleFocusMode,
  onSendInput,
  onOpenIteration,
}: DrillDownProps) {
  const drillEvents = useDrillEvents(ws, assignmentId);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Global keyboard. Esc closes; `]`/`[` cycle; `f` focus-mode (when
  // textarea not focused). Always runs in capture phase so Esc here
  // beats other Esc handlers (lightbox is the exception per its own
  // capture-phase listener in MIG-1).
  useEffect(() => {
    if (!assignmentId) return;
    const currentId = assignmentId;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const target = e.target;
      const inText = target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.key === "]" && !inText) {
        e.preventDefault();
        cycleAssignment(focusItems, currentId, +1, onCycle);
        return;
      }
      if (e.key === "[" && !inText) {
        e.preventDefault();
        cycleAssignment(focusItems, currentId, -1, onCycle);
        return;
      }
      if (e.key === "f" && !inText && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onToggleFocusMode();
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [assignmentId, focusItems, onClose, onCycle, onToggleFocusMode]);

  if (!assignmentId) return null;

  const className = `drill-overlay${focusMode ? " focus-mode" : ""}`;
  return (
    <div className={className} role="dialog" aria-modal="true" aria-label="Attention drill-down" ref={overlayRef}>
      <div className="drill-backdrop" onClick={onClose} />
      <div className="drill-panel">
        <DrillHeader
          assignment={assignment}
          events={drillEvents.events}
          onClose={onClose}
          focusMode={focusMode}
          onToggleFocusMode={onToggleFocusMode}
          {...(onOpenIteration ? { onOpenIteration } : {})}
        />
        <DrillLog
          events={drillEvents.events}
          loaded={drillEvents.loaded}
          hasMore={drillEvents.hasMore}
          error={drillEvents.error}
          onLoadOlder={drillEvents.loadOlder}
        />
        {/*
          F-12 curation toolbar — Decision 2 places it between the log
          and the input. Verb enablement is a pure function of
          `assignment.state`; WS state.transition + operator.curation
          frames flip the button set without manual round-trips.
        */}
        <CurationToolbar assignment={assignment} />
        <DrillInput
          assignmentId={assignmentId}
          assignment={assignment}
          ws={ws}
          onSend={onSendInput}
        />
      </div>
    </div>
  );
}

function cycleAssignment(
  items: AssignmentListItem[],
  current: string,
  delta: number,
  onCycle: (id: string) => void
): void {
  if (items.length === 0) return;
  const idx = items.findIndex((i) => i.id === current);
  if (idx < 0) {
    // Current isn't in the focus row — jump to the first.
    const first = items[0];
    if (first) onCycle(first.id);
    return;
  }
  const nextIdx = ((idx + delta) % items.length + items.length) % items.length;
  const next = items[nextIdx];
  if (next) onCycle(next.id);
}
