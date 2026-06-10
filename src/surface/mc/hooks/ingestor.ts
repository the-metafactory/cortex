/**
 * Grove Mission Control v2 — Hook event ingestor.
 *
 * Takes parsed raw hook events, correlates with registered sessions
 * by cc_session_id, and inserts matching events into the DB.
 *
 * F-20 — for `local.observed` sessions, drives state-machine transitions
 * the controlled path normally fires synchronously:
 *   - First event for a `dispatched` observed session →  `dispatched → running`
 *     (the principal's TTY just emitted the first hook event, so the
 *     terminal session is genuinely doing work).
 *   - `Stop` / `SessionEnd` hook event for a `running` observed session →
 *     `running → completed`. Without this auto-transition, observed
 *     sessions silently inflate F-18 cycle-time / wait-time metrics
 *     until a principal manually closes them — Echo flagged this in
 *     PR #54 cycle-1 review.
 *
 * Both auto-transitions only apply when the registered session has
 * `endpoint_kind = 'local.observed'` — controlled sessions own their
 * state-machine driving via `handleCreateSession` and the WS write
 * path. Touching that here would race those.
 */

import type { Database } from "bun:sqlite";
import type { McEvent, AssignmentState } from "../types";
import type { RawHookEvent } from "./types";
import type { WsClientRegistry } from "../ws/client-registry";
import { insertEvent } from "../db/events";
import { applyTransition } from "../db/transitions";
import { registerOrphanSession } from "../db/sessions";
import { broadcastTransition, broadcastEvent } from "../notifications";

export interface IngestResult {
  count: number;
  events: McEvent[];
}

/**
 * Hook event types that mark a session ending. Auto-fires the
 * `running → completed` transition for observed sessions per F-20
 * Decision 2. Both names are recognised — CC's hook surface has used
 * both labels across versions, and we want forwards/back compat. No
 * other hook types are treated as terminal.
 */
const SESSION_END_EVENT_TYPES = new Set<string>([
  "session.end",
  "SessionEnd",
  "Stop",
]);

interface ObservedSessionRow {
  id: string;
  endpoint_kind: string;
  assignment_id: string;
  ata_state: AssignmentState;
}

export function ingestEvents(
  db: Database,
  events: RawHookEvent[],
  wsRegistry?: WsClientRegistry
): IngestResult {
  if (events.length === 0) return { count: 0, events: [] };

  // Group events by session_id
  const bySession = new Map<string, RawHookEvent[]>();
  for (const event of events) {
    const group = bySession.get(event.session_id) ?? [];
    group.push(event);
    bySession.set(event.session_id, group);
  }

  let count = 0;
  const inserted: McEvent[] = [];

  // Reusable lookup: session by cc_session_id — most recent first, regardless
  // of ended_at status. F-20 widens the SELECT to also pull endpoint_kind +
  // assignment state so we can drive observed-session auto-transitions without
  // a second query.
  const lookupSession = (ccSessionId: string): ObservedSessionRow | null =>
    db
      .query(
        `SELECT s.id AS id, s.endpoint_kind AS endpoint_kind,
                s.assignment_id AS assignment_id,
                a.state AS ata_state
         FROM sessions s
         JOIN agent_task_assignment a ON a.id = s.assignment_id
         WHERE s.cc_session_id = ?
         ORDER BY s.started_at DESC LIMIT 1`
      )
      .get(ccSessionId) as ObservedSessionRow | null;

  for (const [ccSessionId, sessionEvents] of bySession) {
    let session = lookupSession(ccSessionId);

    if (!session) {
      // MC-I1.S5 (ADR-0005 §3) — auto-register the unknown cc_session_id as an
      // orphan `local.observed` session instead of dropping its events. Catches
      // instrumented non-dispatch sessions (e.g. cldyo-live). Idempotent on
      // cc_session_id: registerOrphanSession dedupes, so subsequent batches for
      // the same orphan don't duplicate rows. One stderr line per auto-register
      // (observability) — NOT one per event.
      //
      // Capture display metadata from the raw events: prefer the first event's
      // agent_name so the orphan agent card shows a human label rather than the
      // raw cc_session_id.
      const displayName = sessionEvents.find(
        (e) => e.agent_name !== undefined && e.agent_name.length > 0
      )?.agent_name;
      const orphan = registerOrphanSession(db, ccSessionId, displayName);
      if (orphan) {
        process.stderr.write(
          `[mission-control] ingestor: auto-registered orphan observed session '${ccSessionId}' (assignment '${orphan.assignmentId}')\n`
        );
      }
      // Re-read so the rest of the loop (event insert + F-20 transitions) runs
      // unchanged against the freshly-created (or pre-existing, on a dedup
      // race) orphan row.
      session = lookupSession(ccSessionId);
      if (!session) {
        // Should be unreachable — registerOrphanSession either created the row
        // or a concurrent writer did. If the lookup still misses, something is
        // wrong with the DB; surface it rather than silently dropping.
        process.stderr.write(
          `[mission-control] ingestor: orphan auto-register did not yield a session for '${ccSessionId}'; dropping ${sessionEvents.length} event(s)\n`
        );
        continue;
      }
    }

    // Insert events first — they're the authoritative record. Then
    // consider auto-transitions for observed sessions.
    for (const raw of sessionEvents) {
      const event = insertEvent(db, {
        sessionId: session.id,
        type: raw.event_type,
        payload: {
          ...raw.payload,
          source_hook: raw.source.hook,
          source_tool: raw.source.tool_name,
          agent_id: raw.agent_id,
          agent_name: raw.agent_name,
          original_event_id: raw.event_id,
          original_timestamp: raw.timestamp,
        },
      });
      inserted.push(event);
      count++;
    }

    // F-20 — auto-transition logic for observed sessions only.
    if (session.endpoint_kind !== "local.observed") continue;

    // Walk the session's events in arrival order to drive transitions.
    // We snapshot the assignment state once and update locally so we
    // don't issue redundant transitions when a single batch contains
    // both first-event and end-event.
    let currentState: AssignmentState = session.ata_state;

    for (const raw of sessionEvents) {
      // dispatched → running on the first event we see while in dispatched.
      if (currentState === "dispatched") {
        const result = applyTransition(db, session.assignment_id, session.id, {
          type: "start",
        });
        if (result.ok) {
          currentState = result.assignment.state;
          if (wsRegistry) {
            broadcastTransition(
              wsRegistry,
              session.assignment_id,
              result.from,
              result.assignment.state,
              result.assignment.block_reason
            );
            broadcastEvent(wsRegistry, session.id, result.event);
          }
        } else {
          process.stderr.write(
            `[mission-control] ingestor: auto-start failed for assignment '${session.assignment_id}': ${result.error}\n`
          );
        }
      }

      // running → completed on Stop / SessionEnd.
      if (
        currentState === "running" &&
        SESSION_END_EVENT_TYPES.has(raw.event_type)
      ) {
        const result = applyTransition(db, session.assignment_id, session.id, {
          type: "complete",
        });
        if (result.ok) {
          currentState = result.assignment.state;
          if (wsRegistry) {
            broadcastTransition(
              wsRegistry,
              session.assignment_id,
              result.from,
              result.assignment.state,
              result.assignment.block_reason
            );
            broadcastEvent(wsRegistry, session.id, result.event);
          }
        } else {
          process.stderr.write(
            `[mission-control] ingestor: auto-complete failed for assignment '${session.assignment_id}': ${result.error}\n`
          );
        }
      }
    }
  }

  return { count, events: inserted };
}
