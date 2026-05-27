/**
 * F-16 — display helpers for the denormalised `TaskIterationTag`.
 *
 * Tiny pure module: format the iteration title for chip + table-cell
 * display, and decide which `pill` kind token to use so the visual
 * distinguishes from the existing assignment-state pill family.
 *
 * Lives here (instead of inlined in the components) because the
 * truncation rule (~20 chars + ellipsis) appears in two surfaces (F-7
 * drill-header chip and F-8 task-table column) and a single source of
 * truth means future tweaks land once. Mirrors the F-8 task-table-filter
 * pattern of "tiny pure helpers, exhaustively tested" rather than the
 * "logic embedded in JSX" pattern that breeds drift.
 *
 * Per the design spec `docs/design-mc-iteration-planning.md`
 * §"Surface 3" — chip reads "Iteration: <title> (state)" with the
 * state in lowercase to match the existing assignment-state pill
 * labels; the cell is the title alone (the column header already
 * communicates "this is an iteration"); both truncate to 20 chars
 * and tooltip the full title.
 */

import type { TaskIterationTag, TaskListItem } from "../../db/tasks";
import { ITERATION_STATES, type IterationState } from "../../db/iterations";

/** Visual truncation cap. Mirrors the F-8 column width budget. */
export const ITERATION_TITLE_MAX_CHARS = 20;

/**
 * Truncate a title to the visual cap. Adds an ellipsis (single
 * Unicode char `…`) when truncated. Returns the input unchanged when
 * it already fits — no trailing ellipsis on exact-fit titles.
 *
 * Pure / total — every defined string maps to a defined string. The
 * empty string maps to itself (the principal never sees a blank
 * iteration title because `iterations.title NOT NULL`, but the
 * helper is total against future schema relaxation).
 */
export function truncateIterationTitle(title: string): string {
  if (title.length <= ITERATION_TITLE_MAX_CHARS) return title;
  return title.slice(0, ITERATION_TITLE_MAX_CHARS - 1) + "…";
}

/**
 * Render the F-7 drill-header chip text: "Iteration: <truncated> (state)".
 *
 * Why the format includes the state — the chip is the principal's
 * one-glance signal that "this task is in iteration X, currently
 * <state>". Linking out to the iteration detail without surfacing the
 * state means the principal clicks through purely to confirm the
 * lifecycle column. The four-byte cost in the chip pays for itself
 * many-fold per design spec §"Surface 3".
 */
export function chipText(it: TaskIterationTag): string {
  return `Iteration: ${truncateIterationTitle(it.title)} (${it.state})`;
}

/**
 * Tooltip text for the chip + cell — the full untrucated title plus the
 * state (cell case where the principal hovers a truncated title and
 * needs to know which iteration this actually is). Distinct from
 * `chipText` so the tooltip reveals the full string even when the
 * visible chip itself was truncated.
 */
export function chipTooltip(it: TaskIterationTag): string {
  return `${it.title} (${it.state})`;
}

/**
 * Pill kind token for the iteration chip. We deliberately use a
 * dedicated `iteration-<state>` family (NOT the existing
 * `state-<assignmentState>` family) because:
 *
 *   1. The two state vocabularies are different (iteration: inbox /
 *      designing / queued / in_flight / blocked / done / cancelled;
 *      assignment: queued / dispatched / running / blocked /
 *      completed / failed / cancelled). A literal "state-blocked"
 *      collision would be visually misleading in the drill-down
 *      header where both pill families render side-by-side.
 *
 *   2. The design spec calls for "a different color so it's
 *      distinguishable" — a separate kind token is the cleanest way
 *      to land that without forking the `<Pill/>` component.
 *
 * The CSS pairs in `global.css` define one rule per kind; we keep the
 * mapping table here so a future colour-palette change touches the
 * helper, not the component.
 */
export function chipPillKind(it: TaskIterationTag): string {
  return `iteration iteration-${it.state}`;
}

// ---------------------------------------------------------------------------
// F-16 sweep — shared subscription helpers (Echo grove-v2#43 Major 3 + 4)
// ---------------------------------------------------------------------------

/**
 * Patch payload from an `iteration.updated` WS frame. Either field may
 * be omitted; if both are omitted the patch is a no-op (caller normally
 * just skips in that case).
 */
export interface IterationTagPatch {
  id: string;
  title?: string;
  state?: IterationState;
}

/**
 * Cross-surface row patcher for `iteration.updated` WS frames.
 *
 * Per Echo grove-v2#43 (Major 3) — `use-tasks` and `use-focus-area`
 * had a near-verbatim copy of the same patch logic (skip-when-id-
 * mismatched, skip-when-equal, reconstructed row, identity-preserving
 * short-circuit). Centralised here so when F-17 adds a third surface
 * the patch logic stays in one place.
 *
 * Returns the SAME array reference when no row changed (lets React's
 * referential-equality bailout skip the re-render). Otherwise returns
 * a new array with patched rows shallow-cloned.
 */
export function patchIterationOnRows<
  T extends { iteration: TaskIterationTag | null }
>(rows: T[], patch: IterationTagPatch): T[] {
  let changed = false;
  const next = rows.map((row) => {
    if (!row.iteration || row.iteration.id !== patch.id) return row;
    const updated: TaskIterationTag = { ...row.iteration };
    let rowChanged = false;
    if (patch.title !== undefined && updated.title !== patch.title) {
      updated.title = patch.title;
      rowChanged = true;
    }
    if (patch.state !== undefined && updated.state !== patch.state) {
      updated.state = patch.state;
      rowChanged = true;
    }
    if (!rowChanged) return row;
    changed = true;
    return { ...row, iteration: updated };
  });
  return changed ? next : rows;
}

/**
 * Per Echo grove-v2#43 (Major 4) — runtime shape check for an
 * `iteration.updated` payload before patching cached rows. The TS cast
 * (`as IterationListItem | undefined`) is a lie: a malformed broadcast
 * frame with `title: 42` or `state: "bogus"` would land in the cached
 * row and crash `chipText`'s `title.slice(...)` at render time.
 *
 * Returns the validated patch on success; `null` when the payload
 * doesn't match the wire contract (subscriber drops silently — same
 * shape as bad-message-on-unknown-channel handling).
 */
export function validateIterationUpdatedPayload(
  raw: unknown
): IterationTagPatch | null {
  if (!raw || typeof raw !== "object") return null;
  const it = raw as Record<string, unknown>;
  if (typeof it.id !== "string" || it.id.length === 0) return null;
  if (it.title !== undefined && typeof it.title !== "string") return null;
  if (it.state !== undefined) {
    if (typeof it.state !== "string") return null;
    if (!ITERATION_STATES.includes(it.state as IterationState)) return null;
  }
  return {
    id: it.id,
    ...(it.title !== undefined && { title: it.title as string }),
    ...(it.state !== undefined && { state: it.state as IterationState }),
  };
}

/**
 * Per Echo grove-v2#43 sweep #2 — runtime shape check for a
 * `task.updated` payload before swapping a cached row. Symmetric with
 * `validateIterationUpdatedPayload`: the TS cast (`as TaskListItem`)
 * is a lie, so a malformed broadcast frame would otherwise land in
 * cache and crash `chipText`'s `iteration.title.slice(...)` at render.
 *
 * Validates the load-bearing fields the dashboard renders against.
 * Doesn't (yet) deeply validate `assignments[].state` etc. — those are
 * already inside the existing F-8 / F-7 render paths' own guards;
 * extending here would duplicate those.
 *
 * Returns the validated `TaskListItem` on success, `null` on malformed
 * input. Subscribers drop silently on null — same shape as the
 * iteration validator.
 */
export function validateTaskUpdatedPayload(raw: unknown): TaskListItem | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || t.id.length === 0) return null;
  if (typeof t.title !== "string") return null;
  // `iteration` is the load-bearing denorm — when non-null it must
  // pass the same shape the chip renderers consume. Reuse the
  // iteration validator (id + optional title + optional state) but
  // also require title + state to be present (the broadcast shape
  // always includes them since the JOIN populates both).
  if (t.iteration !== null && t.iteration !== undefined) {
    const itPatch = validateIterationUpdatedPayload(t.iteration);
    if (!itPatch) return null;
    if (typeof itPatch.title !== "string") return null;
    if (typeof itPatch.state !== "string") return null;
  }
  return raw as TaskListItem;
}
