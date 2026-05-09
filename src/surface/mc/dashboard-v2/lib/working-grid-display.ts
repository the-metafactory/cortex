/**
 * Pure helpers for the F-9 working-grid display branching.
 *
 * The component itself uses hooks (focused-tile state, refs, etc.) and
 * needs a React renderer to test — `__tests__/` doesn't run jsdom (per
 * the migration addendum's Decision 8: jsdom + RTL is post-migration).
 * These helpers keep the per-state branching unit-testable without a DOM.
 */

import type { WorkingAgentTile } from "../hooks/use-working-agents";

/**
 * One of five rendering modes per F-9 Decision 7 + the boot/error path.
 *
 * - `hidden`  — Decision 7's "hide entirely" branch (loaded, grid empty,
 *               focus row has entries — don't distract from "needs you").
 * - `error`   — boot fetch failed; grid empty, error pill shown.
 * - `loading` — pre-boot, grid empty, no error.
 * - `empty`   — loaded, grid empty, focus row also empty: "No agents
 *               working right now."
 * - `tiles`   — loaded, grid non-empty: render one tile per agent.
 *
 * The error path is reachable only from boot — refetch failures are
 * swallowed in `use-working-agents` (legacy parity).
 */
export type WorkingGridMode = "hidden" | "error" | "loading" | "empty" | "tiles";

export interface WorkingGridDisplayInput {
  agents: WorkingAgentTile[];
  loaded: boolean;
  error: string | null;
  focusItemCount: number;
}

export function pickWorkingGridMode(input: WorkingGridDisplayInput): WorkingGridMode {
  const { agents, loaded, error, focusItemCount } = input;
  // Decision 7 — hide entirely when focus has attention items and the
  // grid would render empty. Loaded matters: pre-boot the grid is also
  // empty but we'd rather show "Loading…" than nothing.
  if (loaded && agents.length === 0 && focusItemCount > 0) return "hidden";
  if (agents.length > 0) return "tiles";
  if (error) return "error";
  if (!loaded) return "loading";
  return "empty";
}

/** Match the legacy `priorityLabel`. P? for out-of-range / non-integer. */
export function priorityLabel(p: number): string {
  if (Number.isInteger(p) && p >= 0 && p <= 3) return `P${p}`;
  return "P?";
}
