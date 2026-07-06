/**
 * cortex#1469 — hub-vitals STRIP render (SSR).
 *
 * SSR-renders the whole Observability tab through `renderToStaticMarkup` so the
 * strip is exercised WIRED IN (not in isolation), against a response built by
 * the REAL API assembler `getObservability` from a DB seeded with the canonical
 * server-vitals fixture. Pins:
 *   - REAL vitals numbers render (CPU %, humanized mem, connections, leafnodes,
 *     slow-consumers) with tabular numerals — from a fixture that passed
 *     `validateEnvelope` before projection;
 *   - the zero-row state renders the EXACT honest empty-state copy (signal#118),
 *     and no vitals table — never synthesized numbers.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { validateEnvelope } from "../../../../bus/myelin/envelope-validator";
import { projectObservability } from "../../projection/observability-renderer";
import { getObservability } from "../../api/observability-tab";
import { SCHEMA_SQL } from "../../db/schema";
import { ObservabilityView } from "../components/observability-view";
import { HUB_VITALS_EMPTY_NOTE } from "../components/observability-view";
import type { ObservabilityState } from "../hooks/use-observability";
import {
  SERVER_VITALS_FIXTURE,
  TRANSPORT_FAMILY_FIXTURES,
} from "../../__tests__/__fixtures__/signal-transport-envelopes";

const LEAF_CONNECT_FIXTURE = TRANSPORT_FAMILY_FIXTURES.find(
  (f) => f.family === "leaf-connect",
)!;

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

function renderTab(db: Database): string {
  const state: ObservabilityState = {
    data: getObservability(db),
    loaded: true,
    error: null,
  };
  return renderToStaticMarkup(createElement(ObservabilityView, { state }));
}

describe("HubVitalsStrip — render", () => {
  let db: Database;
  beforeEach(() => (db = setupDb()));
  afterEach(() => db.close());

  it("renders CPU/mem/connections/leafnodes/slow-consumers + age from a validated canonical row", () => {
    // Validity BEFORE folding/rendering (acceptance criterion).
    expect(validateEnvelope(SERVER_VITALS_FIXTURE.envelope).ok).toBe(true);
    projectObservability(db, SERVER_VITALS_FIXTURE.envelope, undefined);

    const html = renderTab(db);

    expect(html).toContain("Hub vitals");
    expect(html).toContain("metafactory-community"); // network name
    expect(html).toContain("12.5%"); // cpu
    expect(html).toContain("128.0 MB"); // mem, humanized
    expect(html).toContain("tnum"); // tabular numerals on the numeric cells
    // connections/leafnodes/slow-consumers land in tnum cells.
    expect(html).toContain("hub-vitals-strip");
    // The honest empty copy must NOT appear when a row exists.
    expect(html).not.toContain(HUB_VITALS_EMPTY_NOTE);
  });

  it("renders the EXACT honest empty-state copy on zero server-vitals rows", () => {
    const html = renderTab(db); // empty DB → no transport rows at all.
    expect(html).toContain(HUB_VITALS_EMPTY_NOTE);
    expect(html).not.toContain("hub-vitals-strip"); // no table, no synthetic numbers.
  });

  it("ignores a non-vitals transport row — strip stays in the empty state", () => {
    // A leaf-connect row lands in the transport family + roster, but is not a
    // vitals row, so the strip must not render it (and must show the empty copy).
    expect(validateEnvelope(LEAF_CONNECT_FIXTURE.envelope).ok).toBe(true);
    projectObservability(db, LEAF_CONNECT_FIXTURE.envelope, undefined);

    const html = renderTab(db);
    expect(html).toContain(HUB_VITALS_EMPTY_NOTE);
    expect(html).not.toContain("hub-vitals-strip");
  });
});
