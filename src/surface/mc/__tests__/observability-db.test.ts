/**
 * P-14 U2.1 (#934) — observability_events storage + retention prune.
 *
 * Coverage:
 *   - insert returns an id, idempotent on envelope_id (redelivery → null, one row).
 *   - list by family (newest first) + overall, capped.
 *   - countByFamily omits zero-row families.
 *   - pruneOldObservability deletes rows older than the window, keeps recent.
 *   - pruneRetention includes the observability prune in its summary.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { SCHEMA_SQL } from "../db/schema";
import {
  insertObservabilityEvent,
  listObservabilityEvents,
  countObservabilityByFamily,
} from "../db/observability";
import {
  pruneOldObservability,
  pruneRetention,
  OBSERVABILITY_RETENTION_MS,
} from "../db/retention";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

describe("observability_events storage", () => {
  let db: Database;
  beforeEach(() => (db = setupDb()));
  afterEach(() => db.close());

  it("inserts and returns an id", () => {
    const id = insertObservabilityEvent(db, {
      envelopeId: "env-1",
      family: "signal",
      type: "system.signal.received",
      payload: { n: 1 },
    });
    expect(id).not.toBeNull();
    expect(listObservabilityEvents(db, 10).length).toBe(1);
  });

  it("is idempotent on envelope_id (redelivery → null, one row)", () => {
    expect(insertObservabilityEvent(db, { envelopeId: "dup", family: "federation", type: "system.federation.peer.added", payload: {} })).not.toBeNull();
    expect(insertObservabilityEvent(db, { envelopeId: "dup", family: "federation", type: "system.federation.peer.added", payload: {} })).toBeNull();
    expect(countObservabilityByFamily(db).federation).toBe(1);
  });

  it("lists by family, newest first, and overall", () => {
    insertObservabilityEvent(db, { envelopeId: "a", family: "signal", type: "system.signal.received", payload: {}, timestamp: "2026-06-01T00:00:00.000Z" });
    insertObservabilityEvent(db, { envelopeId: "b", family: "signal", type: "system.signal.dropped", payload: {}, timestamp: "2026-06-02T00:00:00.000Z" });
    insertObservabilityEvent(db, { envelopeId: "c", family: "transport", type: "system.transport.leaf_connect", payload: {}, timestamp: "2026-06-03T00:00:00.000Z" });

    const sig = listObservabilityEvents(db, 10, "signal");
    expect(sig.map((r) => r.envelopeId)).toEqual(["b", "a"]); // newest first
    expect(listObservabilityEvents(db, 10).length).toBe(3);
    expect(listObservabilityEvents(db, 1).length).toBe(1); // cap honoured
  });

  it("countByFamily omits zero-row families", () => {
    insertObservabilityEvent(db, { envelopeId: "x", family: "collector", type: "system.signal.collector.degraded", payload: {} });
    const counts = countObservabilityByFamily(db);
    expect(counts.collector).toBe(1);
    expect(counts.signal).toBeUndefined();
    expect(counts.federation).toBeUndefined();
    expect(counts.transport).toBeUndefined();
  });
});

describe("pruneOldObservability — age-based retention", () => {
  let db: Database;
  beforeEach(() => (db = setupDb()));
  afterEach(() => db.close());

  it("deletes rows older than the window, keeps recent", () => {
    const old = new Date(Date.now() - OBSERVABILITY_RETENTION_MS - 60_000).toISOString();
    const fresh = new Date().toISOString();
    insertObservabilityEvent(db, { envelopeId: "old", family: "signal", type: "system.signal.received", payload: {}, timestamp: old });
    insertObservabilityEvent(db, { envelopeId: "fresh", family: "signal", type: "system.signal.received", payload: {}, timestamp: fresh });

    const res = pruneOldObservability(db);
    expect(res.prunedObservability).toBe(1);
    const remaining = listObservabilityEvents(db, 10);
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.envelopeId).toBe("fresh");
  });

  it("is a no-op when nothing is old", () => {
    insertObservabilityEvent(db, { envelopeId: "fresh", family: "signal", type: "system.signal.received", payload: {} });
    expect(pruneOldObservability(db).prunedObservability).toBe(0);
  });

  it("pruneRetention reports prunedObservability in its summary", () => {
    const old = new Date(Date.now() - OBSERVABILITY_RETENTION_MS - 60_000).toISOString();
    insertObservabilityEvent(db, { envelopeId: "old", family: "transport", type: "system.transport.leaf_disconnect", payload: {}, timestamp: old });
    const summary = pruneRetention(db);
    expect(summary.ok).toBe(true);
    expect(summary.prunedObservability).toBe(1);
  });
});
