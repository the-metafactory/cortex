/**
 * Pill primitives — generic, priority (P0/P1/P2/P3), and assignment-state.
 *
 * Mirrors the legacy monolith's `.pill` family one-for-one so the visual
 * vocabulary across the dashboard stays consistent through the migration.
 * CSS lives in styles/global.css under .pill / .pill.p* / .pill.state-*.
 */

import type { ReactNode } from "react";
import type { AssignmentState } from "../../types";

export interface PillProps {
  /** Optional kind token concatenated into the className (e.g. "p0", "state-blocked"). */
  kind?: string;
  children: ReactNode;
}

export function Pill({ kind, children }: PillProps) {
  return <span className={`pill${kind ? ` ${kind}` : ""}`}>{children}</span>;
}

export interface PriorityPillProps {
  /** 0 = P0 (most urgent), increasing is less urgent. */
  priority: number;
}

export function PriorityPill({ priority }: PriorityPillProps) {
  const label = priorityLabel(priority);
  const kind = `p${Math.max(0, Math.min(3, priority))}`;
  return <Pill kind={kind}>{label}</Pill>;
}

export interface StatePillProps {
  state: AssignmentState;
}

export function StatePill({ state }: StatePillProps) {
  return <Pill kind={`state-${state}`}>{state}</Pill>;
}

export function priorityLabel(priority: number): string {
  if (!Number.isFinite(priority) || priority < 0) return "P?";
  // Note: the visual `kind` token is clamped to p0..p3 in PriorityPill, but
  // the human-readable label intentionally preserves the raw value (so a
  // mis-emitted P7 is visible to principals rather than silently masked as P3).
  return `P${priority}`;
}
