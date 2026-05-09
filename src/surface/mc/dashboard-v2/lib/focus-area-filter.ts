/**
 * F-6 focus-area WebSocket filter.
 *
 * The focus row only changes membership when an assignment enters or
 * leaves the `blocked` state. Every other transition (e.g.
 * running→running, queued→dispatched bursts) is irrelevant to the
 * "who needs me" view and would otherwise hammer the refetch path.
 *
 * Extracted from the `useFocusArea` hook so the predicate can be
 * unit-tested without standing up a full React renderer (MIG-2 sweep
 * review S1).
 */

import type { WsMessage } from "../hooks/use-websocket";

/**
 * True when a `state.transition` WS message indicates a focus-area
 * membership change — i.e. either side of the transition is `blocked`.
 *
 * Returns `false` for messages that are missing `from`/`to`, have
 * non-string values, or describe a transition that doesn't touch
 * `blocked`.
 */
export function isFocusAreaTransition(msg: WsMessage): boolean {
  const from = typeof msg["from"] === "string" ? msg["from"] : null;
  const to = typeof msg["to"] === "string" ? msg["to"] : null;
  return from === "blocked" || to === "blocked";
}
