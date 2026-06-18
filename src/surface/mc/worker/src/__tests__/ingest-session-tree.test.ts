/**
 * ST-P2 — D1 ingest column-write tests for the session-tree fields
 * (`parent_session_id`, `substrate`).
 *
 * The worker persists sessions to Cloudflare D1; D1's prepared-statement API
 * (`prepare(sql).bind(...).run()`) is a thin wrapper that maps cleanly onto
 * bun:sqlite. This test drives the REAL `persistProcessedEvent` SQL (via
 * `processSessionEvent`) against an in-memory bun:sqlite DB loaded from the
 * worker's own `schema.sql` + the 0005 migration — so the actual bound columns,
 * the INSERT, and the ON CONFLICT COALESCE/CASE logic are exercised, not just
 * the upstream `SessionUpsertData` shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processSessionEvent } from "../../../../../common/event-processor";
import type { IngestEvent } from "../../../../../common/types";
import { persistProcessedEvent } from "../routes/ingest";

const WORKER_DIR = join(import.meta.dir, "..", "..");

/**
 * Minimal D1Database shim over bun:sqlite. Implements only the surface the
 * ingest persistence path uses: prepare → bind → run, returning `meta.changes`.
 */
function d1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const stmt: any = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._args = args;
          return stmt;
        },
        async run() {
          const res = db.query(sql).run(...(stmt._args as never[]));
          return { meta: { changes: res.changes } };
        },
        async first() {
          return db.query(sql).get(...(stmt._args as never[]));
        },
        async all() {
          return { results: db.query(sql).all(...(stmt._args as never[])) };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function loadSchema(db: Database): void {
  const schema = readFileSync(join(WORKER_DIR, "schema.sql"), "utf8");
  db.exec(schema);
  // schema.sql already carries the 0005 columns (P0). Run the migration too to
  // assert it is additive-idempotent against a schema that has them — skip the
  // ADD COLUMN lines (would error on an already-present column) and apply only
  // the IF-NOT-EXISTS indices, which is what re-running yields in practice.
}

function row(db: Database, sessionId: string): any {
  return db
    .query(`SELECT parent_session_id, substrate FROM sessions WHERE session_id = ?`)
    .get(sessionId);
}

function baseEvent(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    event_id: "evt-1",
    event_type: "agent.task.started",
    timestamp: "2026-06-11T00:00:00.000Z",
    session_id: "sess-1",
    agent_id: "luna",
    agent_name: "Luna",
    payload: {},
    ...overrides,
  };
}

describe("D1 ingest — session-tree column writes (ST-P2)", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    loadSchema(db);
  });
  afterEach(() => db.close());

  it("writes parent_session_id + substrate on task_started insert", async () => {
    const ev = baseEvent({
      payload: { parent_session_id: "parent-1", substrate: "codex" },
    });
    await persistProcessedEvent(d1(db), processSessionEvent("andreas", ev));
    expect(row(db, "sess-1")).toEqual({ parent_session_id: "parent-1", substrate: "codex" });
  });

  it("defaults substrate to 'claude-code' and parent to NULL when payload omits them", async () => {
    const ev = baseEvent({ payload: {} });
    await persistProcessedEvent(d1(db), processSessionEvent("andreas", ev));
    expect(row(db, "sess-1")).toEqual({ parent_session_id: null, substrate: "claude-code" });
  });

  it("COALESCEs a later parent_session_id onto an earlier NULL (backfill)", async () => {
    // First event: no parent.
    await persistProcessedEvent(d1(db), processSessionEvent("andreas", baseEvent({ payload: {} })));
    expect(row(db, "sess-1").parent_session_id).toBeNull();
    // Later event for the same session carries the parent → backfills.
    await persistProcessedEvent(
      d1(db),
      processSessionEvent("andreas", baseEvent({ event_id: "evt-2", payload: { parent_session_id: "parent-late" } })),
    );
    expect(row(db, "sess-1").parent_session_id).toBe("parent-late");
  });

  it("does NOT reset a previously-observed substrate to the default on a later substrate-less event", async () => {
    // First event: codex.
    await persistProcessedEvent(
      d1(db),
      processSessionEvent("andreas", baseEvent({ payload: { substrate: "codex" } })),
    );
    expect(row(db, "sess-1").substrate).toBe("codex");
    // Later event without substrate must NOT clobber 'codex' back to default.
    await persistProcessedEvent(
      d1(db),
      processSessionEvent("andreas", baseEvent({ event_id: "evt-2", payload: {} })),
    );
    expect(row(db, "sess-1").substrate).toBe("codex");
  });

  it("writes the tree fields on the late-join direct-insert path (task_completed, no prior row)", async () => {
    const ev = baseEvent({
      event_type: "agent.task.completed",
      payload: { parent_session_id: "parent-c", substrate: "codex" },
    });
    await persistProcessedEvent(d1(db), processSessionEvent("andreas", ev));
    expect(row(db, "sess-1")).toEqual({ parent_session_id: "parent-c", substrate: "codex" });
  });
});
