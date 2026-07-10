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

/**
 * Legacy closed source-system set. As of G-1113.D.7c the `tasks.source_system`
 * column is open provider-neutral `TEXT` (the CHECK was dropped), so this is no
 * longer the type of {@link Task.source_system} (now `string`). Retained as the
 * historical set + for the `TaskSourceSystem extends Provider` subset assertion
 * (source-ref.test.ts) that proves the migrated values stay valid Providers.
 */
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

/**
 * A unit of work within a plan/phase (design §6) — the cockpit's work-management
 * noun, distinct from the legacy {@link Task}. Links up to a {@link Plan} and
 * {@link PlanPhase}, and self-references via `parentId` for sub-items. Git
 * objects link back via {@link PullRequest.workItemId}. Per §6, `status` and
 * `priority` are open provider-native strings (no closed enum), so they are
 * deliberately not narrowed here. `phaseId`/`planId` are nullable — a work item
 * can exist before it's filed under a phase.
 */
export interface WorkItem {
  id: string;
  planId: string | null;
  phaseId: string | null;
  parentId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  provider: Provider;
  externalId: string | null;
  url: string | null;
}

// --- Attention (G-1113.E — design §6 / §7.4) ---

export type AttentionKind =
  | "input_needed"
  | "permission"
  | "review"
  | "failed_dispatch"
  | "stale"
  | "blocked";
export type AttentionSeverity = "low" | "normal" | "high" | "critical";
export type AttentionStatus = "open" | "resolved" | "dismissed";

/**
 * One item in the cross-cutting attention queue (design §6 / §7.4) — something
 * that needs principal action. `workItemId` / `sessionId` are the direct
 * deep-link targets; plan / phase / PR deep-links derive through the work item
 * (resolved in the E.3 UI). `kind` producers are wired in E.2; notification
 * routing is E.4. Lifecycle: `open` → `resolved` (condition cleared) | `dismissed`.
 */
export interface AttentionItem {
  id: string;
  /** Stack/deployment the item belongs to (multi-stack federation). */
  stackId: string;
  workItemId: string | null;
  sessionId: string | null;
  kind: AttentionKind;
  severity: AttentionSeverity;
  status: AttentionStatus;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  priority: number;
  principal_id: string;
  /** Raw stored provider key — open `string` since D.7c (CHECK dropped). */
  source_system: string;
  source_url: string | null;
  source_external_id: string | null;
  related_refs_json: string | null;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
}

/**
 * A dispatch/runtime agent — the bus runtime identity (NKey + JetStream
 * consumer), ~1 per assistant×stack. This is **NOT a session**: the recurring
 * 1,044-tile bug (refactor §1) is exactly the conflation of a CC session with an
 * agent row. A session belongs to an agent and is modelled by {@link Session}
 * (with `agent_id`/`agent_name` as session columns per ADR-0011) — never as its
 * own agent row. See CONTEXT.md §Sessions.
 */
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
  /**
   * CK-4a / #1295 — provider back-pressure hint. Set from the dispatch
   * lifecycle's `not_now { retry_after_ms }` (rate/capacity exhaustion); the
   * assignment sits pre-spawn (`queued`) carrying the earliest-retry delay in ms.
   * NULL ⇒ no pending provider retry. LOCAL-ONLY (no D1 analogue — dispatch stays
   * local). Projected by db/working-aggregation.ts; writer is the write-half.
   */
  retry_after_ms: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * One run of a substrate (CONTEXT.md §Sessions) — belongs to one agent, runs on
 * one substrate, and may be a child of another session.
 *
 * ST-P0 / ADR-0011: the canonical (flat/denormalized) session columns are the
 * shared shape across the local bun:sqlite and cloud D1 substrates — defined
 * once in `db/canonical-session.ts` and pinned to both physical schemas by the
 * parity test. The denormalized attribution/lifecycle/metric/sovereignty fields
 * are nullable on the local side until Phase 2 syncs them on write (this phase
 * is foundation-only). The session-tree fields land now:
 *   - `parent_session_id` — self-ref; NULL ⇒ agent-rooted session.
 *   - `substrate`         — NOT NULL, defaults to 'claude-code'.
 *
 * NAMING (ADR-0011): canonical names prefer the D1 spelling, but the local
 * physical PK stays `id` and the terminal timestamp stays `ended_at` — the
 * `id→session_id` / `ended_at→completed_at` rename cascades through FKs, the
 * partial unique indices, transitions.ts and retention.ts, so it is a deliberate
 * Phase-2 TODO. This interface uses the local physical names (it backs the local
 * row + helpers); the cloud projection maps to `session_id`/`completed_at`.
 */
export interface Session {
  id: string;
  assignment_id: string;
  cc_session_id: string | null;
  endpoint_kind: EndpointKind;
  pid: number | null;
  started_at: string;
  /** Terminal timestamp. Canonical name `completed_at`; local stays `ended_at` (Phase-2 rename). */
  ended_at: string | null;
  // --- ST-P0 / ADR-0011 canonical session columns ---
  /** Self-ref to the spawning session; NULL ⇒ agent-rooted. */
  parent_session_id: string | null;
  /** The substrate this session runs on (claude-code | codex | …). */
  substrate: string;
  /** Owning agent id (denormalized). NULL until Phase 2 syncs it. */
  agent_id: string | null;
  /** Owning agent display name (a session is NOT an agent). NULL until Phase 2. */
  agent_name: string | null;
  /** Principal the session belongs to (denormalized). NULL until Phase 2. */
  principal_id: string | null;
  /** Denormalized lifecycle status. NULL until Phase 2 syncs it off the assignment. */
  status: string | null;
  /** Wall-clock duration in ms. NULL until known. */
  duration_ms: number | null;
  /** Events observed for the session. NULL until known. */
  events_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  /** Sovereignty (IAW D.5): 'local' | 'federated' | 'public' | NULL. */
  classification: string | null;
  data_residency: string | null;
  home_principal: string | null;
  /**
   * CK-4a / #1295 / D-8 — the stack this session ORIGINATED on; the schema-level
   * attribution the cross-stack WORKING aggregation groups by. NULL ⇒ own/local
   * stack (the pre-CK-4a / single-stack case). Stamped from the stack's own
   * resolved identity on write / backfill, never from a peer-controlled payload.
   */
  origin_stack_id: string | null;
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
  /**
   * cortex#1410 — CF Access verification for the mutating admission-decision
   * route when MC is bound BEYOND loopback. On a loopback bind this is unused
   * (the loopback boundary is the gate). On a non-loopback bind it MUST be set,
   * or the route fails closed: whoever exposes MC non-loopback supplies the
   * Access application `aud` at deploy time. `teamDomain` defaults to
   * "metafactory". Omitted entirely on every current (loopback) deployment.
   */
  cfAccess?: CfAccessConfig;
  /**
   * FND-6 — the `mc.governance.principals` authorization allowlist. Every
   * governed glass mutation (`/api/sessions`, `/requeue`, `/abandon`, the
   * attention lifecycle, admission-decision) checks the resolved CF-Access
   * principal against this list. Fail-closed: unset ⇒ refuse mutations on a
   * non-loopback bind (403); on loopback an unset list stays permissive so
   * legit local callers keep working (the loopback boundary + Host/Origin are
   * the gate there). Omitted on a default loopback dev deployment.
   */
  governance?: GovernanceConfig;
}

/** FND-6 — per-daemon control-plane authorization. */
export interface GovernanceConfig {
  /** Principal emails (CF-Access identities) allowed to run glass mutations. */
  principals: string[];
  /**
   * FND-6 posture A (loopback: audit-vs-authentication) — the principal a
   * loopback mutation is ATTRIBUTED to when the request carries no
   * `Cf-Access-Authenticated-User-Email` header. On a loopback bind that header
   * is self-asserted (any local process can set an arbitrary value), so it is
   * AUDIT METADATA, not authentication — Host+Origin is the real loopback
   * boundary. When the header is absent the resolved identity falls back to
   * this value (default `DEFAULT_LOCAL_PRINCIPAL`) and is STILL enforced against
   * `principals`. If you configure `principals` on a loopback bind, set this to
   * a listed principal or the headerless local dashboard is refused (403).
   * Ignored off loopback, where a verified CF-Access JWT is mandatory.
   */
  localPrincipal?: string;
  /**
   * FND-3 — step-up MFA (LOCAL TOTP) knobs. Optional; when omitted the daemon
   * reads the enrolled secret from the default path
   * (`~/.config/cortex/step-up-totp.json`). Absent enrollment fails high-blast
   * control verbs closed (403) regardless — this block only relocates the
   * secret, it never disables the gate.
   */
  stepUp?: StepUpGovernanceConfig;
}

/** FND-3 — step-up MFA configuration. */
export interface StepUpGovernanceConfig {
  /**
   * Override the on-disk home of the enrolled TOTP secret. Tilde-expanded.
   * Never contains the secret itself — only its path.
   */
  secretPath?: string;
}

/** cortex#1410 — CF Access application binding for non-loopback MC. */
export interface CfAccessConfig {
  /** The Access application AUD tag the CF-Access JWT must be scoped to. */
  aud: string;
  /** CF Access team slug → issuer + JWKS URL. Defaults to "metafactory". */
  teamDomain?: string;
}

export interface WsConfig {
  /** Max inbound WebSocket payload in bytes. Default 64 KB. */
  maxPayloadLength: number;
  /** Idle timeout in seconds — server closes connections with no activity. */
  idleTimeoutSec: number;
  /** Max concurrent WebSocket clients. 0 = unlimited. */
  maxClients: number;
}
