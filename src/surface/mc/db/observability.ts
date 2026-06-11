/**
 * P-14 U2.1 (#934) — observability_events storage.
 *
 * Append-only projection rows from signal's four `system.*` envelope families,
 * surfaced on the MC Observability tab. Modelled on `db/governance.ts`: insert is
 * idempotent on `envelope_id` (at-least-once redelivery-safe), reads are windowed
 * + capped, no update surface. Retention (age-based prune) lives in db/retention.ts
 * (the established owner of that pattern).
 *
 * `family` is the tab's section discriminator (signal-health groups `signal` +
 * `collector`; `federation` and `transport` are their own sections). `type` is the
 * full envelope `domain.entity.action`. Hub-scope (federation/transport) is a DATA
 * property — a non-hub stack simply has zero rows of those families, which the tab
 * renders as an honest explanatory empty state (never synthesized).
 */

import type { Database } from "bun:sqlite";

/** The four section families. `signal` + `collector` together are "signal health". */
export type ObservabilityFamily = "signal" | "collector" | "federation" | "transport";

export const OBSERVABILITY_FAMILIES: readonly ObservabilityFamily[] = [
  "signal",
  "collector",
  "federation",
  "transport",
] as const;

export interface ObservabilityEventInsert {
  envelopeId: string;
  family: ObservabilityFamily;
  /** Full envelope `domain.entity.action`. */
  type: string;
  /** Origin stack id (or other origin segment), when known. */
  stackId?: string | null;
  /** A short human-readable line for the row (optional). */
  summary?: string | null;
  payload: Record<string, unknown>;
  /** ISO-8601; defaults to now when omitted. */
  timestamp?: string;
}

export interface ObservabilityEventRow {
  id: string;
  envelopeId: string;
  family: ObservabilityFamily;
  type: string;
  stackId: string | null;
  summary: string | null;
  timestamp: string;
}

/**
 * Insert one observability event. Returns the row id, or null when the envelope
 * was already projected (idempotent redelivery no-op via `ON CONFLICT(envelope_id)`).
 */
export function insertObservabilityEvent(
  db: Database,
  e: ObservabilityEventInsert,
): string | null {
  const id = crypto.randomUUID();
  const res = db
    .query(
      `INSERT INTO observability_events
         (id, envelope_id, family, type, stack_id, summary, payload, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
       ON CONFLICT(envelope_id) DO NOTHING`,
    )
    .run(
      id,
      e.envelopeId,
      e.family,
      e.type,
      e.stackId ?? null,
      e.summary ?? null,
      JSON.stringify(e.payload),
      e.timestamp ?? null,
    );
  return res.changes > 0 ? id : null;
}

/**
 * Recent events, newest first, capped at `limit`. When `family` is given, only
 * that family's rows are returned (the tab reads per-section).
 */
export function listObservabilityEvents(
  db: Database,
  limit: number,
  family?: ObservabilityFamily,
): ObservabilityEventRow[] {
  const rows = (
    family === undefined
      ? db
          .query(
            `SELECT id, envelope_id, family, type, stack_id, summary, timestamp
             FROM observability_events
             ORDER BY timestamp DESC, id DESC
             LIMIT ?`,
          )
          .all(limit)
      : db
          .query(
            `SELECT id, envelope_id, family, type, stack_id, summary, timestamp
             FROM observability_events
             WHERE family = ?
             ORDER BY timestamp DESC, id DESC
             LIMIT ?`,
          )
          .all(family, limit)
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    envelopeId: r.envelope_id as string,
    family: r.family as ObservabilityFamily,
    type: r.type as string,
    stackId: (r.stack_id as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    timestamp: r.timestamp as string,
  }));
}

/**
 * P-14 U2.3 (#935) — a transport-family row WITH its parsed `payload`.
 *
 * The generic {@link listObservabilityEvents} read deliberately strips `payload`
 * (the tab only needs `type`/`summary`/`stackId`). The Network-view transport
 * overlay, by contrast, needs the per-leaf verdict + RTT that signal stamps into
 * the envelope BODY (`system.transport.*` payload — `leaf`/`leaves`/`attributes`,
 * see signal P-13.B reconciler). This narrow read returns those rows WITH the
 * payload re-parsed, so the overlay folds signal's OWN verdicts onto the graph
 * (CONTEXT.md §Sourced-from-signal — cortex never re-derives substrate health).
 *
 * Additive: a new query alongside the existing reads; nothing else changes.
 */
export interface TransportRosterEventRow {
  id: string;
  type: string;
  stackId: string | null;
  /** The parsed envelope BODY signal published (`{ action, network, leaf?, leaves?, attributes? }`). */
  payload: Record<string, unknown>;
  timestamp: string;
}

/**
 * Recent `transport`-family rows (newest first, capped at `limit`) WITH their
 * stored `payload` parsed back to an object. Malformed/empty payloads parse to
 * `{}` (never throws — a poison row degrades to an empty body, not a crash).
 *
 * Sourced verbatim from the projected `system.transport.*` envelopes signal
 * emitted; this read does no reconciliation of its own.
 */
export function listTransportRosterEvents(
  db: Database,
  limit: number,
): TransportRosterEventRow[] {
  const rows = db
    .query(
      `SELECT id, type, stack_id, payload, timestamp
       FROM observability_events
       WHERE family = 'transport'
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => {
    let payload: Record<string, unknown> = {};
    const raw = r.payload;
    if (typeof raw === "string" && raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        // A poison payload degrades to {} — the overlay folder skips a body it
        // can't read rather than failing the whole roster read.
      }
    }
    return {
      id: r.id as string,
      type: r.type as string,
      stackId: (r.stack_id as string | null) ?? null,
      payload,
      timestamp: r.timestamp as string,
    };
  });
}

/** Per-family row counts. A family with zero rows is absent from the result map. */
export type ObservabilityCounts = Partial<Record<ObservabilityFamily, number>>;

export function countObservabilityByFamily(db: Database): ObservabilityCounts {
  const rows = db
    .query(`SELECT family, COUNT(*) AS n FROM observability_events GROUP BY family`)
    .all() as { family: ObservabilityFamily; n: number }[];
  const out: ObservabilityCounts = {};
  for (const row of rows) out[row.family] = row.n;
  return out;
}
