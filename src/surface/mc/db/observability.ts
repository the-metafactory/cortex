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

/**
 * P-14 U3.3 (#937) — the ORIGIN-BADGE for a projected observability row.
 *
 *   - `"local"` — this principal's own (or local-sibling) row, the U2.1 default.
 *   - `{ kind: "foreign"; peer }` — a TRUST-VERIFIED federated peer's row, where
 *     `peer` is the CHAIN-VERIFIED `{principal}/{stack}` derived from the
 *     envelope SOURCE (never from the attacker-controlled payload). Mirrors the
 *     agent-presence registry's `AgentRecordOrigin` vocabulary so the Network
 *     view badges peer observability the same way it badges peer agents.
 *
 * A foreign row can NEVER be stored as local: the fold path supplies the
 * source-bound `peer` and this module persists `origin_kind = 'foreign'` +
 * `origin_peer = peer`. The negative-control's identity half.
 */
export type ObservabilityOrigin =
  | "local"
  | { kind: "foreign"; peer: string };

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
  /**
   * P-14 U3.3 — origin badge. Defaults to `"local"` (the U2.1 contract: every
   * caller that doesn't set it is folding a local row). The federated fold path
   * passes `{ kind: "foreign"; peer }` with the chain-verified `{principal}/{stack}`.
   */
  origin?: ObservabilityOrigin;
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
  /** P-14 U3.3 — the row's origin badge (`"local"` or a foreign peer). */
  origin: ObservabilityOrigin;
  timestamp: string;
}

/**
 * Re-hydrate the `origin_kind`/`origin_peer` columns into an
 * {@link ObservabilityOrigin}. A `foreign` row with a missing/empty `origin_peer`
 * (defensive — the writer always pairs them) degrades to `local` rather than an
 * originless foreign badge, so the view never shows an un-attributed peer.
 */
function rowOrigin(originKind: unknown, originPeer: unknown): ObservabilityOrigin {
  if (originKind === "foreign" && typeof originPeer === "string" && originPeer.length > 0) {
    return { kind: "foreign", peer: originPeer };
  }
  return "local";
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
  const origin = e.origin ?? "local";
  const originKind = origin === "local" ? "local" : "foreign";
  const originPeer = origin === "local" ? null : origin.peer;
  const res = db
    .query(
      `INSERT INTO observability_events
         (id, envelope_id, family, type, stack_id, summary, payload, origin_kind, origin_peer, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
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
      originKind,
      originPeer,
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
            `SELECT id, envelope_id, family, type, stack_id, summary, origin_kind, origin_peer, timestamp
             FROM observability_events
             ORDER BY timestamp DESC, id DESC
             LIMIT ?`,
          )
          .all(limit)
      : db
          .query(
            `SELECT id, envelope_id, family, type, stack_id, summary, origin_kind, origin_peer, timestamp
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
    origin: rowOrigin(r.origin_kind, r.origin_peer),
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
  /**
   * P-14 U3.3 (#937) — origin badge. `"local"` for this principal's own hub
   * transport rows; `{ kind: "foreign"; peer }` for a TRUST-VERIFIED federated
   * peer's. The Network-view overlay carries this onto each peer-stack so a
   * folded foreign verdict is visually attributed to its peer, never shown as
   * local substrate health.
   */
  origin: ObservabilityOrigin;
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
      `SELECT id, type, stack_id, payload, origin_kind, origin_peer, timestamp
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
      origin: rowOrigin(r.origin_kind, r.origin_peer),
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
