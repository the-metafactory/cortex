/**
 * S6 (#1520) — `DashboardSnapshot` contract: the ADR-0005 no-interiors guard.
 *
 * cortex#1520 set out to unify the worker's `/api/state` shape with a "local
 * assembly" — but no such local combined-snapshot endpoint exists (cortex's
 * local dashboard serves granular REST + WS projections instead; see the
 * escalation on #1520). S6 was retargeted to the worker's own producer↔consumer
 * contract: one exported `DashboardSnapshot` type (`routes/state.ts`) both
 * `buildSnapshot()` and the `/api/state` route are checked against, plus this
 * test.
 *
 * ADR-0005 / CONTEXT.md "Session interior": tool calls and their
 * arguments/outputs, prompts, file edits, skill invocations, and sub-agent
 * spawns never leave `local.` scope.
 *
 * CORRECTION (review round 1, Sage on #1537): the first version of this test
 * claimed to "seed rows that would carry interior-shaped data" — that wasn't
 * true. Investigation (D1 schema + the full write path: `EventLogger.hook.ts`
 * → `event-processor.ts`/`event-utils.ts` → `ingest.ts`) found:
 *
 *   - D1's schema (`schema.sql`) declares NO column for a raw tool-call
 *     argument/output object, a diff, or a message array, on ANY table
 *     `buildSnapshot()` reads (`sessions`, `session_activity`, `github_events`,
 *     `usage_snapshots`). `ingest.ts`'s INSERT statements always name bound
 *     columns explicitly — nothing ever spreads a raw event payload into a
 *     catch-all column.
 *   - The full RAW local event (`EventLogger.hook.ts`) DOES carry
 *     `payload.tool_input` / `payload.tool_output` — but that hook's own
 *     comment says "raw — relay will filter": stripping those before
 *     anything reaches this worker's `/api/ingest` is `cortex-relay`'s job,
 *     entirely outside `src/surface/mc/worker`. By the time an event reaches
 *     `event-processor.ts`, nothing there reads or persists `tool_input`/
 *     `tool_output` (the one place that inspects `tool_input`,
 *     `extractActivityEntry` in `common/event-utils.ts`, uses it only to pick
 *     a "Write" vs "Edit" label — the object itself is never stored).
 *   - Two free-text D1 columns DO carry short, ALREADY-SANITIZED derivatives
 *     of interior events, by deliberate pre-existing design — not raw
 *     interior, and not something this test (or this slice) changes:
 *       - `sessions.description` — up to a 200-char preview of the
 *         triggering prompt (`EventLogger.hook.ts`'s `preview.slice(0, 200)`
 *         → `payload.prompt_preview`), further passed through
 *         `sanitizeDescription()` (strips `toolu_*` IDs) in
 *         `event-processor.ts`. Surfaces as `agents[].currentTask.description`
 *         / `recentCompletions[].description`.
 *       - `session_activity.detail` (G-410) — a per-event-type summary built
 *         by `extractActivityEntry()`, e.g. "Editing foo.ts" or a redacted,
 *         100-char-capped command preview. Surfaces as
 *         `agents[].currentTask.activity[].detail`.
 *     Both are VALUES, produced by ingest-time sanitizers that run before
 *     anything reaches D1 — `state.ts` never re-validates or re-sanitizes a
 *     row's values on read. This test cannot, and does not, re-verify that
 *     upstream sanitization; that invariant lives at the ingest layer
 *     (`EventLogger.hook.ts` / `common/event-processor.ts` /
 *     `common/event-utils.ts`), not here.
 *
 * Given that, this test pins what's actually decidable from `state.ts`'s
 * side of the boundary:
 *
 *   1. SCHEMA guard — no column on the tables `buildSnapshot()` reads is
 *      named like an interior category. Catches a future schema widening
 *      (e.g. someone adds a `tool_input`/`diff` column) at the earliest
 *      possible point, before any query or DTO field could expose it.
 *   2. DTO KEY-SHAPE guard — `buildSnapshot()`'s serialized output introduces
 *      no interior-NAMED field. Catches a future SELECT/mapping change that
 *      surfaces such a column under a new key.
 *   3. `session_activity`'s EXACT key set — a session_activity row surfaces
 *      as exactly the 4 known G-410 fields, never more.
 *
 * None of these assert anything about the CONTENT of `description`/`detail`
 * — that's the accepted, out-of-scope exception documented above.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, type DashboardSnapshot } from "../routes/state";
import { d1, loadSchema, WORKER_DIR } from "./d1-shim";

/**
 * Interior-shaped key/column names: the SHAPE a leaked tool-call, prompt,
 * diff, or raw message would take, per CONTEXT.md's "Session interior" entry.
 * Deliberately name-based — this pins SHAPE (keys/columns), not the free-text
 * VALUES of legitimate lifecycle fields like `description` or `detail` (see
 * the file-level scope note above).
 */
const INTERIOR_KEY_PATTERN =
  /^(tool_?input|tool_?output|tool_?call|arguments|args|prompts?|diffs?|raw_?messages?|messages|stdout|stderr|file_?content|skill_?invocation|sub_?agent_?spawn)$/i;

/** Recursively collect every object key appearing anywhere in a JSON-shaped value. */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      collectKeys(v, into);
    }
  }
  return into;
}

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
  if (!match) throw new Error(`schema.sql: table "${table}" not found — did it get renamed?`);
  return match[1]!
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"))
    .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1])
    .filter((name): name is string => !!name);
}

describe("DashboardSnapshot contract — ADR-0005 no-interiors guard (S6, #1520)", () => {
  const schemaSql = readFileSync(join(WORKER_DIR, "schema.sql"), "utf8");

  it.each(["sessions", "session_activity", "github_events", "usage_snapshots"])(
    "schema guard: %s has no interior-named column",
    (table: string) => {
      const columns = columnNamesForTable(schemaSql, table);
      expect(columns.length).toBeGreaterThan(0); // sanity: the parser actually found columns
      const leaked = columns.filter((c) => INTERIOR_KEY_PATTERN.test(c));
      expect(leaked).toEqual([]);
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

  it("builds a snapshot whose serialized shape carries no interior-keyed field", async () => {
    seedFullSession(db, "s-full");
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

    // Sanity: the walk actually saw real lifecycle data, not an empty snapshot.
    expect(snapshot.agents.length).toBeGreaterThan(0);
    expect(snapshot.recentActivity.length).toBeGreaterThan(0);
    expect(snapshot.accountUsage).not.toBeNull();

    const keys = collectKeys(snapshot);
    const leaked = [...keys].filter((k) => INTERIOR_KEY_PATTERN.test(k));
    expect(leaked).toEqual([]);
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
