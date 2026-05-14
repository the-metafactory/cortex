/**
 * Grove Mission Control v2 — Event insertion helpers.
 */

import type { Database, Statement } from "bun:sqlite";
import type { McEvent } from "../types";

// Per-database prepared-statement cache. bun:sqlite's db.query() internally
// caches on SQL string, but keeping an explicit reference skips the lookup
// on the hot ingestor path (hundreds of events/sec under burst load). The
// WeakMap means we hold no reference once the Database is GC'd.
const insertEventStmts = new WeakMap<Database, Statement>();

function getInsertEventStmt(db: Database): Statement {
  let stmt = insertEventStmts.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `INSERT INTO events (id, session_id, type, payload, timestamp)
       VALUES (?, ?, ?, ?, ?)`
    );
    insertEventStmts.set(db, stmt);
  }
  return stmt;
}

// Per-process monotonic counter to break ms-collisions. Two ids generated
// in the same ms differ in the counter portion, so lex order matches
// generation order even within a single millisecond.
let lastTimestampMs = 0;
let counterWithinMs = 0;

/**
 * Generate a 26-char time-sortable identifier (NOT a real Crockford ULID).
 *
 * Layout: [10-char base36 ms-timestamp][4-char base36 counter][12-char base36 random]
 *   - ms-timestamp: padStart-zero-padded so all ids of the same era share length
 *   - counter: increments within a single ms, resets on ms change
 *   - random: 12 base36 chars sourced from `crypto.getRandomValues` (CSPRNG)
 *
 * Sort guarantees:
 *   - Lexicographic order matches generation time, even within the same ms,
 *     within a single process.
 *   - ORDER BY id is reliable for paginating events from a single writer.
 *
 * Limits:
 *   - Multi-process / multi-host writers: clock skew can cause inversions.
 *     For voluminous cross-process ordering, ORDER BY (timestamp, id).
 *   - Not crypto-resistant for guessability (12 random chars only).
 *     Do not expose these in URLs that require unpredictability — generate
 *     a separate random token for that.
 */
export function generateId(): string {
  const t = Date.now();
  if (t === lastTimestampMs) {
    counterWithinMs += 1;
  } else {
    counterWithinMs = 0;
    lastTimestampMs = t;
  }

  const ts = t.toString(36).padStart(10, "0");
  const counter = counterWithinMs.toString(36).padStart(4, "0");

  const randBytes = new Uint8Array(12);
  crypto.getRandomValues(randBytes);
  const rand = Array.from(randBytes, (b) => (b % 36).toString(36)).join("");

  return (ts + counter + rand).toUpperCase();
}

/**
 * Insert a generic event into the events table.
 */
export function insertEvent(
  db: Database,
  params: {
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
  }
): McEvent {
  const id = generateId();
  const timestamp = new Date().toISOString();

  getInsertEventStmt(db).run(
    id,
    params.sessionId,
    params.type,
    JSON.stringify(params.payload),
    timestamp
  );

  return {
    id,
    session_id: params.sessionId,
    type: params.type,
    payload: params.payload,
    timestamp,
  };
}

/**
 * List events for a session, ordered ascending by `id`.
 *
 * `id` is time-sortable (see `generateId`) — ORDER BY id ASC matches
 * generation order within the writer process. Pagination uses `before` as
 * an **exclusive** upper bound on `id` so `GET …?before=<oldestId>` walks
 * backwards through history without overlap.
 *
 * Used by F-7 attention drill-down. `limit` is clamped at 200 by callers.
 */
export const EVENTS_LIST_MAX_LIMIT = 200;

export function listEventsForSession(
  db: Database,
  sessionId: string,
  opts: { before?: string; limit: number }
): { events: McEvent[]; hasMore: boolean } {
  const limit = Math.max(1, Math.min(opts.limit, EVENTS_LIST_MAX_LIMIT));

  // Query `limit + 1` to determine hasMore without a second round-trip.
  // If we get `limit + 1` rows, at least one more row exists older than the
  // page we're returning. The extra row is trimmed before return.
  const rows = opts.before
    ? (db
        .query(
          `SELECT id, session_id, type, payload, timestamp
           FROM events
           WHERE session_id = ? AND id < ?
           ORDER BY id DESC
           LIMIT ?`
        )
        .all(sessionId, opts.before, limit + 1) as {
        id: string;
        session_id: string;
        type: string;
        payload: string;
        timestamp: string;
      }[])
    : (db
        .query(
          `SELECT id, session_id, type, payload, timestamp
           FROM events
           WHERE session_id = ?
           ORDER BY id DESC
           LIMIT ?`
        )
        .all(sessionId, limit + 1) as {
        id: string;
        session_id: string;
        type: string;
        payload: string;
        timestamp: string;
      }[]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Reverse to ascending (oldest-first) for the caller. The composite index
  // idx_events_session_id_id (session_id, id DESC) serves the DESC scan
  // directly, so this is an index walk — no in-memory sort — and the
  // in-memory reverse is just a page-sized array flip.
  const events = page.reverse().map((row) => ({
    id: row.id,
    session_id: row.session_id,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    timestamp: row.timestamp,
  }));

  return { events, hasMore };
}

/**
 * Insert an operator.input event.
 *
 * `text` and `images` are both optional at the type level — the caller
 * enforces "at least one of text or images must be present" for the
 * POST /input endpoint (see handlers.ts). Storing images inline here
 * matches the canonical-store rule from `docs/design-mc-image-input.md`
 * Decision 3: operator.input is the authoritative H-source, including
 * for image content; stream-json.user is suppressed on the renderer.
 */
export interface OperatorInputEventPayload {
  text?: string;
  attachments?: string[];
  images?: {
    media_type: string;
    /** Raw base64 (no data-URL prefix). */
    data: string;
  }[];
}

export function createOperatorInputEvent(
  db: Database,
  sessionId: string,
  payload: OperatorInputEventPayload
): McEvent {
  // insertEvent takes Record<string, unknown>; the shape-typed payload is
  // widened at the call-site — the stored JSON is the authoritative truth,
  // and this cast keeps the public API expressive without loosening the
  // insertEvent signature for all callers.
  return insertEvent(db, {
    sessionId,
    type: "operator.input",
    payload: payload as Record<string, unknown>,
  });
}

/**
 * Insert an operator.curation event (F-12 Decision 9).
 *
 * Sibling family of `operator.input` — see addendum Decision 9 for the
 * rationale on why curation verbs are NOT folded into operator.input.
 *
 * The payload follows a tagged-union shape discriminated by `kind`. Four
 * variants ship in F-12: dispatch, requeue, handoff, abandon. F-12b will
 * add `kind: "import"` for the GitHub-issue-add-to-queue verb.
 */
export type OperatorCurationPayload =
  | {
      kind: "dispatch";
      agentId: string;
      reason?: string;
      newAssignmentId?: string;
    }
  | {
      kind: "requeue";
      reason?: string;
    }
  | {
      kind: "handoff";
      fromAgentId: string;
      toAgentId: string;
      reason?: string;
      newAssignmentId: string;
    }
  | {
      kind: "abandon";
      targetKind: "assignment" | "task";
      reason?: string;
    }
  // F-12b Decision 10 — add-to-queue-from-GitHub import event.
  // `source` is a discriminator within `task.imported` so future sources
  // (Linear/Jira) extend via a new `source` value rather than a new `kind`.
  // `ref` is the canonical "owner/repo#number" string (github-ref.canonicalRef).
  // `url` is the canonical html_url from the GitHub response.
  | {
      kind: "task.imported";
      source: "github";
      ref: string;
      url: string;
      type: "issue" | "pr";
    };

export function createOperatorCurationEvent(
  db: Database,
  sessionId: string,
  payload: OperatorCurationPayload
): McEvent {
  // The tagged-union narrowing happens at the call site; the storage layer
  // widens to the generic event-payload shape.
  return insertEvent(db, {
    sessionId,
    type: "operator.curation",
    payload: payload as unknown as Record<string, unknown>,
  });
}

/**
 * Insert a permission.request event.
 */
export function createPermissionRequestEvent(
  db: Database,
  sessionId: string,
  payload: {
    requested_action: string;
    target?: string;
    context?: string;
    risk_hint?: string;
  }
): McEvent {
  return insertEvent(db, {
    sessionId,
    type: "permission.request",
    payload,
  });
}
