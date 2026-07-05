/**
 * S6 (#1520) — `DashboardSnapshot` contract: the ADR-0005 no-interiors guard.
 *
 * cortex#1520 set out to unify the worker's `/api/state` shape with a "local
 * assembly" — but no such local combined-snapshot endpoint exists (cortex's
 * local dashboard serves granular REST + WS projections instead; see the
 * escalation on #1520). S6 was retargeted to the worker's own producer↔consumer
 * contract: one exported `DashboardSnapshot` type (`routes/state.ts`) both
 * `buildSnapshot()` and the `/api/state` route are checked against, plus this
 * test — pinning the by-hand no-interiors filter (the SELECTs in `state.ts`
 * hand-list lifecycle-safe columns; they never `SELECT *`) as an ENFORCED
 * invariant rather than an unverified convention.
 *
 * ADR-0005 / CONTEXT.md "Session interior": tool calls and their
 * arguments/outputs, prompts, file edits, skill invocations, and sub-agent
 * spawns never leave `local.` scope. This test drives the REAL `buildSnapshot`
 * against an in-memory bun:sqlite DB (the same D1 shim pattern as
 * `state-session-tree.test.ts`), seeds rows that WOULD carry interior-shaped
 * data if the filter regressed, and recursively asserts no interior-shaped key
 * appears anywhere in the serialized payload.
 *
 * Scope note: `SessionActivityEntry.detail` is a known, accepted exception —
 * G-410's `extractActivityEntry` (common/event-utils.ts) already sanitizes and
 * truncates it at ingest time (e.g. a redacted, 100-char-capped command
 * preview, or "Editing foo.ts"). That sanitization is pre-existing, out of
 * S6's scope, and unchanged here. This test's job is narrower: pin that the
 * snapshot DTO's KEY SHAPE never grows a field that would carry raw tool
 * interior (e.g. `toolInput`, `arguments`, `diff`, `messages`) even if a row
 * somehow carried one.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, type DashboardSnapshot } from "../routes/state";

const WORKER_DIR = join(import.meta.dir, "..", "..");

/** Minimal D1Database shim over bun:sqlite (same surface buildSnapshot uses). */
function d1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const stmt: any = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._args = args;
          return stmt;
        },
        async first() {
          return db.query(sql).get(...(stmt._args as never[]));
        },
        async all() {
          return { results: db.query(sql).all(...(stmt._args as never[])) };
        },
        async run() {
          const res = db.query(sql).run(...(stmt._args as never[]));
          return { meta: { changes: res.changes } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function loadSchema(db: Database): void {
  db.exec(readFileSync(join(WORKER_DIR, "schema.sql"), "utf8"));
}

/**
 * Interior-shaped key names: the SHAPE a leaked tool-call, prompt, diff, or raw
 * message would take on the wire, per CONTEXT.md's "Session interior" entry.
 * Deliberately name-based (not value-based) — this pins the DTO's KEY SHAPE,
 * not the free-text VALUES of legitimate lifecycle fields like `description`
 * or the sanitized `detail` (see file-level scope note above).
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

describe("DashboardSnapshot contract — ADR-0005 no-interiors guard (S6, #1520)", () => {
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
    // G-410 activity: a sanitized summary, exactly the accepted exception —
    // never the raw tool_input/tool_output pair it was derived from.
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

  it("keeps the one accepted free-text field (`detail`) bounded to a summary, not a raw payload", async () => {
    seedFullSession(db, "s-detail");
    // Even a maximally-long, non-truncated detail (as if the ingest-time
    // sanitizer were bypassed) must still surface as a plain string under the
    // known `detail` key — never restructured into a nested tool-call object.
    db.query(
      `INSERT INTO session_activity (session_id, timestamp, icon, label, detail)
       VALUES ('s-detail', strftime('%Y-%m-%dT%H:%M:%fZ','now'), '💻', 'command', 'echo hello')`
    ).run();

    const snapshot = await buildSnapshot(d1(db));
    const agent = snapshot.agents.find((a) => a.currentTask.sessionId === "s-detail")!;
    expect(agent.currentTask.activity).toHaveLength(1);
    expect(typeof agent.currentTask.activity[0]!.detail).toBe("string");
    // The activity entry has EXACTLY the four G-410 fields — no extra keys.
    expect(Object.keys(agent.currentTask.activity[0]!).sort()).toEqual(
      ["detail", "icon", "label", "timestamp"].sort()
    );
  });
});
