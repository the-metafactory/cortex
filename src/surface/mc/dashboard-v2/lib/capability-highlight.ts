/**
 * G-1114.F.2 — cross-component hover-highlight logic (pure).
 *
 * The INTERACTION (mouse enter/leave, the React context that broadcasts the
 * hovered target) is wiring; the DECISION — "given what the principal is
 * hovering, which agent nodes / capability badges / tasks light up?" — is pure
 * and lives here, unit-tested without a DOM (the D.1-3 pure/wrapper discipline).
 *
 * ## Hover targets
 *
 * A hover target is one of:
 *   - `{ kind: "capability", capability }` — hovering a capability badge (on an
 *     agent node, in the detail panel, or on a task). HIGHLIGHTS every agent
 *     declaring that capability + the badge itself everywhere it appears.
 *   - `{ kind: "agent", agentKey }` — hovering an agent (node / panel).
 *     HIGHLIGHTS the agent + its declared capabilities + the tasks it could
 *     serve.
 *   - `null` — nothing hovered; nothing highlighted (the resting state).
 *
 * ## Output — a highlight set
 *
 * `computeHighlight(target, index)` returns the SET of things to light up:
 *   - `agentKeys` — agent nodes / panel rows to highlight.
 *   - `capabilities` — capability badges to highlight.
 *   - `taskIds` — task rows to highlight.
 *
 * Membership-test helpers (`isAgentHighlighted` etc.) read off frozen Sets so a
 * component can ask "am I lit?" in O(1) during render. When `target` is `null`
 * the result is the shared EMPTY highlight (no allocation, every test false) so
 * the resting render does zero highlight work.
 *
 * Origin-blind, exactly like the match index: a FEDERATED agent highlights on a
 * capability hover the same as a local one (F.3 is where local-vs-foreign
 * DISPATCH differs, not highlighting).
 */

import type { CapabilityMatchIndex } from "./capability-match";

/** What the principal is hovering (or `null` at rest). */
export type HoverTarget =
  | { kind: "capability"; capability: string }
  | { kind: "agent"; agentKey: string }
  | null;

/** The set of elements to highlight, with O(1) membership helpers. */
export interface HighlightSet {
  /** Agent keys to highlight. */
  agentKeys: ReadonlySet<string>;
  /** Capability ids to highlight. */
  capabilities: ReadonlySet<string>;
  /** Task ids to highlight. */
  taskIds: ReadonlySet<string>;
  /** True when nothing is highlighted (the resting state). */
  isEmpty: boolean;
}

/** Shared resting-state highlight — every set empty, zero allocation per render. */
export const EMPTY_HIGHLIGHT: HighlightSet = Object.freeze({
  agentKeys: new Set<string>(),
  capabilities: new Set<string>(),
  taskIds: new Set<string>(),
  isEmpty: true,
});

/**
 * Compute the highlight set for a hover target against the match index.
 *
 * - **null** → {@link EMPTY_HIGHLIGHT} (resting; highlight nothing).
 * - **capability hover** → every agent declaring it (`agentsForCapability`) +
 *   the capability itself. No tasks (a capability isn't a task) — the value is
 *   "which agents can do THIS".
 * - **agent hover** → the agent + its declared capabilities
 *   (`capabilitiesForAgent`) + the tasks it could serve (`tasksForAgent`).
 *
 * Pure: the same target + index always yields the same set.
 */
export function computeHighlight(
  target: HoverTarget,
  index: CapabilityMatchIndex,
): HighlightSet {
  if (target === null) return EMPTY_HIGHLIGHT;

  const agentKeys = new Set<string>();
  const capabilities = new Set<string>();
  const taskIds = new Set<string>();

  if (target.kind === "capability") {
    capabilities.add(target.capability);
    for (const agent of index.agentsForCapability(target.capability)) {
      agentKeys.add(agent.key);
    }
  } else {
    // agent hover
    agentKeys.add(target.agentKey);
    for (const cap of index.capabilitiesForAgent(target.agentKey)) {
      capabilities.add(cap);
    }
    for (const task of index.tasksForAgent(target.agentKey)) {
      taskIds.add(task.id);
    }
  }

  const isEmpty =
    agentKeys.size === 0 && capabilities.size === 0 && taskIds.size === 0;

  return { agentKeys, capabilities, taskIds, isEmpty };
}

/** O(1): is this agent in the highlight set? */
export function isAgentHighlighted(h: HighlightSet, agentKey: string): boolean {
  return h.agentKeys.has(agentKey);
}

/** O(1): is this capability in the highlight set? */
export function isCapabilityHighlighted(
  h: HighlightSet,
  capability: string,
): boolean {
  return h.capabilities.has(capability);
}

/** O(1): is this task in the highlight set? */
export function isTaskHighlighted(h: HighlightSet, taskId: string): boolean {
  return h.taskIds.has(taskId);
}
