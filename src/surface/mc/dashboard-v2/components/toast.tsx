/**
 * Top-of-viewport transient toast.
 *
 * Replaces the legacy monolith's inline `#err` pill. Auto-dismisses after
 * `durationMs` (default 4 s); consumer is expected to clear via `onDismiss`
 * so the parent's state stays consistent. CSS lives in styles/global.css
 * under .toast.
 */

import { useEffect } from "react";

export interface ToastProps {
  message: string;
  tone?: "ok" | "error" | "info";
  /** Duration in ms before onDismiss fires automatically. */
  durationMs?: number;
  onDismiss: () => void;
}

export function Toast({ message, tone = "info", durationMs = 4000, onDismiss }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [message, tone, durationMs, onDismiss]);

  return (
    <div
      className={`toast${tone === "error" ? " error" : tone === "ok" ? " ok" : ""}`}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  );
}
