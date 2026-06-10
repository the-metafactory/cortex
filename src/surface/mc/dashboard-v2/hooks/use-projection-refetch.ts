/**
 * MC-I1.S6 / C-863 — subscribe a live view to the `mc.projection` WS frame.
 *
 * Thin React wrapper over `attachProjectionRefetch` (`lib/projection-subscriber`).
 * A data hook that already exposes a `refetch` calls this with its `view` tag to
 * get live, debounced refreshes off projection writes (verdicts, heartbeats,
 * attention, dispatch-lifecycle) — the same way `use-working-agents` already
 * refreshes off `state.transition`, but driven by the S6 projection broadcast so
 * bus→MC writes no longer wait for the next poll.
 *
 * The subscription + debounce + unmount-cancel all live in the pure core; this
 * hook only manages the effect lifecycle so a pending refetch can never call
 * `setState` after unmount.
 */

import { useEffect } from "react";
import type { WsClient } from "./use-websocket";
import { attachProjectionRefetch } from "../lib/projection-subscriber";
import type { ProjectionView } from "../lib/projection-routing";

/**
 * Default trailing-debounce window for projection-driven refetches. A burst of
 * projection frames (e.g. a dispatch fan-out that flips several rows at once)
 * coalesces into one refetch this long after the last frame. Sits in the
 * 250–500ms band the issue calls for — wider than the 100ms `state.transition`
 * window because projection bursts (a team handoff, a verdict cascade) tend to
 * arrive in clusters and the live panes tolerate a slightly later refresh.
 */
export const PROJECTION_REFETCH_DEBOUNCE_MS = 300;

export function useProjectionRefetch(
  ws: WsClient,
  view: ProjectionView,
  refetch: () => void,
  debounceMs: number = PROJECTION_REFETCH_DEBOUNCE_MS
): void {
  const subscribe = ws.subscribe;
  useEffect(() => {
    return attachProjectionRefetch({ subscribe, view, refetch, debounceMs });
  }, [subscribe, view, refetch, debounceMs]);
}
