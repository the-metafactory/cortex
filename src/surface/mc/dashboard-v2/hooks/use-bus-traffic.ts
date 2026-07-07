/**
 * CK-5 (cortex#1292 · decision D-10) — the bus-traffic WS-frame subscriber.
 *
 * Rides the ONE dashboard WebSocket (`use-websocket.ts`) as a wildcard (`"*"`)
 * subscriber — the WS-FRAME EXTENSION decision D-10 calls for, NOT a second feed
 * or a REST poll. Each surfaced frame is classified (`classifyFrameScope`) and
 * dropped into a bounded ring buffer with its arrival time; a light 1s decay tick
 * recomputes the rolled-up `BusTrafficModel` so the reading falls back to STATIC
 * within one window after the flow stops (truth-not-theater — motion tracks real
 * frames only).
 *
 * All wall-clock reads (`Date.now()`) live here; the math lives in the pure
 * `lib/bus-traffic.ts`. No `server.ts` change: the counters are derived entirely
 * client-side from frames the daemon already pushes.
 */

import { useEffect, useRef, useState } from "react";
import type { WsClient, WsMessage } from "./use-websocket";
import {
  classifyFrameScope,
  computeTrafficModel,
  idleTrafficModel,
  pruneEvents,
  DEFAULT_TRAFFIC_WINDOW_MS,
  type BusTrafficModel,
  type TrafficEvent,
} from "../lib/bus-traffic";

export interface UseBusTrafficOptions {
  /**
   * Only accumulate while the consuming view is visible (the Network tab). A
   * frame arriving while disabled is ignored — the subscription itself stays
   * mounted (gated via a ref) so we don't churn it on every tab flip, matching
   * `use-agents`. Default true.
   */
  enabled?: boolean;
  /** Rolling window width in millis. Default {@link DEFAULT_TRAFFIC_WINDOW_MS}. */
  windowMs?: number;
}

/** Recompute cadence: 1s. Fast enough to feel live, slow enough to be cheap. */
const DECAY_TICK_MS = 1_000;

/**
 * Subscribe to the live WS frame stream and expose the aggregate bus-traffic
 * model. Returns a stable idle model until the first real frame lands.
 */
export function useBusTraffic(
  ws: WsClient,
  opts: UseBusTrafficOptions = {},
): BusTrafficModel {
  const enabled = opts.enabled ?? true;
  const windowMs = opts.windowMs ?? DEFAULT_TRAFFIC_WINDOW_MS;

  const [model, setModel] = useState<BusTrafficModel>(() => idleTrafficModel(windowMs));
  const bufRef = useRef<TrafficEvent[]>([]);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const subscribe = ws.subscribe;

  // Accumulate real frames. Wildcard subscription so every surfaced frame type
  // is seen; the classifier drops control frames and buckets the rest. Recompute
  // eagerly on arrival so the reading feels live, then prune to bound the buffer.
  useEffect(() => {
    function onFrame(msg: WsMessage) {
      if (!enabledRef.current) return;
      const scope = classifyFrameScope(msg.type);
      if (scope === null) return; // control / keepalive — never counted
      const now = Date.now();
      const buf = pruneEvents(bufRef.current, now, windowMs);
      buf.push({ t: now, scope });
      bufRef.current = buf;
      setModel(computeTrafficModel(buf, now, windowMs));
    }
    return subscribe("*", onFrame);
  }, [subscribe, windowMs]);

  // Decay tick: recompute on a timer so the model relaxes to STATIC within one
  // window after frames stop (no arrival event fires to trigger the recompute).
  useEffect(() => {
    if (!enabled) {
      // Tab hidden: clear the buffer and show idle so re-entry starts honest.
      bufRef.current = [];
      setModel(idleTrafficModel(windowMs));
      return;
    }
    const id = setInterval(() => {
      const now = Date.now();
      const buf = pruneEvents(bufRef.current, now, windowMs);
      bufRef.current = buf;
      setModel(computeTrafficModel(buf, now, windowMs));
    }, DECAY_TICK_MS);
    return () => clearInterval(id);
  }, [enabled, windowMs]);

  return model;
}
