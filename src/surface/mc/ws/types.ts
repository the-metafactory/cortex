/**
 * Grove Mission Control v2 — WebSocket protocol types.
 *
 * Protocol version: 2. Bumped when breaking changes are made to message
 * shapes. Clients check `protocolVersion` on the `connected` handshake to
 * detect incompatibility.
 *
 * ADDITIVE frame types are BACK-COMPAT — NOT a version bump. The client
 * dispatcher (dashboard-v2 `use-websocket.ts`) is a type-keyed subscription map
 * (`subs.get(parsed.type)?.forEach(...)`), so a frame `type` an older client
 * doesn't know finds no handler and no-ops (falling through only to an opt-in
 * `"*"` wildcard). Only a BREAKING change to an EXISTING frame's shape bumps
 * `WS_PROTOCOL_VERSION`. (E.g. MC-I1.S6's `mc.projection` frame is additive and
 * intentionally ships without a bump.)
 *
 * v2 (cortex#436): the input/curation event kinds were renamed to
 * `principal.input` / `principal.curation`; the identity field was renamed
 * to `principalId`. Clients must read the principal.* kinds.
 */

import type { AssignmentState, BlockReason, McEvent } from "../types";
import type {
  IterationDetail,
  IterationListItem,
  IterationState,
} from "../db/iterations";
import type { TaskListItem } from "../db/tasks";

export const WS_PROTOCOL_VERSION = 2;

// Data attached to each WebSocket connection
export interface WsData {
  clientId: string;
}

// Server → client messages
export type WsServerMessage =
  | {
      type: "connected";
      clientId: string;
      serverVersion: string;
      protocolVersion: number;
    }
  | {
      type: "state.transition";
      assignmentId: string;
      from: AssignmentState;
      to: AssignmentState;
      blockReason?: BlockReason | null;
    }
  | { type: "event"; sessionId: string; event: McEvent }
  // F-15 — iteration planning lifecycle events.
  //
  // Per Echo grove-v2#42 (Major 3) — the broadcast surface is split so
  // every connected kanban tab doesn't pay the byte cost of a 50 KB
  // body + tasks array on every body autosave (debounced ~1s during a
  // writing session). The kanban only renders list-item fields; the
  // detail surface wants the full row.
  //
  //   - `iteration.created` — full `IterationDetail`. Fires once per
  //     POST; new-iteration creates carry tasks (principal may have
  //     created with attachments) so the detail surface can populate
  //     immediately if the principal opens it post-create.
  //   - `iteration.updated` — header-only `IterationListItem`. Fires
  //     on every successful PATCH / attach / detach. Drives the kanban.
  //   - `iteration.detail_updated` — full `IterationDetail`. Fires
  //     paired with `iteration.updated` from the same handler call so
  //     the per-id detail subscriber gets the body / tasks delta.
  //   - `iteration.state_changed` — column-move signal only. Carries
  //     the (from, to) pair, no body. Fires paired with the others
  //     when a PATCH actually moves the `state` column.
  | { type: "iteration.created"; iteration: IterationDetail }
  | { type: "iteration.updated"; iteration: IterationListItem }
  | { type: "iteration.detail_updated"; iteration: IterationDetail }
  | {
      type: "iteration.state_changed";
      iterationId: string;
      from: IterationState;
      to: IterationState;
    }
  // F-16 sweep — `task.updated` event for cross-surface attach/detach
  // propagation. Per Echo grove-v2#43 (Major 1) — when a task's
  // `iteration_id` flips (null → attached, attached → detached, or
  // moved between iterations), the existing `iteration.updated` patch
  // handlers cannot patch it on row-cached surfaces (focus area, task
  // table) because `row.iteration?.id !== it.id` for the new/null id.
  // Backend now broadcasts a fresh `TaskListItem` (re-read with the
  // updated denorm) so subscribers replace the row in place.
  | { type: "task.updated"; task: TaskListItem }
  // MC-I1.S6 (#848) — bus→MC projection signal. Emitted when the projection
  // renderer mutates MC state from a bus envelope (verdict, heartbeat,
  // federated attention, adapter health, or a dispatch-lifecycle transition).
  // Carries the projected `family` + the optional joined session/assignment so
  // a client can scope its refetch. Like `state.transition`, it's a REFRESH
  // SIGNAL — the authoritative rows come from the REST API on refetch, not from
  // this frame's fields — so it reuses the existing debounced-refetch pattern
  // rather than inventing an authoritative-by-payload protocol. Closes the S4
  // "projection writes bypass WS fan-out" gap.
  | {
      type: "mc.projection";
      family:
        | "dispatch.lifecycle"
        | "review.verdict"
        | "agent.heartbeat"
        | "attention"
        | "adapter.health";
      sessionId?: string;
      assignmentId?: string;
    }
  // G-1114.B.4 — agent-presence live refresh signal. Broadcast when the
  // stack-local runtime agent-presence registry mutates a record
  // (`agent.online` / `agent.heartbeat` / `agent.offline` /
  // `agent.capabilities-changed`). Like `state.transition` and `mc.projection`
  // it's a REFRESH SIGNAL, not an authoritative payload: the agents panel
  // refetches `GET /api/agents` on receipt rather than trusting the frame's
  // fields, so the wire contract stays minimal. ADDITIVE — older dashboard
  // clients (whose type-keyed dispatcher has no `agent.presence` handler) ignore
  // it; no `WS_PROTOCOL_VERSION` bump.
  | {
      type: "agent.presence";
      /** The affected registry key — `{principal}/{stack}/{agent_id}`. */
      key: string;
      /** The post-mutation liveness state, for cheap client-side filtering. */
      state: "online" | "offline";
    }
  | { type: "pong" }
  | { type: "ping" }
  | {
      type: "subscribed";
      assignmentIds: string[];
    }
  | { type: "error"; message: string };

// Client → server messages
export type WsClientMessage =
  | { type: "ping" }
  | { type: "pong" }
  | { type: "subscribe"; assignmentIds?: string[] };
