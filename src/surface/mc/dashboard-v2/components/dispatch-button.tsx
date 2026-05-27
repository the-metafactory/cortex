/**
 * F-19 — Dispatch button + confirmation popover.
 *
 * Renders a small `Dispatch` button. On click, opens a tiny inline popover
 * with `Cancel` / `Confirm`. Confirm fires the parent's `onConfirm` and
 * the parent owns the actual `POST /api/sessions` call so this component
 * stays surface-agnostic (task-table row + iteration-detail task row).
 *
 * Keyboard:
 *   - `Enter` while button is focused — opens popover (native button click).
 *   - `Enter` inside popover — confirms.
 *   - `Esc` inside popover — cancels.
 *
 * The button disables itself while in flight (caller-controlled via the
 * `busy` prop). Per F-19 Decision 5 single-tab two-click protection.
 */

import { useEffect, useRef, useState } from "react";
import "./dispatch-button.css";

export interface DispatchButtonProps {
  /** Display name for the agent in the popover prompt (e.g. "Default Agent" / "Luna"). */
  agentLabel: string;
  /** True while the request is in flight; disables the button + spinner. */
  busy: boolean;
  /** Confirmed click — caller wires this to the dispatch network call. */
  onConfirm: () => void;
  /** Optional className passthrough so callers can scope styling. */
  className?: string;
}

export function DispatchButton({
  agentLabel,
  busy,
  onConfirm,
  className,
}: DispatchButtonProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Auto-focus Confirm when the popover opens — keyboard-first per F-19
  // spec ("Enter confirms; Esc cancels. Keyboard-first matches the cockpit
  // framing.")
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  // Esc / outside-click close — outside-click checks the popover ref so
  // clicking on the button itself toggles correctly.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    function onClickOutside(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onClickOutside);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onClickOutside);
    };
  }, [open]);

  // Stop the row-click handler in task-table from firing when the
  // principal clicks the button or the popover. The dispatch action
  // is its own intent, not a row-drill-down intent.
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <span className={`dispatch-btn-wrap ${className ?? ""}`} onClick={stop}>
      <button
        type="button"
        className="dispatch-btn"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {busy ? "…" : "Dispatch"}
      </button>
      {open ? (
        <div
          ref={popoverRef}
          className="dispatch-popover"
          role="dialog"
          aria-label="Confirm dispatch"
        >
          <p className="dispatch-popover-text">
            Dispatch this task to <strong>{agentLabel}</strong>?
          </p>
          <div className="dispatch-popover-actions">
            <button
              type="button"
              className="dispatch-popover-cancel"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            >
              Cancel
            </button>
            <button
              ref={confirmRef}
              type="button"
              className="dispatch-popover-confirm"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onConfirm();
              }}
            >
              Confirm ↵
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
