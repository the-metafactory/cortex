/**
 * MC-I1.S6 / C-863 — pure `mc.projection` → debounced-refetch core.
 *
 * Factored out of the React hook (`use-projection-refetch`) so the
 * subscribe + family-filter + trailing-debounce + unmount-cancel logic is
 * unit-testable without a DOM. The hook is a thin wrapper that supplies the
 * real `subscribe` and lets the timers default to the platform ones.
 *
 * Behaviour (matches the issue's acceptance criteria):
 *   - Subscribes to exactly the `mc.projection` frame type (additive — other
 *     frame handling is untouched; old clients ignoring the frame keep working).
 *   - Refetches only when the frame's `family` routes to this `view`
 *     (`projection-routing.ts`). A non-targeting or unknown family is ignored.
 *   - Trailing debounce: a burst of N targeting frames within the window
 *     coalesces into ONE refetch, fired `debounceMs` after the LAST frame.
 *   - The debounce is per-subscriber (one timer per `attach` call), and the
 *     returned teardown cancels any pending timer — no refetch (and so no
 *     setState) can fire after unmount.
 */

import type { WsClient, WsMessage } from "../hooks/use-websocket";
import { projectionAffectsView, type ProjectionView } from "./projection-routing";

/** Injection seam so tests can drive a fake clock. */
export interface TimerLike {
  set: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
}

const realTimer: TimerLike = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h),
};

export interface AttachProjectionRefetchArgs {
  /** The single-WS client's `subscribe`. */
  subscribe: WsClient["subscribe"];
  /** Which live view this refetch belongs to. */
  view: ProjectionView;
  /** Re-read the view's REST payload. Called at most once per debounce window. */
  refetch: () => void;
  /** Trailing-debounce window, ms. */
  debounceMs: number;
  /** Test seam; defaults to real timers. */
  timer?: TimerLike;
}

/**
 * Wire an `mc.projection` debounced refetch for one view. Returns a teardown
 * that unsubscribes AND cancels any pending debounced refetch.
 */
export function attachProjectionRefetch(args: AttachProjectionRefetchArgs): () => void {
  const { subscribe, view, refetch, debounceMs, timer = realTimer } = args;

  let pending: ReturnType<typeof setTimeout> | null = null;

  const onProjection = (msg: WsMessage): void => {
    const family = msg["family"];
    if (typeof family !== "string") return;
    if (!projectionAffectsView(family, view)) return;
    if (pending !== null) timer.clear(pending);
    pending = timer.set(() => {
      pending = null;
      refetch();
    }, debounceMs);
  };

  const unsubscribe = subscribe("mc.projection", onProjection);

  return () => {
    unsubscribe();
    if (pending !== null) {
      timer.clear(pending);
      pending = null;
    }
  };
}
