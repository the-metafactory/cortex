/**
 * S6 (#1520) — allow-list SHAPE guard for the `DashboardSnapshot` contract
 * (the public, unauthenticated `/api/state` / `/api/dashboard` projection).
 *
 * cortex#1520 set out to unify the worker's `/api/state` shape with a "local
 * assembly" — no such local combined-snapshot endpoint exists (cortex's local
 * dashboard serves granular REST + WS projections instead; see #1520). S6 is
 * retargeted to the worker's own producer↔consumer contract: one exported
 * `DashboardSnapshot` type (`routes/state.ts`) both `buildSnapshot()` and the
 * `/api/state` route are checked against, plus this test.
 *
 * WHAT THIS TEST ACTUALLY CHECKS, PRECISELY (deliberately under-claiming):
 *
 *   (a) KEY SHAPE, not VALUES. It asserts which field NAMES may appear at
 *       each position in the payload — never that a field's CONTENT is safe.
 *       `description` and `detail` are allow-listed (see below); this test
 *       does not, and cannot, check what's actually inside them on a given
 *       run.
 *   (b) Does NOT re-verify upstream sanitization. `sessions.description`
 *       (up to a 200-char preview of the triggering prompt, truncated in
 *       `EventLogger.hook.ts` and further cleaned by `sanitizeDescription()`
 *       in `common/event-processor.ts`) and `session_activity.detail` (G-410,
 *       a per-event-type summary built by `extractActivityEntry()` in
 *       `common/event-utils.ts`, e.g. "Editing foo.ts" or a redacted,
 *       100-char-capped command preview) are both ingest-time-sanitized
 *       VALUES, allow-listed here by KEY. Their sanitization runs entirely
 *       upstream of `state.ts`; this file never re-checks that work.
 *   (c) Column-backed fields are guarded UNCONDITIONALLY. The schema
 *       allow-list (`ALLOWED_COLUMNS`) reads `schema.sql` directly — a new
 *       column on any of the 4 tables `buildSnapshot()` reads fails this test
 *       regardless of whether any query or fixture ever touches it.
 *   (d) DTO fields are guarded ONLY where the fixture actually populates
 *       them. The shape walk is `Object.keys(obj)` on ONE seeded snapshot;
 *       a conditionally-computed field (e.g. `currentTask.usage`,
 *       `agent.sovereignty`, a nested `sessionTree[].children[]` entry) is
 *       only checked on runs where that branch's precondition is met. The
 *       fixture (below) forces every such branch present at least once —
 *       see the "sanity" assertions in the main test, which assert the
 *       fixture itself, not just the walker, exercised each one. A field
 *       this fixture never triggers would still pass silently.
 *
 * `github_events.payload` — present in `ALLOWED_COLUMNS.github_events` below
 * — IS a real JSON-blob column, written by `common/github-events.ts`'s
 * webhook processors (small, curated GitHub metadata: e.g.
 * `{branch, base, additions, deletions, changedFiles}` for a PR; never a raw
 * webhook body, and not session interior). `getRecentGitHubEvents` SELECTs it
 * into the internal `GithubEventRow.payload` field, but `getRecentActivity`'s
 * mapping to the public `ActivityFeedItem` github arm never references it —
 * `ACTIVITY_GITHUB_KEYS` (below) omits it on purpose.
 *
 * ADR-0005 / CONTEXT.md "Session interior": tool calls and their
 * arguments/outputs, prompts, file edits, skill invocations, and sub-agent
 * spawns never leave `local.` scope. This test's schema + DTO allow-lists are
 * ONE way that boundary gets enforced on the cloud side — not the only one,
 * and (per (a)/(b) above) not a value-level guarantee.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, type DashboardSnapshot } from "../routes/state";
import { d1, loadSchema, WORKER_DIR } from "./d1-shim";

// ---------------------------------------------------------------------------
// Schema allow-list — one entry per table `buildSnapshot()` reads, listing
// every column that table's `CREATE TABLE` declares (schema.sql). Growing
// the schema requires growing this list — a conscious edit, not a silent
// pass.
// ---------------------------------------------------------------------------

const ALLOWED_COLUMNS: Record<string, string[]> = {
  sessions: [
    "session_id", "principal_id", "agent_id", "agent_name", "project",
    "description", "github_issue", "started_at", "completed_at",
    "duration_ms", "status", "pr_url", "events_count", "last_event",
    "last_event_at", "progress_completed", "progress_total", "input_tokens",
    "output_tokens", "cache_read_tokens", "cost_usd", "classification",
    "data_residency", "home_principal", "parent_session_id", "substrate",
    // CK-4a / #1295 — the cross-stack origin the workingAggregation groups by.
    "origin_stack_id",
  ],
  session_activity: ["id", "session_id", "timestamp", "icon", "label", "detail"],
  // `payload` IS a raw-JSON-blob column (see the file header) — it exists,
  // it's here, it's read by `getRecentGitHubEvents`. It never reaches the
  // public DTO though: `getRecentActivity`'s github-arm mapping doesn't
  // reference it, and `ACTIVITY_GITHUB_KEYS` below omits it on purpose.
  github_events: [
    "id", "event_id", "principal_id", "repo", "event_type", "title",
    "number", "url", "author", "agent_authored", "linked_session",
    "payload", "created_at", "received_at",
  ],
  usage_snapshots: [
    "id", "principal_id", "source", "five_hour_pct", "five_hour_resets",
    "seven_day_pct", "seven_day_resets", "seven_day_opus_pct",
    "seven_day_sonnet_pct", "extra_usage_enabled", "recorded_at",
  ],
};

/**
 * Extract column names for one `CREATE TABLE IF NOT EXISTS <table> (...)`
 * block in `schema.sql`. Good enough for this schema's actual shape (verified
 * against all 4 tables `buildSnapshot()` reads): every column is one line,
 * `<name> <TYPE...>[, -- comment]`; no separate constraint-only lines
 * (PRIMARY KEY / UNIQUE are always inline on a column, never their own line)
 * on any of those 4 tables.
 */
function columnNamesForTable(schemaSql: string, table: string): string[] {
  const match = new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`,
  ).exec(schemaSql);
  if (!match) {
    throw new Error(
      `schema.sql: could not parse "${table}" — this parser assumes one column per ` +
      `line ending in a standalone "\\n);" on its own line, with no standalone ` +
      `constraint-only lines (CHECK/FOREIGN KEY/UNIQUE(...) as their own line). ` +
      `Either the table is missing/renamed, or its DDL no longer matches that shape.`,
    );
  }
  return match[1]!
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"))
    .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1])
    .filter((name): name is string => !!name);
}

// ---------------------------------------------------------------------------
// DTO allow-list — one Set per section type in `DashboardSnapshot`, matching
// `routes/state.ts`'s exported interfaces field-for-field. `description` is
// deliberately present on every section that carries it — the accepted,
// sanitized prompt-preview exception documented above.
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = new Set([
  "projects", "agents", "sessionTree", "recentCompletions", "recentActivity",
  "stats", "accountUsage", "principalUsage", "homePrincipals",
  // CK-4a / #1295 — cross-stack WORKING metadata rollup.
  "workingAggregation", "updatedAt",
]);
// CK-4a / #1295 — the workingAggregation section is metadata ONLY: an origin id,
// two counts, and a provider-retry hint. NO session id / interior may appear here
// (the cross-stack half of the no-interiors guard — see the file header + the
// db/working-aggregation.ts scope boundary).
const WORKING_ROLLUP_KEYS = new Set([
  "originStackId", "activeSessionCount", "subAgentCount", "providerRetry",
]);
const PROVIDER_RETRY_KEYS = new Set(["state", "retryAfterMs"]);
const PROJECT_KEYS = new Set(["id", "displayName"]);
const AGENT_TILE_KEYS = new Set([
  "id", "name", "principalId", "homePrincipal", "sovereignty", "status", "currentTask",
]);
const AGENT_CURRENT_TASK_KEYS = new Set([
  "sessionId", "agentId", "agentName", "project", "description", "githubIssue",
  "startedAt", "eventsCount", "lastEvent", "lastEventAt", "progress", "activity",
  "usage", "status", "completedAt", "durationMs", "parentSessionId", "substrate",
]);
const SOVEREIGNTY_KEYS = new Set(["classification", "dataResidency", "homePrincipal"]);
const PROGRESS_KEYS = new Set(["completed", "total"]);
const TASK_USAGE_KEYS = new Set(["inputTokens", "outputTokens", "cacheReadTokens", "costUsd"]);
const SESSION_ACTIVITY_KEYS = new Set(["timestamp", "icon", "label", "detail"]);
const SESSION_TREE_NODE_KEYS = new Set([
  "session_id", "parent_session_id", "substrate", "state", "started_at",
  "ended_at", "agent_name", "task_title", "children",
]);
const RECENT_COMPLETION_KEYS = new Set([
  "agentId", "agentName", "principalId", "project", "description", "durationMs",
  "completedAt", "prUrl", "githubIssue", "status", "homePrincipal", "sovereignty",
]);
const ACTIVITY_SESSION_KEYS = new Set([
  "type", "source", "timestamp", "agentId", "agentName", "project", "description",
  "durationMs", "prUrl", "githubIssue", "status",
]);
// Deliberately excludes `payload` — the raw-JSON-blob github_events column
// exists (`ALLOWED_COLUMNS.github_events` above) and IS read into
// `GithubEventRow.payload`, but `getRecentActivity`'s mapping never forwards
// it into this shape. If a future change starts spreading `GithubEventRow`
// into the DTO instead of naming fields, `payload` showing up here is exactly
// the regression this allow-list is meant to catch.
const ACTIVITY_GITHUB_KEYS = new Set([
  "type", "source", "timestamp", "repo", "title", "number", "url", "author", "agentAuthored",
]);
const STATS_KEYS = new Set(["today"]);
const DAILY_STATS_KEYS = new Set(["prsMerged", "issuesClosed", "commits", "filesChanged", "sessionsCompleted"]);
const USAGE_SNAPSHOT_KEYS = new Set(["fiveHour", "sevenDay", "sevenDayOpus", "sevenDaySonnet", "extraUsage", "updatedAt"]);
const USAGE_QUOTA_KEYS = new Set(["utilization", "resetsAt"]);
const EXTRA_USAGE_KEYS = new Set(["isEnabled", "monthlyLimit", "usedCredits"]);

/**
 * Assert every key on `obj` is in `allowed` — the allow-list primitive every
 * check below uses.
 *
 * bun:test's `expect(...).toEqual(...)` takes no separate failure-message
 * argument, so a bare `expect(unexpected).toEqual([])` would fail with just
 * the leaked key names and no indication of WHICH position in the snapshot
 * they came from (this function gets called ~15 times per test run, at
 * different positions). Wrapping `label` into both sides of the comparison
 * puts it in the failure diff for free — a cheap way to attach context bun's
 * `expect` doesn't otherwise support.
 */
function assertKeysAllowed(obj: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unexpected = Object.keys(obj).filter((k) => !allowed.has(k));
  expect([label, unexpected]).toEqual([label, []]);
}

function assertUsageSnapshot(u: Record<string, unknown>, label: string): void {
  assertKeysAllowed(u, USAGE_SNAPSHOT_KEYS, label);
  for (const quota of ["fiveHour", "sevenDay", "sevenDayOpus", "sevenDaySonnet"] as const) {
    const v = u[quota];
    if (v) assertKeysAllowed(v as Record<string, unknown>, USAGE_QUOTA_KEYS, `${label}.${quota}`);
  }
  if (u.extraUsage) assertKeysAllowed(u.extraUsage as Record<string, unknown>, EXTRA_USAGE_KEYS, `${label}.extraUsage`);
}

function assertSessionTreeNode(node: Record<string, unknown>, label: string): void {
  assertKeysAllowed(node, SESSION_TREE_NODE_KEYS, label);
  for (const child of (node.children as Record<string, unknown>[] | undefined) ?? []) {
    assertSessionTreeNode(child, `${label}.children[]`);
  }
}

/**
 * Walk a real `DashboardSnapshot` and assert every object's keys, at every
 * position, are in that position's allow-list. Positional (not a flat global
 * scan) — a key name that's legitimate in one section can't accidentally
 * "cover for" the same name leaking somewhere it doesn't belong.
 */
function assertSnapshotShape(snapshot: DashboardSnapshot): void {
  assertKeysAllowed(snapshot as unknown as Record<string, unknown>, TOP_LEVEL_KEYS, "DashboardSnapshot");

  for (const p of snapshot.projects) assertKeysAllowed(p, PROJECT_KEYS, "projects[]");

  for (const agent of snapshot.agents) {
    assertKeysAllowed(agent as unknown as Record<string, unknown>, AGENT_TILE_KEYS, "agents[]");
    if (agent.sovereignty) {
      assertKeysAllowed(agent.sovereignty as unknown as Record<string, unknown>, SOVEREIGNTY_KEYS, "agents[].sovereignty");
    }
    const task = agent.currentTask;
    assertKeysAllowed(task as unknown as Record<string, unknown>, AGENT_CURRENT_TASK_KEYS, "agents[].currentTask");
    if (task.progress) assertKeysAllowed(task.progress, PROGRESS_KEYS, "agents[].currentTask.progress");
    if (task.usage) assertKeysAllowed(task.usage, TASK_USAGE_KEYS, "agents[].currentTask.usage");
    for (const a of task.activity) {
      assertKeysAllowed(a as unknown as Record<string, unknown>, SESSION_ACTIVITY_KEYS, "agents[].currentTask.activity[]");
    }
  }

  for (const node of snapshot.sessionTree) {
    assertSessionTreeNode(node as unknown as Record<string, unknown>, "sessionTree[]");
  }

  for (const rc of snapshot.recentCompletions) {
    assertKeysAllowed(rc as unknown as Record<string, unknown>, RECENT_COMPLETION_KEYS, "recentCompletions[]");
    if (rc.sovereignty) {
      assertKeysAllowed(rc.sovereignty as unknown as Record<string, unknown>, SOVEREIGNTY_KEYS, "recentCompletions[].sovereignty");
    }
  }

  for (const item of snapshot.recentActivity) {
    if (item.source === "session") {
      assertKeysAllowed(item as unknown as Record<string, unknown>, ACTIVITY_SESSION_KEYS, "recentActivity[] (session)");
    } else {
      assertKeysAllowed(item as unknown as Record<string, unknown>, ACTIVITY_GITHUB_KEYS, "recentActivity[] (github)");
    }
  }

  assertKeysAllowed(snapshot.stats, STATS_KEYS, "stats");
  assertKeysAllowed(snapshot.stats.today as unknown as Record<string, unknown>, DAILY_STATS_KEYS, "stats.today");

  if (snapshot.accountUsage) {
    assertUsageSnapshot(snapshot.accountUsage as unknown as Record<string, unknown>, "accountUsage");
  }
  for (const [principalId, usage] of Object.entries(snapshot.principalUsage)) {
    assertUsageSnapshot(usage as unknown as Record<string, unknown>, `principalUsage[${principalId}]`);
  }

  // CK-4a / #1295 — the cross-stack WORKING rollup: metadata-only, no interiors.
  for (const rollup of snapshot.workingAggregation) {
    assertKeysAllowed(rollup as unknown as Record<string, unknown>, WORKING_ROLLUP_KEYS, "workingAggregation[]");
    if (rollup.providerRetry) {
      assertKeysAllowed(
        rollup.providerRetry as unknown as Record<string, unknown>,
        PROVIDER_RETRY_KEYS,
        "workingAggregation[].providerRetry",
      );
    }
  }
}

describe("DashboardSnapshot allow-list SHAPE guard for the public /api/state projection (S6, #1520)", () => {
  const schemaSql = readFileSync(join(WORKER_DIR, "schema.sql"), "utf8");

  it.each(Object.keys(ALLOWED_COLUMNS))(
    "schema allow-list: %s has only known columns",
    (table: string) => {
      const columns = columnNamesForTable(schemaSql, table);
      expect(columns.length).toBeGreaterThan(0); // sanity: the parser actually found columns
      const allowed = new Set(ALLOWED_COLUMNS[table]);
      const unexpected = columns.filter((c) => !allowed.has(c));
      expect(unexpected).toEqual([]);
    },
  );

  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    loadSchema(db);
  });
  afterEach(() => db.close());

  /** Seed one active session with every lifecycle field populated. */
  function seedFullSession(db: Database, sessionId: string): void {
    db.query(
      `INSERT INTO sessions
         (session_id, principal_id, agent_id, agent_name, project, description,
          github_issue, started_at, last_event, last_event_at, status,
          progress_completed, progress_total, input_tokens, output_tokens,
          cache_read_tokens, cost_usd, classification, data_residency,
          home_principal, parent_session_id, substrate)
       VALUES (?, 'andreas', 'luna', 'Luna', 'cortex', 'Ship the snapshot contract',
               '1520', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'tool.file.changed',
               strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active',
               3, 10, 1200, 340, 900, 0.42, 'federated', 'eu',
               'andreas', NULL, 'claude-code')`
    ).run(sessionId);
  }

  /** Seed one COMPLETED session — the shape `recentCompletions` and the
   * "session" arm of `recentActivity` both project from. */
  function seedCompletedSession(db: Database, sessionId: string): void {
    db.query(
      `INSERT INTO sessions
         (session_id, principal_id, agent_id, agent_name, project, description,
          github_issue, started_at, completed_at, duration_ms, pr_url, status,
          last_event, last_event_at, classification, data_residency, home_principal,
          parent_session_id, substrate)
       VALUES (?, 'andreas', 'luna', 'Luna', 'cortex', 'Ship the snapshot contract',
               '1520', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'),
               strftime('%Y-%m-%dT%H:%M:%fZ','now'), 4200,
               'https://github.com/the-metafactory/cortex/pull/1537', 'completed',
               'agent.task.completed', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               'federated', 'eu', 'andreas', NULL, 'claude-code')`
    ).run(sessionId);
  }

  /**
   * Seed one ACTIVE session that is a CHILD of `parentSessionId` — the only
   * way to force `sessionTree[].children[]` non-empty, so
   * `assertSessionTreeNode`'s recursive branch actually runs at least once.
   */
  function seedChildSession(db: Database, sessionId: string, parentSessionId: string): void {
    db.query(
      `INSERT INTO sessions
         (session_id, agent_id, agent_name, started_at, last_event, last_event_at,
          status, parent_session_id, substrate)
       VALUES (?, 'echo', 'Echo', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               'agent.task.started', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               'active', ?, 'claude-code')`
    ).run(sessionId, parentSessionId);
  }

  it("builds a snapshot whose shape matches the per-section allow-list, everywhere", async () => {
    seedFullSession(db, "s-full");
    seedCompletedSession(db, "s-done");
    seedChildSession(db, "s-child", "s-full");
    // G-410 activity: a sanitized summary — the accepted exception (see
    // file-level scope note) — never the raw tool_input/tool_output it
    // summarizes.
    db.query(
      `INSERT INTO session_activity (session_id, timestamp, icon, label, detail)
       VALUES ('s-full', strftime('%Y-%m-%dT%H:%M:%fZ','now'), '📝', 'file changed', 'Editing state.ts')`
    ).run();
    db.query(
      `INSERT INTO github_events (event_id, repo, event_type, title, number, url, author, agent_authored, created_at)
       VALUES ('gh-1', 'the-metafactory/cortex', 'pr_merged', 'S6 contract', 1520,
               'https://github.com/the-metafactory/cortex/pull/1520', 'luna', 1,
               strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run();
    db.query(
      `INSERT INTO usage_snapshots
         (principal_id, source, five_hour_pct, five_hour_resets, seven_day_pct,
          seven_day_resets, seven_day_opus_pct, seven_day_sonnet_pct, extra_usage_enabled)
       VALUES ('andreas', 'claude', 40, '2026-07-05T18:00:00Z', 12, '2026-07-12T00:00:00Z', 5, 7, 1)`
    ).run();

    const snapshot: DashboardSnapshot = await buildSnapshot(d1(db));

    // Sanity: the walk actually saw real lifecycle data — every branch the
    // walker below can take is exercised at least once, INCLUDING the
    // conditionally-computed ones: agent.sovereignty, currentTask.progress,
    // currentTask.usage, recentCompletions[].sovereignty, accountUsage + all
    // 4 usage-quota sub-objects + extraUsage, principalUsage, and (via
    // s-child) sessionTree[].children[] non-empty at least one level deep.
    // A DTO field this fixture does NOT populate would still pass silently —
    // see the file-header limits note, item (d).
    expect(snapshot.agents.length).toBeGreaterThan(0);
    expect(snapshot.agents.some((a) => a.sovereignty !== null)).toBe(true);
    expect(snapshot.agents.some((a) => a.currentTask.progress !== null)).toBe(true);
    expect(snapshot.agents.some((a) => a.currentTask.usage !== undefined)).toBe(true);
    expect(snapshot.recentCompletions.length).toBeGreaterThan(0);
    expect(snapshot.recentCompletions.some((rc) => rc.sovereignty !== null)).toBe(true);
    expect(snapshot.recentActivity.some((i) => i.source === "session")).toBe(true);
    expect(snapshot.recentActivity.some((i) => i.source === "github")).toBe(true);
    expect(snapshot.accountUsage).not.toBeNull();
    expect(snapshot.sessionTree.some((n) => n.children.length > 0)).toBe(true);
    // CK-4a — the cross-stack WORKING rollup is populated (s-full + s-child are
    // active under the null/own origin; s-child is the sub-agent), and the cloud
    // projection never carries a provider-retry (dispatch lifecycle is local-only).
    expect(snapshot.workingAggregation.length).toBeGreaterThan(0);
    const ownOrigin = snapshot.workingAggregation.find((r) => r.originStackId === null);
    expect(ownOrigin?.activeSessionCount).toBe(2);
    expect(ownOrigin?.subAgentCount).toBe(1);
    expect(snapshot.workingAggregation.every((r) => r.providerRetry === null)).toBe(true);

    assertSnapshotShape(snapshot);
  });

  it("keeps session_activity's projected shape to exactly the 4 known G-410 fields", async () => {
    seedFullSession(db, "s-detail");
    db.query(
      `INSERT INTO session_activity (session_id, timestamp, icon, label, detail)
       VALUES ('s-detail', strftime('%Y-%m-%dT%H:%M:%fZ','now'), '💻', 'command', 'echo hello')`
    ).run();

    const snapshot = await buildSnapshot(d1(db));
    const agent = snapshot.agents.find((a) => a.currentTask.sessionId === "s-detail")!;
    expect(agent.currentTask.activity).toHaveLength(1);
    expect(typeof agent.currentTask.activity[0]!.detail).toBe("string");
    expect(Object.keys(agent.currentTask.activity[0]!).sort()).toEqual(
      ["detail", "icon", "label", "timestamp"].sort()
    );
  });
});
