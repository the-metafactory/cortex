import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { initDatabase } from "../../surface/mc/db/init";
import { getAttentionItem, dismissAttentionItem } from "../../surface/mc/db/attention";
import { reconcileAttention } from "../../surface/mc/db/attention-sources";
import { getAttentionQueue, handleListAttention } from "../../surface/mc/api/attention";
import { AttentionView } from "../../surface/mc/dashboard-v2/components/attention-view";
import { applyVigilAttention } from "../attention";
import { getVigilSubject, listVigilEvents, writeVigilTransition } from "../db";
import { ingestLedgerEnvelope } from "../ingest";
import { subjectClass, vigilSeverity, type SubjectClass } from "../policy";
import { sweepStale } from "../staleness";
import { ENDED_AT, KEY, ledgerEnvelope } from "./fixtures";

describe("Vigil attention", () => {
  let db: Database;
  const id = `att:vigil:${KEY}`;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => db.close());

  test("subject class uses goal linkage only for runs and vocabulary for state", () => {
    for (const goal_id of [null, "G5", ""]) {
      expect(subjectClass({ subject_kind: "run", goal_id, vocab: null })).toBe(goal_id === null ? "run" : "goal-sensor");
      for (const vocab of ["goal", "escalation", "check", "unknown"] as const) {
        expect(subjectClass({ subject_kind: "state", goal_id, vocab })).toBe(vocab);
      }
    }
  });

  test.each<[SubjectClass, string, "normal" | "high"]>([
    ["goal", "at-risk", "high"], ["goal", "stale", "high"], ["goal-sensor", "failed", "high"],
    ["escalation", "overdue", "high"], ["escalation", "needs-principal", "normal"],
    ["check", "regressed", "normal"], ["unknown", "odd", "normal"], ["run", "failed", "normal"],
  ])("%s reaching %s has severity %s only when worse", (subject, value, severity) => {
    expect(vigilSeverity(subject, value, "worse")).toBe(severity);
    expect(vigilSeverity(subject, value, "better")).toBeNull();
  });

  test("one row opens, updates, resolves and reopens with event attribution", () => {
    const first = ledgerEnvelope();
    const delta = ingestLedgerEnvelope(db, first, ENDED_AT);
    expect(delta).toEqual({ opened: [{ id, stackId: "default", kind: "state_change", severity: "normal", status: "open", workItemId: null, sessionId: null }], resolved: [] });
    expect(listVigilEvents(db, KEY)[0]).toMatchObject({ severity: "normal", attention_id: id });
    const original = db.query("SELECT rowid, created_at FROM attention_items WHERE id = ?").get(id);
    expect(ingestLedgerEnvelope(db, first, ENDED_AT + 1)).toEqual({ opened: [], resolved: [] });
    expect(ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "cancelled", ended_at: "2026-10-12T10:01:05Z" }), ENDED_AT + 60_000)).toEqual({ opened: [], resolved: [] });
    expect(db.query("SELECT rowid, created_at FROM attention_items WHERE id = ?").get(id)).toEqual(original);
    const better = ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:02:05Z" }), ENDED_AT + 120_000);
    expect(better.resolved).toEqual([{ ...delta.opened[0]!, status: "resolved", resolution: null }]);
    expect(getAttentionItem(db, id)?.status).toBe("resolved");
    expect(listVigilEvents(db, KEY)[2]).toMatchObject({ severity: null, attention_id: id });
    expect(ingestLedgerEnvelope(db, ledgerEnvelope({ ended_at: "2026-10-12T10:03:05Z" }), ENDED_AT + 180_000).opened).toHaveLength(1);
    expect(db.query("SELECT count(*) AS n FROM attention_items").get()).toEqual({ n: 1 });
  });

  test("escalation severity updates the same row from needs-principal to overdue", () => {
    const subject = "the-metafactory/soma#604";
    const key = `state:escalation:${subject}`;
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", state: { subject, value: "needs-principal" } }), ENDED_AT);
    const before = db.query("SELECT rowid, created_at FROM attention_items WHERE id = ?").get(`att:vigil:${key}`);
    const delta = ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", state: { subject, value: "overdue" }, ended_at: "2026-10-12T10:01:05Z" }), ENDED_AT + 60_000);
    expect(delta).toEqual({ opened: [], resolved: [] });
    expect(getAttentionItem(db, `att:vigil:${key}`)?.severity).toBe("high");
    expect(db.query("SELECT rowid, created_at FROM attention_items WHERE id = ?").get(`att:vigil:${key}`)).toEqual(before);
    expect(listVigilEvents(db, key).map((e) => e.severity)).toEqual(["normal", "high"]);
  });

  test("better with no open item writes nothing", () => {
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded" }), ENDED_AT);
    const event = writeVigilTransition(db, { subject_key: KEY, from_value: "failed", to_value: "succeeded", direction: "better", run_id: "better", occurred_at: ENDED_AT }, ENDED_AT);
    const changes = db.query("SELECT total_changes() AS n").get();
    expect(applyVigilAttention(db, event, "default")).toEqual({ opened: [], resolved: [] });
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(getAttentionItem(db, id)).toBeNull();
  });

  test("a new worsening after dismissal reopens the subject", () => {
    ingestLedgerEnvelope(db, ledgerEnvelope(), ENDED_AT);
    dismissAttentionItem(db, id);
    expect(ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "cancelled", ended_at: "2026-10-12T10:01:05Z" }), ENDED_AT + 60_000).opened).toHaveLength(1);
  });

  test("staleness projects job and goal changes, repeated sweeps do not reopen", () => {
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", serves: { goal: "G5" }, ran: { kind: "job", ref: "sensor" }, state: { subject: "G5", value: "on-track" } }), ENDED_AT);
    const delta = sweepStale(db, ENDED_AT + 52 * 3_600_000 + 1, {});
    expect(delta.opened).toHaveLength(2);
    expect(delta.opened.every((item) => item.severity === "high")).toBe(true);
    expect(sweepStale(db, ENDED_AT + 53 * 3_600_000, {})).toEqual({ opened: [], resolved: [] });
  });

  test("replay projects no attention and a projection failure rolls back the entire ingest", () => {
    expect(ingestLedgerEnvelope(db, ledgerEnvelope(), ENDED_AT, { replay: true })).toEqual({ opened: [], resolved: [] });
    expect(listVigilEvents(db, KEY)).toEqual([]);
    expect(getAttentionItem(db, id)).toBeNull();
    db.run("CREATE TRIGGER fail_attention BEFORE INSERT ON attention_items BEGIN SELECT RAISE(ABORT, 'attention failure'); END");
    const before = getVigilSubject(db, KEY);
    expect(() => ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "cancelled", ended_at: "2026-10-12T10:01:05Z" }), ENDED_AT + 60_000)).toThrow("attention failure");
    expect(getVigilSubject(db, KEY)).toEqual(before);
    expect(listVigilEvents(db, KEY)).toEqual([]);
  });

  test("MC lists and renders an unlinked Vigil item and reconciliation leaves it open", async () => {
    ingestLedgerEnvelope(db, ledgerEnvelope(), ENDED_AT);
    expect(reconcileAttention(db, { stackId: "default" }).resolved).toEqual([]);
    const entries = getAttentionQueue(db);
    expect(await handleListAttention(db).json()).toEqual({ attention: entries });
    expect(entries[0]?.link).toEqual({ kind: "none" });
    expect(renderToStaticMarkup(createElement(AttentionView, { entries, loaded: true }))).toContain("state change");
    expect(getAttentionItem(db, id)?.status).toBe("open");
  });
});
