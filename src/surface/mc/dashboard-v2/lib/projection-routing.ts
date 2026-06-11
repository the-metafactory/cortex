/**
 * MC-I1.S6 / C-863 — `mc.projection` family → live-view routing.
 *
 * S6 (#862) added a server-side `mc.projection` WS broadcast: when the bus→MC
 * projection renderer mutates MC state from an envelope (review verdicts, agent
 * heartbeats, federated attention, adapter health, or a dispatch-lifecycle
 * transition) it fans the write out to live dashboard clients. The frame is
 * **family-hinted** — it carries a `family` discriminator plus optional
 * `sessionId` / `assignmentId` joins — but, like `state.transition`, it is a
 * REFRESH SIGNAL, not authoritative-by-payload: the rows still come from the
 * REST API on refetch.
 *
 * This module owns the one piece of policy the wiring needs — which live views a
 * given `family` can affect — kept pure so it's unit-testable without a DOM. A
 * view subscribes to `mc.projection` and refetches only when the frame's family
 * routes to it; a family that touches no live pane (today: `adapter.health`,
 * which only feeds the adapter-health surface, not the three live execution
 * panes) routes to the empty set and triggers no refetch.
 */

/** The projection families the server may stamp on an `mc.projection` frame. */
export const PROJECTION_FAMILIES = [
  "dispatch.lifecycle",
  "review.verdict",
  "agent.heartbeat",
  "attention",
  "adapter.health",
  // P-14 U2.1 (#934) — signal's four system.* families refresh the Observability tab.
  "observability",
] as const;

export type ProjectionFamily = (typeof PROJECTION_FAMILIES)[number];

/**
 * The live views a `mc.projection` refetch can target. These are the
 * data hooks whose REST payload a projection write can invalidate.
 */
export type ProjectionView = "working-agents" | "tasks" | "attention" | "observability";

/**
 * Map a projection `family` → the live views it can invalidate.
 *
 *   - `dispatch.lifecycle` — a dispatch moved (queued → dispatched → running →
 *     done/blocked). Re-reads the working grid AND the task table (a task's
 *     aggregate state can flip on any dispatch transition).
 *   - `review.verdict` — a reviewer posted a verdict. Touches the working grid
 *     (the reviewed assignment's state) and the attention queue (a blocking
 *     verdict can open/clear an attention entry).
 *   - `agent.heartbeat` — an agent's liveness changed. Working grid only.
 *   - `attention` — the attention queue itself changed.
 *   - `adapter.health` — adapter up/down; no live execution pane reads it, so
 *     it routes to nothing (additive future surface).
 *
 * An unknown / malformed family routes to the empty set (defensive: a future
 * server family this client doesn't know about triggers no spurious refetch).
 */
export function routeProjectionFamily(family: string): readonly ProjectionView[] {
  switch (family) {
    case "dispatch.lifecycle":
      return ["working-agents", "tasks"];
    case "review.verdict":
      return ["working-agents", "attention"];
    case "agent.heartbeat":
      return ["working-agents"];
    case "attention":
      return ["attention"];
    case "adapter.health":
      return [];
    case "observability":
      // The Observability tab is the sole reader of this family (the four
      // signal system.* families). It can also touch the attention queue (a
      // collector.degraded / backend.unreachable opens an att:adapter: item),
      // but the renderer broadcasts a separate `attention` family for that, so
      // here `observability` routes only to its own view.
      return ["observability"];
    default:
      return [];
  }
}

/** Does an `mc.projection` frame of this family target the given view? */
export function projectionAffectsView(
  family: string,
  view: ProjectionView
): boolean {
  return routeProjectionFamily(family).includes(view);
}
