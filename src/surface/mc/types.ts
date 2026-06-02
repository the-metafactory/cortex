/**
 * Grove Mission Control v2 — shared TypeScript types.
 */

// --- Enum-like unions ---

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export type AgentType = "head" | "hands";

export type AssignmentState =
  | "queued"
  | "dispatched"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type EndpointKind =
  | "local.process.controlled"
  | "local.observed"
  | "local.process.autonomous";

export type LogLevel = "debug" | "info" | "warn" | "error";

// --- Block reason tagged union ---

export interface BlockReasonPermission {
  kind: "permission.request";
  payload: {
    requested_action: string;
    target?: string;
    context?: string;
    risk_hint?: string;
  };
}

export interface BlockReasonToolError {
  kind: "tool.error";
  payload: {
    tool_name: string;
    error_message: string;
  };
}

export interface BlockReasonReviewCheckpoint {
  kind: "review.checkpoint";
  payload: {
    description: string;
  };
}

export type BlockReason =
  | BlockReasonPermission
  | BlockReasonToolError
  | BlockReasonReviewCheckpoint;

// --- Entity types ---

export type TaskSourceSystem = "github" | "internal";

// --- Provider / source-ref model (G-1113.B.1) ---

/**
 * The set of work-item providers Mission Control can normalize a task from.
 * `PROVIDERS` is the single source of truth — `Provider` is derived from it so
 * the union and the runtime guard never drift. Superset of the legacy
 * {@link TaskSourceSystem} (`github | internal`); the remaining members are
 * declared now (B.1, types only) and wired in later phases.
 */
export const PROVIDERS = [
  "internal",
  "github",
  "gitlab",
  "azure-devops",
  "jira",
  "linear",
  "bitbucket",
  "custom",
] as const;

export type Provider = (typeof PROVIDERS)[number];

/** Runtime guard for {@link Provider} — narrows untrusted input (config/API/wire). */
export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Normalized reference to a task's origin in some provider, independent of the
 * provider's own object model. Provider-specific adapters (B.3+) produce this
 * shape so the rest of Mission Control never branches on `source=github`.
 *
 * `providerNativeType` preserves the provider's own object label
 * (e.g. `"issue"`, `"pull_request"`, `"merge_request"`) on the normalized
 * concept rather than forking the model per provider. This resolves the
 * design §11 open question in favour of **native-type-as-field**: a GitLab
 * merge request is a normalized PullRequest carrying
 * `providerNativeType: "merge_request"` — not a separate `ChangeRequest`
 * top-level concept. (The Git-object modelling that consumes this lands in
 * Phase C; B.1 only fixes the source-ref shape.)
 */
export interface SourceRef {
  provider: Provider;
  /** Provider-native id of the backing object (issue number, MR iid, …). Null for internal/manual. */
  externalId: string | null;
  /** Canonical URL to the backing object, when one exists. */
  url: string | null;
  /**
   * Provider-native object label preserved on the normalized concept
   * (e.g. `"issue"`, `"pull_request"`, `"merge_request"`). Null when not
   * applicable. Deliberately an opaque `string` at the source boundary — the
   * typed literal union (`"pull_request" | "merge_request" | …`) lives on the
   * Phase-C `PullRequest` Git concept, not here; don't narrow it in B.2/C.
   */
  providerNativeType: string | null;
}

/**
 * Runtime guard for {@link SourceRef} — the parity contract every provider
 * adapter (G-1113.B.3+) must satisfy: `provider` is a known {@link Provider}
 * and `externalId` / `url` / `providerNativeType` are each `string | null`.
 * Narrows untrusted input (wire frames, fixtures, future adapter output).
 */
export function isSourceRef(value: unknown): value is SourceRef {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!isProvider(v.provider)) return false;
  for (const field of ["externalId", "url", "providerNativeType"] as const) {
    if (v[field] !== null && typeof v[field] !== "string") return false;
  }
  return true;
}

// --- Software-mode Git objects (G-1113.C — design §3.8 / §6) ---
//
// First-class Git nouns, provider-abstracted (the Git concept is concrete; the
// provider rides as a field). C.1 lands GitRepository + GitBranch (types +
// storage); commits/tags (C.2), PRs/reviews (C.3), checks/deployments/artifacts
// (C.4) follow. Ingestion from the GitHub adapter is C.5; UI is C.6/C.7.

export interface GitRepository {
  id: string;
  provider: Provider;
  /** Owner / org / group segment, when the provider has one. */
  owner: string | null;
  name: string;
  url: string | null;
  defaultBranch: string | null;
}

export interface GitBranch {
  id: string;
  repositoryId: string;
  name: string;
  /** The ref this branch is based on (e.g. the PR's base), when known. */
  baseRef: string | null;
  /** Head commit SHA, when known. */
  headSha: string | null;
  provider: Provider;
  externalId: string | null;
  url: string | null;
}

export interface GitCommit {
  id: string;
  repositoryId: string;
  sha: string;
  title: string;
  author: string | null;
  url: string | null;
}

/**
 * A Git tag. Design §3.8 lists `tag` as a first-class noun but §6 has no
 * dedicated interface (Release carries a `tagName`); this is the minimal
 * provider-neutral shape, consistent with the other Git objects.
 */
export interface GitTag {
  id: string;
  repositoryId: string;
  name: string;
  /** SHA of the commit/object the tag points to, when known. */
  targetSha: string | null;
  provider: Provider;
  url: string | null;
}

export type PullRequestState = "draft" | "open" | "merged" | "closed";
export type PullRequestReviewState =
  | "none"
  | "needs_review"
  | "changes_requested"
  | "approved";

/**
 * A pull request (design §6). The normalized concept; provider-native types
 * (GitHub pull request, GitLab merge request) ride as `providerNativeType`.
 * `workItemId` links to the owning work item/task (populated by Phase D — null
 * for now). `reviewState` is the aggregate; individual {@link Review}s are
 * stored separately.
 */
export interface PullRequest {
  id: string;
  workItemId: string | null;
  repositoryId: string;
  provider: Provider;
  /** Provider-native label, e.g. `"pull_request"` (GitHub) or `"merge_request"` (GitLab). */
  providerNativeType: string;
  externalId: string;
  numberOrKey: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  state: PullRequestState;
  reviewState: PullRequestReviewState;
}

export type ReviewState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "pending"
  | "dismissed";

/**
 * An individual review on a {@link PullRequest}. §6 has no dedicated interface
 * (it carries an aggregate `reviewState` on the PR); this is the minimal shape
 * for the per-review rows the GitHub adapter (C.5) will populate.
 */
export interface Review {
  id: string;
  pullRequestId: string;
  /** Reviewer login / display name, when known. */
  reviewer: string | null;
  state: ReviewState;
  provider: Provider;
  url: string | null;
}

export type CheckKind = "check" | "build";
export type CheckState =
  | "pending"
  | "success"
  | "failure"
  | "error"
  | "neutral"
  | "cancelled";

/**
 * A status check or build (design §3.8 lists "check / status check" and "build"
 * — modelled as one entity with a `kind`, since they share a lifecycle). §6 has
 * no dedicated interface; this is the minimal provider-neutral shape.
 */
export interface Check {
  id: string;
  repositoryId: string;
  /** Commit SHA the check ran against, when known. */
  commitSha: string | null;
  name: string;
  kind: CheckKind;
  state: CheckState;
  provider: Provider;
  url: string | null;
}

export type DeploymentState =
  | "pending"
  | "in_progress"
  | "success"
  | "failure"
  | "inactive";

/** A deployment of a build/release to an environment (design §3.8 noun). */
export interface Deployment {
  id: string;
  repositoryId: string;
  environment: string;
  state: DeploymentState;
  provider: Provider;
  url: string | null;
}

/** A build output / release asset (design §3.8 noun). */
export interface Artifact {
  id: string;
  repositoryId: string;
  name: string;
  provider: Provider;
  url: string | null;
}

export type ReleaseState = "draft" | "published" | "failed" | "archived";

/**
 * A published cut of a repository (design §6). `repositoryId` is nullable per
 * §6 (a release can predate repo linkage); `tagName` links to the {@link GitTag}
 * by name when present.
 */
export interface Release {
  id: string;
  repositoryId: string | null;
  provider: Provider;
  externalId: string | null;
  name: string;
  tagName: string | null;
  url: string | null;
  state: ReleaseState;
}

// --- Plan lineage (G-1113.D — design §6) ---

export type PlanKind =
  | "research"
  | "design"
  | "iteration"
  | "migration"
  | "release"
  | "rollout"
  | "incident";
export type PlanStatus = "draft" | "active" | "blocked" | "done" | "cancelled";

/**
 * A plan/program — the work-management layer above tasks/work items (design §6).
 * `umbrellaWorkItemId` links to the umbrella issue when one backs it (wired in
 * later D slices). The phases are stored separately ({@link PlanPhase}).
 */
export interface Plan {
  id: string;
  title: string;
  kind: PlanKind;
  sourceDocumentUrl: string | null;
  provider: Provider;
  externalId: string | null;
  umbrellaWorkItemId: string | null;
  status: PlanStatus;
}

export type PlanPhaseStatus = "not_started" | "active" | "blocked" | "done" | "cancelled";

/** An ordered phase/wave within a {@link Plan}. */
export interface PlanPhase {
  id: string;
  planId: string;
  title: string;
  order: number;
  status: PlanPhaseStatus;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  priority: number;
  principal_id: string;
  source_system: TaskSourceSystem;
  source_url: string | null;
  source_external_id: string | null;
  related_refs_json: string | null;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
}

export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  persistent: boolean;
  created_at: string;
}

export interface AgentTaskAssignment {
  id: string;
  agent_id: string;
  task_id: string;
  state: AssignmentState;
  block_reason: BlockReason | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  assignment_id: string;
  cc_session_id: string | null;
  endpoint_kind: EndpointKind;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
}

export interface McEvent {
  id: string;
  session_id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// --- State machine ---

export type Action =
  | { type: "dispatch" }
  | { type: "start" }
  | { type: "block"; reason: BlockReason }
  | { type: "complete" }
  | { type: "fail"; error?: string }
  | { type: "resume" }
  | { type: "principal_requeue" }
  | { type: "cancel" };

export type ActionType = Action["type"];

export type TransitionResult =
  | { ok: true; state: AssignmentState; blockReason: BlockReason | null }
  | { ok: false; error: string };

// --- Config ---

export interface HooksConfig {
  rawEventsDir: string;
  cursorPath: string;
  pollInterval: number;
}

export interface Config {
  port: number;
  /** Bind address. Defaults to "127.0.0.1" — loopback only.
   *  NEVER set to "0.0.0.0" without auth; see CLAUDE.md security rule. */
  hostname: string;
  db: { path: string };
  log: { level: LogLevel };
  hooks: HooksConfig;
  ws: WsConfig;
}

export interface WsConfig {
  /** Max inbound WebSocket payload in bytes. Default 64 KB. */
  maxPayloadLength: number;
  /** Idle timeout in seconds — server closes connections with no activity. */
  idleTimeoutSec: number;
  /** Max concurrent WebSocket clients. 0 = unlimited. */
  maxClients: number;
}
