/** Data shape for inserting a GitHub event into the store */
export interface GitHubEventData {
  eventId: string;
  repo: string;
  eventType: string;
  title: string | null;
  number: number | null;
  url: string | null;
  author: string | null;
  agentAuthored: boolean;
  linkedSession: string | null;
  payload: string | null;
  createdAt: string;
}

/** Data shape for upserting an issue */
export interface IssueUpsertData {
  id: number;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  author: string | null;
  labels: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
}

/** Data shape for upserting a pull request */
export interface PullRequestUpsertData {
  id: number;
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  author: string | null;
  branch: string | null;
  base: string | null;
  agentAuthored: boolean;
  linkedIssues: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  mergedAt: string | null;
}

/** Data shape for upserting a session */
export interface SessionUpsertData {
  sessionId: string;
  operatorId?: string;
  agentId: string;
  agentName: string;
  project: string | null;
  description: string;
  githubIssue: string | null;
  startedAt: string;
  eventsCount: number;
  lastEvent: string;
  lastEventAt: string;
  progressCompleted: number | null;
  progressTotal: number | null;
}

/** Data for completing a session */
export interface SessionCompleteData {
  completedAt: string;
  durationMs: number | null;
  prUrl: string | null;
  status: "completed" | "failed";
}

/** Data for inserting a usage snapshot */
export interface UsageSnapshotData {
  operatorId?: string;
  source: string;
  fiveHourPct: number | null;
  fiveHourResets: string | null;
  sevenDayPct: number | null;
  sevenDayResets: string | null;
  sevenDayOpusPct: number | null;
  sevenDaySonnetPct: number | null;
  extraUsageEnabled: boolean | null;
}

/** Ingest event shape (from bot cloud publisher) */
export interface IngestEvent {
  event_id: string;
  event_type: string;
  timestamp: string;
  session_id: string;
  agent_id?: string;
  agent_name?: string;
  grove_channel?: string;
  payload: Record<string, unknown>;
}

/** Structured activity entry for a session (tool use, file changes, etc.) */
export interface SessionActivity {
  timestamp: string;
  icon: string;
  label: string;
  detail: string;
}

/** Daily statistics */
export interface DailyStats {
  prsMerged: number;
  issuesClosed: number;
  commits: number;
  filesChanged: number;
  sessionsCompleted: number;
}

/** Activity timeline item */
export interface ActivityItem {
  type: string;
  source: "session" | "github";
  timestamp: string;
  agentId?: string;
  agentName?: string;
  project?: string | null;
  description?: string;
  durationMs?: number | null;
  prUrl?: string | null;
  githubIssue?: string | null;
  status?: "completed" | "failed";
  repo?: string;
  title?: string | null;
  number?: number | null;
  url?: string | null;
  author?: string | null;
  agentAuthored?: boolean;
}
