/**
 * cortex#361 — Agent liveness heartbeat payload type.
 *
 * Bus-side signal that an agent is "still working" on a dispatch. Producers
 * (dispatch-handler, review-pipeline) emit `system.agent.heartbeat` envelopes
 * on a fixed interval (default 30 s) while a task is in flight. The envelope
 * carries a coarse `phase` (derived from the most recent cc-session stream
 * event seen) plus `last_activity_ms_ago` so a subscriber can distinguish
 * "agent is genuinely thinking" from "agent is reading a 559-line PR diff and
 * its tool-use rate is just low".
 *
 * **Out of scope for this iteration** (filed as follow-ups on cortex / myelin):
 *   - Dashboard rendering of "Echo last seen 12s ago" — separate cortex issue.
 *   - Canonical myelin schema entry for `system.agent.heartbeat` — Path B per
 *     cortex#361 ships on the principal-managed `local.{principal}.{stack}.*`
 *     namespace; cross-principal (`federated.*`) propagation needs a myelin
 *     spec round. Tracked as a follow-up issue on `the-metafactory/myelin`.
 *   - cc-session inactivity-timer "respect heartbeat" — separate cortex issue
 *     (touches cc-session's kill path, larger blast radius).
 *
 * **Phase enum.** Four buckets, chosen to be cheap to map from the
 * `CCSession` EventEmitter's emitted events:
 *
 *   | EventEmitter event | Phase                  |
 *   |--------------------|------------------------|
 *   | (no event yet)     | `thinking`             |
 *   | `tool-use`         | `tool_use`             |
 *   | `text`             | `streaming_response`   |
 *   | `result`           | `publishing_verdict`   |
 *
 * Phase is best-effort metadata for surfaces — NOT a security boundary.
 * A spoofed phase is bounded by the envelope's `signed_by[]` chain (the
 * stack key still has to sign the envelope through the normal
 * `runtime.publish` signing path).
 */

/**
 * Payload shape for the `system.agent.heartbeat` envelope type. Lands on
 * `envelope.payload`; `envelope.type` carries the literal
 * `"system.agent.heartbeat"` string and the runtime's stack-aware subject
 * derivation routes it to `local.{principal}.{stack}.system.agent.heartbeat`.
 */
export interface AgentHeartbeatPayload {
  /**
   * Logical agent identifier — `echo`, `luna`, `sage`, etc. Matches the
   * `agent.name` field that cortex.yaml advertises. Stamped on the payload
   * (not the envelope source) so dashboards can group heartbeats by agent
   * without parsing the `org.agent.instance` source triple.
   */
  agent_id: string;
  /**
   * Dispatch-scoped task identifier. For chat-path dispatches this is the
   * `task-${uuid}` string minted by `dispatch-handler.handleAsync`; for the
   * review-pipeline path this is the inbound request envelope's
   * `correlation_id` (the consumer assigns the same value to both the
   * verdict envelope's `correlation_id` and the heartbeat's `task_id`,
   * which lets a subscriber join heartbeats back to the terminal verdict).
   */
  task_id: string;
  /**
   * UUID-shaped correlation key. For the review-pipeline path this is the
   * inbound request envelope's `envelope.id`. For the chat-path dispatch
   * (which has no inbound request envelope today), the producer mints a
   * fresh UUID per dispatch and reuses it across that dispatch's
   * heartbeats. Either way it's a UUID — the envelope's top-level
   * `correlation_id` field is also set so envelope-level correlation works
   * across the schema-validated path (G-1100.B's UUID constraint).
   */
  correlation_id: string;
  /** Coarse activity bucket. See file header for the mapping table. */
  phase: "thinking" | "tool_use" | "streaming_response" | "publishing_verdict";
  /**
   * Milliseconds since the most recent cc-session stream event seen by the
   * producer. `0` immediately after an event; grows monotonically between
   * events. Subscribers that want a "stalled" detector watch for
   * `last_activity_ms_ago` climbing past their per-flavor threshold (e.g.
   * `code-review.generic`'s 5-min hard timer would become "no events for
   * 90 s AND `last_activity_ms_ago` > 90_000 in the last heartbeat").
   */
  last_activity_ms_ago: number;
  /**
   * Monotonically-increasing tick counter scoped to **one
   * `HeartbeatTicker` instance** — which in the cortex-bot wiring means
   * "one CCSession attempt", NOT "one dispatch end-to-end". Starts at 1
   * for the first heartbeat after `HeartbeatTicker.start()` and
   * increments by 1 per tick.
   *
   * **Interaction with cortex#360 retry loop.** The chat-path dispatch
   * handler attaches a fresh `HeartbeatTicker` per retry attempt
   * (`dispatch-handler.ts` `handleSync`), so on a 3-attempt dispatch
   * the iteration sequence is `1,2,3,…` → reset → `1,2,3,…` → reset →
   * `1,2,3,…`, all carrying the same `correlation_id`. A strict
   * gap-detector built from raw iteration arithmetic would mistake
   * each retry boundary for "N-1 lost heartbeats" — so subscribers
   * that stitch heartbeats across attempts MUST treat
   * `(correlation_id continuing) + (iteration reset to 1)` as a
   * retry-attempt boundary, not a wire-loss gap. The review-consumer
   * + handleAsync paths do NOT retry today, so the simpler "iteration
   * monotonic per dispatch" mental model still holds there — but
   * subscribers should write detector code for the retry case
   * (Echo cortex#363 N-2 — doc tightened post-cortex#360 merge).
   *
   * **In-attempt gap detection still works.** Within one ticker
   * instance, the counter is strictly monotonic, so wire-loss
   * detection inside a single attempt is straightforward:
   * `published_iteration[k+1] > published_iteration[k] + 1` implies
   * a lost intermediate heartbeat on the wire.
   */
  iteration: number;
}

/**
 * The literal `envelope.type` string for agent heartbeat envelopes. Exposed
 * as a constant so subscribers (dashboard, future surface-router liveness
 * checks) can filter without re-typing the string.
 *
 * Matches the cortex-local subject prefix `local.{principal}.{stack}.` — the
 * runtime's stack-aware subject derivation prepends those segments
 * automatically (see `MyelinRuntime.publish` and the `stack` config option).
 */
export const AGENT_HEARTBEAT_TYPE = "system.agent.heartbeat" as const;
