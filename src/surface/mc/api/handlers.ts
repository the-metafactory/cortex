/**
 * Grove Mission Control v2 — REST API handlers.
 *
 * Endpoints wired from server.ts:
 *   GET  /api/assignments                    — list assignments for dashboard
 *   GET  /api/focus-area                     — blocked-only feed (F-6)
 *   GET  /api/tasks                          — task-keyed feed (F-8 table)
 *   GET  /api/working-agents                 — agent-keyed feed (F-9 grid)
 *   GET  /api/assignments/:id/events         — paged event feed (F-7 drill-down)
 *   POST /api/sessions                       — spawn a new controlled session
 *   POST /api/assignments/:id/input          — write a principal turn
 *
 * Handlers are pure functions over `ApiDeps`. The server owns HTTP framing
 * (routing, method/status, JSON parsing) and defers business logic here.
 */

import type { Database } from "bun:sqlite";
import type { ProcessManager } from "../session/process-manager";
import type { SpawnFn } from "../session/endpoint-resolver";
import { isUuidLoose } from "../../../common/types/uuid";
import type { WsClientRegistry } from "../ws/client-registry";
import type {
  ApiError,
  CreateSessionRequest,
  CreateSessionResponse,
  ListAssignmentsResponse,
  ListEventsResponse,
  ListFocusAreaResponse,
  ListInboxResponse,
  ListIterationsResponse,
  ListTasksResponse,
  ListWorkingAgentsResponse,
  SendInputRequest,
  SendInputResponse,
} from "./types";

import {
  listAssignments,
  listFocusArea,
  mostActiveAgent,
} from "../db/assignments";
import { getTaskById, listTasks } from "../db/tasks";
import { listWorkingAgents } from "../db/working-agents";
import {
  attachTask,
  canTransitionServer,
  createIteration,
  detachTask,
  getIteration,
  getTaskIterationLink,
  INBOX_MAX_LIMIT,
  ITERATION_STATES,
  listInboxItems,
  listIterations,
  nextStatesServer,
  toIterationListItem,
  touchIteration,
  updateIteration,
  type IterationDetail,
  type IterationState,
} from "../db/iterations";
import {
  generateId,
  createPrincipalCurationEvent,
  createPrincipalInputEvent,
  listEventsForSession,
  EVENTS_LIST_MAX_LIMIT,
} from "../db/events";
import {
  createSession,
  createShadowAssignmentAndSession,
  findLatestSessionForAssignment,
  SHADOW_AGENT_ID,
} from "../db/sessions";
import {
  parseGitHubRef,
  canonicalRef,
  isParseError,
  type GitHubRef,
  type ParseDefaults,
} from "./github-ref";
import {
  fetchIssueOrPr,
  excerpt,
  isGitHubFetchError,
  type GhSpawnFn,
  type GitHubFetchError,
} from "./github-fetch";
import {
  DEFAULT_ITERATION_LABEL,
  importIterationFromMetadata,
  importSubIssueFromMetadata,
  parentMetadataFromGhResponse,
  parentMetadataFromWebhook,
  parentRef,
  subIssueRefsFromWebhook,
} from "./iteration-import";
import { applyTransition } from "../db/transitions";
import {
  computeAssignmentMetrics,
  computeFleetMetrics,
  windowToSinceDate,
  FLEET_WINDOW_ALLOWLIST,
  type FleetWindow,
} from "../db/metrics";
import {
  createControlledEndpoint,
  resolveSessionEndpoint,
  spawnControlledSession,
} from "../session/endpoint-resolver";
import {
  NotControllable,
  SessionClosed,
  SessionConflict,
} from "../session/types";
import {
  broadcastEvent,
  broadcastIterationCreated,
  broadcastIterationDetailUpdated,
  broadcastIterationStateChanged,
  broadcastTaskUpdated,
  broadcastIterationUpdated,
  broadcastTransition,
  maybeNotifyDiscord,
  observeTransitionForCancel,
  type MaybeNotifyDeps,
  type NotificationContext,
} from "../notifications";
import type {
  AbandonRequest,
  AbandonResponse,
  AbandonTaskResponse,
  AttachTaskRequest,
  AttachTaskResponse,
  CreateIterationRequest,
  CreateIterationResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  DetachTaskResponse,
  GetIterationResponse,
  HandoffRequest,
  HandoffResponse,
  ImportIterationFromGithubConflict,
  ImportIterationFromGithubRequest,
  ImportIterationFromGithubResponse,
  MetricsAssignmentResponse,
  MetricsFleetResponse,
  PreviewTaskConflict,
  PreviewTaskRequest,
  PreviewTaskResponse,
  RequeueResponse,
  UpdateIterationRequest,
  UpdateIterationResponse,
} from "./types";
import type { AssignmentState } from "../types";

export interface ApiDeps {
  processManager: ProcessManager;
  wsRegistry: WsClientRegistry;
  /**
   * Spawn override. Omitted in production (endpoint-resolver uses its default
   * spawn of `claude`). Tests inject a `cat`-based fake to avoid depending on
   * the claude CLI in CI.
   */
  spawn?: SpawnFn;
  /**
   * F-11 Discord notification deps. Optional — when absent (or when
   * `notify.config.enabled === false`), `maybeNotifyDiscord` is a no-op
   * and the existing transition + broadcast behaviour is unchanged.
   *
   * See `docs/design-mc-f11-discord-notifications.md` Decision 6:
   * `grove.notifications.discord = false` (the default) makes this a
   * pure-overhead path — the policy function still runs (it's cheap and
   * pure) but no Discord API call follows.
   */
  notify?: MaybeNotifyDeps;
  /**
   * F-12b Decision 4 — optional default `owner/repo` used to resolve the
   * `#N` and `repo#N` shorthand forms in the URL parser. When absent, those
   * shorthands fail parse with a clear message (principal has to use the
   * full `owner/repo#N` form).
   *
   * Format: the raw YAML value `"owner/repo"`. Split on the first `/` at
   * dep-plumbing time; a malformed value is treated as "no default".
   */
  defaultGithubRepo?: string;
  /**
   * F-12b Decision 3 — `gh` CLI spawn override. Omitted in production (the
   * real `Bun.spawn` is used). Tests inject a fake that returns a canned
   * JSON response without shelling out. Kept separate from `spawn` (the
   * controlled-session spawn) because the two callers want different shapes.
   */
  ghSpawn?: GhSpawnFn;
  /**
   * F-17 — per-network override for the GitHub label that marks a parent
   * issue as a Grove iteration. Defaults to `"iteration"` when absent
   * (matches `iteration-import.ts#DEFAULT_ITERATION_LABEL`). Wired from
   * the network yaml's `github.iterationLabel` field through
   * `StartServerOptions`.
   *
   * Per design Decision 10 Q6 — "explicit label `iteration` (or
   * configurable per-repo); avoids accidental promotion of unrelated
   * parent issues". The server-wide default suffices for v1; per-repo
   * overrides are a Phase G extension once multi-repo iteration boards
   * land.
   */
  iterationLabel?: string;
  /**
   * F-17 — GitHub webhook HMAC secret. When present, the
   * `POST /api/github/webhook` route validates the
   * `x-hub-signature-256` header against this secret using HMAC-SHA256.
   * When absent, the route 503s — there is no implicit bypass.
   *
   * Source: same secret the existing `webhook-proxy` uses (principal's
   * `GITHUB_WEBHOOK_SECRET`). Kept separate from the bot's network
   * config so the mission-control surface can be rotated independently
   * if ever needed.
   */
  githubWebhookSecret?: string;
}

const DEFAULT_AGENT_ID = "mc-default-agent";
const DEFAULT_AGENT_NAME = "Mission Control default";
const DEFAULT_PRINCIPAL_ID = "mc-default-principal";
/**
 * Default priority for `internal`-source tasks created via POST /api/sessions.
 * Used by the INSERT below AND `buildNotificationContextFromCreate` — a
 * single source of truth so the two cannot drift (S3 in PR #23 review).
 *
 * SAFETY: when Phase E adds a `priority` field to `CreateSessionRequest`,
 * the INSERT must accept the body value and the helper must take a
 * `priority` parameter; the constant's only role is the v2-default fallback.
 */
const DEFAULT_INTERNAL_TASK_PRIORITY = 2;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(message: string, status: number): Response {
  return json({ error: message } satisfies ApiError, status);
}

// ---------- GET /api/assignments ----------

export function handleListAssignments(db: Database): Response {
  const assignments = listAssignments(db);
  const body: ListAssignmentsResponse = { assignments };
  return json(body);
}

// ---------- GET /api/focus-area ----------

/**
 * Focus area feed for the dashboard's "who needs me" row
 * (design-mc-f6-focus-area.md). Returns only `blocked` assignments,
 * ordered by task priority ASC then updated_at ASC.
 */
export function handleListFocusArea(db: Database): Response {
  const items = listFocusArea(db);
  // design-mc-f6-focus-area.md §2.6 and §4: empty state shows "All clear"
  // + a most-active-agent one-liner. Always included so the dashboard
  // renders the empty state in one round-trip.
  const activeAgent = mostActiveAgent(db);
  const body: ListFocusAreaResponse = {
    items,
    mostActiveAgent: activeAgent,
  };
  return json(body);
}

// ---------- GET /api/tasks ----------

/**
 * Task-keyed feed for the dashboard's §8.4 table (F-8).
 *
 * Query param `includeClosed=true` opts into `status IN ('done','cancelled')`
 * rows; any other value (including absence) defaults to open-only.
 * See `docs/design-mc-f8-task-table.md` Decision 1 for rationale and
 * Decision 4 for the aggregate-state rank.
 */
export function handleListTasks(db: Database, url: URL): Response {
  const raw = url.searchParams.get("includeClosed");
  const includeClosed = raw === "true" || raw === "1";
  try {
    const tasks = listTasks(db, { includeClosed });
    const body: ListTasksResponse = { tasks };
    return json(body);
  } catch (err) {
    // listTasks is a read-only query so the common failure mode is a DB-level
    // fault (connection closed, disk error, corrupt index). Log to stderr for
    // remote debugging — symmetric with the rollback / spawn paths — and
    // return a 500 the dashboard's fetchTasks catch handler can surface via
    // the error pill. See PR #13 review.
    process.stderr.write(
      `[api] GET /api/tasks failed: ${(err as Error).message}\n`
    );
    return error(`Failed to list tasks: ${(err as Error).message}`, 500);
  }
}

// ---------- GET /api/iterations ----------

/**
 * `?state=` validation set. Built from the canonical `ITERATION_STATES`
 * tuple in `db/iterations.ts` so the API, validator, and SQL CHECK all
 * resolve to one source of truth — adding a state here is impossible
 * without first adding it to the canonical export.
 */
const ITERATION_STATE_VALUES: ReadonlySet<IterationState> = new Set(ITERATION_STATES);

/**
 * Inbox `?source=` allowlist. v1 only ingests from GitHub; expanding to
 * Jira / Linear adds entries here in lock-step with the source adapter
 * (per design Decision 7). `internal` is intentionally absent — the
 * inbox query already filters internal-only tasks out, so accepting
 * `?source=internal` would silently always-return-empty.
 */
const INBOX_SOURCE_ALLOWLIST: ReadonlySet<string> = new Set(["github"]);

/**
 * F-13 — kanban data source.
 *
 * `?state=<state>` filters to a single column. Without `state`, returns
 * every iteration except `cancelled` (the kanban renders six visible
 * columns; cancelled is archive-only).
 */
export function handleListIterations(db: Database, url: URL): Response {
  const stateRaw = url.searchParams.get("state");
  let state: IterationState | undefined;
  if (stateRaw !== null) {
    if (!ITERATION_STATE_VALUES.has(stateRaw as IterationState)) {
      return error(
        `Invalid 'state' filter '${stateRaw}'. Allowed: ${[...ITERATION_STATE_VALUES].join(", ")}`,
        400
      );
    }
    state = stateRaw as IterationState;
  }
  try {
    const iterations = listIterations(db, state ? { state } : {});
    const body: ListIterationsResponse = { iterations };
    return json(body);
  } catch (err) {
    process.stderr.write(
      `[api] GET /api/iterations failed: ${(err as Error).message}\n`
    );
    return error(`Failed to list iterations: ${(err as Error).message}`, 500);
  }
}

// ---------- GET /api/inbox ----------

/**
 * F-13 — kanban inbox column. Upstream-imported tasks not yet linked
 * to any iteration.
 *
 * `?source=<system>` filters to a single source (e.g. `github`).
 * `?limit=<n>` overrides the default cap (Decision 10 Q3 — 100). Bounded
 * by `INBOX_MAX_LIMIT` so a malicious caller cannot DoS via huge limit.
 */
export function handleListInbox(db: Database, url: URL): Response {
  const sourceRaw = url.searchParams.get("source");
  let source: string | undefined;
  if (sourceRaw !== null) {
    if (!INBOX_SOURCE_ALLOWLIST.has(sourceRaw)) {
      return error(
        `Invalid 'source' filter '${sourceRaw}'. Allowed: ${[...INBOX_SOURCE_ALLOWLIST].join(", ")}`,
        400
      );
    }
    source = sourceRaw;
  }
  const limitRaw = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitRaw !== null) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return error("'limit' must be a positive integer", 400);
    }
    limit = Math.min(parsed, INBOX_MAX_LIMIT);
  }
  try {
    const items = listInboxItems(db, {
      ...(source ? { source } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const body: ListInboxResponse = { items };
    return json(body);
  } catch (err) {
    process.stderr.write(
      `[api] GET /api/inbox failed: ${(err as Error).message}\n`
    );
    return error(`Failed to list inbox items: ${(err as Error).message}`, 500);
  }
}

// ---------- GET /api/working-agents ----------

/**
 * Agent-keyed feed for the dashboard's §8.3 working-agent grid (F-9).
 *
 * Returns one tile per agent that holds at least one active-non-blocked
 * assignment. Primary assignment picked by rank + updated_at (matches
 * F-8 Decision 5 for drill-down-entry consistency).
 *
 * See docs/design-mc-f9-working-grid.md for the decision log.
 */
export function handleListWorkingAgents(db: Database): Response {
  try {
    const agents = listWorkingAgents(db);
    const body: ListWorkingAgentsResponse = { agents };
    return json(body);
  } catch (err) {
    process.stderr.write(
      `[api] GET /api/working-agents failed: ${(err as Error).message}\n`
    );
    return error(
      `Failed to list working agents: ${(err as Error).message}`,
      500
    );
  }
}

// ---------- GET /api/assignments/:id/events ----------

const DEFAULT_EVENTS_LIMIT = 50;
// Real event ids are 26 chars (see generateId). Accept a small multiple to
// forgive future layout changes but reject obvious abuse (megabyte `before`
// strings consume DB sort work for no useful result). Length-only check —
// shape is validated by the parameterised cursor comparison downstream.
const BEFORE_MAX_LEN = 64;

/**
 * Return a page of events for the latest session of an assignment.
 *
 * Scope: events are keyed by `session_id` in the table; this endpoint resolves
 * the assignment → its latest session (active or ended) and pages that session's
 * events. Multi-session history is deferred per design-mc-f7-attention-view.md.
 */
export function handleListEvents(
  db: Database,
  assignmentId: string,
  url: URL
): Response {
  // Assignment existence check — 404 distinguishes "bad id" from "no events yet".
  // Never echo the attacker-controlled id back in the response body: once MC
  // moves behind a reverse proxy this becomes a log-poisoning / cache-key-
  // pollution vector. Server-side log keeps the id for debugging.
  const assignmentRow = db
    .query(`SELECT 1 FROM agent_task_assignment WHERE id = ?`)
    .get(assignmentId);
  if (!assignmentRow) {
    process.stderr.write(
      `[api] GET /api/assignments/:id/events — unknown assignment id=${JSON.stringify(assignmentId)}\n`
    );
    return error("No such assignment", 404);
  }

  const rawBefore = url.searchParams.get("before");
  // Validate `before` length before any DB work. Real ids are 26 chars; a
  // multi-KB `before` would consume sort effort for no useful result.
  if (rawBefore !== null && rawBefore.length > BEFORE_MAX_LEN) {
    return error(
      `'before' cursor too long (max ${BEFORE_MAX_LEN} chars)`,
      400
    );
  }

  const session = findLatestSessionForAssignment(db, assignmentId);
  if (!session) {
    const body: ListEventsResponse = {
      events: [],
      hasMore: false,
      sessionId: null,
    };
    return json(body);
  }

  const rawLimit = url.searchParams.get("limit");
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : NaN;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, EVENTS_LIST_MAX_LIMIT)
      : DEFAULT_EVENTS_LIMIT;

  const { events, hasMore } = listEventsForSession(db, session.id, {
    ...(rawBefore ? { before: rawBefore } : {}),
    limit,
  });

  const body: ListEventsResponse = {
    events,
    hasMore,
    sessionId: session.id,
  };
  return json(body);
}

// ---------- POST /api/sessions ----------

/**
 * Ensure the well-known default agent row exists. Idempotent — safe to call
 * on every POST /api/sessions. Phase E will introduce principal-specified
 * agents; until then a single shared agent is sufficient to satisfy the
 * agent_task_assignment FK.
 */
function ensureDefaultAgent(db: Database): string {
  db.query(
    `INSERT INTO agents (id, name, type, persistent)
     VALUES (?, ?, 'hands', 1)
     ON CONFLICT(id) DO NOTHING`
  ).run(DEFAULT_AGENT_ID, DEFAULT_AGENT_NAME);
  return DEFAULT_AGENT_ID;
}

/**
 * F-20 — register an agent by id idempotently. Used by `local.observed`
 * sessions where the wrapper supplies the principal's identity (e.g.
 * `agentId: 'andreas'`, `agentName: 'Andreas'`) which may not exist in
 * the agents table yet. The first observed call lands the row;
 * subsequent calls are no-ops. `name` is only applied on insert — once
 * an agent is registered, the principal owns its display name.
 */
function ensureNamedAgent(
  db: Database,
  agentId: string,
  agentName: string | undefined
): string {
  const displayName = agentName && agentName.length > 0 ? agentName : agentId;
  db.query(
    `INSERT INTO agents (id, name, type, persistent)
     VALUES (?, ?, 'head', 1)
     ON CONFLICT(id) DO NOTHING`
  ).run(agentId, displayName);
  return agentId;
}

// F-19 Decision 5 — server-side dispatch debounce.
//
// Cross-tab two-click protection: when a principal opens MC v2 in two
// browser tabs and clicks Dispatch on the same task in both, the
// per-tab UI gate (button-disabled-while-busy) doesn't help — each
// tab has independent state. Without server-side gating each POST
// would call `spawnControlledSession` → `Bun.spawn` → a fresh CC
// subprocess and pay the full boot-prompt token cost twice for what
// the principal experienced as one click.
//
// Implementation: a tiny per-process Map keyed by `taskId|agentId`
// remembers the assignment id created by a recent successful POST.
// A repeat POST within DISPATCH_DEBOUNCE_MS gets a `409` carrying that
// assignment id — the dashboard hook treats this as success and
// refetches. Memory-only (cleared on restart, lost on crash); 2 s is
// well above any legitimate human double-click round-trip and well
// below any "second principal dispatched the same task on purpose"
// interval.
const DISPATCH_DEBOUNCE_MS = 2_000;
interface DispatchDebounceEntry {
  assignmentId: string;
  expiresAt: number;
}
const dispatchDebounce = new Map<string, DispatchDebounceEntry>();

function dispatchDebounceKey(taskId: string, agentId: string): string {
  return `${taskId}|${agentId}`;
}

/**
 * Test-only — drop the debounce map between tests so cross-test bleed
 * doesn't make a happy-path test flap on the second run.
 */
export function _resetDispatchDebounceForTests(): void {
  dispatchDebounce.clear();
}

// F-20 — UUID-shape validator. Cheap regex (RFC 4122 8-4-4-4-12 hex). Looser
// than crypto-grade UUID parsing — accepts any case, doesn't enforce
// version bits — because the wrapper just needs *some* opaque string CC's
// `--session-id` will accept and EventLogger will tag events with. Stricter
// parsing has no operational benefit here.
// cortex#196 — loose UUID check (`isUuidLoose`) is shared in
// `src/common/types/uuid.ts`. Same 8-4-4-4-12 hex layout, no
// version/variant constraint (matches the comment above).

// eslint-disable-next-line @typescript-eslint/require-await
export async function handleCreateSession(
  db: Database,
  deps: ApiDeps,
  rawBody: unknown
): Promise<Response> {
  // Body validation is synchronous; signature stays async to match the
  // router's `await fn(...)` invocation contract and to leave room for
  // the I/O-bound path below.
  const body = (rawBody ?? {}) as CreateSessionRequest;
  if (typeof body !== "object") {
    return error("Body must be a JSON object", 400);
  }
  if (body.prompt !== undefined && typeof body.prompt !== "string") {
    return error("'prompt' must be a string", 400);
  }
  if (body.title !== undefined && typeof body.title !== "string") {
    return error("'title' must be a string", 400);
  }

  // F-20 — kind validation. Default to controlled when omitted; observed
  // requires a UUID-shaped ccSessionId.
  const kind = body.kind ?? "local.process.controlled";
  if (kind === "local.observed") {
    if (
      typeof body.ccSessionId !== "string" ||
      !isUuidLoose(body.ccSessionId)
    ) {
      return error(
        `'ccSessionId' must be a UUID when kind='local.observed'`,
        400
      );
    }
  }

  // Empty-string trim falls through to defaults; `||` preserves that
  // semantic where `??` would propagate the empty string.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const title = body.title?.trim() || "Untitled session";
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const principalId = body.principalId?.trim() || DEFAULT_PRINCIPAL_ID;
  // F-20 — when an observed session supplies an agentId we don't have on
  // file, register it on the spot using `agentName` as the display name.
  // Falls back to ensuring the default agent for unscoped controlled work.
  let agentId: string;
  if (body.agentId && body.agentId.trim().length > 0) {
    agentId = ensureNamedAgent(db, body.agentId.trim(), body.agentName?.trim());
  } else {
    agentId = ensureDefaultAgent(db);
  }

  // Resolve or create the task + assignment up front, in one transaction.
  // If anything after this fails (e.g. spawn), we roll back explicitly.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const taskId = body.taskId?.trim() || generateId();
  const assignmentId = generateId();

  // F-19 — cross-tab debounce. CHECK and SET in one atomic step at handler
  // entry, BEFORE the (much slower) spawn + state-machine + WS work below.
  // Any later SET would leave a TOCTOU window where two concurrent same-
  // (taskId, agentId) POSTs both pass the CHECK before either records and
  // both spawn CC subprocesses (per Echo's PR-#55 review). Only meaningful
  // when the caller supplied a `taskId` (the without-taskId path mints a
  // fresh task per call so debounce-by-task-id is a non-sequitur there).
  //
  // The lock is RELEASED on the spawn-failure rollback path below so the
  // principal can retry without waiting 2s after a transient failure.
  let debounceKey: string | null = null;
  if (body.taskId) {
    const key = dispatchDebounceKey(taskId, agentId);
    const now = Date.now();
    const entry = dispatchDebounce.get(key);
    if (entry && entry.expiresAt > now) {
      return error(
        `Recently dispatched (assignment '${entry.assignmentId}'); cooldown ${DISPATCH_DEBOUNCE_MS}ms`,
        409
      );
    }
    // Soft-lock: claim the slot immediately. Concurrent same-key POSTs
    // arriving during the spawn now hit the entry above and 409 out.
    // Opportunistic eviction (per Echo's nit): drop any expired siblings
    // we observe while we're already touching the map.
    for (const [k, v] of dispatchDebounce) {
      if (v.expiresAt <= now) dispatchDebounce.delete(k);
    }
    dispatchDebounce.set(key, {
      assignmentId,
      expiresAt: now + DISPATCH_DEBOUNCE_MS,
    });
    debounceKey = key;
  }

  const insertRows = db.transaction(() => {
    if (!body.taskId) {
      db.query(
        `INSERT INTO tasks (id, title, priority, principal_id, source_system)
         VALUES (?, ?, ?, ?, 'internal')`
      ).run(taskId, title, DEFAULT_INTERNAL_TASK_PRIORITY, principalId);
    }

    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES (?, ?, ?, 'queued')`
    ).run(assignmentId, agentId, taskId);
  });

  try {
    insertRows();
  } catch (err) {
    // Release the soft-lock so the principal can retry without 2s wait.
    if (debounceKey !== null) dispatchDebounce.delete(debounceKey);
    return error(
      `Failed to create assignment: ${(err as Error).message}`,
      500
    );
  }

  // F-20 — branch on endpoint kind. Controlled = MC v2 owns the
  // subprocess (existing path); observed = wrapper already started CC
  // and we just register a session row that the ingestor can match
  // events to via cc_session_id.
  //
  // Type widens to a minimal { sessionId } since `endpoint.write` is
  // only valid on the controlled branch — the prompt-write path
  // below is gated on `kind === 'local.process.controlled'` so the
  // unused `write` method on the observed branch isn't a problem.
  let endpoint: { sessionId: string; write?: (text: string) => void };
  if (kind === "local.observed") {
    // ccSessionId is validated above (UUID_RE) when kind is observed.
    const ccSessionId = body.ccSessionId ?? "";
    // Defensive: refuse a duplicate ccSessionId. Two observed sessions
    // sharing a uuid would crosstalk in the ingestor's lookup —
    // generateId() collisions are vanishingly unlikely but the wrapper
    // could be misused. A partial unique index on
    // (cc_session_id WHERE cc_session_id IS NOT NULL AND ended_at IS NULL)
    // is the schema-level defense-in-depth; the controlled path inserts
    // with `cc_session_id = NULL` and stays NULL (no UPDATE site in
    // src/mission-control today populates it), so the partial index
    // only sees observed-INSERT rows. Per Echo's PR-#56 review.
    const dup = db
      .query(
        "SELECT id FROM sessions WHERE cc_session_id = ? AND ended_at IS NULL"
      )
      .get(ccSessionId) as { id: string } | null;
    if (dup) {
      // Roll back the task + assignment rows insertRows() already
      // committed — same shape as the controlled spawn-failure rollback
      // a few lines below. Without this, a duplicate ccSessionId leaves
      // a zombie `queued` assignment plus an orphan task (when the
      // caller didn't supply taskId) lying around. Per Echo's PR-#56
      // review.
      try {
        db.transaction(() => {
          db.query(`DELETE FROM agent_task_assignment WHERE id = ?`).run(
            assignmentId
          );
          if (!body.taskId) {
            db.query(`DELETE FROM tasks WHERE id = ?`).run(taskId);
          }
        })();
      } catch (rollbackErr) {
        process.stderr.write(
          `[api] rollback after observed-dup-409 failed: ${(rollbackErr as Error).message}\n`
        );
      }
      if (debounceKey !== null) dispatchDebounce.delete(debounceKey);
      return error(
        `An active observed session already exists for ccSessionId '${ccSessionId}'`,
        409
      );
    }
    const session = createSession(db, {
      assignmentId,
      endpointKind: "local.observed",
      ccSessionId,
    });
    endpoint = { sessionId: session.id };
  } else {
    // Spawn the controlled CC session. If this throws, we must roll
    // back the task+assignment rows we just inserted — a zombie queued
    // assignment with no session is not useful state.
    try {
      const ep = spawnControlledSession(
        db,
        deps.processManager,
        assignmentId,
        {
          ...(deps.spawn ? { spawn: deps.spawn } : {}),
          dispatcher: { wsRegistry: deps.wsRegistry },
        }
      );
      endpoint = ep;
    } catch (err) {
      try {
        db.transaction(() => {
          db.query(`DELETE FROM agent_task_assignment WHERE id = ?`).run(
            assignmentId
          );
          if (!body.taskId) {
            db.query(`DELETE FROM tasks WHERE id = ?`).run(taskId);
          }
        })();
      } catch (rollbackErr) {
        process.stderr.write(
          `[api] rollback after spawn-failure failed: ${(rollbackErr as Error).message}\n`
        );
      }
      // Release the soft-lock so the principal can retry without 2s wait.
      if (debounceKey !== null) dispatchDebounce.delete(debounceKey);
      const status = err instanceof SessionConflict ? 409 : 500;
      return error(`Spawn failed: ${(err as Error).message}`, status);
    }
  }

  // Drive the state machine.
  //   Controlled — queued → dispatched → running fires immediately
  //     (the subprocess is up and ready to receive stdin).
  //   Observed — queued → dispatched fires here; the dispatched →
  //     running transition is deferred until the ingestor sees the first
  //     event for this ccSessionId (per F-20 Decision 2). This keeps the
  //     working grid honest — observed sessions only show as `running`
  //     when they're actually doing work.
  // If a transition fails (shouldn't under normal conditions) we still
  // return 201 — the session row exists and is recoverable. The error
  // surfaces to stderr so it isn't silently swallowed.
  const transitions =
    kind === "local.observed"
      ? ([{ type: "dispatch" as const }] as const)
      : ([{ type: "dispatch" as const }, { type: "start" as const }] as const);
  for (const action of transitions) {
    const result = applyTransition(db, assignmentId, endpoint.sessionId, action);
    if (!result.ok) {
      process.stderr.write(
        `[api] applyTransition(${action.type}) failed for ${assignmentId}: ${result.error}\n`
      );
      break;
    }
    broadcastTransition(
      deps.wsRegistry,
      assignmentId,
      result.from,
      result.assignment.state,
      result.assignment.block_reason
    );
    broadcastEvent(deps.wsRegistry, endpoint.sessionId, result.event);

    // F-11 Discord notifications. The loop fires twice per spawn —
    // queued→dispatched and dispatched→running — both of which Decision 1
    // marks "Notify=No". The hook is still called twice; coalescing /
    // dedup is the sink's job, never the loop's. See addendum's
    // "Invariant the implementer must absorb" note.
    if (deps.notify) {
      const ctx = buildNotificationContextFromCreate(
        assignmentId,
        taskId,
        title,
        principalId
      );
      // Fire-and-forget — Discord errors must not block the API response.
      // The sink swallows + logs internally per Decision 9.
      void maybeNotifyDiscord(deps.notify, {
        from: result.from,
        to: result.assignment.state,
        blockReason: result.assignment.block_reason,
        ctx,
      });
    }
  }

  // F-12 Decision 9 + Scope Summary — emit an `principal.curation` event with
  // `kind: "dispatch"` so the manual-dispatch path (POST /api/sessions) lands
  // in the audit trail alongside requeue / handoff / abandon. The event
  // anchors to the newly-spawned session and captures the agent the principal
  // dispatched to; `newAssignmentId` is included for symmetry with the
  // handoff variant (the "assignment this spawn created").
  const dispatchCurationEvent = createPrincipalCurationEvent(
    db,
    endpoint.sessionId,
    {
      kind: "dispatch",
      agentId,
      newAssignmentId: assignmentId,
    }
  );
  broadcastEvent(deps.wsRegistry, endpoint.sessionId, dispatchCurationEvent);

  // Optional initial principal turn — controlled sessions only. Observed
  // sessions don't have a writable stdin (the wrapper's TTY owns it);
  // a `prompt` field on an observed POST is silently ignored.
  if (
    kind === "local.process.controlled" &&
    body.prompt &&
    body.prompt.length > 0 &&
    endpoint.write
  ) {
    try {
      endpoint.write(body.prompt);
      const event = createPrincipalInputEvent(db, endpoint.sessionId, {
        text: body.prompt,
      });
      broadcastEvent(deps.wsRegistry, endpoint.sessionId, event);
    } catch (err) {
      // Don't fail the whole create-session call — the session is spawned
      // and the principal can retry via POST /api/assignments/:id/input.
      process.stderr.write(
        `[api] initial prompt write failed for ${assignmentId}: ${(err as Error).message}\n`
      );
    }
  }

  // F-19 — debounce slot was claimed at handler entry (CHECK + SET in one
  // step) so concurrent same-key POSTs arriving during this spawn already
  // 409'd out. No re-SET here.

  const body201: CreateSessionResponse = {
    assignmentId,
    sessionId: endpoint.sessionId,
  };
  return json(body201, 201);
}

/**
 * F-11: Build a `NotificationContext` for the freshly-created session.
 *
 * The handler only has `body.title` + `principalId` + the generated ids in
 * scope at hook time — the task row hasn't been re-read from the DB yet
 * (and we shouldn't take the round-trip on the hot path). This helper
 * reconstructs the minimum metadata `maybeNotifyDiscord` needs.
 *
 * `priority` is sourced from the same `DEFAULT_INTERNAL_TASK_PRIORITY`
 * constant the INSERT above uses — keeping the two in lockstep so a
 * future change to the default cannot silently desynchronise them (S3 in
 * PR #23 review). When Phase E adds a `priority` field to the create
 * body, both the INSERT and this helper grow a parameter together.
 */
function buildNotificationContextFromCreate(
  assignmentId: string,
  taskId: string,
  taskTitle: string,
  principalId: string
): NotificationContext {
  return {
    assignmentId,
    agentName: DEFAULT_AGENT_NAME,
    taskId,
    taskRef: taskShortRef(taskId),
    taskTitle,
    priority: DEFAULT_INTERNAL_TASK_PRIORITY,
    taskSourceUrl: null, // 'internal' source for create-session.
    principalId,
    observedAtMs: Date.now(),
  };
}

/**
 * Short-form task identifier for notification subject lines. Prefers
 * `tasks.source_external_id` (e.g. issue/PR number) when caller has it;
 * here we synthesise from the first 6 chars of the task id (ULID-ish).
 */
function taskShortRef(taskId: string): string {
  return `T-${taskId.slice(0, 6)}`;
}

// ---------- POST /api/assignments/:id/input ----------

/**
 * Server-side cap on principal input payload size, measured in UTF-8 bytes.
 *
 * Name mirrors the client-side `DRILL_INPUT_MAX_BYTES` in the drill-down input
 * (F-10 Decision 2) so the shared 50 KB bound is obvious from grep alone; the
 * two constants live in different runtimes (browser inline script vs Bun
 * server) and cannot share a module, so duplication is intentional. The
 * client cap is a UX hint; this is the authoritative bound.
 */
export const DRILL_INPUT_MAX_BYTES = 50 * 1024;

/**
 * Image-input bounds per `docs/design-mc-image-input.md` Decision 5.
 * Decoded-image size is 5 MB per image; 8 images per message; 25 MB
 * combined body. Measured on raw base64 payload length (≈ 4/3 of decoded
 * bytes) — exact decoded-size measurement requires base64 decode which
 * is wasted work for an obvious-reject path.
 */
export const IMAGE_ALLOWED_MEDIA_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export const IMAGE_MAX_COUNT_PER_MESSAGE = 8;
export const IMAGE_MAX_DECODED_BYTES = 5 * 1024 * 1024;
export const IMAGE_BODY_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Estimate the decoded byte size of a base64 string without actually
 * decoding it. Within a byte or two of exact for reasonable inputs; good
 * enough for a reject-path size check.
 */
function base64DecodedByteLength(b64: string): number {
  const n = b64.length;
  if (n === 0) return 0;
  let padding = 0;
  if (b64.charCodeAt(n - 1) === 0x3d /* = */) padding++;
  if (n > 1 && b64.charCodeAt(n - 2) === 0x3d) padding++;
  return Math.floor((n * 3) / 4) - padding;
}

/** Loose base64 shape check — characters only, no structural validation. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function handleSendInput(
  db: Database,
  deps: ApiDeps,
  assignmentId: string,
  rawBody: unknown
): Response {
  const body = rawBody as SendInputRequest | null;
  if (typeof body !== "object" || body === null) {
    return error("Body must be a JSON object.", 400);
  }

  // --- text validation ---
  const hasText = body.text !== undefined;
  if (hasText && typeof body.text !== "string") {
    return error("'text' must be a string.", 400);
  }
  const text = hasText ? body.text ?? "" : "";
  const textByteLength = Buffer.byteLength(text, "utf8");
  if (textByteLength > DRILL_INPUT_MAX_BYTES) {
    return error("Principal input exceeds the 50 KB limit.", 413);
  }

  // --- image validation ---
  const hasImages = Array.isArray(body.images) && body.images.length > 0;
  if (body.images !== undefined && !Array.isArray(body.images)) {
    return error("'images' must be an array.", 400);
  }
  const images: SendInputRequest["images"] = hasImages ? (body.images ?? []) : [];
  if (images.length > IMAGE_MAX_COUNT_PER_MESSAGE) {
    return error(
      `At most ${IMAGE_MAX_COUNT_PER_MESSAGE} images per message.`,
      413
    );
  }
  let imagesByteSum = 0;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (typeof img !== "object") {
      return error(`images[${i}] must be an object.`, 400);
    }
    if (typeof img.media_type !== "string" || typeof img.data !== "string") {
      return error(
        `images[${i}] requires string 'media_type' and 'data'.`,
        400
      );
    }
    if (!IMAGE_ALLOWED_MEDIA_TYPES.has(img.media_type)) {
      return error(
        "Attachment type not supported. Use PNG, JPEG, WebP, or GIF.",
        400
      );
    }
    if (!BASE64_RE.test(img.data)) {
      return error(`images[${i}].data is not valid base64.`, 400);
    }
    const decoded = base64DecodedByteLength(img.data);
    if (decoded > IMAGE_MAX_DECODED_BYTES) {
      return error(
        `images[${i}] exceeds the 5 MB per-image limit.`,
        413
      );
    }
    imagesByteSum += img.data.length;
  }

  if (imagesByteSum + textByteLength > IMAGE_BODY_MAX_BYTES) {
    return error(
      "Attachments too large — total request body exceeds 25 MB.",
      413
    );
  }

  // --- at least one of text or images must be present ---
  if (textByteLength === 0 && images.length === 0) {
    return error("'text' or 'images' must be provided.", 400);
  }

  const endpoint = resolveSessionEndpoint(
    db,
    deps.processManager,
    assignmentId
  );
  if (!endpoint) {
    return error(
      `No active session for assignment '${assignmentId}'`,
      404
    );
  }

  try {
    // Text-only (no images) continues through the legacy string overload so
    // the wire shape (`content: "..."`) stays identical for existing paths.
    // With images, switch to the rich content-block array.
    if (images.length === 0) {
      endpoint.write(text);
    } else {
      const blocks: import("../session/stream-json").StreamJsonContentBlock[] = [];
      if (textByteLength > 0) {
        blocks.push({ type: "text", text });
      }
      for (const img of images) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.media_type,
            data: img.data,
          },
        });
      }
      endpoint.write(blocks);
    }
  } catch (err) {
    if (err instanceof NotControllable) {
      return error(err.message, 409);
    }
    if (err instanceof SessionClosed) {
      return error(err.message, 410);
    }
    return error(`Write failed: ${(err as Error).message}`, 500);
  }

  const event = createPrincipalInputEvent(db, endpoint.sessionId, {
    ...(textByteLength > 0 ? { text } : {}),
    ...(images.length > 0
      ? {
          images: images.map((i) => ({
            media_type: i.media_type,
            data: i.data,
          })),
        }
      : {}),
  });
  broadcastEvent(deps.wsRegistry, endpoint.sessionId, event);

  const resp: SendInputResponse = { ok: true, eventId: event.id };
  return json(resp);
}

// ============================================================================
// F-12 — task curation endpoints
// ============================================================================
//
// Decisions referenced inline:
//   D1  — scope: dispatch/requeue/abandon/handoff in F-12; add-to-queue in F-12b
//   D3  — per-state enablement matrix
//   D5  — abandon branches on context (assignment vs task)
//   D6  — handoff: cancel-and-respawn (in-flight) / new-only (failed)
//   D7  — requeue: 1-to-1 mirror of state-machine's operator_requeue
//   D9  — principal.curation event family with `kind` discriminator
//   D11 — state.transition observer that calls endpoint.close() for the
//         {→ cancelled, operator_requeue from blocked} transitions

interface AssignmentCurationRow {
  id: string;
  agent_id: string;
  task_id: string;
  state: AssignmentState;
}

/**
 * Per-state lookup for the curation toolbar. Single source of truth so the
 * server can validate verb legality without re-implementing the state-machine
 * transition table — the matrix mirrors `state-machine.ts`'s TRANSITIONS
 * exactly for the verbs F-12 ships.
 *
 * Empty-assignment rows (Decision 3) are deferred to F-12b — those endpoints
 * (`POST /api/tasks/:taskId/abandon`) do not exist in F-12.
 */
const TERMINAL_STATES = new Set<AssignmentState>([
  "completed",
  "failed",
  "cancelled",
]);

function readAssignment(
  db: Database,
  assignmentId: string
): AssignmentCurationRow | null {
  return db
    .query(
      "SELECT id, agent_id, task_id, state FROM agent_task_assignment WHERE id = ?"
    )
    .get(assignmentId) as AssignmentCurationRow | null;
}

function readReason(rawBody: unknown): {
  reason?: string;
  err?: Response;
} {
  if (rawBody === null || rawBody === undefined) return {};
  if (typeof rawBody !== "object") {
    return { err: error("Body must be a JSON object", 400) };
  }
  const reason = (rawBody as { reason?: unknown }).reason;
  if (reason === undefined || reason === null) return {};
  if (typeof reason !== "string") {
    return { err: error("'reason' must be a string", 400) };
  }
  // Same 50 KB cap principal.input uses — principal-authored free-text.
  if (Buffer.byteLength(reason, "utf8") > DRILL_INPUT_MAX_BYTES) {
    return { err: error("'reason' exceeds the 50 KB limit", 413) };
  }
  return { reason };
}

/**
 * Strict-shape validation for curation-endpoint request bodies.
 *
 * The Discord-loopback threat model is low-risk, but the PR #30 review bar
 * called for explicit shape validation over loose `as` casts. This helper
 * rejects any key not in `allowed` with a 400, and accepts `null` /
 * `undefined` / `{}` as no-op bodies (the caller's field-level checks then
 * enforce any required fields).
 *
 * Returning the response object (rather than throwing) keeps the handler
 * style consistent with `readReason`.
 */
function validateBodyKeys(
  rawBody: unknown,
  allowed: readonly string[]
): Response | null {
  if (rawBody === null || rawBody === undefined) return null;
  if (typeof rawBody !== "object") return null; // caller surfaces its own 400
  const keys = Object.keys(rawBody);
  const allowedSet = new Set(allowed);
  const unexpected = keys.filter((k) => !allowedSet.has(k));
  if (unexpected.length > 0) {
    return error(
      `Unexpected field(s) in request body: ${unexpected.join(", ")}. Allowed: ${allowed.join(", ")}`,
      400
    );
  }
  return null;
}

/**
 * Resolve the session id used as the FK on the curation event for an
 * assignment. Curation verbs operate on assignments that already had at
 * least one session — Requeue and Abandon-the-assignment require some
 * session to anchor the `events.session_id` FK.
 *
 * Returns `null` if no session ever existed for the assignment (impossible
 * for the F-12 verb set — `POST /api/sessions` always spawns — but the
 * caller surfaces this as a 409 to keep the invariant explicit).
 */
function resolveCurationSessionId(
  db: Database,
  assignmentId: string
): string | null {
  const session = findLatestSessionForAssignment(db, assignmentId);
  return session?.id ?? null;
}

/**
 * Drive the Decision 11 observer for any state transition that just landed.
 * Wired alongside `broadcastTransition` so every cancel / requeue-from-blocked
 * gets the kill side effect for free, matching the §3.3 single-source-of-truth
 * pattern (the state machine emits the transition; the side effects ride on
 * the same event).
 */
function fireCancelObserver(
  deps: ApiDeps,
  sessionId: string,
  from: AssignmentState,
  to: AssignmentState,
  action: string,
  db: Database
): Promise<void> | null {
  return observeTransitionForCancel(
    {
      processManager: deps.processManager,
      closeSession: async (sid: string) => {
        await createControlledEndpoint(db, deps.processManager, sid).close();
      },
    },
    sessionId,
    from,
    to,
    action
  );
}

// ---------- POST /api/assignments/:id/requeue ----------

export function handleRequeueAssignment(
  db: Database,
  deps: ApiDeps,
  assignmentId: string,
  rawBody: unknown
): Response {
  const row = readAssignment(db, assignmentId);
  if (!row) return error("No such assignment", 404);

  // Strict shape — PR #30 S3. `reason` is the only field the RequeueRequest
  // type declares; reject unknown keys rather than silently ignoring them.
  const requeueKeysErr = validateBodyKeys(rawBody, ["reason"]);
  if (requeueKeysErr) return requeueKeysErr;

  const { reason, err: reasonErr } = readReason(rawBody);
  if (reasonErr) return reasonErr;

  const sessionId = resolveCurationSessionId(db, assignmentId);
  if (!sessionId) {
    // Defensive: F-12 has no producer for assignment-without-any-session,
    // but if one ever lands here we refuse rather than fabricating a FK.
    return error(
      `Assignment '${assignmentId}' has no session to anchor curation event`,
      409
    );
  }

  const result = applyTransition(db, assignmentId, sessionId, {
    type: "operator_requeue",
  });
  if (!result.ok) {
    // State-machine refused — most common shape is "Invalid transition".
    // 409 mirrors the addendum's wire-side equivalent for "operation not
    // legal in current state".
    return error(result.error, 409);
  }

  broadcastTransition(
    deps.wsRegistry,
    assignmentId,
    result.from,
    result.assignment.state,
    result.assignment.block_reason
  );
  broadcastEvent(deps.wsRegistry, sessionId, result.event);

  // Decision 11 — kill the live process if `operator_requeue` came from `blocked`.
  // Fire-and-forget; the response doesn't await the kill.
  void fireCancelObserver(
    deps,
    sessionId,
    result.from,
    result.assignment.state,
    "operator_requeue",
    db
  );

  // Decision 9 — sibling principal.curation event with `kind: "requeue"`.
  const curationEvent = createPrincipalCurationEvent(db, sessionId, {
    kind: "requeue",
    ...(reason ? { reason } : {}),
  });
  broadcastEvent(deps.wsRegistry, sessionId, curationEvent);

  const body: RequeueResponse = {
    ok: true,
    assignmentId,
    from: result.from,
    to: result.assignment.state,
    eventId: curationEvent.id,
  };
  return json(body);
}

// ---------- POST /api/assignments/:id/abandon ----------

export function handleAbandonAssignment(
  db: Database,
  deps: ApiDeps,
  assignmentId: string,
  rawBody: unknown
): Response {
  const row = readAssignment(db, assignmentId);
  if (!row) return error("No such assignment", 404);

  // Body parsing: { scope?, reason? }
  let body: AbandonRequest = {};
  if (rawBody !== null && rawBody !== undefined) {
    if (typeof rawBody !== "object") {
      return error("Body must be a JSON object", 400);
    }
    body = rawBody;
  }
  if (
    body.scope !== undefined &&
    (body.scope as string) !== "assignment" &&
    (body.scope as string) !== "task"
  ) {
    return error("'scope' must be 'assignment' or 'task'", 400);
  }
  const { reason, err: reasonErr } = readReason(rawBody);
  if (reasonErr) return reasonErr;

  // Decision 5 — branch on context:
  //   active assignment (non-terminal)        → cancel the assignment
  //   no active assignment (state is terminal) → cancel the task
  //
  // Caller may force a scope explicitly. `scope: "task"` on a non-terminal
  // assignment is currently rejected (Decision 5 says abandon-the-task is
  // for "no active assignment"; F-12 keeps the assignment-keyed surface
  // strict — the principal should cancel the assignment first or wait for
  // it to settle). `scope: "assignment"` on a terminal assignment is
  // rejected by the state machine itself ("No transitions from terminal
  // state").
  const assignmentTerminal = TERMINAL_STATES.has(row.state);
  const inferredScope = assignmentTerminal ? "task" : "assignment";
  const scope = body.scope ?? inferredScope;

  if (scope === "assignment") {
    if (assignmentTerminal) {
      return error(
        `Assignment '${assignmentId}' is terminal (state=${row.state}); cannot abandon the assignment. Use scope=task to cancel the task itself.`,
        409
      );
    }

    const sessionId = resolveCurationSessionId(db, assignmentId);
    if (!sessionId) {
      return error(
        `Assignment '${assignmentId}' has no session to anchor curation event`,
        409
      );
    }

    const result = applyTransition(db, assignmentId, sessionId, {
      type: "cancel",
    });
    if (!result.ok) return error(result.error, 409);

    broadcastTransition(
      deps.wsRegistry,
      assignmentId,
      result.from,
      result.assignment.state,
      result.assignment.block_reason
    );
    broadcastEvent(deps.wsRegistry, sessionId, result.event);

    // Decision 11 — kill the live process; transitioned into `cancelled`.
    void fireCancelObserver(
      deps,
      sessionId,
      result.from,
      result.assignment.state,
      "cancel",
      db
    );

    const curationEvent = createPrincipalCurationEvent(db, sessionId, {
      kind: "abandon",
      targetKind: "assignment",
      ...(reason ? { reason } : {}),
    });
    broadcastEvent(deps.wsRegistry, sessionId, curationEvent);

    const respBody: AbandonResponse = {
      ok: true,
      assignmentId,
      taskId: row.task_id,
      scope: "assignment",
      from: result.from,
      to: result.assignment.state,
      eventId: curationEvent.id,
    };
    return json(respBody);
  }

  // scope === "task"
  // Decision 5 — abandon-the-task: only legal when no active assignment is
  // in flight. F-12 keeps this strict to the assignment-keyed surface — if
  // the assignment row is non-terminal, the principal should cancel the
  // assignment explicitly first (or use the inferred-scope default which
  // routes to scope=assignment).
  if (!assignmentTerminal) {
    return error(
      `Assignment '${assignmentId}' is non-terminal (state=${row.state}); cannot abandon the task while an assignment is in flight. Use scope=assignment to cancel the assignment first.`,
      409
    );
  }

  // Verify task is not already cancelled (Decision 3 — disabled state).
  const taskRow = db
    .query("SELECT status FROM tasks WHERE id = ?")
    .get(row.task_id) as { status: string } | null;
  if (!taskRow) {
    return error(`Task '${row.task_id}' not found`, 404);
  }
  if (taskRow.status === "cancelled") {
    return error(`Task '${row.task_id}' is already cancelled`, 409);
  }

  // Update the task row. No state-machine transition on the assignment —
  // the assignment is already terminal (its row is preserved as historical
  // record per Decision 4's "no merging" rule).
  db.query(
    `UPDATE tasks SET status = 'cancelled', updated_at = unixepoch() WHERE id = ?`
  ).run(row.task_id);

  // Anchor the curation event on the assignment's latest (terminal) session.
  // The FK is to `sessions(id)`, not "active session" — terminal sessions
  // remain in the table so this is sound.
  const sessionId = resolveCurationSessionId(db, assignmentId);
  if (!sessionId) {
    // The assignment row exists but no session ever ran. F-12 cannot produce
    // this state today, but if it ever lands the abandon-the-task event has
    // no anchor. Surface as 409 — F-12b adds the synthetic shadow-session
    // pattern that resolves this cleanly.
    return error(
      `Assignment '${assignmentId}' has no session to anchor curation event`,
      409
    );
  }

  const curationEvent = createPrincipalCurationEvent(db, sessionId, {
    kind: "abandon",
    targetKind: "task",
    ...(reason ? { reason } : {}),
  });
  broadcastEvent(deps.wsRegistry, sessionId, curationEvent);

  const respBody: AbandonResponse = {
    ok: true,
    assignmentId,
    taskId: row.task_id,
    scope: "task",
    eventId: curationEvent.id,
  };
  return json(respBody);
}

// ---------- POST /api/assignments/:id/handoff ----------

export async function handleHandoffAssignment(
  db: Database,
  deps: ApiDeps,
  assignmentId: string,
  rawBody: unknown
): Promise<Response> {
  const row = readAssignment(db, assignmentId);
  if (!row) return error("No such assignment", 404);

  if (rawBody === null || rawBody === undefined || typeof rawBody !== "object") {
    return error("Body must be a JSON object with 'newAgentId'", 400);
  }
  // Strict shape — PR #30 S2. Reject unknown keys rather than silently
  // ignoring them; callers that hand-rolled the payload should fail loud.
  const handoffKeysErr = validateBodyKeys(rawBody, ["newAgentId", "reason"]);
  if (handoffKeysErr) return handoffKeysErr;
  const body = rawBody as HandoffRequest;
  if (typeof body.newAgentId !== "string" || body.newAgentId.trim() === "") {
    return error("'newAgentId' must be a non-empty string", 400);
  }
  const newAgentId = body.newAgentId.trim();

  const { reason, err: reasonErr } = readReason(rawBody);
  if (reasonErr) return reasonErr;

  // Decision 6 — `completed` and `cancelled` are disabled per Decision 3.
  // `failed` is the only terminal state hand-off accepts (new-assignment-only).
  if (row.state === "completed" || row.state === "cancelled") {
    return error(
      `Assignment '${assignmentId}' is in terminal state '${row.state}'; hand-off is only legal on non-terminal states or 'failed'.`,
      409
    );
  }

  // Verify the new agent exists; the schema's FK on agent_task_assignment
  // would also catch this but the API-level check produces a friendlier 400.
  const agent = db
    .query("SELECT id, name FROM agents WHERE id = ?")
    .get(newAgentId) as { id: string; name: string } | null;
  if (!agent) {
    return error(`Agent '${newAgentId}' not found`, 400);
  }

  // Decision 6 — a hand-off to the same agent is a no-op at best and a
  // misleading audit trail at worst (cancel-and-respawn to the same
  // destination emits a `handoff` principal.curation event pointing nowhere
  // meaningful). Reject explicitly rather than silently doing the wrong
  // thing.
  if (newAgentId === row.agent_id) {
    return error("Cannot hand off to the same agent", 400);
  }

  const inFlight = !TERMINAL_STATES.has(row.state); // queued|dispatched|running|blocked

  // Step 1 (in-flight only): cancel the current assignment AND close its
  // live process BEFORE spawning the new session (Decision 6 invariant —
  // "old closed before new spawn" so two concurrent CC processes never run
  // on the same task_id during the spawn window).
  //
  // Use the existing session as the FK anchor for the cancel's state.transition
  // event; the curation event lands on the NEW session below (Decision 9 —
  // "Dispatch on a terminal-state assignment, the event lands on the **new**
  // session created by the spawn").
  let cancelFrom: AssignmentState | undefined;
  let cancelTo: AssignmentState | undefined;
  let oldSessionId: string | null;

  if (inFlight) {
    oldSessionId = resolveCurationSessionId(db, assignmentId);
    if (!oldSessionId) {
      return error(
        `Assignment '${assignmentId}' has no session to anchor cancel transition`,
        409
      );
    }
    const cancel = applyTransition(db, assignmentId, oldSessionId, {
      type: "cancel",
    });
    if (!cancel.ok) {
      return error(cancel.error, 409);
    }
    cancelFrom = cancel.from;
    cancelTo = cancel.assignment.state;
    broadcastTransition(
      deps.wsRegistry,
      assignmentId,
      cancel.from,
      cancel.assignment.state,
      cancel.assignment.block_reason
    );
    broadcastEvent(deps.wsRegistry, oldSessionId, cancel.event);

    // Decision 6 + Decision 11 — close the OLD process NOW, before spawn.
    // Await so the kill completes (SIGTERM→exit, or SIGKILL escalation)
    // before the new session is created. Mirrors the policy-gated kill
    // `fireCancelObserver` would otherwise do post-spawn; running it up
    // front pins the invariant instead of racing it. Best-effort: errors
    // are logged to stderr but don't abort the hand-off (the DB cancel has
    // already committed; the new spawn must still happen so the principal
    // isn't left with neither side running).
    try {
      await createControlledEndpoint(
        db,
        deps.processManager,
        oldSessionId
      ).close();
    } catch (err) {
      process.stderr.write(
        `[api] handoff: close of old session ${oldSessionId} failed: ${(err as Error).message}\n`
      );
    }
  }

  // Step 2 — create a new assignment row to the new agent. Same `task_id`,
  // back to `queued`. Schema-wise no UNIQUE on (task_id, agent_id) — terminal
  // rows on the same task are preserved (Decision 4 / F-8 Decision 4).
  const newAssignmentId = generateId();
  try {
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES (?, ?, ?, 'queued')`
    ).run(newAssignmentId, newAgentId, row.task_id);
  } catch (err) {
    return error(
      `Failed to create new assignment: ${(err as Error).message}`,
      500
    );
  }

  // Step 3 — spawn the new controlled session. Mirrors POST /api/sessions's
  // spawn path (rollback on failure included).
  let endpoint;
  try {
    endpoint = spawnControlledSession(
      db,
      deps.processManager,
      newAssignmentId,
      {
        ...(deps.spawn ? { spawn: deps.spawn } : {}),
        dispatcher: { wsRegistry: deps.wsRegistry },
      }
    );
  } catch (err) {
    try {
      db.query(`DELETE FROM agent_task_assignment WHERE id = ?`).run(
        newAssignmentId
      );
    } catch (rollbackErr) {
      process.stderr.write(
        `[api] handoff rollback after spawn-failure failed: ${(rollbackErr as Error).message}\n`
      );
    }
    const status = err instanceof SessionConflict ? 409 : 500;
    return error(`Spawn failed: ${(err as Error).message}`, status);
  }

  // Decision 6 invariant: the OLD session's `endpoint.close()` was already
  // awaited above (before spawn). The post-spawn observer that previous
  // revisions of this handler used (`fireCancelObserver`) is no longer
  // wired here — the kill is not deferred. `cancelFrom` / `cancelTo` remain
  // in scope because the HandoffResponse below reports them to the caller.

  // Drive the new assignment queued → dispatched → running. Same loop
  // shape as handleCreateSession.
  for (const action of [
    { type: "dispatch" as const },
    { type: "start" as const },
  ]) {
    const result = applyTransition(
      db,
      newAssignmentId,
      endpoint.sessionId,
      action
    );
    if (!result.ok) {
      process.stderr.write(
        `[api] applyTransition(${action.type}) failed for ${newAssignmentId}: ${result.error}\n`
      );
      break;
    }
    broadcastTransition(
      deps.wsRegistry,
      newAssignmentId,
      result.from,
      result.assignment.state,
      result.assignment.block_reason
    );
    broadcastEvent(deps.wsRegistry, endpoint.sessionId, result.event);
  }

  // Decision 9 — principal.curation event with `kind: "handoff"` on the NEW
  // session. The cancel of the old assignment has its own `state.transition`
  // event on the OLD session; this curation event captures the principal
  // rationale for the hand-off as a whole.
  const curationEvent = createPrincipalCurationEvent(db, endpoint.sessionId, {
    kind: "handoff",
    fromAgentId: row.agent_id,
    toAgentId: newAgentId,
    newAssignmentId,
    ...(reason ? { reason } : {}),
  });
  broadcastEvent(deps.wsRegistry, endpoint.sessionId, curationEvent);

  const respBody: HandoffResponse = {
    ok: true,
    assignmentId,
    newAssignmentId,
    newSessionId: endpoint.sessionId,
    ...(cancelFrom ? { from: cancelFrom } : {}),
    ...(cancelTo ? { to: cancelTo } : {}),
    eventId: curationEvent.id,
  };
  return json(respBody);
}

// ============================================================================
// F-12b — Add to queue (GitHub issue/PR import)
// ============================================================================
//
// Three handlers:
//   handlePreviewTask  — POST /api/tasks/preview (no write)
//   handleCreateTask   — POST /api/tasks        (commits task + shadow pair)
//   handleAbandonTask  — POST /api/tasks/:taskId/abandon (task-keyed cancel)
//
// Design addendum: `docs/design-mc-f12b-add-to-queue.md`
//   Decision 3 — gh CLI via Bun.spawn (see ./github-fetch.ts)
//   Decision 4 — URL parser (see ./github-ref.ts)
//   Decision 5 — application-level dedup at preview time, 409 response
//   Decision 6 — endpoint shapes
//   Decision 8 — task-shadow-{taskId} helper in ../db/sessions.ts
//   Decision 10 — `principal.curation` with kind: "task.imported"

const TITLE_OVERRIDE_MAX_LEN = 500;

/** Parse a "owner/repo" default-repo string into {owner, repo}, or {} if malformed. */
function parseDefaultRepo(raw: string | undefined): ParseDefaults {
  if (!raw || typeof raw !== "string") return {};
  const idx = raw.indexOf("/");
  if (idx <= 0 || idx === raw.length - 1) return {};
  const owner = raw.slice(0, idx);
  const repo = raw.slice(idx + 1);
  // Parser will validate the identifier regex again; accept any non-empty
  // split here and let the parser's validation reject malformed values on
  // the hot path.
  if (owner.length === 0 || repo.length === 0 || repo.includes("/")) {
    return {};
  }
  return { owner, repo };
}

/**
 * Map a `GitHubFetchError.kind` to an HTTP status code for the wire.
 * Centralised so preview and create agree.
 */
function fetchErrorStatus(err: GitHubFetchError): number {
  switch (err.kind) {
    case "not_found":
      return 404;
    case "unauthorized":
      return 401;
    case "rate_limited":
      // 429 Too Many Requests is the canonical HTTP status for upstream
      // rate-limit propagation. Modern clients (and any future programmatic
      // consumer of this endpoint) special-case 429 with Retry-After /
      // exponential-backoff handling, whereas 403 reads as "credentials
      // wrong, try a different identity" and would mislead retries.
      return 429;
    case "timeout":
    case "spawn_failed":
    case "upstream":
    case "parse_error":
      return 502;
  }
}

interface DedupCheckResult {
  existingTaskId: string;
  existingTitle: string;
  existingStatus: string;
}

/**
 * Application-level dedup (Decision 5) — no UNIQUE index in v1.
 *
 * Returns the existing task row if one already tracks the same
 * `source_external_id` under `source_system='github'`, or `null` if no
 * duplicate exists.
 */
function findExistingGithubTask(
  db: Database,
  canonical: string
): DedupCheckResult | null {
  return (
    db
      .query(
        `SELECT id AS existingTaskId, title AS existingTitle, status AS existingStatus
         FROM tasks
         WHERE source_system = 'github' AND source_external_id = ?
         LIMIT 1`
      )
      .get(canonical) as DedupCheckResult | null
  );
}

/**
 * Shared preview-flow helper: parse → dedup-check → fetch. Returns the
 * resolved GitHub metadata + canonical ref + parsed ref on success, a
 * conflict response on dedup hit, or an error response otherwise.
 *
 * Used by both `handlePreviewTask` (returns the metadata to the caller)
 * and `handleCreateTask` (recomputes to defend the dedup race window
 * between preview and submit).
 */
type PreviewFlowResult =
  | {
      ok: true;
      ref: GitHubRef;
      canonical: string;
      metadata: {
        type: "issue" | "pr";
        state: string;
        title: string;
        labels: string[];
        body: string | null;
        html_url: string;
      };
    }
  | { ok: false; response: Response };

async function runPreviewFlow(
  db: Database,
  deps: ApiDeps,
  rawRef: unknown
): Promise<PreviewFlowResult> {
  if (typeof rawRef !== "string") {
    return { ok: false, response: error("'ref' must be a string", 400) };
  }

  const defaults = parseDefaultRepo(deps.defaultGithubRepo);
  const parsed = parseGitHubRef(rawRef, defaults);
  if (isParseError(parsed)) {
    return { ok: false, response: error(parsed.error, 400) };
  }

  const canonical = canonicalRef(parsed);

  // Dedup at preview time — returns 409 conflict BEFORE any GitHub fetch
  // work. Saves the rate-limit quota on the happy path for re-imports.
  const existing = findExistingGithubTask(db, canonical);
  if (existing) {
    const conflict: PreviewTaskConflict = {
      kind: "conflict",
      existingTaskId: existing.existingTaskId,
      existingTitle: existing.existingTitle,
      existingStatus: existing.existingStatus,
      message: `Task ${existing.existingTaskId} already tracks ${canonical}`,
    };
    return { ok: false, response: json(conflict, 409) };
  }

  const fetched = await fetchIssueOrPr(
    { owner: parsed.owner, repo: parsed.repo, number: parsed.number },
    deps.ghSpawn ? { spawn: deps.ghSpawn } : {}
  );
  if (isGitHubFetchError(fetched)) {
    return {
      ok: false,
      response: error(fetched.message, fetchErrorStatus(fetched)),
    };
  }

  return {
    ok: true,
    ref: parsed,
    canonical,
    metadata: fetched,
  };
}

// ---------- POST /api/tasks/preview ----------

export async function handlePreviewTask(
  db: Database,
  deps: ApiDeps,
  rawBody: unknown
): Promise<Response> {
  if (typeof rawBody !== "object" || rawBody === null) {
    return error("Body must be a JSON object", 400);
  }
  const body = rawBody as Partial<PreviewTaskRequest>;
  const keysErr = validateBodyKeys(rawBody, ["ref"]);
  if (keysErr) return keysErr;

  const flow = await runPreviewFlow(db, deps, body.ref);
  if (!flow.ok) return flow.response;

  const resp: PreviewTaskResponse = {
    kind: "preview",
    ref: flow.canonical,
    url: flow.metadata.html_url,
    type: flow.metadata.type,
    state: flow.metadata.state,
    title: flow.metadata.title,
    labels: flow.metadata.labels,
    body_excerpt: excerpt(flow.metadata.body),
    fetched_at: new Date().toISOString(),
  };
  return json(resp);
}

// ---------- POST /api/tasks ----------

export async function handleCreateTask(
  db: Database,
  deps: ApiDeps,
  rawBody: unknown
): Promise<Response> {
  if (typeof rawBody !== "object" || rawBody === null) {
    return error("Body must be a JSON object", 400);
  }
  const keysErr = validateBodyKeys(rawBody, [
    "ref",
    "titleOverride",
    "priority",
  ]);
  if (keysErr) return keysErr;

  const body = rawBody as Partial<CreateTaskRequest>;

  // Priority validation (Decision 10 — integer 0..3 on the wire).
  if (typeof body.priority !== "number") {
    return error("'priority' must be a number (0..3)", 400);
  }
  if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 3) {
    return error("'priority' must be an integer between 0 and 3", 400);
  }
  const priority = body.priority;

  // Optional title override — when present must be a string, 500 char cap.
  let titleOverride: string | undefined;
  if (body.titleOverride !== undefined) {
    if (typeof body.titleOverride !== "string") {
      return error("'titleOverride' must be a string", 400);
    }
    const trimmed = body.titleOverride.trim();
    if (trimmed.length > TITLE_OVERRIDE_MAX_LEN) {
      return error(
        `'titleOverride' must be ${TITLE_OVERRIDE_MAX_LEN} characters or fewer`,
        400
      );
    }
    if (trimmed.length > 0) titleOverride = trimmed;
  }

  // Full preview-flow re-run (parse + dedup + fetch). Decision 6 spells this
  // out as "defense-in-depth: if the principal races the dedup window
  // between preview and submit, they get the same error here".
  const flow = await runPreviewFlow(db, deps, body.ref);
  if (!flow.ok) return flow.response;

  const title = titleOverride ?? flow.metadata.title;
  const sourceUrl = flow.metadata.html_url;
  const canonical = flow.canonical;
  const type = flow.metadata.type;

  const taskId = generateId();
  const shadowAssignmentId = generateId();
  const shadowSessionId = generateId();
  const principalId = DEFAULT_PRINCIPAL_ID;

  // All four writes (task + shadow assignment + shadow session + curation
  // event) land under one transaction so a partial failure leaves no
  // observer-visible half-state. `db.transaction` is best-effort atomic at
  // the SQLite level; if any INSERT throws, the whole batch rolls back.
  //
  // The import event's full record is stashed into a mutable holder so
  // the caller can `broadcastEvent` after the transaction commits (the
  // event insert is inside the tx, but WS broadcast happens post-commit
  // so subscribers don't see a write-then-rollback ghost).
  const holder: { event: ReturnType<typeof createPrincipalCurationEvent> | null } =
    { event: null };

  const insertAll = db.transaction(() => {
    db.query(
      `INSERT INTO tasks
         (id, title, priority, principal_id,
          source_system, source_url, source_external_id)
       VALUES (?, ?, ?, ?, 'github', ?, ?)`
    ).run(taskId, title, priority, principalId, sourceUrl, canonical);

    createShadowAssignmentAndSession(db, taskId, {
      assignmentId: shadowAssignmentId,
      sessionId: shadowSessionId,
    });

    holder.event = createPrincipalCurationEvent(db, shadowSessionId, {
      kind: "task.imported",
      source: "github",
      ref: canonical,
      url: sourceUrl,
      type,
    });
  });

  try {
    insertAll();
  } catch (err) {
    const msg = (err as Error).message;
    process.stderr.write(
      `[api] POST /api/tasks insert failed for ref=${canonical}: ${msg}\n`
    );
    return error(`Failed to create task: ${msg}`, 500);
  }

  if (!holder.event) {
    return error("Internal error: import event not produced", 500);
  }
  broadcastEvent(deps.wsRegistry, shadowSessionId, holder.event);

  const resp: CreateTaskResponse = {
    taskId,
    shadowAssignmentId,
    shadowSessionId,
    title,
    source_url: sourceUrl,
    source_external_id: canonical,
    priority,
  };
  return json(resp, 201);
}

// ---------- POST /api/tasks/:taskId/abandon ----------

/**
 * Task-keyed abandon — inherited from F-12 Decision 5's deferred route.
 *
 * Distinct from `POST /api/assignments/:id/abandon`:
 *   - F-12's assignment-abandon goes through `applyTransition(..., cancel)`
 *     and mutates `agent_task_assignment.state = 'cancelled'`.
 *   - F-12b's task-abandon sets `tasks.status = 'cancelled'` directly. No
 *     assignment state-machine transition — the per-assignment machine is
 *     scope-mismatched (the task row, not the assignment row, is what's
 *     being cancelled).
 *
 * Legal only when the task is not already `cancelled` AND has no non-shadow
 * non-terminal assignment (i.e. no real agent is in-flight on this task).
 * The 409 message names the alternative endpoint for principals who hit the
 * wrong door.
 */
export function handleAbandonTask(
  db: Database,
  deps: ApiDeps,
  taskId: string,
  rawBody: unknown
): Response {
  // Strict shape — body is `{ reason? }` (or empty/null).
  const keysErr = validateBodyKeys(rawBody, ["reason"]);
  if (keysErr) return keysErr;
  const reasonParse = readReason(rawBody);
  if (reasonParse.err) return reasonParse.err;
  const reason = reasonParse.reason;

  const taskRow = db
    .query(`SELECT id, status FROM tasks WHERE id = ?`)
    .get(taskId) as { id: string; status: string } | null;
  if (!taskRow) {
    return error(`Task '${taskId}' not found`, 404);
  }
  if (taskRow.status === "cancelled") {
    return error(`Task '${taskId}' is already cancelled`, 409);
  }

  // Reject if there's a non-shadow, non-terminal assignment — the principal
  // should cancel that assignment first (via the assignment-keyed route) or
  // let it settle. Mirrors F-12's task-scope branch invariant.
  const blocker = db
    .query(
      `SELECT id, state FROM agent_task_assignment
       WHERE task_id = ?
         AND agent_id != '${SHADOW_AGENT_ID}'
         AND state NOT IN ('completed','failed','cancelled')
       LIMIT 1`
    )
    .get(taskId) as { id: string; state: string } | null;
  if (blocker) {
    return error(
      `Task '${taskId}' has a non-terminal assignment (id=${blocker.id}, state=${blocker.state}); cancel the assignment first via POST /api/assignments/:id/abandon.`,
      409
    );
  }

  // Resolve the session to anchor the curation event. Preferred order
  // (Decision 10): the shadow session for F-12b-imported tasks (always
  // present); otherwise the latest terminal session for any real
  // assignment on this task.
  const sessionRow = db
    .query(
      `SELECT s.id AS id
       FROM sessions s
       JOIN agent_task_assignment a ON a.id = s.assignment_id
       WHERE a.task_id = ?
       ORDER BY
         CASE WHEN a.agent_id = '${SHADOW_AGENT_ID}' THEN 0 ELSE 1 END ASC,
         s.started_at DESC
       LIMIT 1`
    )
    .get(taskId) as { id: string } | null;
  if (!sessionRow) {
    // Pre-F-12b tasks (internal-source) that never ran any assignment fall
    // here — no session exists to anchor the event FK. Refuse rather than
    // fabricating one; the principal can still cancel the task row by other
    // means (direct SQL or a future internal-source curation route).
    return error(
      `Task '${taskId}' has no session to anchor curation event`,
      409
    );
  }

  // Mutate the task + insert the curation event in one transaction.
  // Holder object pattern — mutable ref survives TS narrowing across the
  // transaction closure. See the create-task handler above for the same
  // pattern; duplicated here rather than extracted because the pair of
  // inserts is short enough that a helper would be more ceremony.
  const holder: { event: ReturnType<typeof createPrincipalCurationEvent> | null } =
    { event: null };
  const tx = db.transaction(() => {
    db.query(
      `UPDATE tasks SET status = 'cancelled', updated_at = unixepoch() WHERE id = ?`
    ).run(taskId);

    holder.event = createPrincipalCurationEvent(db, sessionRow.id, {
      kind: "abandon",
      targetKind: "task",
      ...(reason ? { reason } : {}),
    });
  });

  try {
    tx();
  } catch (err) {
    const msg = (err as Error).message;
    process.stderr.write(
      `[api] POST /api/tasks/${taskId}/abandon failed: ${msg}\n`
    );
    return error(`Failed to abandon task: ${msg}`, 500);
  }
  if (!holder.event) {
    return error("Internal error: curation event not produced", 500);
  }
  broadcastEvent(deps.wsRegistry, sessionRow.id, holder.event);

  // Re-read updated_at to surface the canonical ISO-8601 timestamp.
  const after = db
    .query(`SELECT updated_at FROM tasks WHERE id = ?`)
    .get(taskId) as { updated_at: number } | null;
  const updated_at = after
    ? new Date(after.updated_at * 1000).toISOString()
    : new Date().toISOString();

  const resp: AbandonTaskResponse = {
    taskId,
    status: "cancelled",
    updated_at,
    eventId: holder.event.id,
  };
  return json(resp);
}

// ============================================================================
// F-15 — iteration mutation surface
// ============================================================================
//
// Decisions referenced inline:
//   D1  — Grove owns the lifecycle; source state is never an input
//   D5  — designing → queued is "Promote"; cancellation is the explicit destructive path
//   D8  — endpoint shapes (this file)
//   D9  — no write-back to source
//   D10 Q1 — principal-driven `done` from non-`in_flight`/non-`blocked`
//            states is REJECTED in v1 (Phase G feature). The matrix in
//            `db/iterations.ts#canTransitionServer` enforces this; the
//            handler wraps the rejection with a friendlier message
//            naming `cancel` as the alternative for principals who hit
//            the wrong door.

/** Cap for iteration title to keep it row-friendly. Mirrors F-12b's TITLE_OVERRIDE_MAX_LEN. */
const ITERATION_TITLE_MAX_LEN = 500;
/** Cap for iteration body (markdown design notes). Mirrors `DRILL_INPUT_MAX_BYTES`. */
const ITERATION_BODY_MAX_BYTES = 50 * 1024;

/**
 * Validate priority (integer 0..3) — same shape as F-12b's task priority.
 * Returns the parsed value or an error message; `null` for "not present".
 */
function parseOptionalPriority(
  raw: unknown
): { value: number } | { error: string } | null {
  if (raw === undefined) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 3) {
    return { error: "'priority' must be an integer between 0 and 3" };
  }
  return { value: raw };
}

/**
 * Common readback + broadcast: re-fetch the full IterationDetail (header
 * + tasks) so the wire response and the WS frame agree on shape. The
 * read is one indexed query — cheap enough to do unconditionally rather
 * than threading the row through every code path.
 */
function readDetailOrThrow(db: Database, id: string): IterationDetail {
  const detail = getIteration(db, id);
  if (!detail) {
    // The handler already returned the row from a successful write a
    // microsecond ago; if the read returns null we're seeing concurrent
    // deletion (impossible in v1 — DELETE on iterations isn't wired)
    // or a corrupted DB. Throw so the outer try/catch turns it into a
    // 500 rather than fabricating a half-shape response.
    throw new Error(`Iteration '${id}' disappeared between write and read`);
  }
  return detail;
}

// ---------- GET /api/iterations/:id ----------

export function handleGetIteration(db: Database, id: string): Response {
  try {
    const detail = getIteration(db, id);
    if (!detail) {
      return error(`Iteration '${id}' not found`, 404);
    }
    const body: GetIterationResponse = { iteration: detail };
    return json(body);
  } catch (err) {
    process.stderr.write(
      `[api] GET /api/iterations/:id failed for ${id}: ${(err as Error).message}\n`
    );
    return error(`Failed to read iteration: ${(err as Error).message}`, 500);
  }
}

// ---------- POST /api/iterations ----------

const CREATE_ITERATION_KEYS = [
  "title",
  "body",
  "imported_body",
  "priority",
  "state",
  "source_system",
  "source_url",
  "source_parent_ref",
] as const;

export function handleCreateIteration(
  db: Database,
  deps: ApiDeps,
  rawBody: unknown
): Response {
  if (rawBody === null || rawBody === undefined || typeof rawBody !== "object") {
    return error("Body must be a JSON object with 'title'", 400);
  }
  const keysErr = validateBodyKeys(rawBody, CREATE_ITERATION_KEYS);
  if (keysErr) return keysErr;

  const body = rawBody as Partial<CreateIterationRequest>;

  // Title — required, non-empty, capped.
  if (typeof body.title !== "string") {
    return error("'title' must be a string", 400);
  }
  const title = body.title.trim();
  if (title.length === 0) {
    return error("'title' must not be empty", 400);
  }
  if (title.length > ITERATION_TITLE_MAX_LEN) {
    return error(
      `'title' must be ${ITERATION_TITLE_MAX_LEN} characters or fewer`,
      400
    );
  }

  // Body — optional string, capped to 50 KB UTF-8.
  let bodyText: string | null = null;
  if (body.body !== undefined && body.body !== null) {
    if (typeof body.body !== "string") {
      return error("'body' must be a string or null", 400);
    }
    if (Buffer.byteLength(body.body, "utf8") > ITERATION_BODY_MAX_BYTES) {
      return error("'body' exceeds the 50 KB limit", 413);
    }
    bodyText = body.body;
  }

  // Imported body — same caps; usually only set by F-17's import path.
  let importedBody: string | null = null;
  if (body.imported_body !== undefined && body.imported_body !== null) {
    if (typeof body.imported_body !== "string") {
      return error("'imported_body' must be a string or null", 400);
    }
    if (
      Buffer.byteLength(body.imported_body, "utf8") > ITERATION_BODY_MAX_BYTES
    ) {
      return error("'imported_body' exceeds the 50 KB limit", 413);
    }
    importedBody = body.imported_body;
  }

  const prio = parseOptionalPriority(body.priority);
  if (prio && "error" in prio) return error(prio.error, 400);
  const priority = prio ? prio.value : 2;

  // State — optional. Validates against the canonical enum but does NOT
  // run through `canTransitionServer` (this is a fresh row; there's no
  // current state to transition from).
  let state: IterationState = "inbox";
  if (body.state !== undefined) {
    if (typeof body.state !== "string" || !ITERATION_STATES.includes(body.state)) {
      return error(
        `Invalid 'state' '${body.state}'. Allowed: ${ITERATION_STATES.join(", ")}`,
        400
      );
    }
    state = body.state;
  }

  // Source columns — purely display references after creation (Decision
  // 1 + Decision 9). Validated for type only; no canonicalisation here
  // (F-17 / source adapters own that).
  for (const k of ["source_system", "source_url", "source_parent_ref"] as const) {
    const v = body[k];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return error(`'${k}' must be a string or null`, 400);
    }
  }

  const id = generateIterationId();
  try {
    createIteration(db, {
      id,
      title,
      body: bodyText,
      imported_body: importedBody,
      priority,
      state,
      source_system: (body.source_system) ?? null,
      source_url: (body.source_url) ?? null,
      source_parent_ref: (body.source_parent_ref) ?? null,
      // `imported_at` is set by F-17 during real imports; for principal-
      // typed iterations it's null. Leaving it out of the create body
      // keeps the wire surface honest about what callers should provide.
      imported_at: null,
    });
  } catch (err) {
    process.stderr.write(
      `[api] POST /api/iterations failed: ${(err as Error).message}\n`
    );
    return error(`Failed to create iteration: ${(err as Error).message}`, 500);
  }

  let detail: IterationDetail;
  try {
    detail = readDetailOrThrow(db, id);
  } catch (err) {
    return error((err as Error).message, 500);
  }

  // WS broadcast — fire-and-forget. The HTTP response and the WS frame
  // are independent; if the WS layer is offline the response still ships.
  broadcastIterationCreated(deps.wsRegistry, detail);

  const resp: CreateIterationResponse = { iteration: detail };
  return json(resp, 201);
}

/**
 * Iteration ids share the `generateId` ULID-ish shape with tasks /
 * sessions / events. Prefixing with `it-` would be principal-friendly
 * but breaks the existing `generateId` invariant ("opaque to callers");
 * keep parity with the rest of the schema.
 */
function generateIterationId(): string {
  return generateId();
}

// ---------- PATCH /api/iterations/:id ----------

const PATCH_ITERATION_KEYS = ["title", "body", "priority", "state"] as const;

export function handlePatchIteration(
  db: Database,
  deps: ApiDeps,
  id: string,
  rawBody: unknown
): Response {
  // Empty body is allowed (treated as no-op).
  if (rawBody !== null && rawBody !== undefined && typeof rawBody !== "object") {
    return error("Body must be a JSON object", 400);
  }
  const keysErr = validateBodyKeys(rawBody, PATCH_ITERATION_KEYS);
  if (keysErr) return keysErr;
  const body = (rawBody ?? {}) as Partial<UpdateIterationRequest>;

  // Read the current row up front — needed for both the 404 check AND
  // for the canTransitionServer call below (the validator gates on
  // current state, which only the DB knows authoritatively — never
  // trust an `from` value sent by the client).
  const current = getIteration(db, id);
  if (!current) {
    return error(`Iteration '${id}' not found`, 404);
  }

  // Title.
  let title: string | undefined;
  if (body.title !== undefined) {
    if (typeof body.title !== "string") {
      return error("'title' must be a string", 400);
    }
    const trimmed = body.title.trim();
    if (trimmed.length === 0) {
      return error("'title' must not be empty", 400);
    }
    if (trimmed.length > ITERATION_TITLE_MAX_LEN) {
      return error(
        `'title' must be ${ITERATION_TITLE_MAX_LEN} characters or fewer`,
        400
      );
    }
    title = trimmed;
  }

  // Body — explicit null clears it.
  let bodyText: string | null | undefined;
  if (body.body !== undefined) {
    if (body.body !== null && typeof body.body !== "string") {
      return error("'body' must be a string or null", 400);
    }
    if (
      typeof body.body === "string" &&
      Buffer.byteLength(body.body, "utf8") > ITERATION_BODY_MAX_BYTES
    ) {
      return error("'body' exceeds the 50 KB limit", 413);
    }
    bodyText = body.body;
  }

  const prio = parseOptionalPriority(body.priority);
  if (prio && "error" in prio) return error(prio.error, 400);
  const priority = prio ? prio.value : undefined;

  // State — gated through the server-side validator (Decision 10 Q1).
  let state: IterationState | undefined;
  let stateMoved = false;
  if (body.state !== undefined) {
    if (typeof body.state !== "string" || !ITERATION_STATES.includes(body.state)) {
      return error(
        `Invalid 'state' '${body.state}'. Allowed: ${ITERATION_STATES.join(", ")}`,
        400
      );
    }
    const proposed = body.state;
    if (proposed !== current.state) {
      // canTransitionServer rejects the (current, proposed) move.
      // Friendly message names the legal next states so the principal
      // sees the right escape hatch (almost always `cancel`).
      if (!canTransitionServer(current.state, proposed)) {
        const allowed = nextStatesServer(current.state);
        const allowedClause =
          allowed.length === 0
            ? `iteration is in terminal state '${current.state}'; no transitions out`
            : `allowed next states: ${allowed.join(", ")}`;
        // D10 Q1 — special-case `* → done` from non-{in_flight,blocked}
        // with a copy that names `cancel` as the v1 alternative. Avoids
        // the principal interpreting "you can't ship this iteration"
        // as a bug and re-trying.
        const isDoneAttempt = proposed === "done";
        const detail = isDoneAttempt
          ? "iteration must reach in_flight before it can complete; cancel it instead if the work is no longer needed (principal-driven done is a Phase G feature)"
          : `transition '${current.state}' → '${proposed}' is not legal`;
        return error(`${detail}; ${allowedClause}`, 400);
      }
      state = proposed;
      stateMoved = true;
    }
  }

  // Apply the patch. `updateIteration` handles the no-op case
  // (empty patch returns the row without touching updated_at).
  let updated;
  try {
    updated = updateIteration(db, id, {
      ...(title !== undefined ? { title } : {}),
      ...(bodyText !== undefined ? { body: bodyText } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(state !== undefined ? { state } : {}),
    });
  } catch (err) {
    process.stderr.write(
      `[api] PATCH /api/iterations/${id} failed: ${(err as Error).message}\n`
    );
    return error(`Failed to update iteration: ${(err as Error).message}`, 500);
  }
  if (!updated) {
    // updateIteration returned null → row went away between our read
    // and the write. Rare; surface as 404.
    return error(`Iteration '${id}' not found`, 404);
  }

  let detail: IterationDetail;
  try {
    detail = readDetailOrThrow(db, id);
  } catch (err) {
    return error((err as Error).message, 500);
  }

  // Per Echo grove-v2#42 (Major 3) — broadcast surface split. Kanban
  // gets the header-only `IterationListItem`; the detail surface gets
  // the full row via the paired `iteration.detail_updated` event.
  broadcastIterationUpdated(deps.wsRegistry, toIterationListItem(detail));
  broadcastIterationDetailUpdated(deps.wsRegistry, detail);
  if (stateMoved && state !== undefined) {
    // Order matters: emit `iteration.updated` first so subscribers that
    // only listen to `state_changed` already have the new row in their
    // local list when they pivot on the transition.
    broadcastIterationStateChanged(
      deps.wsRegistry,
      id,
      current.state,
      state
    );
  }

  const resp: UpdateIterationResponse = { iteration: detail };
  return json(resp);
}

// ---------- POST /api/iterations/:id/tasks ----------

const ATTACH_TASK_KEYS = ["task_id", "create"] as const;

export function handleAttachTaskToIteration(
  db: Database,
  deps: ApiDeps,
  iterationId: string,
  rawBody: unknown
): Response {
  if (rawBody === null || rawBody === undefined || typeof rawBody !== "object") {
    return error(
      "Body must be a JSON object with 'task_id' or 'create'",
      400
    );
  }
  const keysErr = validateBodyKeys(rawBody, ATTACH_TASK_KEYS);
  if (keysErr) return keysErr;

  const body = rawBody as AttachTaskRequest;

  // Mutually exclusive — either attach an existing task by id, or
  // create-and-attach a new internal-only task. Both is a usage error.
  const hasTaskId = body.task_id !== undefined;
  const hasCreate = body.create !== undefined;
  if (hasTaskId && hasCreate) {
    return error(
      "Send either 'task_id' (attach existing) or 'create' (create new) — not both",
      400
    );
  }
  if (!hasTaskId && !hasCreate) {
    return error(
      "Body must include 'task_id' (attach existing) or 'create' (create new)",
      400
    );
  }

  // Iteration existence — we read with `getIteration` because the
  // response also needs the readback shape, and one indexed query is
  // cheap. Outside the transaction below: a 404 on the iteration is a
  // pre-condition, not a write.
  const iteration = getIteration(db, iterationId);
  if (!iteration) {
    return error(`Iteration '${iterationId}' not found`, 404);
  }

  // F-16 sweep — track the task id across both attach branches so the
  // post-broadcast section can re-read + emit `task.updated` (Echo
  // grove-v2#43 Major 1). Set to the existing `body.task_id` in the
  // attach-existing path; set to `newTaskId` in the create-and-attach
  // path. Stays null on early-return error paths so the broadcast
  // doesn't fire on a half-applied attach.
  let mutatedTaskId: string | null;

  // ---- Path 1: attach existing task ----
  if (hasTaskId) {
    if (typeof body.task_id !== "string" || body.task_id.length === 0) {
      return error("'task_id' must be a non-empty string", 400);
    }
    const taskId = body.task_id;
    mutatedTaskId = taskId;

    // Per Echo grove-v2#42 (Major 2) — wrap the link-read + 409 gate +
    // attach-write + touch in `db.transaction(() => { … })`. Without
    // this, two concurrent attaches racing through the gate both pass
    // (`attachTask` is permissive at the DB layer per
    // `iterations.test.ts:608` — it overwrites the FK silently); last
    // write wins and the principal-visible 1:N invariant is violated.
    // The transaction also keeps the post-attach `touchIteration`
    // atomic with the write, so a partial-success can't leave the
    // iteration with a fresh tasks row but stale `updated_at`.
    type AttachOutcome =
      | { kind: "attached" }
      | { kind: "idempotent" }
      | { kind: "task-not-found" }
      | { kind: "attached-elsewhere"; iterationId: string };
    const holder: { outcome: AttachOutcome | null } = { outcome: null };
    try {
      db.transaction(() => {
        const link = getTaskIterationLink(db, taskId);
        if (!link) {
          holder.outcome = { kind: "task-not-found" };
          return;
        }
        if (link.iterationId !== null && link.iterationId !== iterationId) {
          // Decision 3 — task contributing to two iterations is the
          // principal's signal to clone, not to model nesting. Refuse
          // with the existing iteration id so the dashboard can offer
          // a "detach and re-attach" affordance instead of silently
          // overwriting.
          holder.outcome = {
            kind: "attached-elsewhere",
            iterationId: link.iterationId,
          };
          return;
        }
        if (link.iterationId === iterationId) {
          // Idempotent — already attached. No write, no touch.
          holder.outcome = { kind: "idempotent" };
          return;
        }
        attachTask(db, iterationId, taskId);
        touchIteration(db, iterationId);
        holder.outcome = { kind: "attached" };
      })();
    } catch (err) {
      process.stderr.write(
        `[api] POST /api/iterations/${iterationId}/tasks (attach existing) failed: ${(err as Error).message}\n`
      );
      return error(
        `Failed to attach task: ${(err as Error).message}`,
        500
      );
    }

    const outcome = holder.outcome;
    if (!outcome) {
      // Defensive — transaction body always sets a kind. If we reach
      // here, the implementation drifted; fail loud rather than silent.
      return error("Internal error: attach outcome not produced", 500);
    }
    if (outcome.kind === "task-not-found") {
      return error(`Task '${taskId}' not found`, 404);
    }
    if (outcome.kind === "attached-elsewhere") {
      return error(
        `Task '${taskId}' is already attached to iteration '${outcome.iterationId}'`,
        409
      );
    }
    if (outcome.kind === "idempotent") {
      // Already attached. Return the current detail without a no-op
      // WS broadcast (frame would carry no new info).
      const resp: AttachTaskResponse = { iteration };
      return json(resp);
    }
    // outcome.kind === "attached" — fall through to the readback +
    // broadcast below.
  } else {
    // ---- Path 2: create + attach in one call ----
    const create = body.create;
    if (typeof create !== "object") {
      return error("'create' must be an object with 'title'", 400);
    }
    if (typeof create.title !== "string" || create.title.trim().length === 0) {
      return error("'create.title' must be a non-empty string", 400);
    }
    const newTitle = create.title.trim();
    if (newTitle.length > ITERATION_TITLE_MAX_LEN) {
      return error(
        `'create.title' must be ${ITERATION_TITLE_MAX_LEN} characters or fewer`,
        400
      );
    }
    let prio = 2;
    if (create.priority !== undefined) {
      const p = parseOptionalPriority(create.priority);
      if (p && "error" in p) return error(p.error, 400);
      if (p) prio = p.value;
    }
    const newTaskId = generateId();
    mutatedTaskId = newTaskId;
    try {
      // Internal-only source — principal-typed-direct-into-iteration.
      // Mirrors the F-12b CreateSession internal-task INSERT shape.
      // Per Echo grove-v2#42 (Major 2) — the touch is now inside the
      // same transaction so create-and-touch land atomically.
      db.transaction(() => {
        db.query(
          `INSERT INTO tasks
             (id, title, priority, principal_id, source_system, iteration_id)
           VALUES (?, ?, ?, ?, 'internal', ?)`
        ).run(newTaskId, newTitle, prio, DEFAULT_PRINCIPAL_ID, iterationId);
        touchIteration(db, iterationId);
      })();
    } catch (err) {
      process.stderr.write(
        `[api] POST /api/iterations/${iterationId}/tasks (create new) failed: ${(err as Error).message}\n`
      );
      return error(
        `Failed to create + attach task: ${(err as Error).message}`,
        500
      );
    }
  }

  let detail: IterationDetail;
  try {
    detail = readDetailOrThrow(db, iterationId);
  } catch (err) {
    return error((err as Error).message, 500);
  }
  // Per Echo grove-v2#42 (Major 3) — broadcast surface split.
  broadcastIterationUpdated(deps.wsRegistry, toIterationListItem(detail));
  broadcastIterationDetailUpdated(deps.wsRegistry, detail);

  // F-16 sweep — Per Echo grove-v2#43 (Major 1) — emit `task.updated`
  // so cross-surface row-cached subscribers (focus area, task table)
  // can patch the iteration denorm in place. The kanban patches via
  // `iteration.updated` per F-16; row-cached surfaces need the full
  // task row because `iteration.updated`'s patch handler can't infer
  // a `null → attached` transition from id-equality.
  if (mutatedTaskId) {
    const updatedTask = getTaskById(db, mutatedTaskId);
    if (updatedTask) {
      broadcastTaskUpdated(deps.wsRegistry, updatedTask);
    }
  }

  const resp: AttachTaskResponse = { iteration: detail };
  return json(resp);
}

// ---------- DELETE /api/iterations/:id/tasks/:taskId ----------

export function handleDetachTaskFromIteration(
  db: Database,
  deps: ApiDeps,
  iterationId: string,
  taskId: string
): Response {
  const iteration = getIteration(db, iterationId);
  if (!iteration) {
    return error(`Iteration '${iterationId}' not found`, 404);
  }

  // Per Echo grove-v2#42 (Major 2) — wrap the link-read + 409 gates +
  // detach-write + touch in `db.transaction(() => { … })`. Same
  // race-window concern as `handleAttachTaskToIteration`: without the
  // wrap, two concurrent detaches racing through the gate could both
  // pass (then the second's `detachTask` becomes a silent no-op since
  // `iteration_id` is already null) and the post-write touch could
  // land out of order with the actual detach.
  type DetachOutcome =
    | { kind: "detached" }
    | { kind: "task-not-found" }
    | { kind: "not-attached" }
    | { kind: "wrong-iteration"; iterationId: string };
  const holder: { outcome: DetachOutcome | null } = { outcome: null };
  try {
    db.transaction(() => {
      const link = getTaskIterationLink(db, taskId);
      if (!link) {
        holder.outcome = { kind: "task-not-found" };
        return;
      }
      if (link.iterationId === null) {
        holder.outcome = { kind: "not-attached" };
        return;
      }
      if (link.iterationId !== iterationId) {
        holder.outcome = {
          kind: "wrong-iteration",
          iterationId: link.iterationId,
        };
        return;
      }
      detachTask(db, taskId);
      touchIteration(db, iterationId);
      holder.outcome = { kind: "detached" };
    })();
  } catch (err) {
    process.stderr.write(
      `[api] DELETE /api/iterations/${iterationId}/tasks/${taskId} failed: ${(err as Error).message}\n`
    );
    return error(`Failed to detach task: ${(err as Error).message}`, 500);
  }

  const outcome = holder.outcome;
  if (!outcome) {
    return error("Internal error: detach outcome not produced", 500);
  }
  if (outcome.kind === "task-not-found") {
    return error(`Task '${taskId}' not found`, 404);
  }
  if (outcome.kind === "not-attached") {
    return error(
      `Task '${taskId}' is not attached to any iteration`,
      409
    );
  }
  if (outcome.kind === "wrong-iteration") {
    return error(
      `Task '${taskId}' is attached to iteration '${outcome.iterationId}', not '${iterationId}'`,
      409
    );
  }

  let detail: IterationDetail;
  try {
    detail = readDetailOrThrow(db, iterationId);
  } catch (err) {
    return error((err as Error).message, 500);
  }
  // Per Echo grove-v2#42 (Major 3) — broadcast surface split.
  broadcastIterationUpdated(deps.wsRegistry, toIterationListItem(detail));
  broadcastIterationDetailUpdated(deps.wsRegistry, detail);

  // F-16 sweep — Per Echo grove-v2#43 (Major 1) — emit `task.updated`
  // with the now-ungrouped task (`iteration: null`) so cross-surface
  // subscribers replace the cached row in place. Without this the
  // stale chip survives — `iteration.updated`'s patch handler can't
  // infer the `attached → null` transition from id-equality.
  const updatedTask = getTaskById(db, taskId);
  if (updatedTask) {
    broadcastTaskUpdated(deps.wsRegistry, updatedTask);
  }

  const resp: DetachTaskResponse = { iteration: detail };
  return json(resp);
}

// ============================================================================
// F-17 — GitHub iteration auto-import
// ============================================================================
//
// Two surfaces:
//   handleImportIterationFromGithub  — POST /api/iterations/from-github
//                                       (principal-driven, gh CLI, 200/201/400/404/409)
//   handleGithubWebhook              — POST /api/github/webhook
//                                       (HMAC-validated upstream stream;
//                                        delegates to iteration-import.ts)
//
// Decisions referenced inline (see docs/design-mc-iteration-planning.md):
//   D1  — Grove owns the lifecycle. Source is import-only.
//   D2  — GitHub parent-issue + sub-issues IS the iteration.
//   D5  — Principal-driven promotion only (auto-import lands in `inbox`).
//   D7  — GitHub-only in v1.
//   D9  — No write-back; subsequent principal edits never overwritten.
//   D10 Q6 — explicit `iteration` label (configurable per-network).

const IMPORT_FROM_GITHUB_KEYS = ["ref", "label"] as const;

/**
 * F-17 — principal-driven import. Mirrors F-12b's `POST /api/tasks` shape:
 * parse the ref → fetch via gh CLI → run the import logic → return the
 * canonical iteration detail.
 *
 * Status codes:
 *   - 201 fresh import (new iteration row created)
 *   - 200 already imported (returns existing row + bodyRefreshed flag)
 *   - 400 bad ref / unknown body keys / unsupported label override
 *   - 401/404/429/502 propagated from `fetchIssueOrPr` (same mapping
 *     F-12b uses)
 *   - 409 the issue exists but isn't carrying the iteration label —
 *     returns the canonical ref + a friendly message naming the label
 *     so the principal can apply it via GitHub and retry.
 */
export async function handleImportIterationFromGithub(
  db: Database,
  deps: ApiDeps,
  rawBody: unknown
): Promise<Response> {
  if (rawBody === null || rawBody === undefined || typeof rawBody !== "object") {
    return error("Body must be a JSON object with 'ref'", 400);
  }
  const keysErr = validateBodyKeys(rawBody, IMPORT_FROM_GITHUB_KEYS);
  if (keysErr) return keysErr;

  const body = rawBody as Partial<ImportIterationFromGithubRequest>;
  if (typeof body.ref !== "string") {
    return error("'ref' must be a string", 400);
  }

  // Optional per-call label override. Principals can pass it explicitly
  // when working with a repo that uses a non-default label without
  // editing the network yaml; the default falls through from the
  // server's per-network config.
  let labelOverride: string | undefined;
  if (body.label !== undefined) {
    if (typeof body.label !== "string" || body.label.trim().length === 0) {
      return error("'label' must be a non-empty string when provided", 400);
    }
    labelOverride = body.label.trim();
  }
  const iterationLabel =
    labelOverride ?? deps.iterationLabel ?? DEFAULT_ITERATION_LABEL;

  const defaults = parseDefaultRepo(deps.defaultGithubRepo);
  const parsed = parseGitHubRef(body.ref, defaults);
  if (isParseError(parsed)) {
    return error(parsed.error, 400);
  }
  const canonical = canonicalRef(parsed);

  // No pre-flight short-circuit on `existingByRef`. The principal-driven
  // path is a backfill surface — its headline use case is recovering when
  // a webhook delivery was missed (network blip, secret rotation gap,
  // restart) and the upstream body has since changed. Skipping the gh
  // fetch when a row already exists would lock out that recovery: every
  // re-import would return `bodyRefreshed: false` and silently keep the
  // stale `imported_body` snapshot, with no principal-visible cue that
  // the audit trail had diverged.
  //
  // Cost is bounded — principal-initiated, never a webhook firehose — and
  // `importIterationFromMetadata` already correctly returns
  // `{ kind: 'exists', bodyRefreshed: true }` when the snapshot needs
  // refreshing, so the truth lives there (single source for the dedup
  // logic). The `canonical` ref is still useful below in the conflict
  // path — keep it computed.

  // Fetch via gh CLI (same path F-12b uses for /api/tasks).
  const fetched = await fetchIssueOrPr(
    { owner: parsed.owner, repo: parsed.repo, number: parsed.number },
    deps.ghSpawn ? { spawn: deps.ghSpawn } : {}
  );
  if (isGitHubFetchError(fetched)) {
    return error(fetched.message, fetchErrorStatus(fetched));
  }

  // Build the parent metadata + run the import logic.
  const meta = parentMetadataFromGhResponse(parsed, {
    title: fetched.title,
    body: fetched.body,
    labels: fetched.labels,
    html_url: fetched.html_url,
  });

  const result = importIterationFromMetadata(db, meta, { iterationLabel });

  if (result.kind === "invalid_metadata") {
    // Should not happen on the principal-driven path — `gh api` always
    // returns sane shapes — but guard against malformed responses.
    process.stderr.write(
      `[api] POST /api/iterations/from-github invalid metadata for ${canonical}: ${result.reason}\n`
    );
    return error(`GitHub response invalid: ${result.reason}`, 502);
  }

  if (result.kind === "not_iteration_labelled") {
    const conflict: ImportIterationFromGithubConflict = {
      kind: "conflict",
      reason: "not_iteration_labelled",
      canonical: result.canonical,
      message: `Issue ${result.canonical} does not carry the '${iterationLabel}' label. Apply the label on GitHub, then retry — or pass {label: '...'} for a different label name.`,
    };
    return json(conflict, 409);
  }

  // result.kind === "created" or "exists" (re-checked the dedup window
  // — the row could land between our pre-flight and the import call
  // if a webhook also fired in parallel).
  const detail = getIteration(db, result.iteration.id);
  if (!detail) {
    return error(
      `Iteration '${result.iteration.id}' disappeared between import and read`,
      500
    );
  }

  // WS broadcast — fresh import is a `created`; refresh of an existing
  // row is an `updated` (matching F-15's broadcast surface split).
  if (result.kind === "created") {
    broadcastIterationCreated(deps.wsRegistry, detail);
  } else {
    broadcastIterationUpdated(deps.wsRegistry, toIterationListItem(detail));
    broadcastIterationDetailUpdated(deps.wsRegistry, detail);
  }

  const resp: ImportIterationFromGithubResponse = {
    kind: result.kind === "created" ? "imported" : "exists",
    iteration: detail,
    bodyRefreshed: result.kind === "exists" ? result.bodyRefreshed : false,
  };
  return json(resp, result.kind === "created" ? 201 : 200);
}

// ----------------------------------------------------------------------------
// F-17 — webhook receiver
// ----------------------------------------------------------------------------

/**
 * Module-scoped TTL set of recently processed `x-github-delivery` IDs.
 *
 * GitHub re-fires deliveries on non-2xx (and the receiver is mostly
 * lenient about non-actionable events, returning 200) but the HMAC
 * verify alone doesn't prevent replay — it only proves the message
 * wasn't tampered with after signing. An attacker holding a captured
 * signed payload (off-the-wire or via a leaked log) can re-fire
 * `issues.opened` arbitrarily, refreshing `imported_body`, flipping
 * task status, and spamming WS broadcasts. Dedupe on the delivery ID
 * makes those replays a 200-no-op.
 *
 * Single-process scope — multi-process deployments would need a DB
 * (or Redis) backed table because each worker keeps its own Map.
 * v1 mission-control is single-process Bun so this is sufficient;
 * upgrade path is to swap this for a `db.query("INSERT ... ON CONFLICT
 * DO NOTHING")` against a `webhook_deliveries` table.
 *
 * Eviction: pruned inline on each delivery — cheap because the Map
 * stays small (GitHub's 24h delivery retry window narrows to 1h here,
 * and even bursty repos top out in low-thousands of unique IDs/h).
 */
const WEBHOOK_DELIVERY_TTL_MS = 60 * 60 * 1000; // 1 hour
const recentWebhookDeliveries = new Map<string, number>();

/**
 * Test-only — clear the in-memory dedupe map. Production code never
 * calls this; tests use it to keep deliveryId state from leaking
 * between cases when they want to assert dedupe behaviour explicitly.
 */
export function _resetWebhookDeliveryDedupeForTests(): void {
  recentWebhookDeliveries.clear();
}

/**
 * Returns true if `deliveryId` was seen within the last
 * `WEBHOOK_DELIVERY_TTL_MS`. Otherwise records it and returns false.
 * Prunes expired entries inline on each call.
 */
function isReplayedWebhookDelivery(deliveryId: string): boolean {
  const now = Date.now();

  // Prune expired entries — cheap O(n) scan; Map iteration order is
  // insertion order so we could early-exit on the first non-expired
  // entry, but the scan stays bounded by 1 hour of unique IDs which is
  // small enough that the simpler shape wins.
  for (const [id, expiresAt] of recentWebhookDeliveries) {
    if (expiresAt <= now) {
      recentWebhookDeliveries.delete(id);
    }
  }

  const existingExpiry = recentWebhookDeliveries.get(deliveryId);
  if (existingExpiry !== undefined && existingExpiry > now) {
    return true;
  }
  recentWebhookDeliveries.set(deliveryId, now + WEBHOOK_DELIVERY_TTL_MS);
  return false;
}

/**
 * Verify a GitHub `x-hub-signature-256` header against `secret` using
 * HMAC-SHA256. Returns true on a valid signature; false otherwise.
 *
 * Implemented against the Web Crypto API directly so we don't introduce
 * a new dep — Bun ships SubtleCrypto natively. Constant-time comparison
 * (`crypto.subtle.verify`) is preferred over a naive string equality
 * because the verification is the auth boundary for the webhook
 * surface and a string `===` would leak signature bytes by timing.
 */
async function verifyGithubSignature(
  secret: string,
  body: string,
  signatureHeader: string
): Promise<boolean> {
  // GitHub sends `sha256=<hex>` — strip the prefix.
  if (!signatureHeader.startsWith("sha256=")) return false;
  const sigHex = signatureHeader.slice("sha256=".length);
  if (sigHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(sigHex)) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  // Decode hex → Uint8Array for the constant-time verify path.
  const sigBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    sigBytes[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(body));
}

/**
 * F-17 — GitHub webhook receiver. Validates HMAC, dispatches `issues`
 * events to the iteration-import path.
 *
 * Per the F-17 design the receiver doesn't subscribe to anything new —
 * the existing `webhook-proxy` already validates the upstream HMAC and
 * fans out to grove-api. This route is a peer surface that runs the
 * Grove-iteration logic against the same payload (the proxy can be
 * configured to fan out to both endpoints; for v1 the principal wires
 * mission-control's `/api/github/webhook` URL alongside the cloud
 * worker's).
 *
 * Behaviour by event:
 *   - `issues.labeled`   — if the new label matches the iteration label
 *                           AND no Grove iteration exists yet, create one.
 *                           Idempotent (no-op when one already exists).
 *   - `issues.unlabeled` — log + no-op. Decision 9 — orphaning is the
 *                           principal's call; we never delete iterations
 *                           in response to upstream label changes.
 *   - `issues.edited`    — if the issue is a tracked iteration parent,
 *                           refresh the audit-only `imported_body`
 *                           snapshot. Principal-edited `body` left alone.
 *   - `issues.opened`    — if the issue is a sub-issue of a tracked
 *   /closed/edited         parent, create or update the child task row.
 *   - other events       — ignored (returns 200 OK so GitHub doesn't
 *                           retry).
 */
export async function handleGithubWebhook(
  db: Database,
  deps: ApiDeps,
  rawBody: string,
  headers: { signature: string; event: string; deliveryId: string }
): Promise<Response> {
  if (!deps.githubWebhookSecret) {
    return error("github webhook receiver not configured", 503);
  }
  if (!headers.signature || !headers.event || !headers.deliveryId) {
    return error("missing required GitHub webhook headers", 400);
  }

  let valid: boolean;
  try {
    valid = await verifyGithubSignature(
      deps.githubWebhookSecret,
      rawBody,
      headers.signature
    );
  } catch (err) {
    process.stderr.write(
      `[api] /api/github/webhook signature verify failed: ${(err as Error).message}\n`
    );
    return error("unauthorized", 401);
  }
  if (!valid) {
    return error("unauthorized", 401);
  }

  // Replay dedupe — checked AFTER HMAC verify so an attacker can't probe
  // the dedupe map for known IDs without first proving they hold the
  // secret. A duplicate delivery (GitHub retry, or a captured payload
  // re-fired) returns 200-no-op without dispatching, so neither the DB
  // nor WS subscribers see the side-effect twice.
  if (isReplayedWebhookDelivery(headers.deliveryId)) {
    return new Response("ok", { status: 200 });
  }

  // Only handle `issues` events; ignore everything else (PRs, pushes,
  // etc. flow through the existing dashboard / D1 pipeline). Returning
  // 200 keeps GitHub from retrying — the event was accepted, just not
  // actionable for the iteration surface.
  if (headers.event !== "issues") {
    return new Response("ok", { status: 200 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (_err) {
    return error("invalid JSON payload", 400);
  }
  if (typeof payload !== "object" || payload === null) {
    return error("payload must be a JSON object", 400);
  }
  const action = (payload as { action?: unknown }).action;
  if (typeof action !== "string") {
    return error("payload missing 'action'", 400);
  }

  const iterationLabel = deps.iterationLabel ?? DEFAULT_ITERATION_LABEL;

  // ---- Sub-issue branch (any sub-issue lifecycle event) ----
  // The sub-issue branch is checked BEFORE the parent-issue branch so
  // an issue that happens to be both labelled `iteration` AND a child
  // of another iteration (rare but legal) is handled as a sub-issue
  // first. The parent-issue branch handles the labelled-as-iteration
  // case via the `parent_not_tracked` short-circuit (an iteration
  // parent isn't itself a sub-issue, so the lookup returns null).
  if (
    action === "opened" ||
    action === "closed" ||
    action === "reopened" ||
    action === "edited"
  ) {
    const refs = subIssueRefsFromWebhook(payload);
    if (refs) {
      const subResult = importSubIssueFromMetadata(db, refs.parent, refs.child);
      if (subResult.kind === "attached" || subResult.kind === "exists") {
        // Re-broadcast the iteration so the dashboard sees the new
        // task count immediately. Cheap — one detail re-read.
        const detail = getIteration(db, subResult.iterationId);
        if (detail) {
          broadcastIterationUpdated(deps.wsRegistry, toIterationListItem(detail));
          broadcastIterationDetailUpdated(deps.wsRegistry, detail);
          const updatedTask = getTaskById(db, subResult.taskId);
          if (updatedTask) {
            broadcastTaskUpdated(deps.wsRegistry, updatedTask);
          }
        }
        return new Response("ok", { status: 200 });
      }
      // parent_not_tracked / invalid_metadata → fall through to the
      // parent-issue branch (the issue might itself be an iteration
      // parent).
    }
  }

  // ---- Parent-issue branch ----
  const meta = parentMetadataFromWebhook(payload);
  if (!meta) {
    // Structurally malformed payload. Log + 400 so the principal sees it
    // (GitHub will surface 400s in the webhook delivery UI).
    return error("payload missing required issue/repository fields", 400);
  }

  if (action === "labeled") {
    // Decision 1 — `issues.labeled` with the iteration label is the
    // primary auto-import trigger. The label that just changed is on
    // `payload.label.name`; we still pass through the full label set
    // to `importIterationFromMetadata` because the issue might have
    // been labelled iteration in this same delivery alongside other
    // labels (GitHub batches multi-label changes into one event).
    const env = payload as { label?: { name?: string } };
    const newLabel = env.label?.name;
    // Cheap fast-path — if the label change isn't the iteration label,
    // no-op without a DB write. Saves the lookup when GitHub fires a
    // burst of unrelated label changes (common on issue triage).
    if (typeof newLabel === "string" && newLabel !== iterationLabel) {
      return new Response("ok", { status: 200 });
    }
    const result = importIterationFromMetadata(db, meta, { iterationLabel });
    if (result.kind === "created") {
      const detail = getIteration(db, result.iteration.id);
      if (detail) broadcastIterationCreated(deps.wsRegistry, detail);
    }
    // `exists` / `not_iteration_labelled` / `invalid_metadata` are all
    // benign no-ops at the webhook surface — we just acknowledge.
    return new Response("ok", { status: 200 });
  }

  if (action === "unlabeled") {
    // Decision 9 — orphaning is the principal's call. Log + 200; never
    // delete the iteration row in response to an upstream label
    // removal.
    const env = payload as { label?: { name?: string } };
    const removed = env.label?.name;
    if (removed === iterationLabel) {
      process.stderr.write(
        `[api] /api/github/webhook issues.unlabeled — '${iterationLabel}' removed from ${parentRef(meta)} (no-op; Grove iteration left intact)\n`
      );
    }
    return new Response("ok", { status: 200 });
  }

  if (action === "edited") {
    // Decision 9 — refresh the audit-only `imported_body` snapshot;
    // never overwrite the principal-edited `body`.
    const result = importIterationFromMetadata(db, meta, { iterationLabel });
    if (result.kind === "exists" && result.bodyRefreshed) {
      const detail = getIteration(db, result.iteration.id);
      if (detail) {
        broadcastIterationUpdated(deps.wsRegistry, toIterationListItem(detail));
        broadcastIterationDetailUpdated(deps.wsRegistry, detail);
      }
    } else if (result.kind === "created") {
      // Edge case: the issue carried the iteration label but Grove
      // didn't have an iteration for it yet (the labeled event was
      // missed or pre-dated this receiver). Treat as a fresh import.
      const detail = getIteration(db, result.iteration.id);
      if (detail) broadcastIterationCreated(deps.wsRegistry, detail);
    }
    return new Response("ok", { status: 200 });
  }

  // `opened` / `closed` / `reopened` for an issue that isn't a sub-issue
  // and isn't carrying the iteration label fall through to here and are
  // ignored. Acknowledge so GitHub doesn't retry.
  return new Response("ok", { status: 200 });
}

// ---------- F-18 — GET /api/metrics/* ----------

/**
 * F-18 — assignment-scoped metrics. Cycle time + per-state +
 * per-block-reason ms breakdown for one assignment. See
 * `docs/design-mc-f18-metrics.md` Decision 4.
 */
export function handleGetAssignmentMetrics(
  db: Database,
  assignmentId: string
): Response {
  try {
    const m = computeAssignmentMetrics(db, assignmentId);
    if (!m) return error(`Assignment '${assignmentId}' not found`, 404);
    const body: MetricsAssignmentResponse = { metrics: m };
    return json(body);
  } catch (err) {
    process.stderr.write(
      `[api] GET /api/metrics/assignment/${assignmentId} failed: ${(err as Error).message}\n`
    );
    return error(
      `Failed to compute assignment metrics: ${(err as Error).message}`,
      500
    );
  }
}

const FLEET_WINDOW_SET: ReadonlySet<string> = new Set(FLEET_WINDOW_ALLOWLIST);

/**
 * F-18 — fleet metrics with optional per-agent filter. Aggregate cycle-time
 * percentiles + per-state means + top blockers + per-agent breakdown across
 * the requested time window.
 */
export function handleGetFleetMetrics(db: Database, url: URL): Response {
  const windowRaw = url.searchParams.get("window");
  if (!windowRaw) {
    return error(
      `Missing 'window' query param. Allowed: ${[...FLEET_WINDOW_ALLOWLIST].join(", ")}`,
      400
    );
  }
  if (!FLEET_WINDOW_SET.has(windowRaw)) {
    return error(
      `Invalid 'window' value '${windowRaw}'. Allowed: ${[...FLEET_WINDOW_ALLOWLIST].join(", ")}`,
      400
    );
  }
  const since = windowToSinceDate(windowRaw as FleetWindow);
  const agentRaw = url.searchParams.get("agent");
  const agentId =
    agentRaw !== null && agentRaw.length > 0 ? agentRaw : undefined;
  try {
    const metrics = computeFleetMetrics(db, { since, agentId });
    const body: MetricsFleetResponse = { metrics };
    return json(body);
  } catch (err) {
    process.stderr.write(
      `[api] GET /api/metrics/fleet failed: ${(err as Error).message}\n`
    );
    return error(
      `Failed to compute fleet metrics: ${(err as Error).message}`,
      500
    );
  }
}
