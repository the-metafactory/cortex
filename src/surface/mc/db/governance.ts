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

// ===========================================================================
// P-14 U3.1 (#936) — governance_denials storage.
//
// Pipeline-level access-decision rows projected from U0.2's (#932)
// `system.access.{denied,filtered}` envelopes — the access-gate dimension of
// the governance pane, sibling to `governance_verdicts` (the governed-action
// pipeline dimension). SAME discipline: append-only from the projection's
// view, idempotent on `envelope_id` (at-least-once redelivery-safe), windowed
// + capped reads, no update/delete surface (retention owns age-out — 30d in
// db/retention.ts).
//
// A REFUSAL is the sovereignty subset of denials — `reason_kind` ===
// 'sovereignty_model_class' (a consumer-side sovereignty gate refused a task
// whose model-class demand its own class would violate, U0.2 §reason-kinds),
// plus the three `system.access.filtered` visibility reasons
// (`residency_blocked` / `model_class_blocked` / `classification_exceeds_max`).
// The pane breaks denials into refusals-vs-other so a sovereignty refusal
// reads distinctly from an authz/chain denial.
// ===========================================================================

/** The two `system.access.*` access-decision envelope kinds we project. */
export type GovernanceDenialKind = "denied" | "filtered";

/**
 * The set of `reason_kind` values that classify a denial row as a sovereignty
 * REFUSAL (vs. a generic authz/chain denial). Drawn from U0.2's #932
 * `SystemAccessDeniedReason.kind` extension + the three
 * `SystemAccessFilteredReason` visibility reasons. Membership is the single
 * source of truth for `isRefusal` so the projection and the summary agree.
 */
export const REFUSAL_REASON_KINDS: ReadonlySet<string> = new Set<string>([
  // system.access.denied — consumer-side sovereignty gate (#932)
  "sovereignty_model_class",
  "sovereignty_mismatch",
  // system.access.filtered — renderer visibility drops (the three axes)
  "residency_blocked",
  "model_class_blocked",
  "classification_exceeds_max",
]);

/** True when a denial's `reason_kind` is a sovereignty refusal (see set above). */
export function isRefusalReason(reasonKind: string | null): boolean {
  return reasonKind !== null && REFUSAL_REASON_KINDS.has(reasonKind);
}

export interface GovernanceDenialInsert {
  envelopeId: string;
  /** `denied` (access gate) or `filtered` (renderer visibility drop). */
  kind: GovernanceDenialKind;
  /** The `reason.kind` discriminator (denied) or the filtered reason enum. */
  reasonKind: string;
  /** Principal the gate was evaluating (payload `principal_id`), when known. */
  principalId?: string | null;
  /** Capability claim evaluated (denied) — null for filtered drops. */
  capability?: string | null;
  /** Subject of the ORIGINATING envelope the decision was about. */
  envelopeSubject?: string | null;
  /** Free-form detail (reason text / verify_reason / fault / detail). */
  detail?: string | null;
  source?: string | null;
  subject?: string | null;
  principal?: string | null;
  stack?: string | null;
  payload: Record<string, unknown>;
}

export interface GovernanceDenialRow {
  id: string;
  envelopeId: string;
  kind: GovernanceDenialKind;
  reasonKind: string;
  /** Derived from `reasonKind` — sovereignty refusal vs generic denial. */
  isRefusal: boolean;
  principalId: string | null;
  capability: string | null;
  envelopeSubject: string | null;
  detail: string | null;
  principal: string | null;
  stack: string | null;
  createdAt: number;
}

/** Insert one access-denial row. Returns the row id, or null when the envelope
 *  was already projected (idempotent redelivery no-op). */
export function insertGovernanceDenial(
  db: Database,
  d: GovernanceDenialInsert,
): string | null {
  const id = crypto.randomUUID();
  const res = db
    .query(
      `INSERT INTO governance_denials
         (id, envelope_id, kind, reason_kind, principal_id, capability,
          envelope_subject, detail, source, subject, principal, stack, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(envelope_id) DO NOTHING`,
    )
    .run(
      id,
      d.envelopeId,
      d.kind,
      d.reasonKind,
      d.principalId ?? null,
      d.capability ?? null,
      d.envelopeSubject ?? null,
      d.detail ?? null,
      d.source ?? null,
      d.subject ?? null,
      d.principal ?? null,
      d.stack ?? null,
      JSON.stringify(d.payload),
    );
  return res.changes > 0 ? id : null;
}

function mapDenialRow(r: Record<string, unknown>): GovernanceDenialRow {
  const reasonKind = r.reason_kind as string;
  return {
    id: r.id as string,
    envelopeId: r.envelope_id as string,
    kind: r.kind as GovernanceDenialKind,
    reasonKind,
    isRefusal: isRefusalReason(reasonKind),
    principalId: (r.principal_id as string | null) ?? null,
    capability: (r.capability as string | null) ?? null,
    envelopeSubject: (r.envelope_subject as string | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    principal: (r.principal as string | null) ?? null,
    stack: (r.stack as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

/** Access denials from the last `days` days, newest first, capped at `limit`. */
export function listRecentDenials(
  db: Database,
  days: number,
  limit: number,
): GovernanceDenialRow[] {
  const rows = db
    .query(
      `SELECT id, envelope_id, kind, reason_kind, principal_id, capability,
              envelope_subject, detail, principal, stack, created_at
       FROM governance_denials
       WHERE created_at >= unixepoch() - (? * 86400)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(days, limit) as Record<string, unknown>[];
  return rows.map(mapDenialRow);
}

export interface GovernanceDenialSummary {
  /** All denial rows in the window. */
  total: number;
  /** Sovereignty refusals (subset of total — see {@link REFUSAL_REASON_KINDS}). */
  refusals: number;
  /** Generic denials (total − refusals): authz / chain-verify / originator. */
  otherDenials: number;
  /** Per `reason_kind` counts in the window. */
  byReasonKind: Record<string, number>;
  /** All denial rows (refusals included) in the last 24h — the alarm input. */
  denials24h: number;
}

export function summarizeDenials(db: Database, days: number): GovernanceDenialSummary {
  const windowExpr = `created_at >= unixepoch() - (? * 86400)`;
  const byKindRows = db
    .query(
      `SELECT reason_kind, COUNT(*) AS n FROM governance_denials
       WHERE ${windowExpr} GROUP BY reason_kind`,
    )
    .all(days) as { reason_kind: string; n: number }[];

  const byReasonKind: Record<string, number> = {};
  let total = 0;
  let refusals = 0;
  for (const row of byKindRows) {
    byReasonKind[row.reason_kind] = row.n;
    total += row.n;
    if (isRefusalReason(row.reason_kind)) refusals += row.n;
  }

  const denials24h = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM governance_denials
         WHERE created_at >= unixepoch() - 86400`,
      )
      .get() as { n: number }
  ).n;

  return {
    total,
    refusals,
    otherDenials: total - refusals,
    byReasonKind,
    denials24h,
  };
}
