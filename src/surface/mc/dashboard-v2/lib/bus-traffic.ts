/**
 * CK-5 (cortex#1292 · decision D-10) — client-side aggregate bus-traffic model.
 *
 * The constellation must "breathe with REAL envelope flow" (plan §2 north-star)
 * WITHOUT inventing a second feed or a REST poll (decision D-10): it rides the
 * frames the ONE dashboard WebSocket already delivers. Every surfaced frame
 * (`agent.presence`, `event`, `state.transition`, `task.*`, `iteration.*`,
 * `mc.projection`, …) is a daemon-pushed projection of real bus / stack activity;
 * counting them over a rolling window is an honest throughput proxy — no
 * `server.ts` change, no fabricated motion, no polling multiplication (the very
 * thing CK-3 kills).
 *
 * TRUTH-NOT-THEATER (invariant 2): the model measures ACTUAL frames. Zero frames
 * in the window ⇒ `active: false` ⇒ the canvas dash-flow, the atmosphere, and the
 * bus-traffic strip all render STATIC. Motion only ever tracks real flow — the
 * glass never fabricates liveness.
 *
 * This module is PURE (no React, no timers, no `subscribe`, no wall-clock read)
 * so it unit-tests without a DOM. `use-bus-traffic.ts` owns the ring buffer and
 * the `Date.now()` reads; it feeds timestamps in here.
 */

/**
 * Envelope scope buckets, mirroring the constellation skin's Deterministic /
 * Agentic / Human attention coding (`--d` / `--a` / `--h` tokens, constellation
 * .css). The bus-traffic strip's "D/A/H scope-count legend" (mockup @505) reads
 * these. This is a SURFACE-FRAME → scope projection: it classifies the dashboard
 * frames the WS already carries, not raw M2 envelopes (those never reach the
 * browser — ADR-0005). Honest by construction: every count is a frame that
 * actually arrived.
 */
export type TrafficScope = "d" | "a" | "h";

/** A single classified, timestamped frame arrival. `t` is `Date.now()` millis. */
export interface TrafficEvent {
  t: number;
  scope: TrafficScope;
}

/** The rendered model: throughput + per-scope counts over the rolling window. */
export interface BusTrafficModel {
  /** Any real flow in the window. FALSE ⇒ render everything static. */
  active: boolean;
  /** Frames per second across the window (rounded to 1 dp). 0 when idle. */
  throughput: number;
  /** Total frames counted in the window. */
  total: number;
  /** Per-scope frame counts in the window. */
  counts: Record<TrafficScope, number>;
  /** The window width the model was computed over (millis) — echoed for the UI. */
  windowMs: number;
}

/** Default rolling window: 5s balances responsiveness against jitter. */
export const DEFAULT_TRAFFIC_WINDOW_MS = 5_000;

/**
 * Control / transport frames that are NOT bus activity: the WS keepalive and the
 * subscription handshake. Counting them would fabricate a permanent low hum of
 * "traffic" even on a dead-quiet stack (the ping fires every few seconds) — which
 * is exactly the theater invariant 2 forbids. Excluded from every count.
 */
const CONTROL_FRAME_TYPES: ReadonlySet<string> = new Set([
  "ping",
  "pong",
  "connected",
  "subscribed",
  "error",
]);

/**
 * Substring rules for the Human scope: a frame representing a human-in-the-loop
 * moment (attention, admission, approval, handoff, governance, pier). Checked
 * first so an `mc.attention`-style frame lands in `h`, not the `a`/`d` fallbacks.
 */
const HUMAN_FRAME_HINTS: readonly string[] = [
  "attention",
  "admission",
  "approval",
  "handoff",
  "governance",
  "pier",
  "escalat",
];

/**
 * Substring rules for the Agentic scope: agent / session / dispatch activity —
 * the swarm's own signal (invariant 19). Checked after Human so a human-gated
 * dispatch approval still reads as Human.
 */
const AGENTIC_FRAME_HINTS: readonly string[] = [
  "agent",
  "session",
  "dispatch",
  "event",
  "state.",
  "presence",
];

/**
 * Classify a WS frame `type` into a D/A/H scope, or `null` when it is a control
 * frame that must not be counted. Pure + total: an unrecognised surfaced frame
 * (a task/iteration/projection/system frame) falls through to Deterministic —
 * the honest default for a system-emitted, non-agent, non-human envelope.
 *
 * Ordering is load-bearing and documented: Human hints win over Agentic hints so
 * a human-gated agent action (e.g. a dispatch approval) reads as Human, not as
 * swarm activity — presence ≠ activity (invariant 19).
 */
export function classifyFrameScope(type: string): TrafficScope | null {
  if (CONTROL_FRAME_TYPES.has(type)) return null;
  const t = type.toLowerCase();
  for (const hint of HUMAN_FRAME_HINTS) if (t.includes(hint)) return "h";
  for (const hint of AGENTIC_FRAME_HINTS) if (t.includes(hint)) return "a";
  // task.*, iteration.*, mc.projection, and any other system-emitted surfaced
  // frame: Deterministic. This is the fallback, never a fabricated bucket.
  return "d";
}

/**
 * Drop events older than `now - windowMs`. Pure; returns a new array (kept in
 * arrival order). The hook calls this to bound the ring buffer so it never grows
 * without limit on a busy stack.
 */
export function pruneEvents(
  events: readonly TrafficEvent[],
  now: number,
  windowMs: number = DEFAULT_TRAFFIC_WINDOW_MS,
): TrafficEvent[] {
  const cutoff = now - windowMs;
  return events.filter((e) => e.t > cutoff);
}

/** An idle model — zero flow, everything static. Stable shape for the UI. */
export function idleTrafficModel(
  windowMs: number = DEFAULT_TRAFFIC_WINDOW_MS,
): BusTrafficModel {
  return { active: false, throughput: 0, total: 0, counts: { d: 0, a: 0, h: 0 }, windowMs };
}

/**
 * Compute the rendered model from the buffered events at wall-clock `now`.
 * Events outside the window are ignored (the caller need not have pruned).
 * Throughput is total / window-seconds, rounded to 1 dp. `active` is strictly
 * `total > 0` — a single real frame lights the glass; zero keeps it static.
 */
export function computeTrafficModel(
  events: readonly TrafficEvent[],
  now: number,
  windowMs: number = DEFAULT_TRAFFIC_WINDOW_MS,
): BusTrafficModel {
  const cutoff = now - windowMs;
  const counts: Record<TrafficScope, number> = { d: 0, a: 0, h: 0 };
  let total = 0;
  for (const e of events) {
    if (e.t <= cutoff) continue;
    counts[e.scope] += 1;
    total += 1;
  }
  if (total === 0) return idleTrafficModel(windowMs);
  const perSec = total / (windowMs / 1000);
  const throughput = Math.round(perSec * 10) / 10;
  return { active: true, throughput, total, counts, windowMs };
}

/** Format a throughput for the strip: `"12.5 env/s"`, `"0 env/s"` when idle. */
export function formatThroughput(model: BusTrafficModel): string {
  return `${model.throughput} env/s`;
}
