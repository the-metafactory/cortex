/**
 * P-14 U3.1 (#936) — governance access-denial projection + 30d query +
 * retention + render + API tests.
 *
 * Verifies:
 *   1. Projection: `system.access.denied` (nested reason.kind) and
 *      `system.access.filtered` (flat reason enum) land as rows with the
 *      reason-kind extracted, refusal classification correct, principal/stack
 *      parsed from the subject.
 *   2. Refusal classification: sovereignty reason kinds → isRefusal; authz /
 *      chain-verify kinds → generic denial.
 *   3. Idempotency: a redelivered envelope (same id) is not double-inserted.
 *   4. Fail-closed filters: non-access types, malformed payloads (no reason
 *      kind), and missing ids project nothing — and never throw.
 *   5. Renderer seam: the system.access subjects are in the dispatch adapter
 *      grammar and match real derived subjects; render() routes a denied
 *      envelope into a row; garbage never throws.
 *   6. 30-day window: rows inside 30d are listed/summarized; a row backdated
 *      past 30d falls out of both.
 *   7. Retention: governance_denials past the 35d retention window is pruned;
 *      a row inside the 30d query window survives.
 *   8. API: empty DB → honest zeros; seeded denials + refusals split correctly
 *      and combine with verdict denials into the alarm tier.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { SCHEMA_SQL } from "../db/schema";
import {
  projectGovernanceDenial,
  type ProjectableDenialEnvelope,
} from "../projection/governance-denial";
import {
  createDispatchProjectionRenderer,
  DISPATCH_PROJECTION_SUBJECTS,
} from "../projection/dispatch-lifecycle-renderer";
import { subjectMatches } from "../../../bus/surface-router";
import { getGovernance } from "../api/governance";
import {
  insertGovernanceDenial,
  insertGovernanceVerdict,
  listRecentDenials,
  summarizeDenials,
  isRefusalReason,
} from "../db/governance";
import {
  pruneOldGovernanceDenials,
  pruneRetention,
  GOVERNANCE_DENIAL_RETENTION_MS,
} from "../db/retention";
import type { Envelope } from "../../../bus/myelin/envelope-validator";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

const SUBJECT = "local.switch-soc.default.system.access.denied";

function deniedEnvelope(
  reasonKind: string,
  extra: Record<string, unknown> = {},
  id = crypto.randomUUID(),
): ProjectableDenialEnvelope {
  return {
    id,
    type: "system.access.denied",
    source: "switch-soc.default.cortex",
    payload: {
      principal_id: "switch-soc",
      capability: "code-review.typescript",
      envelope_subject: "local.switch-soc.default.dispatch.task.received",
      reason: { kind: reasonKind, ...extra },
    },
  };
}

function filteredEnvelope(
  reason: string,
  id = crypto.randomUUID(),
): ProjectableDenialEnvelope {
  return {
    id,
    type: "system.access.filtered",
    source: "switch-soc.default.cortex",
    payload: {
      renderer_id: "dashboard",
      envelope_subject: "local.switch-soc.default.dispatch.task.received",
      reason,
    },
  };
}

function rowCount(db: Database): number {
  return (db.query(`SELECT COUNT(*) AS n FROM governance_denials`).get() as { n: number }).n;
}

/** Backdate a denial row's created_at by `msAgo` (unix-seconds column). */
function backdateDenial(db: Database, rowId: string, msAgo: number): void {
  const secAgo = Math.floor(msAgo / 1000);
  db.query(`UPDATE governance_denials SET created_at = unixepoch() - ? WHERE id = ?`).run(
    secAgo,
    rowId,
  );
}

describe("projectGovernanceDenial", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("projects a system.access.denied envelope → a denial row with reason kind + identity", () => {
    const res = projectGovernanceDenial(
      db,
      deniedEnvelope("chain_verify_failed", { verify_reason: "stamp_unknown" }),
      SUBJECT,
    );
    expect(res?.kind).toBe("denied");
    expect(res?.reasonKind).toBe("chain_verify_failed");
    expect(res?.rowId).not.toBeNull();

    const [row] = listRecentDenials(db, 30, 10);
    expect(row?.reasonKind).toBe("chain_verify_failed");
    expect(row?.isRefusal).toBe(false); // chain-verify is a generic denial
    expect(row?.principalId).toBe("switch-soc");
    expect(row?.capability).toBe("code-review.typescript");
    expect(row?.detail).toBe("stamp_unknown"); // verify_reason surfaced as detail
    // Subject identity parsed (stack-ful local grammar, anchored on `system`).
    expect(row?.principal).toBe("switch-soc");
    expect(row?.stack).toBe("default");
  });

  it("classifies a sovereignty_model_class denial as a REFUSAL", () => {
    const res = projectGovernanceDenial(
      db,
      deniedEnvelope("sovereignty_model_class", { reason: "frontier demanded, local-only class", enforced: true }),
      SUBJECT,
    );
    expect(res?.reasonKind).toBe("sovereignty_model_class");
    const [row] = listRecentDenials(db, 30, 10);
    expect(row?.isRefusal).toBe(true);
    expect(row?.detail).toBe("frontier demanded, local-only class");
  });

  it("projects a system.access.filtered envelope (flat reason enum) as a refusal", () => {
    const res = projectGovernanceDenial(db, filteredEnvelope("residency_blocked"), SUBJECT);
    expect(res?.kind).toBe("filtered");
    expect(res?.reasonKind).toBe("residency_blocked");
    const [row] = listRecentDenials(db, 30, 10);
    expect(row?.kind).toBe("filtered");
    expect(row?.isRefusal).toBe(true); // a visibility filter is a sovereignty refusal
    expect(row?.detail).toBe("dashboard"); // renderer_id surfaced as detail
  });

  it("is idempotent on envelope id — redelivery does not double-insert", () => {
    const env = deniedEnvelope("insufficient_role");
    const first = projectGovernanceDenial(db, env, SUBJECT);
    const second = projectGovernanceDenial(db, env, SUBJECT);
    expect(first?.rowId).not.toBeNull();
    expect(second?.rowId).toBeNull(); // recognized redelivery
    expect(rowCount(db)).toBe(1);
  });

  it("returns null for non-access types, malformed payloads, and missing ids — never throws", () => {
    // Wrong type.
    expect(
      projectGovernanceDenial(db, { id: "a", type: "dispatch.task.started", payload: { x: 1 } }),
    ).toBeNull();
    // denied with NO reason record — malformed.
    expect(
      projectGovernanceDenial(db, { id: "b", type: "system.access.denied", payload: { principal_id: "p" } }),
    ).toBeNull();
    // denied with reason missing a kind — malformed.
    expect(
      projectGovernanceDenial(db, { id: "c", type: "system.access.denied", payload: { reason: {} } }),
    ).toBeNull();
    // filtered with no reason enum — malformed.
    expect(
      projectGovernanceDenial(db, { id: "d", type: "system.access.filtered", payload: {} }),
    ).toBeNull();
    // No envelope id — no idempotency key, refuse to project.
    expect(
      projectGovernanceDenial(db, { type: "system.access.denied", payload: { reason: { kind: "x" } } }),
    ).toBeNull();
    expect(rowCount(db)).toBe(0);
  });

  it("parses stack-less local subjects too", () => {
    const res = projectGovernanceDenial(
      db,
      deniedEnvelope("unknown_principal"),
      "local.jc.system.access.denied",
    );
    expect(res).not.toBeNull();
    const [row] = listRecentDenials(db, 30, 1);
    expect(row?.principal).toBe("jc");
    expect(row?.stack).toBeNull();
  });
});

describe("refusal classification (isRefusalReason)", () => {
  it("sovereignty + visibility kinds are refusals; authz/chain kinds are not", () => {
    expect(isRefusalReason("sovereignty_model_class")).toBe(true);
    expect(isRefusalReason("sovereignty_mismatch")).toBe(true);
    expect(isRefusalReason("residency_blocked")).toBe(true);
    expect(isRefusalReason("model_class_blocked")).toBe(true);
    expect(isRefusalReason("classification_exceeds_max")).toBe(true);
    // Generic denials.
    expect(isRefusalReason("chain_verify_failed")).toBe(false);
    expect(isRefusalReason("chain_verify_fault")).toBe(false);
    expect(isRefusalReason("originator_denied")).toBe(false);
    expect(isRefusalReason("insufficient_role")).toBe(false);
    expect(isRefusalReason(null)).toBe(false);
  });
});

describe("renderer seam (U3.1)", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("the dispatch adapter grammar matches real derived system.access subjects", () => {
    const derived = [
      "local.switch-soc.default.system.access.denied",
      "local.jc.system.access.filtered",
      "federated.andreas.default.system.access.denied",
    ];
    for (const subject of derived) {
      const matched = DISPATCH_PROJECTION_SUBJECTS.some((p) => subjectMatches(p, subject));
      expect(matched).toBe(true);
    }
  });

  it("render() routes a forced gate-refusal into a row and never throws on garbage", async () => {
    const adapter = createDispatchProjectionRenderer(db);
    // The live-oracle shape: a forced gate-refusal (sovereignty_model_class).
    const env = {
      id: crypto.randomUUID(),
      source: "switch-soc.default.cortex",
      type: "system.access.denied",
      timestamp: new Date().toISOString(),
      sovereignty: { classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "local-only" },
      payload: {
        principal_id: "switch-soc",
        capability: "chat",
        envelope_subject: "local.switch-soc.default.dispatch.task.received",
        reason: { kind: "sovereignty_model_class", reason: "frontier demand on local-only class", enforced: true },
      },
    } as unknown as Envelope;
    await adapter.render(env, undefined, SUBJECT);
    expect(rowCount(db)).toBe(1);

    const [row] = listRecentDenials(db, 30, 1);
    expect(row?.reasonKind).toBe("sovereignty_model_class");
    expect(row?.isRefusal).toBe(true);

    // Garbage payload through the same seam — swallowed, not thrown.
    const garbage = { ...env, id: crypto.randomUUID(), payload: "not-an-object" } as unknown as Envelope;
    await adapter.render(garbage, undefined, SUBJECT);
    expect(rowCount(db)).toBe(1);
  });
});

describe("30-day window (listRecentDenials / summarizeDenials)", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("includes rows inside 30d and excludes a row backdated past 30d", () => {
    const inside = projectGovernanceDenial(db, deniedEnvelope("chain_verify_failed"), SUBJECT);
    const old = projectGovernanceDenial(db, deniedEnvelope("insufficient_role"), SUBJECT);
    expect(inside?.rowId).not.toBeNull();
    expect(old?.rowId).not.toBeNull();

    // Backdate the second row to 31 days ago.
    backdateDenial(db, old!.rowId!, 31 * 24 * 60 * 60 * 1000);

    const rows = listRecentDenials(db, 30, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reasonKind).toBe("chain_verify_failed");

    const s = summarizeDenials(db, 30);
    expect(s.total).toBe(1);
    expect(s.byReasonKind.insufficient_role).toBeUndefined();
  });

  it("summary splits refusals from generic denials over the window", () => {
    projectGovernanceDenial(db, deniedEnvelope("sovereignty_model_class"), SUBJECT);
    projectGovernanceDenial(db, filteredEnvelope("residency_blocked"), SUBJECT);
    projectGovernanceDenial(db, deniedEnvelope("chain_verify_failed"), SUBJECT);
    projectGovernanceDenial(db, deniedEnvelope("insufficient_role"), SUBJECT);

    const s = summarizeDenials(db, 30);
    expect(s.total).toBe(4);
    expect(s.refusals).toBe(2); // sovereignty_model_class + residency_blocked
    expect(s.otherDenials).toBe(2); // chain_verify_failed + insufficient_role
    expect(s.denials24h).toBe(4);
  });
});

describe("retention (pruneOldGovernanceDenials)", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("prunes a denial past the 35d retention window, keeps one inside the 30d query window", () => {
    const fresh = projectGovernanceDenial(db, deniedEnvelope("chain_verify_failed"), SUBJECT);
    const stale = projectGovernanceDenial(db, deniedEnvelope("insufficient_role"), SUBJECT);
    backdateDenial(db, fresh!.rowId!, 5 * 24 * 60 * 60 * 1000); // 5d — inside 30d
    backdateDenial(db, stale!.rowId!, GOVERNANCE_DENIAL_RETENTION_MS + 24 * 60 * 60 * 1000); // 36d

    const res = pruneOldGovernanceDenials(db);
    expect(res.prunedGovernanceDenials).toBe(1);
    expect(rowCount(db)).toBe(1);
    expect(listRecentDenials(db, 30, 10)[0]?.reasonKind).toBe("chain_verify_failed");
  });

  it("pruneRetention reports the governance-denial prune in its summary", () => {
    const stale = projectGovernanceDenial(db, deniedEnvelope("originator_denied"), SUBJECT);
    backdateDenial(db, stale!.rowId!, GOVERNANCE_DENIAL_RETENTION_MS + 24 * 60 * 60 * 1000);
    const summary = pruneRetention(db);
    expect(summary.ok).toBe(true);
    expect(summary.prunedGovernanceDenials).toBe(1);
  });
});

describe("GET /api/governance (denials dimension)", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("empty DB → zero denial summary, empty list", () => {
    const res = getGovernance(db);
    expect(res.denials).toHaveLength(0);
    expect(res.denialSummary.total).toBe(0);
    expect(res.denialSummary.refusals).toBe(0);
    expect(res.denialSummary.otherDenials).toBe(0);
  });

  it("surfaces denials + refusals and folds them into the alarm tier with verdict denials", () => {
    // 3 access denials/refusals in 24h.
    insertGovernanceDenial(db, { envelopeId: crypto.randomUUID(), kind: "denied", reasonKind: "sovereignty_model_class", payload: {} });
    insertGovernanceDenial(db, { envelopeId: crypto.randomUUID(), kind: "filtered", reasonKind: "residency_blocked", payload: {} });
    insertGovernanceDenial(db, { envelopeId: crypto.randomUUID(), kind: "denied", reasonKind: "chain_verify_failed", payload: {} });
    // 3 governed-action verdict denials in 24h (resolved deny ×2 + l0 deny).
    insertGovernanceVerdict(db, { envelopeId: crypto.randomUUID(), layer: "resolved", decision: "deny", name: "x", payload: {} });
    insertGovernanceVerdict(db, { envelopeId: crypto.randomUUID(), layer: "resolved", decision: "deny", name: "x", payload: {} });
    insertGovernanceVerdict(db, { envelopeId: crypto.randomUUID(), layer: "l0", decision: "deny", name: "x", payload: {} });

    const res = getGovernance(db);
    expect(res.denialSummary.total).toBe(3);
    expect(res.denialSummary.refusals).toBe(2); // sovereignty_model_class + residency_blocked
    expect(res.denialSummary.otherDenials).toBe(1); // chain_verify_failed
    // alarm combines: 3 verdict denials + 3 access denials = 6/24h → high (≥5).
    expect(res.alarm.denials24h).toBe(6);
    expect(res.alarm.tier).toBe("high");
    expect(res.denials).toHaveLength(3);
  });
});
