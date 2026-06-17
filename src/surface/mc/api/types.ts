/**
 * Grove Mission Control v2 — REST API request/response shapes.
 */

import type { AssignmentListItem, MostActiveAgent } from "../db/assignments";
import type { TaskListItem } from "../db/tasks";
import type { WorkingAgentTile } from "../db/working-agents";
import type { AgentOrigin } from "./agents";
import type {
  InboxItem,
  IterationDetail,
  IterationListItem,
  IterationState,
} from "../db/iterations";
import type { McEvent } from "../types";

export interface ApiError {
  error: string;
}

// --- GET /api/assignments ---

export interface ListAssignmentsResponse {
  assignments: AssignmentListItem[];
}

// --- GET /api/focus-area ---

/**
 * Focus area feed — blocked assignments only, ordered by task priority ASC
 * then updated_at ASC. See docs/design-mc-f6-focus-area.md.
 *
 * `mostActiveAgent` drives the empty-state one-liner from §2.6 of the design
 * addendum ("All clear" + most-active-agent line). Null when no assignment
 * is in `running` — the dashboard falls back to the static empty-state text.
 * Populated regardless of whether `items` is empty so the client doesn't
 * need a second round-trip to render the empty state.
 */
export interface ListFocusAreaResponse {
  items: AssignmentListItem[];
  mostActiveAgent: MostActiveAgent | null;
}

// --- GET /api/tasks ---

/**
 * Task list feed for the dashboard's §8.4 table. Task-keyed projection with
 * assignment roll-up and server-computed `aggregate_state` per the rank
 * table in `docs/design-mc-f8-task-table.md` Decision 4.
 *
 * Default omits `done`/`cancelled` rows; `?includeClosed=true` opts in.
 * Payload capped at 500 rows (`TASKS_QUERY_LIMIT`) — see addendum Decision 1.
 */
export interface ListTasksResponse {
  tasks: TaskListItem[];
}

// --- GET /api/working-agents ---

/**
 * Working-agent grid feed for the dashboard's §8.3 grid. Agent-keyed
 * projection with the current-primary assignment folded in, plus a count
 * of additional active-non-blocked assignments for the `+N` badge.
 *
 * #1008 — each tile MAY carry an `origin` (`"local"` or `{principal, stack}`)
 * when the serving stack has pane-of-glass DB-read aggregation on: the feed is
 * then the origin-tagged UNION across the local db + each readable LOCAL sibling
 * stack's db. The field is OPTIONAL — the single-db feed omits it (byte-identical
 * to the pre-#1008 shape), and the dashboard's multi-hub grouping treats a
 * missing `origin` as `"local"`.
 *
 * See docs/design-mc-f9-working-grid.md for the full decision log.
 */
export interface ListWorkingAgentsResponse {
  agents: (WorkingAgentTile & { origin?: AgentOrigin })[];
}

// --- POST /api/sessions ---

/**
 * Minimal Phase A body. taskId/agentId can be supplied for Phase E task
 * curation integration; when omitted a task and default agent are synthesized.
 *
 * F-20 widens this with `kind` + `ccSessionId` + `agentName` so externally-
 * launched terminal sessions (`cldyo-live`) can register an observed
 * session without requiring MC v2 to spawn the CC subprocess. See
 * `docs/design-mc-f20-observe.md`.
 */
export interface CreateSessionRequest {
  title?: string;
  taskId?: string;
  agentId?: string;
  /** Display name for the agent — used when `agentId` is supplied for a
   *  not-yet-known agent (e.g. principal's `cldyo-live` invocation). */
  agentName?: string;
  principalId?: string;
  /**
   * Optional initial principal turn. If provided, it is written to the
   * controlled session after spawn and recorded as a principal.input event.
   * Ignored for `kind: 'local.observed'` (no stdin to write to).
   */
  prompt?: string;
  /**
   * F-20 endpoint kind. Defaults to `'local.process.controlled'` — MC v2
   * spawns and owns the CC subprocess. `'local.observed'` registers an
   * externally-launched session for read-only visibility; `ccSessionId`
   * must be supplied so the ingestor can match incoming events.
   */
  kind?: "local.process.controlled" | "local.observed";
  /**
   * F-20 — required when `kind === 'local.observed'`. UUID supplied by
   * the wrapper (see `cldyo-live`); CC will tag every emitted event with
   * this id via `--session-id <uuid>`.
   */
  ccSessionId?: string;
  /**
   * ST-P2 — substrate the session runs on (claude-code | codex | …). Additive +
   * optional; defaults to 'claude-code' (DEFAULT_SUBSTRATE) when omitted, so no
   * existing caller changes behavior. An attribute of the SESSION (refactor D4).
   */
  substrate?: string;
  /**
   * ST-P2 — the session that spawned this one (the session-tree edge). Additive
   * + optional; NULL/omitted ⇒ an agent-rooted session. Threaded onto the
   * created `sessions` row so the tree can be assembled by the API projection
   * (Phase 4). For runner-spawned children this is the env-stamped parent
   * (Phase 1); the observed/orphan path correlates it in the ingestor (D1b).
   */
  parentSessionId?: string | null;
}

export interface CreateSessionResponse {
  assignmentId: string;
  sessionId: string;
}

// --- GET /api/assignments/:id/events ---

/**
 * Paged event feed for the F-7 drill-down. Ordered ascending by event `id`.
 *
 * - `sessionId` is the session these events belong to. Null when the
 *   assignment has no session yet (still `queued`) — in that case `events`
 *   is empty and `hasMore` is false.
 * - `hasMore` is true when older events exist before the returned page.
 *   Use the first returned event's id as the next `before` cursor.
 */
export interface ListEventsResponse {
  events: McEvent[];
  hasMore: boolean;
  sessionId: string | null;
}

// --- POST /api/assignments/:id/input ---

/**
 * Principal input to a running session. At least one of `text` or
 * non-empty `images` must be present; empty body (or both absent /
 * images empty) returns 400.
 *
 * Image content blocks follow the Maestro/CC shape — raw base64
 * + media_type, no data-URL prefix. See
 * `docs/design-mc-image-input.md` Decision 4.
 */
export interface SendInputImage {
  /** One of the Decision 5 allowlist media types. */
  media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  /** Raw base64 string (no `data:<type>;base64,` prefix). */
  data: string;
}

export interface SendInputRequest {
  text?: string;
  images?: SendInputImage[];
}

export interface SendInputResponse {
  ok: true;
  eventId: string;
}

// --- POST /api/assignments/:id/requeue ---
//
// F-12 Decision 7: 1-to-1 mirror of the state machine's `principal_requeue`
// action. Legal from `blocked` and `failed` only; any other state returns
// 409 with the state-machine's error string.

export interface RequeueRequest {
  /** Optional free-text reason captured in the principal.curation event. */
  reason?: string;
}

export interface RequeueResponse {
  ok: true;
  assignmentId: string;
  from: AssignmentStateName;
  to: AssignmentStateName;
  eventId: string;
}

// --- POST /api/assignments/:id/abandon ---
//
// F-12 Decision 5: branches on context.
//   scope === "assignment"  → applyTransition(... cancel) on the assignment
//   scope === "task"        → UPDATE tasks.status = 'cancelled'
// When omitted, the server picks: assignment if the assignment is non-terminal,
// task if the assignment is in {completed,failed,cancelled} (per the matrix).

export type AbandonScope = "assignment" | "task";

export interface AbandonRequest {
  scope?: AbandonScope;
  reason?: string;
}

export interface AbandonResponse {
  ok: true;
  assignmentId: string;
  scope: AbandonScope;
  taskId: string;
  /** Present only for scope === "assignment". */
  from?: AssignmentStateName;
  /** Present only for scope === "assignment". */
  to?: AssignmentStateName;
  eventId: string;
}

// --- POST /api/assignments/:id/handoff ---
//
// F-12 Decision 6:
//   - In-flight (queued/dispatched/running/blocked): cancel current + spawn new.
//   - Terminal-but-rerunnable (failed): spawn new only.
// `completed` and `cancelled` source assignments are rejected at the handler
// per the Decision 3 enablement matrix.

export interface HandoffRequest {
  newAgentId: string;
  reason?: string;
}

export interface HandoffResponse {
  ok: true;
  /** The original assignment id (kept verbatim, even when not cancelled). */
  assignmentId: string;
  newAssignmentId: string;
  newSessionId: string;
  /** Present when the original was cancelled by hand-off (in-flight path). */
  from?: AssignmentStateName;
  /** Present when the original was cancelled by hand-off (in-flight path). */
  to?: AssignmentStateName;
  eventId: string;
}

// AssignmentStateName re-export so handlers/tests don't need to drag the union
// in from `../types` for response shapes alone.
type AssignmentStateName =
  | "queued"
  | "dispatched"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

// --- F-12b "Add to queue" from GitHub ---------------------------------------
//
// See `docs/design-mc-f12b-add-to-queue.md` Decisions 6 + 10.
//
// Three new endpoints:
//   POST /api/tasks/preview           — validate + fetch + dedup, no write
//   POST /api/tasks                   — commit task + shadow assignment/session
//   POST /api/tasks/:taskId/abandon   — task-keyed cancel (inherited from F-12)

/**
 * Shared request body for preview and create — Decision 4 accepts a URL,
 * `owner/repo#N`, `repo#N` (with default owner), or `#N` (with default
 * owner+repo). Canonicalisation happens server-side.
 */
export interface PreviewTaskRequest {
  ref: string;
}

/** Successful preview — no dedup conflict. Decision 6 wire shape. */
export interface PreviewTaskResponse {
  kind: "preview";
  /** Canonical `owner/repo#number` string. */
  ref: string;
  /** Canonical html_url from GitHub. */
  url: string;
  type: "issue" | "pr";
  /** GitHub state: "open" | "closed" (or whatever GitHub returns). */
  state: string;
  title: string;
  labels: string[];
  /** First ~240 chars of the issue body with whitespace collapsed. */
  body_excerpt: string;
  /** ISO-8601 UTC — not persisted, purely informational. */
  fetched_at: string;
}

/** Dedup conflict response — shared by preview and create. */
export interface PreviewTaskConflict {
  kind: "conflict";
  existingTaskId: string;
  existingTitle: string;
  existingStatus: string;
  message: string;
}

/** Create request body. Priority is integer 0..3 on the wire (Decision 10). */
export interface CreateTaskRequest {
  ref: string;
  titleOverride?: string;
  priority: number;
}

export interface CreateTaskResponse {
  taskId: string;
  shadowAssignmentId: string;
  shadowSessionId: string;
  title: string;
  source_url: string;
  source_external_id: string;
  priority: number;
}

/**
 * Task-keyed abandon (Decision 6 — inherited from F-12 Decision 5's
 * deferred route). Different from `POST /api/assignments/:id/abandon`:
 * this one mutates `tasks.status = 'cancelled'` directly, the other
 * routes through `applyTransition` on an assignment.
 */
export interface AbandonTaskRequest {
  reason?: string;
}

export interface AbandonTaskResponse {
  taskId: string;
  status: "cancelled";
  /** ISO-8601 UTC. */
  updated_at: string;
  eventId: string;
}

// --- F-13 Iteration planning surface ----------------------------------------
//
// See `docs/design-mc-iteration-planning.md` Decision 8 for the wire shapes.
// Schema-only PR — only the two read endpoints are wired here. Mutation
// endpoints (POST/PATCH /api/iterations*) are deferred to F-14/F-15.

/** Powers the iteration kanban (six lifecycle columns + ungrouped lane). */
export interface ListIterationsResponse {
  iterations: IterationListItem[];
}

/** Powers the kanban inbox column (upstream-imported, not yet attached). */
export interface ListInboxResponse {
  items: InboxItem[];
}

// --- F-15 iteration mutation surface --------------------------------------
//
// Decision 8 spells the wire shapes:
//   GET    /api/iterations/:id              — header + tasks
//   POST   /api/iterations                  — create (empty or from source)
//   PATCH  /api/iterations/:id              — update title/body/priority/state
//   POST   /api/iterations/:id/tasks        — attach existing task or create+attach
//   DELETE /api/iterations/:id/tasks/:tid   — detach (does not delete task)
//
// Every mutation returns the canonical `IterationDetail` so the client can
// replace its in-memory copy in one render pass — same idiom F-12 uses
// for the curation verbs.

/** Powers the iteration detail surface (`/iterations/:id`). */
export interface GetIterationResponse {
  iteration: IterationDetail;
}

/**
 * Create body for `POST /api/iterations`. `title` is the only required
 * field; the rest default per the schema (`state='inbox'`, `priority=2`).
 *
 * `state` is settable on create so a principal-typed internal-only
 * iteration can land directly in `designing` (skipping the inbox lane,
 * since there's no upstream issue to anchor it). Server validates the
 * value is in the canonical enum.
 */
export interface CreateIterationRequest {
  title: string;
  body?: string | null;
  imported_body?: string | null;
  priority?: number;
  state?: IterationState;
  source_system?: string | null;
  source_url?: string | null;
  source_parent_ref?: string | null;
}

export interface CreateIterationResponse {
  iteration: IterationDetail;
}

/**
 * Patch body for `PATCH /api/iterations/:id`. Any subset of these
 * fields is allowed; an empty body is a no-op (still returns 200 with
 * the unchanged iteration).
 *
 * `state` transitions go through `canTransition` server-side regardless
 * of what the client sends — never trust the client to gate the
 * lifecycle.
 */
export interface UpdateIterationRequest {
  title?: string;
  body?: string | null;
  priority?: number;
  state?: IterationState;
}

export interface UpdateIterationResponse {
  iteration: IterationDetail;
}

/**
 * Body for `POST /api/iterations/:id/tasks`. Two mutually exclusive
 * shapes:
 *   - `{ task_id: '...' }` → attach an EXISTING task (typically pulled
 *     from the inbox or another iteration).
 *   - `{ create: { title, priority? } }` → create a new internal-only
 *     task in one call, attach it, return the iteration.
 *
 * Sending both keys returns 400; sending neither returns 400.
 */
export interface AttachTaskRequest {
  task_id?: string;
  create?: {
    title: string;
    priority?: number;
  };
}

export interface AttachTaskResponse {
  iteration: IterationDetail;
}

export interface DetachTaskResponse {
  iteration: IterationDetail;
}

// --- F-17 GitHub iteration auto-import ------------------------------------
//
// Principal-driven path. Lets the principal explicitly pull a GitHub issue
// into Grove as an iteration (matching the auto-import logic the webhook
// handler runs on `issues.labeled`), without waiting for the next webhook
// event. Useful for backfilling pre-existing labelled issues.
//
// Per `docs/design-mc-iteration-planning.md` Decision 1 + Decision 9 the
// import is a one-time event — once the row exists in Grove, subsequent
// upstream edits do NOT clobber Grove-side edits. The handler refreshes
// only the audit-only `imported_body` snapshot when the upstream body
// changed; everything else is principal-sovereign.

/**
 * Request body for `POST /api/iterations/from-github`.
 *
 * `ref` follows the same shorthand-friendly format as F-12b's
 * `POST /api/tasks/preview` — full HTTPS URL, `owner/repo#N`, or `#N`
 * with a default repo configured. The `label` defaults to `"iteration"`
 * (matches the auto-import default).
 */
export interface ImportIterationFromGithubRequest {
  ref: string;
  label?: string;
}

/**
 * 200 OK shape — returns the freshly-imported (or already-existing)
 * iteration in canonical detail shape so the caller can append it to
 * the kanban without a round-trip.
 *
 * `bodyRefreshed` flags whether the call refreshed the audit-only
 * `imported_body` snapshot (true on re-import where the upstream body
 * changed since last import; false on a true no-op or fresh import).
 * Useful for the principal UI to show a "no changes since last import"
 * vs "snapshot updated" cue.
 */
export interface ImportIterationFromGithubResponse {
  kind: "imported" | "exists";
  iteration: IterationDetail;
  bodyRefreshed: boolean;
}

/**
 * Conflict response — the issue exists but isn't carrying the
 * `iteration` label (so importing it would silently drop it). Returned
 * 409 by the principal-driven path; the webhook auto-path treats this
 * as a no-op (a webhook fires for every issue label change; we filter
 * to the iteration label internally).
 */
export interface ImportIterationFromGithubConflict {
  kind: "conflict";
  reason: "not_iteration_labelled";
  canonical: string;
  message: string;
}

// --- GET /api/metrics/assignment/:id  +  GET /api/metrics/fleet ---

/**
 * F-18 — metrics REST surface. See `docs/design-mc-f18-metrics.md`.
 *
 * Both endpoints are read-only over the existing schema (no new tables, no
 * new event kinds). The shapes mirror `db/metrics.ts` exports verbatim;
 * this module just re-asserts them on the wire so a wire-only consumer
 * (e.g., a future cloud client) can import from `api/types` without pulling
 * in the `bun:sqlite`-tainted `db/metrics.ts`.
 */
export interface MetricsAssignmentResponse {
  metrics: import("../db/metrics").AssignmentMetrics;
}

export interface MetricsFleetResponse {
  metrics: import("../db/metrics").FleetMetrics;
}
