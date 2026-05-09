/**
 * Shared formatting utilities used across frontend and backend.
 * No dependencies on backend-specific imports to allow frontend usage.
 */

/**
 * Format milliseconds as a human-readable duration string (e.g. "12m 34s").
 *
 * Long-form. Use `formatDurationCompact` for scan-friendly single-token
 * output (e.g. F-18 metrics big-numbers).
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

/**
 * Compact duration formatter — single-token, two significant figures,
 * scan-friendly. Anything above 99 days reads as ">99d".
 *
 * Used by the F-18 metrics panel's big-number cells. Distinct from
 * `formatDuration` (`12m 34s` long-form); both live here so the next
 * contributor doesn't end up with a third variant.
 */
export function formatDurationCompact(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const sec = ms / 1_000;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${min < 10 ? min.toFixed(1) : Math.round(min)}m`;
  const hr = min / 60;
  if (hr < 24) return `${hr < 10 ? hr.toFixed(1) : Math.round(hr)}h`;
  const d = hr / 24;
  if (d > 99) return ">99d";
  return `${d < 10 ? d.toFixed(1) : Math.round(d)}d`;
}
