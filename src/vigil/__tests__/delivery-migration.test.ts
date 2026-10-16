import { expect, test } from "bun:test";
import { initDatabase } from "../../surface/mc/db/init";
import { getVigilTextsSpent, listVigilEvents, type VigilEventRow } from "../db";
import { flushTexts } from "../flush";
import { ingestLedgerEnvelope } from "../ingest";
import { DELIVERY_DEFAULTS, ENDED_AT, KEY, ledgerEnvelope, temporaryVigilDatabaseFile } from "./fixtures";

test("delivery columns migrate without losing rows and retries survive reopening", async () => {
  using file = temporaryVigilDatabaseFile("vigil-delivery-");
  const { path } = file;
  const old = initDatabase(path);
  ingestLedgerEnvelope(old, ledgerEnvelope({ serves: { goal: "G1" } }), ENDED_AT);
  const columns = ["held_reason", "sent_at", "via", "attempts", "last_error", "transient_failures"];
  for (const column of columns) old.run(`ALTER TABLE vigil_events DROP COLUMN ${column}`);
  const historical = old.query<Omit<VigilEventRow, keyof typeof DELIVERY_DEFAULTS>, []>("SELECT * FROM vigil_events").all();
  const subjects = old.query("SELECT * FROM vigil_subjects").all();
  old.close();

  const migrated = initDatabase(path);
  let attempted;
  const now = Date.parse("2026-10-16T10:00:00Z");
  try {
    expect(listVigilEvents(migrated, KEY)).toEqual(historical.map((event) => ({
      ...event, ...DELIVERY_DEFAULTS,
    })));
    expect(migrated.query("SELECT * FROM vigil_subjects").all()).toEqual(subjects);
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    for (const update of ["held_reason = 'invalid'", "via = 'invalid'", "attempts = -1", "attempts = NULL", "transient_failures = -1"]) {
      expect(() => migrated.run(`UPDATE vigil_events SET ${update}`)).toThrow();
    }
    await flushTexts({ db: migrated, now, send: async () => ({ delivered: false, kind: "transient", code: "network" }) });
    attempted = listVigilEvents(migrated, KEY);
    expect(attempted[0]).toMatchObject({ delivery: "pending", attempts: 1, last_error: "network", transient_failures: 1 });
  } finally { migrated.close(); }

  const reopened = initDatabase(path);
  try {
    expect(listVigilEvents(reopened, KEY)).toEqual(attempted);
    expect(reopened.query("SELECT * FROM vigil_subjects").all()).toEqual(subjects);
    const batches: number[] = [];
    for (let i = 0; i < 2; i++) await flushTexts({
      db: reopened, now, send: async () => ({ delivered: false, kind: "transient", code: "timeout" }),
      fallback: async (batch) => { batches.push(batch.length); },
    });
    expect(batches).toEqual([1]);
    expect(listVigilEvents(reopened, KEY)[0]).toMatchObject({ delivery: "sent", via: "email", attempts: 3, transient_failures: 0 });
    expect(getVigilTextsSpent(reopened, "2026-10-16")).toBe(1);
  } finally { reopened.close(); }
});
