// IAW D.5 — `Classification` is the canonical sovereignty-classification
// union, exported by the envelope validator. Re-exported here as a type-only
// import so consumers of `IngestEvent` / `SessionSovereignty` don't need to
// reach into `bus/myelin/` for a one-token union, and so a future widening
// of the union (e.g. adding `"restricted"`) flows from one definition.
// The import is type-only — `common/types.ts` stays runtime-dep-free.
import type { Classification } from "../bus/myelin/envelope-validator";

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

/**
 * IAW D.5 — Sovereignty fields lifted off the myelin envelope when an
 * ingest event was minted from one. Optional everywhere: events emitted
 * from pre-IAW pipelines carry no envelope and these stay `null` end-to-end.
 *
 * Field semantics mirror `myelin/docs/envelope.md` §sovereignty:
 *   - `classification` — "local" | "federated" | "public"; drives the
 *     dashboard subscription split (D.5.1) and the badge colour (D.5.3).
 *   - `data_residency`  — free-form region tag (e.g. "nz", "eu"); rendered
 *     verbatim in the badge alongside the classification chip.
 *   - `home_operator`   — `signed_by[0].principal` operator segment with
 *     the `did:mf:` prefix stripped. Drives D.5.2 per-operator slicing.
 *     The cloud worker also keeps `sessions.operator_id` (the API-key
 *     owner) which is the *receiving* operator; `home_operator` is who
 *     the work originated from. For purely-local traffic the two match.
 */
export interface SessionSovereignty {
  classification: Classification | null;
  dataResidency: string | null;
  homeOperator: string | null;
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
  /** IAW D.5 — sovereignty lifted from the originating envelope, if any. */
  sovereignty?: SessionSovereignty;
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
  /**
   * IAW D.5 — sovereignty fields hoisted onto the event envelope by the
   * relay when the originating myelin envelope carried `sovereignty.*` +
   * `signed_by[]`. Wire-shape uses snake_case to match the rest of the
   * ingest contract; the worker normalises to camelCase before persist.
   * All three fields are optional — pre-IAW publishers omit them and the
   * cloud worker stores nulls. See `SessionSovereignty` for semantics.
   */
  sovereignty?: {
    classification?: Classification;
    data_residency?: string;
    home_operator?: string;
  };
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
