import { expect, test } from "bun:test";
import { initDatabase } from "../../surface/mc/db/init";
import { getVigilTextsSpent, recordVigilTextReceipt } from "../db";
import { temporaryVigilDatabaseFile } from "./fixtures";

test("receipt storage upgrades an existing database and deduplication survives reopening", () => {
  using file = temporaryVigilDatabaseFile("vigil-receipts-");
  const old = initDatabase(file.path);
  old.run("DROP TABLE vigil_text_receipts");
  old.close();
  const receipt = { event_id: "event", subject_key: "state:goal:default:G1", budget_day: "2026-10-16" };
  const migrated = initDatabase(file.path);
  try {
    recordVigilTextReceipt(migrated, receipt);
    expect(getVigilTextsSpent(migrated, receipt.budget_day)).toBe(1);
  } finally { migrated.close(); }
  const reopened = initDatabase(file.path);
  try {
    recordVigilTextReceipt(reopened, receipt);
    recordVigilTextReceipt(reopened, { ...receipt, budget_day: "2026-10-17" });
    expect(getVigilTextsSpent(reopened, receipt.budget_day)).toBe(1);
    expect(getVigilTextsSpent(reopened, "2026-10-17")).toBe(0);
    expect(reopened.query("SELECT * FROM vigil_text_receipts").all()).toEqual([receipt]);
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { reopened.close(); }
});

test("a failed budget write rolls back the receipt identity so redelivery can retry", () => {
  const db = initDatabase(":memory:");
  const receipt = { event_id: "event", subject_key: "state:goal:default:G1", budget_day: "2026-10-16" };
  try {
    db.run("CREATE TRIGGER fail_budget BEFORE INSERT ON vigil_budget BEGIN SELECT RAISE(ABORT, 'budget unavailable'); END");
    expect(() => recordVigilTextReceipt(db, receipt)).toThrow("budget unavailable");
    expect(db.query("SELECT * FROM vigil_text_receipts").all()).toEqual([]);
    db.run("DROP TRIGGER fail_budget");
    recordVigilTextReceipt(db, receipt);
    expect(getVigilTextsSpent(db, receipt.budget_day)).toBe(1);
  } finally { db.close(); }
});
