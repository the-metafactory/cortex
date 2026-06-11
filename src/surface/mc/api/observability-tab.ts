/**
 * P-14 U2.1 (#934) — GET /api/observability-events.
 *
 * Read-only surface over `observability_events` (the projection of signal's four
 * `system.*` families) for the MC Observability tab. Returns each section's
 * recent rows + per-family counts. NOT to be confused with `/api/observability/*`
 * (U0.1's Tier-3 sideband trace/timeline proxy) — distinct path, distinct concern.
 *
 * The hub-scope caveat is the CONSUMER's to render honestly: a non-hub stack has
 * zero `federation` / `transport` rows, and the response simply reflects that
 * (empty arrays, zero counts). This handler NEVER synthesizes rows to paper over
 * an empty family — an empty section is the truth, not a defect.
 */

import type { Database } from "bun:sqlite";

import {
  listObservabilityEvents,
  countObservabilityByFamily,
  OBSERVABILITY_FAMILIES,
  type ObservabilityEventRow,
  type ObservabilityCounts,
  type ObservabilityFamily,
} from "../db/observability";

/** Per-family cap on rows returned to the tab. */
export const OBSERVABILITY_LIST_CAP = 200;

export interface ObservabilityResponse {
  /** Recent rows per family, newest first (each capped at {@link OBSERVABILITY_LIST_CAP}). */
  byFamily: Record<ObservabilityFamily, ObservabilityEventRow[]>;
  /** Per-family total row counts (a zero-row family is present with 0). */
  counts: Record<ObservabilityFamily, number>;
  listCap: number;
}

export function getObservability(db: Database): ObservabilityResponse {
  const rawCounts: ObservabilityCounts = countObservabilityByFamily(db);
  const byFamily = {} as Record<ObservabilityFamily, ObservabilityEventRow[]>;
  const counts = {} as Record<ObservabilityFamily, number>;
  for (const family of OBSERVABILITY_FAMILIES) {
    byFamily[family] = listObservabilityEvents(db, OBSERVABILITY_LIST_CAP, family);
    counts[family] = rawCounts[family] ?? 0;
  }
  return { byFamily, counts, listCap: OBSERVABILITY_LIST_CAP };
}

/** GET /api/observability-events — per-section rows + counts for the tab. */
export function handleGetObservability(db: Database): Response {
  return new Response(JSON.stringify(getObservability(db)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
