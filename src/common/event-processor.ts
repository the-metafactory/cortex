import type {
  IngestEvent,
  SessionSovereignty,
  SessionUpsertData,
  SessionCompleteData,
  UsageSnapshotData,
} from "./types";
import {
  detectProjectFromIngestEvent,
  extractProgress,
  extractGitHubIssue,
} from "./event-utils";

/**
 * IAW D.5 — lift sovereignty fields off an ingest event into the
 * normalised `SessionSovereignty` shape persisted on `sessions`. Returns
 * `undefined` when no sovereignty fields are present so the worker can
 * leave the D1 columns as NULL rather than inserting empty strings.
 *
 * The relay is responsible for hoisting `envelope.sovereignty.*` and
 * `signed_by[0].principal` (after `did:mf:` strip → principal segment) onto
 * the ingest event before publishing. This processor is purely defensive —
 * it never invents sovereignty data, only reflects what arrived.
 */
function extractSovereignty(event: IngestEvent): SessionSovereignty | undefined {
  const s = event.sovereignty;
  if (!s) return undefined;
  // At least one field must be present; otherwise treat as absent.
  if (s.classification == null && s.data_residency == null && s.home_principal == null) {
    return undefined;
  }
  return {
    classification: s.classification ?? null,
    dataResidency: s.data_residency ?? null,
    homePrincipal: s.home_principal ?? null,
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * ST-P2 — lift the canonical session-tree fields (`parent_session_id`,
 * `substrate`) off an ingest event payload into the `SessionUpsertData` shape
 * the cloud D1 writer persists. Both are optional (additive ST-P1 wire
 * contract): when absent we return `undefined`/`null` so the worker leaves
 * `parent_session_id` NULL and `substrate` at its column default. Never invents
 * data — only reflects what arrived (mirrors `extractSovereignty`).
 */
function extractSessionTree(event: IngestEvent): {
  parentSessionId: string | null;
  substrate: string | null;
} {
  const p = event.payload;
  const parent = typeof p.parent_session_id === "string" && p.parent_session_id.length > 0
    ? p.parent_session_id
    : null;
  const substrate = typeof p.substrate === "string" && p.substrate.length > 0
    ? p.substrate
    : null;
  return { parentSessionId: parent, substrate };
}

/** Light cleanup — only strip CC internal noise that would never be meaningful to a human reader */
function sanitizeDescription(raw: string): string {
  return raw
    .replace(/toolu_[A-Za-z0-9_-]+/g, "")              // tool-use IDs
    .replace(/\s{2,}/g, " ")
    .trim() || "Task";
}

/** Classified result of processing a session event */
export type ProcessedSessionEvent =
  | { type: "task_started"; session: SessionUpsertData }
  | {
      type: "task_completed";
      sessionId: string;
      completion: SessionCompleteData;
      fallbackSession?: SessionUpsertData;
    }
  | { type: "usage_update"; snapshot: UsageSnapshotData }
  | {
      type: "progress";
      sessionId: string;
      eventType: string;
      timestamp: string;
      progress: { completed: number; total: number } | null;
      /** Project detected from this event — used to backfill null projects on existing sessions */
      project: string | null;
      fallbackSession?: SessionUpsertData;
    };

/** Classify an event and extract the data needed for persistence */
export function processSessionEvent(
  principalId: string,
  event: IngestEvent,
): ProcessedSessionEvent {
  switch (event.event_type) {
    case "agent.task.started":
      return processTaskStarted(principalId, event);
    case "agent.task.completed":
    case "agent.task.failed":
      return processTaskCompleted(principalId, event);
    case "agent.usage.update":
      return processUsageUpdate(principalId, event);
    default:
      return processProgressEvent(principalId, event);
  }
}

function processTaskStarted(
  principalId: string,
  event: IngestEvent,
): ProcessedSessionEvent {
  const description = sanitizeDescription(
    asString(event.payload.prompt_preview) ||
    asString(event.payload.description) ||
    "Task",
  );
  const project = detectProjectFromIngestEvent(event);
  const githubIssue = extractGitHubIssue(description);
  const eventPrincipal = typeof event.payload.operator_id === "string" ? event.payload.operator_id : null;

  const tree = extractSessionTree(event);
  return {
    type: "task_started",
    session: {
      sessionId: event.session_id,
      principalId: eventPrincipal ?? principalId,
      agentId: event.agent_id ?? "unknown",
      agentName: event.agent_name ?? event.agent_id ?? "agent",
      project,
      description,
      githubIssue,
      startedAt: event.timestamp,
      eventsCount: 1,
      lastEvent: event.event_type,
      lastEventAt: event.timestamp,
      progressCompleted: null,
      progressTotal: null,
      sovereignty: extractSovereignty(event),
      parentSessionId: tree.parentSessionId,
      substrate: tree.substrate,
    },
  };
}

function processTaskCompleted(
  principalId: string,
  event: IngestEvent,
): ProcessedSessionEvent {
  const status =
    event.event_type === "agent.task.completed"
      ? ("completed" as const)
      : ("failed" as const);
  const durationMs = event.payload.duration_ms
    ? Number(event.payload.duration_ms)
    : null;
  const prUrl = asString(event.payload.pr_url) || null;

  // Build a fallback session in case no session exists yet (late join)
  const description = asString(event.payload.summary) || "Task";
  const project = detectProjectFromIngestEvent(event);
  const githubIssue = extractGitHubIssue(description);
  const eventPrincipal = typeof event.payload.operator_id === "string" ? event.payload.operator_id : null;

  const tree = extractSessionTree(event);
  return {
    type: "task_completed",
    sessionId: event.session_id,
    completion: {
      completedAt: event.timestamp,
      durationMs,
      prUrl,
      status,
    },
    fallbackSession: {
      sessionId: event.session_id,
      principalId: eventPrincipal ?? principalId,
      agentId: event.agent_id ?? "unknown",
      agentName: event.agent_name ?? event.agent_id ?? "agent",
      project,
      description,
      githubIssue,
      startedAt: event.timestamp,
      eventsCount: 1,
      lastEvent: event.event_type,
      lastEventAt: event.timestamp,
      progressCompleted: null,
      progressTotal: null,
      sovereignty: extractSovereignty(event),
      parentSessionId: tree.parentSessionId,
      substrate: tree.substrate,
    },
  };
}

function processUsageUpdate(
  principalId: string,
  event: IngestEvent,
): ProcessedSessionEvent {
  const p = event.payload;
  const fiveHour = p.five_hour as
    | { utilization?: number; resets_at?: string }
    | undefined;
  const sevenDay = p.seven_day as
    | { utilization?: number; resets_at?: string }
    | undefined;
  const sevenDayOpus = p.seven_day_opus as
    | { utilization?: number }
    | undefined;
  const sevenDaySonnet = p.seven_day_sonnet as
    | { utilization?: number }
    | undefined;
  const extraUsage = p.extra_usage as
    | { is_enabled?: boolean }
    | undefined;

  // Prefer per-event operator_id (from GROVE_OPERATOR_ID env var) over API key owner.
  const eventPrincipal = typeof p.operator_id === "string" ? p.operator_id : null;

  return {
    type: "usage_update",
    snapshot: {
      principalId: eventPrincipal ?? principalId,
      source: "event",
      fiveHourPct: fiveHour?.utilization ?? null,
      fiveHourResets: fiveHour?.resets_at ?? null,
      sevenDayPct: sevenDay?.utilization ?? null,
      sevenDayResets: sevenDay?.resets_at ?? null,
      sevenDayOpusPct: sevenDayOpus?.utilization ?? null,
      sevenDaySonnetPct: sevenDaySonnet?.utilization ?? null,
      extraUsageEnabled: extraUsage?.is_enabled ?? null,
    },
  };
}

function processProgressEvent(
  principalId: string,
  event: IngestEvent,
): ProcessedSessionEvent {
  const progress = extractProgress(event);
  const rawDesc =
    asString(event.payload.active_task) ||
    asString(event.payload.path) ||
    event.event_type;
  // Strip internal IDs, file paths, and XML tags that leak from CC internals
  const description = sanitizeDescription(rawDesc);
  const project = detectProjectFromIngestEvent(event);
  const githubIssue = extractGitHubIssue(description);
  const eventPrincipal = typeof event.payload.operator_id === "string" ? event.payload.operator_id : null;
  const tree = extractSessionTree(event);

  return {
    type: "progress",
    sessionId: event.session_id,
    eventType: event.event_type,
    timestamp: event.timestamp,
    progress,
    project,
    fallbackSession: {
      sessionId: event.session_id,
      principalId: eventPrincipal ?? principalId,
      agentId: event.agent_id ?? "unknown",
      agentName: event.agent_name ?? event.agent_id ?? "agent",
      project,
      description,
      githubIssue,
      startedAt: event.timestamp,
      eventsCount: 1,
      lastEvent: event.event_type,
      lastEventAt: event.timestamp,
      progressCompleted: progress?.completed ?? null,
      progressTotal: progress?.total ?? null,
      sovereignty: extractSovereignty(event),
      parentSessionId: tree.parentSessionId,
      substrate: tree.substrate,
    },
  };
}
