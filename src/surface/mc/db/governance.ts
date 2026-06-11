/**
 * G-1115 — governance_verdicts storage (governance upgrade Stage 5).
 *
 * Pipeline-level audit rows projected from `governance.verdict.*` envelopes.
 * Append-only from the projection's perspective: insert is idempotent on
 * `envelope_id` (redelivery-safe), reads are windowed + capped. No update or
 * delete surface — retention is a future concern (db/retention.ts owns that
 * pattern when it comes).
 */

import type { Database } from "bun:sqlite";

export type GovernanceLayer = "l0" | "tribunal" | "gate" | "resolved";

export interface GovernanceVerdictInsert {
  envelopeId: string;
  layer: GovernanceLayer;
  decision: string;
  name: string;
  tool?: string | null;
  reason?: string | null;
  resolvedBy?: string | null;
  source?: string | null;
  subject?: string | null;
  principal?: string | null;
  stack?: string | null;
  payload: Record<string, unknown>;
}

export interface GovernanceVerdictRow {
  id: string;
  envelopeId: string;
  layer: GovernanceLayer;
  decision: string;
  name: string;
  tool: string | null;
  reason: string | null;
  resolvedBy: string | null;
  principal: string | null;
  stack: string | null;
  createdAt: number;
}

/** Insert one verdict. Returns the row id, or null when the envelope was
 *  already projected (idempotent redelivery no-op). */
export function insertGovernanceVerdict(
  db: Database,
  v: GovernanceVerdictInsert,
): string | null {
  const id = crypto.randomUUID();
  const res = db
    .query(
      `INSERT INTO governance_verdicts
         (id, envelope_id, layer, decision, name, tool, reason, resolved_by,
          source, subject, principal, stack, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(envelope_id) DO NOTHING`,
    )
    .run(
      id,
      v.envelopeId,
      v.layer,
      v.decision,
      v.name,
      v.tool ?? null,
      v.reason ?? null,
      v.resolvedBy ?? null,
      v.source ?? null,
      v.subject ?? null,
      v.principal ?? null,
      v.stack ?? null,
      JSON.stringify(v.payload),
    );
  return res.changes > 0 ? id : null;
}

/** Verdicts from the last `days` days, newest first, capped at `limit`. */
export function listRecentVerdicts(
  db: Database,
  days: number,
  limit: number,
): GovernanceVerdictRow[] {
  const rows = db
    .query(
      `SELECT id, envelope_id, layer, decision, name, tool, reason, resolved_by,
              principal, stack, created_at
       FROM governance_verdicts
       WHERE created_at >= unixepoch() - (? * 86400)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(days, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    envelopeId: r.envelope_id as string,
    layer: r.layer as GovernanceLayer,
    decision: r.decision as string,
    name: r.name as string,
    tool: (r.tool as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    resolvedBy: (r.resolved_by as string | null) ?? null,
    principal: (r.principal as string | null) ?? null,
    stack: (r.stack as string | null) ?? null,
    createdAt: r.created_at as number,
  }));
}

export interface GovernanceSummary {
  /** All rows in the window (not capped by the list limit). */
  total: number;
  /** `resolved` rows are the per-action outcomes — counted by outcome. */
  allows: number;
  denials: number;
  defers: number;
  byLayer: Record<GovernanceLayer, number>;
  /** Denials (resolved outcome=deny OR any layer decision deny/fail) in the last 24h. */
  denials24h: number;
}

export function summarizeGovernance(db: Database, days: number): GovernanceSummary {
  const windowExpr = `created_at >= unixepoch() - (? * 86400)`;
  const byLayerRows = db
    .query(
      `SELECT layer, COUNT(*) AS n FROM governance_verdicts WHERE ${windowExpr} GROUP BY layer`,
    )
    .all(days) as { layer: GovernanceLayer; n: number }[];
  const byLayer: Record<GovernanceLayer, number> = { l0: 0, tribunal: 0, gate: 0, resolved: 0 };
  let total = 0;
  for (const row of byLayerRows) {
    byLayer[row.layer] = row.n;
    total += row.n;
  }

  const outcome = (decision: string): number =>
    (
      db
        .query(
          `SELECT COUNT(*) AS n FROM governance_verdicts
           WHERE ${windowExpr} AND layer = 'resolved' AND decision = ?`,
        )
        .get(days, decision) as { n: number }
    ).n;

  const denials24h = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM governance_verdicts
         WHERE created_at >= unixepoch() - 86400
           AND ((layer = 'resolved' AND decision = 'deny')
             OR (layer != 'resolved' AND decision IN ('deny','fail')))`,
      )
      .get() as { n: number }
  ).n;

  return {
    total,
    allows: outcome("allow"),
    denials: outcome("deny"),
    defers: outcome("defer"),
    byLayer,
    denials24h,
  };
}
