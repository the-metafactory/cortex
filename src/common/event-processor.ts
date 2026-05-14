import type {
  IngestEvent,
  SessionUpsertData,
  SessionCompleteData,
  UsageSnapshotData,
} from "./types";
import {
  detectProjectFromIngestEvent,
  extractProgress,
  extractGitHubIssue,
} from "./event-utils";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
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
  operatorId: string,
  event: IngestEvent,
): ProcessedSessionEvent {
  switch (event.event_type) {
    case "agent.task.started":
      return processTaskStarted(operatorId, event);
    case "agent.task.completed":
    case "agent.task.failed":
      return processTaskCompleted(operatorId, event);
    case "agent.usage.update":
      return processUsageUpdate(operatorId, event);
    default:
      return processProgressEvent(operatorId, event);
  }
}

function processTaskStarted(
  operatorId: string,
  event: IngestEvent,
): ProcessedSessionEvent {
  const description = sanitizeDescription(
    asString(event.payload.prompt_preview) ||
    asString(event.payload.description) ||
    "Task",
  );
  const project = detectProjectFromIngestEvent(event);
  const githubIssue = extractGitHubIssue(description);
  const eventOperator = typeof event.payload.operator_id === "string" ? event.payload.operator_id : null;

  return {
    type: "task_started",
    session: {
      sessionId: event.session_id,
      operatorId: eventOperator ?? operatorId,
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
    },
  };
}

function processTaskCompleted(
  operatorId: string,
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
  const eventOperator = typeof event.payload.operator_id === "string" ? event.payload.operator_id : null;

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
      operatorId: eventOperator ?? operatorId,
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
    },
  };
}

function processUsageUpdate(
  operatorId: string,
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
  const eventOperator = typeof p.operator_id === "string" ? p.operator_id : null;

  return {
    type: "usage_update",
    snapshot: {
      operatorId: eventOperator ?? operatorId,
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
  operatorId: string,
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
  const eventOperator = typeof event.payload.operator_id === "string" ? event.payload.operator_id : null;

  return {
    type: "progress",
    sessionId: event.session_id,
    eventType: event.event_type,
    timestamp: event.timestamp,
    progress,
    project,
    fallbackSession: {
      sessionId: event.session_id,
      operatorId: eventOperator ?? operatorId,
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
    },
  };
}
