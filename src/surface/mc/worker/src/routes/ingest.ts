/**
 * G-400: POST /api/ingest — Batched event ingestion from principals' bots.
 * Accepts events from bots, validates API key, writes to D1 with dedup.
 * Business logic delegated to shared event-processor; this file handles D1 persistence only.
 *
 * Request body:
 * {
 *   "principal_id": "andreas",
 *   "events": [{ event_id, event_type, timestamp, session_id, ... }]
 * }
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { requireApiKey, type PrincipalKey } from "../auth";
import { processSessionEvent, type ProcessedSessionEvent } from "../../../../../common/event-processor";
import { extractActivityEntry } from "../../../../../common/event-utils";
import type {
  IngestEvent,
  SessionUpsertData,
  SessionCompleteData,
  UsageSnapshotData,
} from "../../../../../common/types";
import { invalidateCache } from "./state";
import { eventMessage, toDashboardEvent } from "../dashboard-socket-protocol";

type Variables = { principalId: string; principalKey: PrincipalKey };

export const ingestRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

interface IngestBody {
  principal_id: string;
  events: IngestEvent[];
}

ingestRoutes.post("/api/ingest", requireApiKey, async (c) => {
  const principalId = c.get("principalId");

  let body: IngestBody;
  try {
    body = await c.req.json<IngestBody>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!body.events || !Array.isArray(body.events)) {
    return c.json({ error: "events must be an array" }, 400);
  }

  if (body.events.length === 0) {
    return c.json({ ok: true, ingested: 0, skipped: 0 });
  }

  // Use the principal_id from the API key, not the request body (trust the key)
  const effectivePrincipalId = principalId;

  let ingested = 0;
  let skipped = 0;

  const db = c.env.GROVE_DB;
  const activitySessionIds = new Set<string>();
  // Events that committed this request — fanned to live dashboards after the response.
  const broadcastable: IngestEvent[] = [];

  for (const event of body.events) {
    if (!event.event_id || !event.event_type || !event.session_id) {
      skipped++;
      continue;
    }

    try {
      const processed = processSessionEvent(effectivePrincipalId, event);
      await persistProcessedEvent(db, processed);

      // G-410: Extract and persist activity entry for this event
      const activity = extractActivityEntry(event);
      if (activity) {
        await insertActivity(db, event.session_id, activity);
        activitySessionIds.add(event.session_id);
      }

      ingested++;
      broadcastable.push(event);
    } catch {
      // INSERT OR IGNORE handles duplicates; other errors are skipped
      skipped++;
    }
  }

  // G-410: Trim activity log to last 50 entries per affected session
  for (const sid of activitySessionIds) {
    await trimActivity(db, sid, 50);
  }

  // G-406: Invalidate snapshot cache after successful writes
  if (ingested > 0) {
    invalidateCache();
  }

  // Live push: fan each committed event to connected dashboards via the
  // DashboardSocket DO. Best-effort and off the response path (waitUntil) — a
  // broadcast failure must never affect the ingest result.
  if (broadcastable.length > 0) {
    c.executionCtx.waitUntil(broadcastIngestedEvents(c.env, broadcastable));
  }

  return c.json({ ok: true, ingested, skipped });
});

/**
 * Fan committed events to live dashboard clients via the DashboardSocket DO.
 * Mirrors the local bot's `broadcastEvent` ({type:"event", sessionId, event}).
 * Never throws — a dead/absent DO must not surface to the ingesting bot.
 */
async function broadcastIngestedEvents(env: Env, events: IngestEvent[]): Promise<void> {
  if (!env.DASHBOARD_SOCKET) return; // binding absent (e.g. bare local dev) — skip
  // Map each ingest-wire event to the dashboard McEvent shape (event_id→id,
  // event_type→type) the renderer expects, and send the whole batch in ONE DO
  // round-trip (not one subrequest per event).
  const messages = events.map((event) => eventMessage(event.session_id, toDashboardEvent(event)));
  const stub = env.DASHBOARD_SOCKET.get(env.DASHBOARD_SOCKET.idFromName("global"));
  try {
    await stub.fetch("https://do/broadcast", {
      method: "POST",
      body: JSON.stringify({ messages }),
    });
  } catch (err) {
    // Best-effort live push; log and continue. Ingest already succeeded.
    console.error("[ingest] WS broadcast failed:", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// D1 persistence — maps ProcessedSessionEvent variants to D1 SQL
// ---------------------------------------------------------------------------

async function persistProcessedEvent(db: D1Database, processed: ProcessedSessionEvent): Promise<void> {
  switch (processed.type) {
    case "task_started":
      await upsertSession(db, processed.session);
      break;
    case "task_completed": {
      const result = await completeSession(db, processed.sessionId, processed.completion);
      if (!result.changed && processed.fallbackSession) {
        await insertSessionDirect(db, processed.fallbackSession, processed.completion);
      }
      break;
    }
    case "usage_update":
      await insertUsageSnapshot(db, processed.snapshot);
      break;
    case "progress": {
      const result = await updateSessionProgress(
        db, processed.sessionId, processed.eventType,
        processed.timestamp, processed.progress, processed.project,
      );
      if (!result.changed && processed.fallbackSession) {
        await upsertSession(db, processed.fallbackSession);
      }
      break;
    }
  }
}

async function upsertSession(db: D1Database, session: SessionUpsertData): Promise<void> {
  // IAW D.5 — sovereignty fields are optional; pre-IAW publishers omit them
  // and the D1 columns stay NULL. On conflict we COALESCE so later events
  // for the same session can backfill (e.g. task_started without envelope,
  // then a progress event from a federated source carries sovereignty).
  const sov = session.sovereignty;
  await db.prepare(`
    INSERT INTO sessions
    (session_id, principal_id, agent_id, agent_name, project, description, github_issue,
     started_at, status, events_count, last_event, last_event_at,
     classification, data_residency, home_principal)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      status = 'active',
      principal_id = COALESCE(excluded.principal_id, principal_id),
      agent_name = excluded.agent_name,
      project = COALESCE(excluded.project, project),
      description = COALESCE(excluded.description, description),
      github_issue = COALESCE(excluded.github_issue, github_issue),
      last_event = excluded.last_event,
      last_event_at = excluded.last_event_at,
      events_count = events_count + 1,
      classification = COALESCE(excluded.classification, classification),
      data_residency = COALESCE(excluded.data_residency, data_residency),
      home_principal = COALESCE(excluded.home_principal, home_principal)
  `).bind(
    session.sessionId,
    session.principalId ?? null,
    session.agentId,
    session.agentName,
    session.project,
    session.description,
    session.githubIssue,
    session.startedAt,
    session.lastEvent,
    session.lastEventAt,
    sov?.classification ?? null,
    sov?.dataResidency ?? null,
    sov?.homePrincipal ?? null,
  ).run();
}

async function completeSession(
  db: D1Database,
  sessionId: string,
  data: SessionCompleteData,
): Promise<{ changed: boolean }> {
  const result = await db.prepare(`
    UPDATE sessions SET
      completed_at = ?,
      duration_ms = ?,
      pr_url = ?,
      status = ?,
      last_event = ?,
      last_event_at = ?
    WHERE session_id = ?
  `).bind(
    data.completedAt,
    data.durationMs,
    data.prUrl,
    data.status,
    `agent.task.${data.status}`,
    data.completedAt,
    sessionId,
  ).run();

  return { changed: (result.meta.changes ?? 0) > 0 };
}

async function insertSessionDirect(
  db: D1Database,
  session: SessionUpsertData,
  completion: SessionCompleteData,
): Promise<void> {
  // IAW D.5 — same late-join semantics as upsertSession but on a fresh row,
  // so we insert sovereignty straight (no COALESCE needed; there's nothing
  // to merge with).
  const sov = session.sovereignty;
  await db.prepare(`
    INSERT OR IGNORE INTO sessions
    (session_id, principal_id, agent_id, agent_name, project, description, github_issue,
     started_at, completed_at, duration_ms, pr_url, status, last_event, last_event_at,
     classification, data_residency, home_principal)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    session.sessionId,
    session.principalId ?? null,
    session.agentId,
    session.agentName,
    session.project,
    session.description,
    session.githubIssue,
    session.startedAt,
    completion.completedAt,
    completion.durationMs,
    completion.prUrl,
    completion.status,
    session.lastEvent,
    session.lastEventAt,
    sov?.classification ?? null,
    sov?.dataResidency ?? null,
    sov?.homePrincipal ?? null,
  ).run();
}

async function updateSessionProgress(
  db: D1Database,
  sessionId: string,
  eventType: string,
  timestamp: string,
  progress: { completed: number; total: number } | null,
  project: string | null = null,
): Promise<{ changed: boolean }> {
  const result = await db.prepare(`
    UPDATE sessions SET
      status = CASE WHEN status IN ('completed', 'failed') AND last_event_at < ? THEN 'active' ELSE status END,
      events_count = events_count + 1,
      last_event = ?,
      last_event_at = ?,
      project = CASE WHEN project IS NULL AND ? IS NOT NULL THEN ? ELSE project END,
      progress_completed = CASE WHEN ? IS NOT NULL THEN ? ELSE progress_completed END,
      progress_total = CASE WHEN ? IS NOT NULL THEN ? ELSE progress_total END
    WHERE session_id = ?
  `).bind(
    timestamp,
    eventType,
    timestamp,
    project,
    project,
    progress?.completed ?? null,
    progress?.completed ?? null,
    progress?.total ?? null,
    progress?.total ?? null,
    sessionId,
  ).run();

  return { changed: (result.meta.changes ?? 0) > 0 };
}

// ---------------------------------------------------------------------------
// G-410: Session activity persistence
// ---------------------------------------------------------------------------

async function insertActivity(
  db: D1Database,
  sessionId: string,
  activity: { timestamp: string; icon: string; label: string; detail: string },
): Promise<void> {
  await db.prepare(`
    INSERT INTO session_activity (session_id, timestamp, icon, label, detail)
    VALUES (?, ?, ?, ?, ?)
  `).bind(sessionId, activity.timestamp, activity.icon, activity.label, activity.detail).run();
}

async function trimActivity(db: D1Database, sessionId: string, keep: number): Promise<void> {
  await db.prepare(`
    DELETE FROM session_activity
    WHERE session_id = ? AND id NOT IN (
      SELECT id FROM session_activity WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?
    )
  `).bind(sessionId, sessionId, keep).run();
}

async function insertUsageSnapshot(db: D1Database, snapshot: UsageSnapshotData): Promise<void> {
  await db.prepare(`
    INSERT INTO usage_snapshots
    (principal_id, source, five_hour_pct, five_hour_resets, seven_day_pct, seven_day_resets,
     seven_day_opus_pct, seven_day_sonnet_pct, extra_usage_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    snapshot.principalId ?? null,
    snapshot.source,
    snapshot.fiveHourPct,
    snapshot.fiveHourResets,
    snapshot.sevenDayPct,
    snapshot.sevenDayResets,
    snapshot.sevenDayOpusPct,
    snapshot.sevenDaySonnetPct,
    snapshot.extraUsageEnabled != null ? (snapshot.extraUsageEnabled ? 1 : 0) : null,
  ).run();
}
