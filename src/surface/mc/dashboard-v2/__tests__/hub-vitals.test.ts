/**
 * cortex#1469 — hub-vitals fold + helpers.
 *
 * Two layers:
 *   1. FULL PATH — the canonical server-vitals fixture (provenance-pinned from
 *      signal's builder, cortex#1467) is asserted valid via `validateEnvelope`
 *      BEFORE folding, projected through the REAL observability projection into
 *      an in-memory DB, read back via `listTransportRosterEvents` (the exact
 *      read `transportRoster` uses), and folded — so the row shape the fold sees
 *      is production's, not a hand-built stub.
 *   2. UNIT — the pure fold's tolerance rules (newest-per-network wins, non-
 *      vitals transport rows ignored, malformed/`{}` payloads skipped, empty →
 *      empty) + the byte/scrape-age formatters.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { validateEnvelope } from "../../../../bus/myelin/envelope-validator";
import { projectObservability } from "../../projection/observability-renderer";
import { listTransportRosterEvents } from "../../db/observability";
import { SCHEMA_SQL } from "../../db/schema";
import type { TransportRosterEventRow } from "../../api/observability-tab";
import {
  SERVER_VITALS_FIXTURE,
  CANONICAL_SERVER_VITALS,
  makeServerVitalsEnvelope,
  toUnderscoreType,
  TRANSPORT_TYPES,
} from "../../__tests__/__fixtures__/signal-transport-envelopes";
import {
  foldHubVitals,
  humanizeBytes,
  formatScrapeAge,
  scrapeAge,
  HUB_VITALS_TYPE,
} from "../lib/hub-vitals";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

/** Build a production-shaped transport-roster row without the DB round-trip. */
function row(
  over: Partial<TransportRosterEventRow> & { type: string; payload: Record<string, unknown> },
): TransportRosterEventRow {
  return {
    id: crypto.randomUUID(),
    stackId: null,
    origin: "local",
    timestamp: "2026-06-12T00:00:00.000Z",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. FULL PATH — validate → project → read → fold (AC: assert validity first).
// ---------------------------------------------------------------------------

describe("hub vitals — canonical fixture through the real projection", () => {
  let db: Database;
  beforeEach(() => (db = setupDb()));
  afterEach(() => db.close());

  it("the canonical server-vitals envelope PASSES validateEnvelope", () => {
    const result = validateEnvelope(SERVER_VITALS_FIXTURE.envelope);
    if (!result.ok) {
      throw new Error(
        `validateEnvelope rejected the canonical server-vitals fixture: ${JSON.stringify(result.errors)}`,
      );
    }
    expect(result.ok).toBe(true);
  });

  it("projects into transport family and folds to the seeded vitals numbers", () => {
    // Validity asserted BEFORE folding, per the acceptance criterion.
    expect(validateEnvelope(SERVER_VITALS_FIXTURE.envelope).ok).toBe(true);

    const family = projectObservability(db, SERVER_VITALS_FIXTURE.envelope, undefined);
    expect(family).toBe("transport");

    const rows = listTransportRosterEvents(db, 200);
    const vitals = foldHubVitals(rows);

    expect(vitals).toHaveLength(1);
    const v = vitals[0]!;
    expect(v.network).toBe("metafactory-community");
    expect(v.serverName).toBe("metafactory-hub");
    expect(v.cpu).toBe(CANONICAL_SERVER_VITALS.cpu); // 12.5
    expect(v.mem).toBe(CANONICAL_SERVER_VITALS.mem); // 134217728
    expect(v.connections).toBe(5);
    expect(v.leafnodes).toBe(2);
    expect(v.slowConsumers).toBe(1);
    expect(humanizeBytes(v.mem)).toBe("128.0 MB");
  });
});

// ---------------------------------------------------------------------------
// 2. UNIT — the pure fold's tolerance rules.
// ---------------------------------------------------------------------------

describe("foldHubVitals — tolerance + newest-per-network", () => {
  it("empty input folds to empty output", () => {
    expect(foldHubVitals([])).toEqual([]);
  });

  it("keeps the NEWEST row per network (rows arrive newest-first)", () => {
    const newer = row({
      type: HUB_VITALS_TYPE,
      timestamp: "2026-06-12T00:10:00.000Z",
      payload: { network: "alpha", vitals: { ...CANONICAL_SERVER_VITALS, cpu: 99.9 } },
    });
    const older = row({
      type: HUB_VITALS_TYPE,
      timestamp: "2026-06-12T00:00:00.000Z",
      payload: { network: "alpha", vitals: { ...CANONICAL_SERVER_VITALS, cpu: 1.1 } },
    });
    // newest-first order (DB ORDER BY timestamp DESC).
    const vitals = foldHubVitals([newer, older]);
    expect(vitals).toHaveLength(1);
    expect(vitals[0]!.cpu).toBe(99.9);
  });

  it("folds one entry per distinct network, sorted by network name", () => {
    const vitals = foldHubVitals([
      row({ type: HUB_VITALS_TYPE, payload: { network: "beta", vitals: CANONICAL_SERVER_VITALS } }),
      row({ type: HUB_VITALS_TYPE, payload: { network: "alpha", vitals: CANONICAL_SERVER_VITALS } }),
    ]);
    expect(vitals.map((v) => v.network)).toEqual(["alpha", "beta"]);
  });

  it("ignores non-vitals transport rows (e.g. leaf-connect)", () => {
    const vitals = foldHubVitals([
      row({
        type: TRANSPORT_TYPES.leafConnect,
        payload: { network: "alpha", leaf: { principal: "jc", stack: "default" } },
      }),
    ]);
    expect(vitals).toEqual([]);
  });

  it("skips a row with a missing/non-object vitals body", () => {
    const vitals = foldHubVitals([
      row({ type: HUB_VITALS_TYPE, payload: { network: "alpha" } }), // no vitals
      row({ type: HUB_VITALS_TYPE, payload: { network: "beta", vitals: {} as unknown } }),
    ]);
    // `{}` vitals is an object → folds (numbers default to 0); missing vitals → skipped.
    expect(vitals.map((v) => v.network)).toEqual(["beta"]);
    expect(vitals[0]!.cpu).toBe(0);
    expect(vitals[0]!.serverName).toBeNull();
  });

  it("skips a row with no readable network", () => {
    const vitals = foldHubVitals([
      row({ type: HUB_VITALS_TYPE, payload: { vitals: CANONICAL_SERVER_VITALS } }), // no network
    ]);
    expect(vitals).toEqual([]);
  });

  it("tolerates null string fields (carries them as null)", () => {
    const env = makeServerVitalsEnvelope("gamma", { server_name: null, version: null, uptime: null });
    const payload = (env as unknown as { payload: Record<string, unknown> }).payload;
    const vitals = foldHubVitals([row({ type: HUB_VITALS_TYPE, payload })]);
    expect(vitals).toHaveLength(1);
    expect(vitals[0]!.serverName).toBeNull();
    expect(vitals[0]!.uptime).toBeNull();
    // numeric fields still fold.
    expect(vitals[0]!.connections).toBe(5);
  });

  it("matches ONLY the hyphen type — the underscore spelling never folds", () => {
    // The underscore body a real envelope can never carry (subject-only spelling).
    // Build it via toUnderscoreType so the impossible literal never appears as a
    // type string in this tree (cortex#1469 PROHIBITION + AC underscore grep).
    const vitals = foldHubVitals([
      row({
        type: toUnderscoreType(HUB_VITALS_TYPE),
        payload: { network: "alpha", vitals: CANONICAL_SERVER_VITALS },
      }),
    ]);
    expect(vitals).toEqual([]);
  });
});

describe("humanizeBytes", () => {
  it("formats across unit boundaries", () => {
    expect(humanizeBytes(512)).toBe("512 B");
    expect(humanizeBytes(1536)).toBe("1.5 KB");
    expect(humanizeBytes(134217728)).toBe("128.0 MB");
    expect(humanizeBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
  it("degrades a negative/NaN byte count to an em dash", () => {
    expect(humanizeBytes(-1)).toBe("—");
    expect(humanizeBytes(Number.NaN)).toBe("—");
  });
});

describe("formatScrapeAge / scrapeAge", () => {
  it("formats seconds, minutes, hours, days", () => {
    expect(formatScrapeAge(5_000)).toBe("5s ago");
    expect(formatScrapeAge(90_000)).toBe("1m ago");
    expect(formatScrapeAge(2 * 3600_000)).toBe("2h ago");
    expect(formatScrapeAge(3 * 86_400_000)).toBe("3d ago");
  });
  it("degrades a negative/NaN age to 'just now'", () => {
    expect(formatScrapeAge(-1)).toBe("just now");
    expect(formatScrapeAge(Number.NaN)).toBe("just now");
  });
  it("scrapeAge derives the delta from the row timestamp and now", () => {
    const v = foldHubVitals([
      row({
        type: HUB_VITALS_TYPE,
        timestamp: "2026-06-12T00:00:00.000Z",
        payload: { network: "alpha", vitals: CANONICAL_SERVER_VITALS },
      }),
    ])[0]!;
    const now = Date.parse("2026-06-12T00:00:30.000Z");
    expect(scrapeAge(v, now)).toBe("30s ago");
  });
  it("degrades an unparseable timestamp to 'just now'", () => {
    const v = foldHubVitals([
      row({ type: HUB_VITALS_TYPE, timestamp: "not-a-date", payload: { network: "alpha", vitals: CANONICAL_SERVER_VITALS } }),
    ])[0]!;
    expect(scrapeAge(v, Date.parse("2026-06-12T00:00:30.000Z"))).toBe("just now");
  });
});
