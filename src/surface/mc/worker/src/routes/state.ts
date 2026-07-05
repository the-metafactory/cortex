/**
 * G-400/G-406: GET /api/state — Dashboard snapshot.
 *
 * `DashboardSnapshot` (below) is authored independently in this file, from
 * the D1 projection this worker populates via event ingestion
 * (`routes/ingest.ts`) — it does not mirror or stay in sync with any local
 * assembly. Cortex's local dashboard serves granular REST (`/api/agents`,
 * `/api/working-agents`, `/api/tasks`, …) plus incremental WS projections;
 * there is no local `/api/state` equivalent (S6, #1520). `buildSnapshot()`
 * and the routes that read its cached output are typed against one exported
 * `DashboardSnapshot`, so a shape change on one side is a compile error on
 * the other instead of a silent runtime drift.
 *
 * Public endpoint (no auth required) — the dashboard is a static site.
 *
 * G-406: Module-level snapshot cache with ETag/304 support.
 * Cache is invalidated on writes (ingest, github webhook) via invalidateCache().
 */

import { Hono } from "hono";
import type { Env } from "../index";
import type { Classification } from "../../../../bus/myelin/envelope-validator";
import { assembleSessionTree, type SessionTreeNode } from "../lib/session-tree";

// ---------------------------------------------------------------------------
// S6 (#1520): DashboardSnapshot contract
//
// One exported type per section of the `/api/state` / `/api/dashboard`
// payload, so `buildSnapshot()` (producer) and the routes that read its
// cached JSON back (consumers) are checked against the same shape.
//
// ADR-0005 (Session interior, CONTEXT.md): every field below is lifecycle
// metadata — with two known, deliberate exceptions, neither of them RAW
// interior (a raw tool-call argument/output object, a full unbounded prompt,
// a diff, or a message array never appear here; D1's schema has no column
// for any of those categories on the 4 tables this file reads — see the
// allow-list guard in `__tests__/dashboard-snapshot-contract.test.ts`, which
// checks SHAPE, not content — read that file's header before assuming more
// than it actually enforces):
//   - `AgentCurrentTask.description` (sourced from `sessions.description`) —
//     up to a 200-char PREVIEW of the triggering prompt. Truncated at the
//     source (`EventLogger.hook.ts`'s `preview.slice(0, 200)` →
//     `payload.prompt_preview`) and passed through `sanitizeDescription()`
//     (strips `toolu_*` IDs) in `common/event-processor.ts` before it ever
//     reaches D1. Also the sole `recentCompletions[].description`.
//   - `SessionActivityEntry.detail` (G-410) — a pre-sanitized, truncated
//     per-event-type action summary (`extractActivityEntry`, e.g. "Editing
//     foo.ts" or a redacted, 100-char-capped command preview), never the raw
//     tool_input/tool_output it summarizes.
// Both sanitizers run at ingest time, upstream of this file; `state.ts` never
// re-validates or re-sanitizes a row's values on read.
//
// `github_events.payload` IS a raw JSON-blob column — small, curated GitHub
// metadata (branch/additions/deletions for a PR, commit/file counts for a
// push — not session interior), read by `getRecentGitHubEvents` but never
// forwarded into `ActivityFeedItem`.
// ---------------------------------------------------------------------------

/** IAW D.5.3 sovereignty block — `null` when none of the three fields are populated. */
export interface SovereigntyInfo {
  classification: Classification | null;
  dataResidency: string | null;
  homePrincipal: string | null;
}

/** One activity-feed entry surfaced under `agents[].currentTask.activity` (G-410). */
export interface SessionActivityEntry {
  timestamp: string;
  icon: string;
  label: string;
  detail: string;
}

/** A session's current-task detail, as surfaced on an active/recently-terminal agent tile. */
export interface AgentCurrentTask {
  sessionId: string;
  agentId: string;
  agentName: string;
  project: string | null;
  /** Ingest-time-sanitized 200-char prompt preview — see the ADR-0005 note above. */
  description: string;
  githubIssue: string | null;
  startedAt: string;
  eventsCount: number;
  lastEvent: string;
  lastEventAt: string;
  progress: { completed: number; total: number } | null;
  activity: SessionActivityEntry[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    costUsd?: number;
  };
  status: "active" | "completed" | "failed";
  completedAt?: string;
  durationMs?: number | null;
  /** ST-P4 — the session-tree edge; `null` ⇒ agent-rooted. */
  parentSessionId: string | null;
  substrate: string;
}

/** One agent tile in the snapshot's `agents` list (session-keyed, not agent-identity-keyed). */
export interface AgentTile {
  id: string;
  name: string;
  principalId: string | null;
  homePrincipal: string | null;
  sovereignty: SovereigntyInfo | null;
  status: "active" | "completed";
  currentTask: AgentCurrentTask;
}

/** One completed/failed session in `recentCompletions`. */
export interface RecentCompletionItem {
  agentId: string;
  agentName: string;
  principalId: string | null;
  project: string | null;
  /** Ingest-time-sanitized 200-char prompt preview — see the ADR-0005 note above. */
  description: string;
  durationMs: number | null;
  completedAt: string;
  prUrl: string | null;
  githubIssue: string | null;
  status: "completed" | "failed";
  homePrincipal: string | null;
  sovereignty: SovereigntyInfo | null;
}

/**
 * The `github_events.event_type` values every writer emits — enumerated from
 * `common/github-events.ts`'s PR/issue processors (`pr_opened`/`pr_merged`/
 * `pr_closed`/`pr_reopened`, `issue_opened`/`issue_closed`/`issue_reopened`,
 * `comment`) plus `push`/`release`, and cross-checked against the sync-route
 * writer (`routes/sync.ts`, same literal set). The D1 column itself is an
 * untyped TEXT with no CHECK constraint, so a row could in principle carry
 * something else — hence the `(string & {})` escape hatch, which keeps the
 * known values autocompletable without falsely claiming exhaustiveness.
 */
export type GithubEventType =
  | "pr_opened" | "pr_merged" | "pr_closed" | "pr_reopened"
  | "issue_opened" | "issue_closed" | "issue_reopened"
  | "comment" | "push" | "release"
  | (string & {});

/** One merged entry in `recentActivity` — either a session completion or a GitHub event. */
export type ActivityFeedItem =
  | {
      type: "task_completed" | "task_failed";
      source: "session";
      timestamp: string;
      agentId: string;
      agentName: string;
      project: string | null;
      /** Ingest-time-sanitized 200-char prompt preview — see the ADR-0005 note above. */
      description: string;
      durationMs: number | null;
      prUrl: string | null;
      githubIssue: string | null;
      status: "completed" | "failed";
    }
  | {
      type: GithubEventType;
      source: "github";
      timestamp: string;
      repo: string;
      title: string | null;
      number: number | null;
      url: string | null;
      author: string | null;
      agentAuthored: boolean;
    };

/** One 5h/7d usage-quota reading (per-account or per-principal). */
export interface UsageSnapshotInfo {
  fiveHour: { utilization: number; resetsAt: string } | null;
  sevenDay: { utilization: number; resetsAt: string } | null;
  sevenDayOpus: { utilization: number; resetsAt: string } | null;
  sevenDaySonnet: { utilization: number; resetsAt: string } | null;
  // `monthlyLimit`/`usedCredits` are future-numeric placeholders: no D1 column
  // backs them yet (usage_snapshots has no `monthly_limit`/`used_credits`
  // schema columns), so both are always constructed as literal `null` today.
  // Typed `number | null` (not frozen `null`) so a future column can start
  // populating them without a DashboardSnapshot type change.
  extraUsage: { isEnabled: boolean; monthlyLimit: number | null; usedCredits: number | null } | null;
  updatedAt: string;
}

/** Today's rollup counters. */
export interface DailyStats {
  prsMerged: number;
  issuesClosed: number;
  commits: number;
  filesChanged: number;
  sessionsCompleted: number;
}

/**
 * The `/api/state` payload shape — also the `state` slice of the combined
 * `/api/dashboard` payload ({@link CombinedDashboardPayload}, below).
 */
export interface DashboardSnapshot {
  projects: Array<{ id: string; displayName: string }>;
  agents: AgentTile[];
  sessionTree: SessionTreeNode[];
  recentCompletions: RecentCompletionItem[];
  recentActivity: ActivityFeedItem[];
  stats: { today: DailyStats };
  accountUsage: UsageSnapshotInfo | null;
  principalUsage: Record<string, UsageSnapshotInfo>;
  homePrincipals: string[];
  updatedAt: string;
}

/** One repo's dashboard summary ({@link buildRepos}). */
export interface RepoSummary {
  fullName: string;
  shortName: string;
  description: string | null;
  defaultBranch: string | null;
  openIssues: number;
  openPRs: number;
  syncedAt: string;
}

/** One day's activity-heatmap row ({@link buildHeatmap}). */
export interface HeatmapDay {
  day: string;
  github: number;
  agent: number;
  byAuthor: Record<string, number>;
}

/** The combined `/api/dashboard` payload — {@link getCachedSnapshot}'s cached shape. */
export interface CombinedDashboardPayload {
  state: DashboardSnapshot;
  repos: RepoSummary[];
  heatmap: { days: HeatmapDay[] };
}

// ---------------------------------------------------------------------------
// G-406: Module-level cache
// ---------------------------------------------------------------------------

let cachedSnapshotJson: string | null = null;
let cachedETag: string | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5_000; // 5s TTL — prevents stale reads across isolates

/**
 * Build a full (unfiltered) snapshot object from D1.
 *
 * IAW D.5 — `homePrincipal` (when supplied) slices the snapshot's `agents`
 * and `recentCompletions` lists by the originating principal. The other
 * derived sections (stats, repos, heatmap) stay global because they reflect
 * the receiving principal's totals; per-principal stats are a future slice
 * (D.5 ships the activity-card path first per the plan §5).
 */
export async function buildSnapshot(
  db: D1Database,
  project?: string | null,
  homePrincipal?: string | null,
): Promise<DashboardSnapshot> {
  const [agents, completions, activity, dailyStats, projects, accountUsage, principalUsage, homePrincipals] = await Promise.all([
    getActiveAgents(db, project, homePrincipal),
    getRecentCompletions(db, project, undefined, homePrincipal),
    getRecentActivity(db, project),
    getDailyStats(db),
    getProjects(db),
    getLatestAccountUsage(db),
    getPerPrincipalUsage(db),
    getKnownHomePrincipals(db),
  ]);

  return {
    projects: projects.map((id: string) => ({
      id,
      displayName: id === "meta-factory" ? "metafactory" : id.charAt(0).toUpperCase() + id.slice(1),
    })),
    agents,
    /**
     * ST-P4 — the session tree (refactor §5b): the active sessions in `agents`
     * folded into the `initiated-by` forest (`parent_session_id`). ADDITIVE —
     * the existing `agents` array is unchanged; the frontend reads this for the
     * nested working-grid until P5 consumes it directly. Lifecycle metadata only
     * (ADR-0005 — no interiors in the cloud projection).
     */
    sessionTree: buildSessionTree(agents),
    recentCompletions: completions,
    recentActivity: activity,
    stats: { today: dailyStats },
    accountUsage,
    principalUsage,
    /**
     * IAW D.5.2 — distinct `home_principal` values observed in recent
     * sessions. The frontend uses this to populate the principal filter
     * dropdown; "Local only" (the default) corresponds to `null` here.
     */
    homePrincipals,
    updatedAt: new Date().toISOString(),
  };
}

/** Build repos list from D1 (same query as repos.ts GET /api/repos). */
export async function buildRepos(db: D1Database): Promise<RepoSummary[]> {
  const { results } = await db.prepare(`
    SELECT r.full_name, r.short_name, r.description, r.default_branch, r.synced_at,
           COALESCE(i.open_count, 0) AS open_issues,
           COALESCE(p.open_count, 0) AS open_prs
    FROM repos r
    LEFT JOIN (SELECT repo, COUNT(*) AS open_count FROM issues WHERE state = 'open' GROUP BY repo) i
      ON i.repo = r.full_name
    LEFT JOIN (SELECT repo, COUNT(*) AS open_count FROM pull_requests WHERE state = 'open' GROUP BY repo) p
      ON p.repo = r.full_name
    ORDER BY r.short_name
  `).all();

  return (results ?? []).map((r: Record<string, unknown>) => ({
    fullName: r.full_name as string,
    shortName: r.short_name as string,
    description: r.description as string | null,
    defaultBranch: r.default_branch as string | null,
    openIssues: r.open_issues as number,
    openPRs: r.open_prs as number,
    syncedAt: r.synced_at as string,
  }));
}

/** Build activity heatmap from D1 (same query as stats.ts GET /api/stats/activity). */
export async function buildHeatmap(db: D1Database, days = 7): Promise<HeatmapDay[]> {
  const now = new Date();
  const startDate = new Date(now.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);

  const [ghRows, sessionRows, authorRows, agentRows] = await Promise.all([
    db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as count
      FROM github_events
      WHERE created_at >= ? AND created_at < ?
      GROUP BY date(created_at)
    `).bind(startDate, endDate).all(),

    db.prepare(`
      SELECT date(completed_at) as day, COUNT(*) as count
      FROM sessions
      WHERE completed_at >= ? AND completed_at < ?
      GROUP BY date(completed_at)
    `).bind(startDate, endDate).all(),

    db.prepare(`
      SELECT date(created_at) as day, author, COUNT(*) as count
      FROM github_events
      WHERE created_at >= ? AND created_at < ? AND author IS NOT NULL
      GROUP BY date(created_at), author
    `).bind(startDate, endDate).all(),

    db.prepare(`
      SELECT date(completed_at) as day, agent_name, COUNT(*) as count
      FROM sessions
      WHERE completed_at >= ? AND completed_at < ? AND agent_name IS NOT NULL
      GROUP BY date(completed_at), agent_name
    `).bind(startDate, endDate).all(),
  ]);

  const ghMap = new Map<string, number>();
  for (const row of (ghRows.results ?? [])) {
    ghMap.set(row.day as string, row.count as number);
  }
  const sessionMap = new Map<string, number>();
  for (const row of (sessionRows.results ?? [])) {
    sessionMap.set(row.day as string, row.count as number);
  }
  const authorMap = new Map<string, Record<string, number>>();
  for (const row of (authorRows.results ?? [])) {
    const day = row.day as string;
    if (!authorMap.has(day)) authorMap.set(day, {});
    authorMap.get(day)![row.author as string] = row.count as number;
  }
  for (const row of (agentRows.results ?? [])) {
    const day = row.day as string;
    if (!authorMap.has(day)) authorMap.set(day, {});
    const existing = authorMap.get(day)!;
    const name = row.agent_name as string;
    existing[name] = (existing[name] ?? 0) + (row.count as number);
  }

  const result: Array<{ day: string; github: number; agent: number; byAuthor: Record<string, number> }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const day = d.toISOString().slice(0, 10);
    result.push({
      day,
      github: ghMap.get(day) ?? 0,
      agent: sessionMap.get(day) ?? 0,
      byAuthor: authorMap.get(day) ?? {},
    });
  }
  return result;
}

/**
 * Mark cache as stale. The next getCachedSnapshot() call will rebuild lazily.
 * This avoids unnecessary D1 work during write-heavy bursts where no dashboard
 * poll may happen for minutes.
 */
export function invalidateCache(): void {
  cachedSnapshotJson = null;
  cachedETag = null;
}

/**
 * Get cached combined snapshot + ETag. Rebuilds from D1 if cache is stale or cold.
 */
export async function getCachedSnapshot(db: D1Database): Promise<{ json: string; etag: string }> {
  const stale = Date.now() - cachedAt > CACHE_TTL_MS;
  if (!cachedSnapshotJson || !cachedETag || stale) {
    const [state, repos, heatmap] = await Promise.all([
      buildSnapshot(db),
      buildRepos(db),
      buildHeatmap(db),
    ]);

    const combined: CombinedDashboardPayload = { state, repos, heatmap: { days: heatmap } };
    const json = JSON.stringify(combined);

    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    cachedSnapshotJson = json;
    cachedETag = `W/"sha256-${hashHex.slice(0, 16)}"`;
    cachedAt = Date.now();
  }
  return { json: cachedSnapshotJson!, etag: cachedETag! };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const stateRoutes = new Hono<{ Bindings: Env }>();

stateRoutes.get("/api/state", async (c) => {
  const db = c.env.CORTEX_DB;
  const project = c.req.query("project");
  // IAW D.5.2 — `?home_principal=<id>` slices the snapshot to a single
  // originating principal. Sentinel `"local"` means "null home_principal
  // only" (purely local traffic, no federated stamps) and matches the
  // dashboard's default filter chip.
  const homePrincipal = c.req.query("home_principal");

  // Project-filtered or principal-filtered requests bypass cache (rare).
  // The cache key would need to grow per-(project, home_principal) tuple
  // otherwise; not worth the complexity for the slow path.
  if (project || homePrincipal) {
    const snapshot = await buildSnapshot(db, project, homePrincipal);
    return c.json(snapshot);
  }

  // Legacy endpoint: serve state portion from cache, no ETag
  // (ETag is on the combined /api/dashboard payload — using it here would be
  // a semantic mismatch since this returns only the state slice)
  const { json } = await getCachedSnapshot(db);
  // The `as CombinedDashboardPayload` below is an UNCHECKED assertion — it
  // gives `.state` a type for this one call site, but TypeScript does NOT
  // verify the parsed JSON actually has this shape; a genuine
  // producer↔consumer drift would compile silently here. The real
  // compile-time link is above, in `getCachedSnapshot()`:
  // `const combined: CombinedDashboardPayload = { state, repos, heatmap: {
  // days: heatmap } }` fails to compile the moment `buildSnapshot()`'s
  // return type drifts from `DashboardSnapshot`. That guard only fires under
  // THIS FILE'S OWN `bunx tsc` — the worker has its own tsconfig, and the
  // root tsconfig (the one CI actually runs) excludes `src/surface/mc/worker`
  // entirely, so nothing currently runs the worker's tsc in CI (see the
  // follow-up issue tracking this gap). `dashboardRoutes.ts`'s
  // `/api/dashboard`, by contrast, returns `new Response(json, {...})`
  // straight from the cache (dashboard.ts:13-23) — it never touches `.state`
  // and has no equivalent gap.
  const combined = JSON.parse(json) as CombinedDashboardPayload;
  return c.json(combined.state);
});

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

async function getActiveAgents(
  db: D1Database,
  project?: string | null,
  homePrincipal?: string | null,
): Promise<AgentTile[]> {
  let sql = `
    SELECT session_id, principal_id, agent_id, agent_name, project, description,
           github_issue, started_at, completed_at, duration_ms, status, pr_url,
           events_count, last_event, last_event_at, progress_completed, progress_total,
           input_tokens, output_tokens, cache_read_tokens, cost_usd,
           classification, data_residency, home_principal,
           parent_session_id, substrate
    FROM sessions
    WHERE (status = 'active' AND last_event_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours'))
      OR (status IN ('completed', 'failed') AND completed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'))
  `;
  const params: unknown[] = [];

  if (project) {
    sql += ` AND project = ?`;
    params.push(project);
  }

  const homeFilter = applyHomePrincipalFilter(homePrincipal);
  sql += homeFilter.sql;
  params.push(...homeFilter.params);

  sql += ` ORDER BY started_at DESC`;

  const { results } = await db.prepare(sql).bind(...params).all();

  // G-410: Batch-fetch activity for all returned sessions
  const sessionIds = (results ?? []).map((r: Record<string, unknown>) => r.session_id as string);
  const activityMap = await getSessionActivities(db, sessionIds);

  return (results ?? []).map((r: Record<string, unknown>) => ({
    id: r.agent_id as string,
    name: r.agent_name as string,
    principalId: r.principal_id as string | null,
    // IAW D.5.3 — surface sovereignty + homePrincipal on each agent card.
    // `homePrincipal` defaults to null (purely local traffic); the frontend
    // renders nothing rather than a "local" chip for the null case so the
    // 99% pre-IAW path stays visually unchanged.
    homePrincipal: (r.home_principal as string | null) ?? null,
    sovereignty: buildSovereignty(r),
    status: r.status === "active" ? "active" as const : "completed" as const,
    currentTask: {
      sessionId: r.session_id as string,
      agentId: r.agent_id as string,
      agentName: r.agent_name as string,
      project: r.project as string | null,
      description: r.description as string,
      githubIssue: r.github_issue as string | null,
      startedAt: r.started_at as string,
      eventsCount: r.events_count as number,
      lastEvent: r.last_event as string,
      lastEventAt: r.last_event_at as string,
      progress: r.progress_total
        ? { completed: r.progress_completed as number, total: r.progress_total as number }
        : null,
      activity: activityMap.get(r.session_id as string) ?? [],
      usage: r.input_tokens != null
        ? {
            inputTokens: r.input_tokens as number,
            outputTokens: r.output_tokens as number,
            cacheReadTokens: r.cache_read_tokens as number | undefined,
            costUsd: r.cost_usd as number | undefined,
          }
        : undefined,
      status: r.status as "active" | "completed" | "failed",
      completedAt: r.completed_at as string | undefined,
      durationMs: r.duration_ms as number | null | undefined,
      // ST-P4 — the session-tree edge + substrate, surfaced per active session
      // (lifecycle metadata only — ADR-0005). The tree itself is assembled at
      // the snapshot level (buildSessionTree) from these same rows.
      parentSessionId: (r.parent_session_id as string | null) ?? null,
      substrate: (r.substrate as string | null) ?? "claude-code",
    },
  }));
}

/**
 * ST-P4 — assemble the cloud session tree from the active-agent session rows.
 *
 * The cloud `agents` array is already SESSION-keyed (one entry per active
 * session, via `currentTask.sessionId`); this folds those same sessions into
 * the `initiated-by` forest the dashboard renders, using the SHARED pure
 * assembler (byte-identical to the local copy — see `lib/session-tree.ts`).
 *
 * Lifecycle metadata ONLY (ADR-0005: cloud never holds session interiors). A
 * child whose parent is outside the active window surfaces as a root (the
 * assembler's orphaned-parent rule), never dropped.
 */
function buildSessionTree(
  agents: Array<{
    status: "active" | "completed";
    currentTask: {
      sessionId: string;
      agentName: string;
      startedAt: string;
      completedAt?: string;
      parentSessionId: string | null;
      substrate: string;
    };
  }>
): SessionTreeNode[] {
  return assembleSessionTree(
    agents.map((a) => ({
      session_id: a.currentTask.sessionId,
      parent_session_id: a.currentTask.parentSessionId,
      substrate: a.currentTask.substrate,
      state: a.status,
      started_at: a.currentTask.startedAt,
      ended_at: a.currentTask.completedAt ?? null,
      agent_name: a.currentTask.agentName,
    }))
  );
}

/**
 * IAW D.5.2 — translate the `home_principal` query param into a parameterised
 * SQL fragment for chaining onto a `sessions` WHERE clause.
 *
 *   - `undefined` / `null` / `""` → no slicing (snapshot covers all rows).
 *   - `"local"`                   → `home_principal IS NULL` (purely local
 *                                   traffic, the dashboard default chip).
 *   - any other string            → `home_principal = ?` (specific principal).
 *
 * Returns `{ sql, params }` rather than mutating in place so the caller's
 * SELECT is constructible without hidden side-effects on a shared array.
 *
 * Echo cortex#224 round 1 — extracted to fold three (and eventually more)
 * `getActiveAgents` / `getRecentCompletions` / future-helper copies through
 * one place. Adding `"federated"` (all stamped traffic) or `"public"` (a
 * specific classification cut) becomes a one-file change.
 */
function applyHomePrincipalFilter(homePrincipal?: string | null): {
  sql: string;
  params: unknown[];
} {
  if (homePrincipal === "local") {
    return { sql: ` AND home_principal IS NULL`, params: [] };
  }
  if (homePrincipal) {
    return { sql: ` AND home_principal = ?`, params: [homePrincipal] };
  }
  return { sql: "", params: [] };
}

/**
 * IAW D.5.3 — build the snapshot's `sovereignty` block from a session row.
 * Returns `null` when none of the three sovereignty fields are populated so
 * the frontend can fast-path the "pre-IAW row, render nothing" case without
 * a per-field truthy check.
 */
function buildSovereignty(r: Record<string, unknown>): SovereigntyInfo | null {
  const classification = r.classification as Classification | null | undefined;
  const dataResidency = r.data_residency as string | null | undefined;
  const homePrincipal = r.home_principal as string | null | undefined;
  if (classification == null && dataResidency == null && homePrincipal == null) {
    return null;
  }
  return {
    classification: classification ?? null,
    dataResidency: dataResidency ?? null,
    homePrincipal: homePrincipal ?? null,
  };
}

/** G-410: Fetch last 50 activity entries for each session ID. */
async function getSessionActivities(
  db: D1Database,
  sessionIds: string[],
): Promise<Map<string, SessionActivityEntry[]>> {
  const map = new Map<string, SessionActivityEntry[]>();
  if (sessionIds.length === 0) return map;

  // D1 doesn't support WHERE IN with bound arrays easily, so batch manually
  // For a small number of sessions (typically <10), individual queries are fine
  await Promise.all(sessionIds.map(async (sid) => {
    const { results } = await db.prepare(`
      SELECT timestamp, icon, label, detail
      FROM session_activity
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT 50
    `).bind(sid).all();

    if (results && results.length > 0) {
      // Reverse so oldest is first (matches local dashboard order)
      map.set(sid, (results as Array<Record<string, unknown>>).reverse().map((r) => ({
        timestamp: r.timestamp as string,
        icon: r.icon as string,
        label: r.label as string,
        detail: r.detail as string,
      })));
    }
  }));

  return map;
}

async function getRecentCompletions(
  db: D1Database,
  project?: string | null,
  limit = 50,
  homePrincipal?: string | null,
): Promise<RecentCompletionItem[]> {
  let sql = `
    SELECT agent_id, agent_name, principal_id, project, description, duration_ms,
           completed_at, pr_url, github_issue, status,
           classification, data_residency, home_principal
    FROM sessions
    WHERE status IN ('completed', 'failed')
  `;
  const params: unknown[] = [];

  if (project) {
    sql += ` AND project = ?`;
    params.push(project);
  }

  const homeFilter = applyHomePrincipalFilter(homePrincipal);
  sql += homeFilter.sql;
  params.push(...homeFilter.params);

  sql += ` ORDER BY completed_at DESC LIMIT ?`;
  params.push(limit);

  const { results } = await db.prepare(sql).bind(...params).all();

  return (results ?? []).map((r: Record<string, unknown>) => ({
    agentId: r.agent_id as string,
    agentName: r.agent_name as string,
    principalId: r.principal_id as string | null,
    project: r.project as string | null,
    description: r.description as string,
    durationMs: r.duration_ms as number | null,
    completedAt: r.completed_at as string,
    prUrl: r.pr_url as string | null,
    githubIssue: r.github_issue as string | null,
    status: r.status as "completed" | "failed",
    // IAW D.5.3 — sovereignty surface on completions row.
    homePrincipal: (r.home_principal as string | null) ?? null,
    sovereignty: buildSovereignty(r),
  }));
}

/**
 * IAW D.5.2 — return the distinct, non-null `home_principal` values seen in
 * recent sessions. Powers the dashboard's principal filter dropdown — the
 * frontend prepends "Local only" (default) + "All principals" to this list.
 *
 * Window: same 7-day horizon the heatmap uses, so the dropdown doesn't grow
 * unboundedly with historical federated peers that have gone dark.
 */
async function getKnownHomePrincipals(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(`
    SELECT DISTINCT home_principal
    FROM sessions
    WHERE home_principal IS NOT NULL
      AND (last_event_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
           OR completed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days'))
    ORDER BY home_principal ASC
  `).all();
  return (results ?? []).map((r) => r.home_principal as string);
}

async function getRecentActivity(
  db: D1Database,
  project?: string | null,
  limit = 500,
): Promise<ActivityFeedItem[]> {
  // Merge session completions and GitHub events into one timeline
  const [completions, githubEvents] = await Promise.all([
    getRecentCompletions(db, project, limit),
    getRecentGitHubEvents(db, project, limit),
  ]);

  const items: ActivityFeedItem[] = [];

  for (const c of completions) {
    items.push({
      type: c.status === "completed" ? "task_completed" : "task_failed",
      source: "session",
      timestamp: c.completedAt,
      agentId: c.agentId,
      agentName: c.agentName,
      project: c.project,
      description: c.description,
      durationMs: c.durationMs,
      prUrl: c.prUrl,
      githubIssue: c.githubIssue,
      status: c.status,
    });
  }

  for (const g of githubEvents) {
    items.push({
      type: g.eventType,
      source: "github",
      timestamp: g.createdAt,
      repo: g.repo,
      title: g.title,
      number: g.number,
      url: g.url,
      author: g.author,
      agentAuthored: g.agentAuthored,
    });
  }

  // Sort by timestamp descending
  items.sort((a, b) =>
    new Date(b.timestamp as string).getTime() - new Date(a.timestamp as string).getTime()
  );

  return items.slice(0, limit);
}

interface GithubEventRow {
  eventId: string;
  repo: string;
  eventType: GithubEventType;
  title: string | null;
  number: number | null;
  url: string | null;
  author: string | null;
  agentAuthored: boolean;
  linkedSession: string | null;
  payload: string | null;
  createdAt: string;
  receivedAt: string;
}

async function getRecentGitHubEvents(
  db: D1Database,
  project?: string | null,
  limit = 100,
): Promise<GithubEventRow[]> {
  let sql = `
    SELECT event_id, repo, event_type, title, number, url, author,
           agent_authored, linked_session, payload, created_at, received_at
    FROM github_events
  `;
  const params: unknown[] = [];

  if (project) {
    sql += ` WHERE (repo = ? OR SUBSTR(repo, INSTR(repo, '/') + 1) = ?)`;
    params.push(project, project);
  }

  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const { results } = await db.prepare(sql).bind(...params).all();

  return (results ?? []).map((r: Record<string, unknown>) => ({
    eventId: r.event_id as string,
    repo: r.repo as string,
    eventType: r.event_type as GithubEventType,
    title: r.title as string | null,
    number: r.number as number | null,
    url: r.url as string | null,
    author: r.author as string | null,
    agentAuthored: (r.agent_authored as number) === 1,
    linkedSession: r.linked_session as string | null,
    payload: r.payload as string | null,
    createdAt: r.created_at as string,
    receivedAt: r.received_at as string,
  }));
}

async function getDailyStats(db: D1Database, date?: string): Promise<DailyStats> {
  const day = date ?? new Date().toISOString().slice(0, 10);

  const [sessionsResult, prsResult, issuesResult, pushResult] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) as count FROM sessions
       WHERE status = 'completed' AND completed_at >= ? AND completed_at < date(?, '+1 day')`
    ).bind(day, day).first<{ count: number }>(),

    db.prepare(
      `SELECT COUNT(*) as count FROM github_events
       WHERE event_type = 'pr_merged' AND created_at >= ? AND created_at < date(?, '+1 day')`
    ).bind(day, day).first<{ count: number }>(),

    db.prepare(
      `SELECT COUNT(*) as count FROM github_events
       WHERE event_type = 'issue_closed' AND created_at >= ? AND created_at < date(?, '+1 day')`
    ).bind(day, day).first<{ count: number }>(),

    db.prepare(
      `SELECT COALESCE(SUM(json_extract(payload, '$.commits')), 0) as commits,
              COALESCE(SUM(json_extract(payload, '$.filesChanged')), 0) as files
       FROM github_events
       WHERE event_type = 'push' AND created_at >= ? AND created_at < date(?, '+1 day')`
    ).bind(day, day).first<{ commits: number; files: number }>(),
  ]);

  return {
    prsMerged: prsResult?.count ?? 0,
    issuesClosed: issuesResult?.count ?? 0,
    commits: pushResult?.commits ?? 0,
    filesChanged: pushResult?.files ?? 0,
    sessionsCompleted: sessionsResult?.count ?? 0,
  };
}

async function getProjects(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(`
    SELECT short_name AS name FROM repos ORDER BY short_name
  `).all();

  return (results ?? []).map((r: Record<string, unknown>) => r.name as string);
}

async function getLatestAccountUsage(db: D1Database): Promise<UsageSnapshotInfo | null> {
  const row = await db.prepare(`
    SELECT source, five_hour_pct, five_hour_resets, seven_day_pct, seven_day_resets,
           seven_day_opus_pct, seven_day_sonnet_pct, extra_usage_enabled, recorded_at
    FROM usage_snapshots
    ORDER BY recorded_at DESC
    LIMIT 1
  `).first<{
    source: string;
    five_hour_pct: number | null;
    five_hour_resets: string | null;
    seven_day_pct: number | null;
    seven_day_resets: string | null;
    seven_day_opus_pct: number | null;
    seven_day_sonnet_pct: number | null;
    extra_usage_enabled: number | null;
    recorded_at: string;
  }>();

  if (!row) return null;

  return {
    fiveHour: row.five_hour_pct != null
      ? { utilization: row.five_hour_pct, resetsAt: row.five_hour_resets ?? "" }
      : null,
    sevenDay: row.seven_day_pct != null
      ? { utilization: row.seven_day_pct, resetsAt: row.seven_day_resets ?? "" }
      : null,
    sevenDayOpus: row.seven_day_opus_pct != null
      ? { utilization: row.seven_day_opus_pct, resetsAt: "" }
      : null,
    sevenDaySonnet: row.seven_day_sonnet_pct != null
      ? { utilization: row.seven_day_sonnet_pct, resetsAt: "" }
      : null,
    extraUsage: row.extra_usage_enabled != null
      ? { isEnabled: row.extra_usage_enabled === 1, monthlyLimit: null, usedCredits: null }
      : null,
    updatedAt: row.recorded_at,
  };
}

async function getPerPrincipalUsage(db: D1Database): Promise<Record<string, UsageSnapshotInfo>> {
  const { results } = await db.prepare(`
    SELECT u.principal_id, u.source, u.five_hour_pct, u.five_hour_resets,
           u.seven_day_pct, u.seven_day_resets, u.seven_day_opus_pct,
           u.seven_day_sonnet_pct, u.extra_usage_enabled, u.recorded_at
    FROM usage_snapshots u
    INNER JOIN (
      SELECT principal_id, MAX(recorded_at) as max_recorded
      FROM usage_snapshots
      WHERE principal_id IS NOT NULL
      GROUP BY principal_id
    ) latest ON u.principal_id = latest.principal_id AND u.recorded_at = latest.max_recorded
  `).all();

  const map: Record<string, UsageSnapshotInfo> = {};
  for (const row of results ?? []) {
    const principalId = row.principal_id as string;
    map[principalId] = formatUsageRow(row);
  }
  return map;
}

function formatUsageRow(row: Record<string, unknown>): UsageSnapshotInfo {
  return {
    fiveHour: (row.five_hour_pct as number | null) != null
      ? { utilization: row.five_hour_pct as number, resetsAt: (row.five_hour_resets as string) ?? "" }
      : null,
    sevenDay: (row.seven_day_pct as number | null) != null
      ? { utilization: row.seven_day_pct as number, resetsAt: (row.seven_day_resets as string) ?? "" }
      : null,
    sevenDayOpus: (row.seven_day_opus_pct as number | null) != null
      ? { utilization: row.seven_day_opus_pct as number, resetsAt: "" }
      : null,
    sevenDaySonnet: (row.seven_day_sonnet_pct as number | null) != null
      ? { utilization: row.seven_day_sonnet_pct as number, resetsAt: "" }
      : null,
    extraUsage: (row.extra_usage_enabled as number | null) != null
      ? { isEnabled: (row.extra_usage_enabled as number) === 1, monthlyLimit: null, usedCredits: null }
      : null,
    updatedAt: row.recorded_at as string,
  };
}
