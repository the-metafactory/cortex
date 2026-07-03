/**
 * cortex#1467 — canonical transport-envelope ANTI-DRIFT suite.
 *
 * The U2.3 overlay + U2.1 attention arms shipped DEAD because cortex's fixtures
 * pinned an impossible underscore-typed body and called the fold/producer
 * DIRECTLY, bypassing AJV — green suites against a wire shape that can never
 * occur (signal maps subject-tail `_`→`-` in `envelope.type`, and the myelin
 * schema rejects `_` types; validation runs BEFORE the router). This suite closes
 * that hole three ways, all driven by provenance-pinned fixtures reproduced from
 * signal's builder output (signal `main` @ 81eebaa):
 *
 *   1. ANTI-DRIFT — each family's fixture is routed through `validateEnvelope`;
 *      the hyphen form PASSES and the underscore form FAILS. A future fixture
 *      that regresses to the impossible spelling now fails the suite (signal pins
 *      the same at canonical-envelope-schema.test.ts:319).
 *   2. AC1 — each canonical hyphen-typed row drives `buildTransportOverlay` to
 *      NON-EMPTY output; no family falls through to `default: return []`.
 *   3. AC2 — `produceObservabilityAttention` OPENS on `leaf-disconnect` and
 *      RESOLVES on `leaf-connect`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { validateEnvelope } from "../../../bus/myelin/envelope-validator";
import {
  buildTransportOverlay,
  overlayForStack,
} from "../dashboard-v2/lib/network-transport-overlay";
import { produceObservabilityAttention } from "../projection/observability-attention";
import { ADAPTER_ATTENTION_PREFIX } from "../projection/adapter-lifecycle";
import { SCHEMA_SQL } from "../db/schema";
import type { TransportRosterEventRow } from "../api/observability-tab";
import {
  TRANSPORT_TYPES,
  TRANSPORT_FAMILY_FIXTURES,
  makeTransportEnvelope,
  toUnderscoreType,
} from "./__fixtures__/signal-transport-envelopes";

// ---------------------------------------------------------------------------
// 1. ANTI-DRIFT — the fixture envelopes clear cortex's vendored myelin schema,
//    and the impossible underscore body is rejected. (cortex#1467 step 4)
// ---------------------------------------------------------------------------

describe("canonical transport fixtures — validateEnvelope anti-drift", () => {
  for (const fx of TRANSPORT_FAMILY_FIXTURES) {
    it(`${fx.family}: the canonical hyphen-typed envelope PASSES validateEnvelope`, () => {
      const result = validateEnvelope(fx.envelope);
      // Surface the AJV errors on failure so any drift is diagnosable.
      if (!result.ok) {
        throw new Error(
          `validateEnvelope rejected canonical ${fx.family}: ${JSON.stringify(result.errors)}`,
        );
      }
      expect(result.ok).toBe(true);
    });

    it(`${fx.family}: flipping the body type to the underscore form is REJECTED`, () => {
      // The exact hole the old fixtures exploited: an underscore `type` never
      // survives AJV (myelin type grammar forbids `_`), so it could only ever be
      // "tested" by bypassing validation. Prove the schema bites.
      const bad = makeTransportEnvelope(fx.type, { payload: fx.payload });
      (bad as unknown as { type: string }).type = toUnderscoreType(fx.type);
      expect(validateEnvelope(bad).ok).toBe(false);
    });
  }

  it("the four fixtures cover exactly the four hyphen-typed families", () => {
    expect(TRANSPORT_FAMILY_FIXTURES.map((f) => f.type).sort()).toEqual(
      [
        TRANSPORT_TYPES.leafConnect,
        TRANSPORT_TYPES.leafDisconnect,
        TRANSPORT_TYPES.livenessDrift,
        TRANSPORT_TYPES.rosterSnapshot,
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. AC1 — a canonical hyphen-typed row drives buildTransportOverlay to
//    non-empty output for EVERY family (no default fall-through).
// ---------------------------------------------------------------------------

/** Project one canonical fixture into the DB-row shape the overlay folds. */
function rowFor(type: string, payload: Record<string, unknown>): TransportRosterEventRow {
  return {
    id: crypto.randomUUID(),
    type,
    stackId: "metafactory-community",
    payload,
    origin: "local",
    timestamp: "2026-06-12T00:00:00.000Z",
  };
}

describe("buildTransportOverlay — per-family non-empty fold (AC1)", () => {
  for (const fx of TRANSPORT_FAMILY_FIXTURES) {
    it(`${fx.family}: folds to a non-empty overlay (never hits default: [])`, () => {
      const overlay = buildTransportOverlay([rowFor(fx.type, fx.payload)]);
      expect(overlay.byKey.size).toBeGreaterThan(0);
      const peer = overlayForStack(overlay, fx.peer.principal, fx.peer.stack);
      expect(peer).not.toBeNull();
    });
  }

  it("the underscore body a real envelope can never carry folds to EMPTY (default arm)", () => {
    // Belt: proves the overlay's exact-match arms are what the respell fixed —
    // the pre-fix underscore spelling is exactly the dead `default: return []`.
    const overlay = buildTransportOverlay([
      rowFor(toUnderscoreType(TRANSPORT_TYPES.leafConnect), { leaf: { principal: "jc", stack: "default" } }),
    ]);
    expect(overlay.byKey.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. AC2 — attention OPENS on leaf-disconnect, RESOLVES on leaf-connect.
// ---------------------------------------------------------------------------

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

function attentionStatus(db: Database, id: string): string | null {
  const row = db.query(`SELECT status FROM attention_items WHERE id = ?`).get(id) as
    | { status: string }
    | null;
  return row?.status ?? null;
}

describe("produceObservabilityAttention — leaf open/resolve (AC2)", () => {
  let db: Database;
  beforeEach(() => (db = setupDb()));
  afterEach(() => db.close());

  it("OPENS on system.transport.leaf-disconnect and RESOLVES on system.transport.leaf-connect", () => {
    const opened = produceObservabilityAttention(db, {
      type: TRANSPORT_TYPES.leafDisconnect,
      payload: { leaf: "jc/default" },
    });
    expect(opened).toMatchObject({ action: "opened" });
    expect(opened?.itemId.startsWith(`${ADAPTER_ATTENTION_PREFIX}transport:`)).toBe(true);
    expect(attentionStatus(db, opened!.itemId)).toBe("open");

    const resolved = produceObservabilityAttention(db, {
      type: TRANSPORT_TYPES.leafConnect,
      payload: { leaf: "jc/default" },
    });
    expect(resolved).toMatchObject({ action: "resolved" });
    // Same origin id → same item → the open transitions to resolved.
    expect(resolved?.itemId).toBe(opened?.itemId);
    expect(attentionStatus(db, opened!.itemId)).toBe("resolved");
  });
});
