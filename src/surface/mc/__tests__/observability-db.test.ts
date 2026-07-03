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
  listTransportRosterEvents,
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
    insertObservabilityEvent(db, { envelopeId: "c", family: "transport", type: "system.transport.leaf-connect", payload: {}, timestamp: "2026-06-03T00:00:00.000Z" });

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
    insertObservabilityEvent(db, { envelopeId: "old", family: "transport", type: "system.transport.leaf-disconnect", payload: {}, timestamp: old });
    const summary = pruneRetention(db);
    expect(summary.ok).toBe(true);
    expect(summary.prunedObservability).toBe(1);
  });
});

describe("listTransportRosterEvents (P-14 U2.3) — payload-bearing transport read", () => {
  let db: Database;
  beforeEach(() => (db = setupDb()));
  afterEach(() => db.close());

  it("returns ONLY transport-family rows, newest first, WITH parsed payload", () => {
    insertObservabilityEvent(db, {
      envelopeId: "sig", family: "signal", type: "system.signal.received",
      payload: { n: 1 }, timestamp: "2026-06-01T00:00:00.000Z",
    });
    insertObservabilityEvent(db, {
      envelopeId: "t1", family: "transport", type: "system.transport.liveness-drift",
      payload: { action: "liveness_drift", network: "net", attributes: { peer: "jc/default", to: "connected" } },
      timestamp: "2026-06-02T00:00:00.000Z",
    });
    insertObservabilityEvent(db, {
      envelopeId: "t2", family: "transport", type: "system.transport.leaf-connect",
      payload: { action: "leaf_connect", network: "net", leaf: { principal: "jc", stack: "default", network: "net", rtt_ms: 8.4 } },
      timestamp: "2026-06-03T00:00:00.000Z",
    });

    const rows = listTransportRosterEvents(db, 50);
    expect(rows.length).toBe(2); // signal row excluded
    expect(rows[0]!.type).toBe("system.transport.leaf-connect"); // newest first
    // The payload round-trips back to an object (NOT stripped like the tab read).
    expect((rows[0]!.payload.leaf as Record<string, unknown>).rtt_ms).toBe(8.4);
    expect((rows[1]!.payload.attributes as Record<string, unknown>).to).toBe("connected");
  });

  it("degrades a poison payload to {} without throwing", () => {
    // Force a non-JSON payload directly (the insert path always JSON-stringifies,
    // so write a raw bad value to exercise the parse guard).
    db.query(
      `INSERT INTO observability_events (id, envelope_id, family, type, payload, timestamp)
       VALUES (?, ?, 'transport', 'system.transport.roster-snapshot', '{not json', datetime('now'))`,
    ).run(crypto.randomUUID(), "poison");
    const rows = listTransportRosterEvents(db, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]!.payload).toEqual({});
  });

  it("is empty on a non-hub stack (no transport rows)", () => {
    insertObservabilityEvent(db, { envelopeId: "sig", family: "signal", type: "system.signal.received", payload: {} });
    expect(listTransportRosterEvents(db, 10)).toEqual([]);
  });
});

describe("observability origin badge (P-14 U3.3)", () => {
  let db: Database;
  beforeEach(() => (db = setupDb()));
  afterEach(() => db.close());

  it("defaults a row's origin to local when no origin is supplied (U2.1 contract)", () => {
    insertObservabilityEvent(db, {
      envelopeId: "local-1", family: "transport", type: "system.transport.leaf-connect", payload: {},
    });
    expect(listObservabilityEvents(db, 10, "transport")[0]?.origin).toBe("local");
    expect(listTransportRosterEvents(db, 10)[0]?.origin).toBe("local");
  });

  it("persists + round-trips a FOREIGN origin badge (chain-verified peer)", () => {
    insertObservabilityEvent(db, {
      envelopeId: "fed-1",
      family: "transport",
      type: "system.transport.liveness-drift",
      payload: { action: "liveness_drift", network: "net", attributes: { peer: "joel/research", to: "connected" } },
      origin: { kind: "foreign", peer: "joel/research" },
    });
    const tabRow = listObservabilityEvents(db, 10, "transport")[0];
    expect(tabRow?.origin).toEqual({ kind: "foreign", peer: "joel/research" });
    const rosterRow = listTransportRosterEvents(db, 10)[0];
    expect(rosterRow?.origin).toEqual({ kind: "foreign", peer: "joel/research" });
  });

  it("a foreign row with a missing peer degrades to local (never an originless foreign badge)", () => {
    // Defensive: a writer always pairs origin_kind=foreign with a non-empty
    // origin_peer; an inconsistent row must not surface an un-attributed foreign.
    db.query(
      `INSERT INTO observability_events (id, envelope_id, family, type, payload, origin_kind, origin_peer, timestamp)
       VALUES (?, ?, 'transport', 'system.transport.leaf-connect', '{}', 'foreign', NULL, datetime('now'))`,
    ).run(crypto.randomUUID(), "broken-foreign");
    expect(listObservabilityEvents(db, 10, "transport")[0]?.origin).toBe("local");
  });

  it("local and foreign rows coexist, each carrying its own badge", () => {
    insertObservabilityEvent(db, {
      envelopeId: "loc", family: "transport", type: "system.transport.leaf-connect",
      payload: {}, origin: "local", timestamp: "2026-06-01T00:00:00.000Z",
    });
    insertObservabilityEvent(db, {
      envelopeId: "fed", family: "transport", type: "system.transport.leaf-connect",
      payload: {}, origin: { kind: "foreign", peer: "joel/research" }, timestamp: "2026-06-02T00:00:00.000Z",
    });
    const rows = listTransportRosterEvents(db, 10);
    expect(rows.find((r) => r.id && (r.payload, true) && r.origin !== "local")).toBeDefined();
    const byOrigin = rows.map((r) => (r.origin === "local" ? "local" : r.origin.peer));
    expect(byOrigin.sort()).toEqual(["joel/research", "local"]);
  });
});
