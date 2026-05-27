/**
 * F-6 focus area — "who needs me" row at the top of the dashboard.
 *
 * Renders one card per blocked assignment from the `useFocusArea` hook.
 * Caps the visible row at 6 cards + an overflow chip ("+N more"); see
 * F-6 addendum §2.5 + §3.1 (FOCUS_MAX_VISIBLE).
 *
 * Keyboard:
 *   1-9   — select card by position (within the visible cap)
 *   ←/→   — move selection one card
 *   Enter — open the F-7 drill-down for the selected card (placeholder
 *           in MIG-2; wired in MIG-3)
 *
 * Empty state shows "All clear" + a most-active-agent one-liner per
 * F-6 addendum §2.6 / §4. The one-liner is null when no assignment is
 * `running`; the card row renders the static fallback then.
 *
 * MIG-2 ships everything except the actual drill-down navigation —
 * Enter currently calls a stub `onSelect` which the parent can wire to
 * a toast / future router.
 *
 * Performance (sweep W5):
 *   The global `keydown` listener is attached once with `[]` deps and
 *   reads `visible` / `selectedIdx` / `onSelect` / `onOpen` through a
 *   ref that is refreshed every render. The window listener no longer
 *   churns on idle re-renders or on every items recomputation.
 *
 * Selection (sweep S2):
 *   `selectedIdx` lives in parent state. When `items` shrinks below
 *   the previous selection, this component clamps the parent's value
 *   back into range via `onSelect` so ArrowLeft/ArrowRight don't drift
 *   forward off a stale index.
 */

import { useEffect, useRef } from "react";
import "./focus-area.css";
import { blockReasonOneLiner, priorityBorderClass, timeAgo } from "../lib/block-reason";
import type { AssignmentListItem, MostActiveAgent } from "../../db/assignments";

const FOCUS_MAX_VISIBLE = 6;

export interface FocusAreaProps {
  items: AssignmentListItem[];
  mostActiveAgent: MostActiveAgent | null;
  loaded: boolean;
  error: string | null;
  /** Currently-selected card index (visible cap; -1 when nothing selected). */
  selectedIdx: number;
  onSelect: (idx: number) => void;
  /**
   * Called when the principal presses Enter (or clicks) on a card.
   * Receives the assignment; MIG-3 wires this to the drill-down.
   */
  onOpen: (item: AssignmentListItem) => void;
}

interface KeyboardCtx {
  visible: AssignmentListItem[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
  onOpen: (item: AssignmentListItem) => void;
}

export function FocusArea({
  items,
  mostActiveAgent,
  loaded,
  error,
  selectedIdx,
  onSelect,
  onOpen,
}: FocusAreaProps) {
  // Visible-cap clamp + overflow count.
  const visible = items.slice(0, FOCUS_MAX_VISIBLE);
  const overflow = Math.max(0, items.length - FOCUS_MAX_VISIBLE);

  // Selection clamp (sweep S2): if items shrink below the parent's
  // selected index, snap it back into range via the parent setter.
  // Skips when `selectedIdx === -1` (no selection) and when the
  // index is already valid.
  useEffect(() => {
    if (selectedIdx >= 0 && selectedIdx >= visible.length) {
      onSelect(visible.length === 0 ? -1 : visible.length - 1);
    }
  }, [visible.length, selectedIdx, onSelect]);

  // Latest-values ref — read by the (stable) global keydown listener
  // so the listener can attach once at mount and stay attached.
  const ctxRef = useRef<KeyboardCtx>({ visible, selectedIdx, onSelect, onOpen });
  ctxRef.current = { visible, selectedIdx, onSelect, onOpen };

  // Global keydown handler — attached once, reads from `ctxRef`.
  // Skips when an input/textarea/contenteditable element has focus so
  // we don't hijack typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      const { visible: v, selectedIdx: idx, onSelect: sel, onOpen: open } = ctxRef.current;
      if (v.length === 0) return;

      if (e.key >= "1" && e.key <= "9") {
        const i = Number(e.key) - 1;
        if (i < v.length) {
          e.preventDefault();
          sel(i);
        }
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const next = idx < 0 ? 0 : Math.min(idx + 1, v.length - 1);
        sel(next);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const next = idx <= 0 ? 0 : idx - 1;
        sel(next);
        return;
      }
      if (e.key === "Enter" && idx >= 0 && idx < v.length) {
        const item = v[idx];
        if (item) {
          e.preventDefault();
          open(item);
        }
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <section className="focus-area" aria-label="Focus area — who needs me">
      <h2>Who needs me</h2>
      {error && (
        <div className="focus-error" role="alert">{error}</div>
      )}
      {!loaded ? (
        <div className="focus-loading dim">Loading…</div>
      ) : visible.length === 0 ? (
        <FocusEmpty mostActiveAgent={mostActiveAgent} />
      ) : (
        <div className="focus-cards" role="list">
          {visible.map((item, idx) => (
            <FocusCard
              key={item.id}
              item={item}
              idx={idx}
              selected={idx === selectedIdx}
              onSelect={() => onSelect(idx)}
              onOpen={() => onOpen(item)}
            />
          ))}
          {overflow > 0 && (
            <div className="focus-more dim">+{overflow} more</div>
          )}
        </div>
      )}
    </section>
  );
}

interface FocusCardProps {
  item: AssignmentListItem;
  idx: number;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}

function FocusCard({ item, idx, selected, onSelect, onOpen }: FocusCardProps) {
  const cls = [
    "focus-card",
    priorityBorderClass(item.task.priority),
    selected ? "selected" : "",
  ].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      role="listitem"
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="idx mono">{idx + 1}</div>
      <div className="title truncate">{item.task.title}</div>
      <div className="reason truncate">{blockReasonOneLiner(item.block_reason)}</div>
      <div className="meta">
        <span>P{item.task.priority}</span>
        <span>· {timeAgo(item.updated_at)}</span>
      </div>
    </div>
  );
}

function FocusEmpty({ mostActiveAgent }: { mostActiveAgent: MostActiveAgent | null }) {
  return (
    <div className="focus-empty">
      <span className="heartbeat" aria-hidden="true" />
      <span>All clear.</span>
      {mostActiveAgent && (
        <span className="dim">
          {" "}{mostActiveAgent.name} is working on {mostActiveAgent.taskTitle}.
        </span>
      )}
    </div>
  );
}
