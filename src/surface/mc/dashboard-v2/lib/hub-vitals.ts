/**
 * cortex#1469 — Hub VITALS fold (pure).
 *
 * signal#154/#157 taught signal's transport collector to scrape the NATS hub's
 * `/varz` monitor endpoint and publish hub SERVER vitals — CPU, memory, client
 * connections, leafnode count, slow consumers — as
 * `system.transport.server-vitals` envelopes on every successful scrape tick.
 * Cortex's Mission Control already files the whole `system.transport.*` family
 * into `observability_events` (prefix routing,
 * `projection/observability-renderer.ts`), so these rows land in the DB today —
 * and reach the browser payload-bearing on `transportRoster`
 * (`api/observability-tab.ts`). Nothing read them until this fold.
 *
 * ## SOURCED FROM SIGNAL — never re-derived (CONTEXT.md §Sourced-from-signal)
 *
 * cortex does not compute hub health. Every field here is taken VERBATIM from
 * the `payload.vitals` body signal stamped from `/varz` (field names are
 * signal's `ServerVitals`, `src/lib/transport-observability/leafz-parser.ts`).
 * We only pick the NEWEST row per network and carry the numbers through.
 *
 * ## Wire-type spelling (the one that exists)
 *
 * The matched row `type` is the HYPHEN form `system.transport.server-vitals`.
 * signal maps subject-tail `_`→`-` in `envelope.type`, and cortex's vendored
 * myelin schema forbids `_` types — so `system.transport.server_vitals`
 * (underscore) is a SUBJECT string that NEVER appears as a body/row `type`.
 * Matching the underscore spelling would match nothing (cortex#1467/#1469).
 *
 * Pure + DOM-free → unit-testable against the canonical server-vitals fixture.
 */

import type { TransportRosterEventRow } from "../../api/observability-tab";

/**
 * The hub-vitals row `type` — HYPHEN form, the only spelling on the wire. THE
 * single source of truth for the matcher spelling; import it rather than
 * hard-coding a string a future edit could drift to the underscore (impossible)
 * form.
 */
export const HUB_VITALS_TYPE = "system.transport.server-vitals" as const;

/** One network's latest hub vitals, folded from the newest server-vitals row. */
export interface HubVitals {
  /** The network this hub serves (from the envelope `payload.network`). */
  network: string;
  /** NATS `server_name`, or null when signal reported it absent. */
  serverName: string | null;
  /** NATS server version string, or null. */
  version: string | null;
  /** Server uptime as signal's raw NATS string (e.g. "3d4h5m6s"), or null. */
  uptime: string | null;
  /** Current client connections. */
  connections: number;
  /** Current leaf-node connections (roster size from the server's view). */
  leafnodes: number;
  /** Slow-consumer count — the headline back-pressure signal. */
  slowConsumers: number;
  /** Resident memory in bytes. */
  mem: number;
  /** CPU usage percent as NATS reports it (0–100·cores). */
  cpu: number;
  /** The scrape row's timestamp (ISO-8601) — the basis for scrape age. */
  timestamp: string;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Fold transport-roster rows into the latest hub vitals PER NETWORK.
 *
 * - Keeps only rows whose `type` is {@link HUB_VITALS_TYPE} (hyphen form) — a
 *   non-vitals transport row (e.g. `system.transport.leaf-connect`) is ignored.
 * - Rows arrive newest-first (the DB read's `ORDER BY timestamp DESC`); the
 *   fold keeps the FIRST seen per `payload.network`, so the newest scrape wins
 *   without any clock comparison.
 * - Skips a row with no readable `payload.network` string or a missing/
 *   non-object `payload.vitals` (a malformed or `{}` body degrades to skipped,
 *   never a throw). Null string fields are tolerated and carried as null.
 *
 * Result is sorted by network name for a stable strip render.
 */
export function foldHubVitals(
  rows: readonly TransportRosterEventRow[],
): HubVitals[] {
  const byNetwork = new Map<string, HubVitals>();

  for (const row of rows) {
    if (row.type !== HUB_VITALS_TYPE) continue;

    const network = asStringOrNull(row.payload.network);
    if (network === null) continue;
    if (byNetwork.has(network)) continue; // newest-first: first seen wins.

    const vitals = row.payload.vitals;
    if (!isRecord(vitals)) continue;

    byNetwork.set(network, {
      network,
      serverName: asStringOrNull(vitals.server_name),
      version: asStringOrNull(vitals.version),
      uptime: asStringOrNull(vitals.uptime),
      connections: asNumber(vitals.connections),
      leafnodes: asNumber(vitals.leafnodes),
      slowConsumers: asNumber(vitals.slow_consumers),
      mem: asNumber(vitals.mem),
      cpu: asNumber(vitals.cpu),
      timestamp: row.timestamp,
    });
  }

  return [...byNetwork.values()].sort((a, b) =>
    a.network < b.network ? -1 : a.network > b.network ? 1 : 0,
  );
}

/** Humanize a byte count to a compact `B`/`KB`/`MB`/`GB` string (base-1024). */
export function humanizeBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format a scrape age (ms between the row timestamp and now) as a compact
 * "Xs ago" / "Xm ago" / "Xh ago" / "Xd ago". Negative/NaN → "just now".
 */
export function formatScrapeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "just now";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Scrape age for a vitals row given the current epoch-ms. Parses the row
 * timestamp; an unparseable timestamp degrades to "just now" rather than NaN.
 */
export function scrapeAge(vitals: HubVitals, nowMs: number): string {
  const then = Date.parse(vitals.timestamp);
  if (Number.isNaN(then)) return "just now";
  return formatScrapeAge(nowMs - then);
}
