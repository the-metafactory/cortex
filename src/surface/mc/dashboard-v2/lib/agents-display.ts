/**
 * G-1114.B.4 — pure display helpers for the agents panel.
 *
 * Kept out of the React component so the formatting (relative-time, panel mode
 * selection) is unit-testable without a DOM, mirroring `working-grid-display.ts`.
 */

import type { AgentPresenceTile } from "../hooks/use-agents";

/** Panel render mode, selected from load/error/data state. */
export type AgentsPanelMode = "error" | "loading" | "empty" | "list";

export interface AgentsPanelInput {
  agents: AgentPresenceTile[];
  loaded: boolean;
  error: string | null;
}

/**
 * Pick the panel's render mode.
 *   - `error`   — boot fetch failed (and nothing loaded yet).
 *   - `loading` — first fetch in flight.
 *   - `empty`   — loaded, no agents observed.
 *   - `list`    — loaded, ≥1 agent.
 *
 * A refetch error after a successful boot is intentionally NOT `error` (the hook
 * swallows it warn-only) — the last-good list stays on screen.
 */
export function pickAgentsPanelMode(input: AgentsPanelInput): AgentsPanelMode {
  if (input.error && !input.loaded) return "error";
  if (!input.loaded) return "loading";
  if (input.agents.length === 0) return "empty";
  return "list";
}

/**
 * Format an epoch-ms timestamp as a compact relative string ("just now",
 * "12s ago", "3m ago", "2h ago", "5d ago"). `null`/`undefined` → "never".
 * `now` is injectable for deterministic tests.
 */
export function formatRelativeTime(
  epochMs: number | null | undefined,
  now: number = Date.now()
): string {
  if (epochMs === null || epochMs === undefined) return "never";
  const deltaMs = now - epochMs;
  // A future or near-zero timestamp (clock skew) reads as "just now" rather
  // than a negative duration.
  if (deltaMs < 5_000) return "just now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
