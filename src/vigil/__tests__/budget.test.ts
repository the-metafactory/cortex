import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../../surface/mc/db/init";
import { TABLE_NAMES } from "../../surface/mc/db/schema";
import { budgetDay, canSendVigilText, inQuietHours } from "../budget";
import { getVigilTextsSpent, recordVigilTextDelivered } from "../db";

describe("Vigil Zurich budget clock", () => {
  test.each([
    ["2026-10-12T06:59:59+02:00", "2026-10-11", true],
    ["2026-10-12T07:00:00+02:00", "2026-10-12", false],
    ["2026-10-12T21:59:59+02:00", "2026-10-12", false],
    ["2026-10-12T22:00:00+02:00", "2026-10-12", true],
    ["2026-10-25T02:30:00+02:00", "2026-10-24", true],
    ["2026-10-25T02:30:00+01:00", "2026-10-24", true],
    ["2026-10-25T06:59:59+01:00", "2026-10-24", true],
    ["2026-10-25T07:00:00+01:00", "2026-10-25", false],
    ["2026-03-29T06:59:59+02:00", "2026-03-28", true],
    ["2026-03-29T07:00:00+02:00", "2026-03-29", false],
    ["2026-01-01T00:00:00+01:00", "2025-12-31", true],
    ["2028-03-01T06:59:59+01:00", "2028-02-29", true],
    ["2026-10-12T05:00:00Z", "2026-10-12", false],
  ] as const)("%s belongs to %s; quiet=%s", (instant, day, quiet) => {
    const now = new Date(instant);
    expect(budgetDay(now)).toBe(day);
    expect(inQuietHours(now)).toBe(quiet);
    expect(budgetDay(now.getTime())).toBe(day);
    expect(inQuietHours(now.getTime())).toBe(quiet);
  });
});

describe("Vigil budget storage and eligibility", () => {
  let db: Database;
  let clock: number;
  const now = () => clock;
  beforeEach(() => {
    db = initDatabase(":memory:");
    clock = Date.parse("2026-10-12T07:00:00+02:00");
  });
  afterEach(() => db.close());

  test("unseen days read zero without creating rows or borrowing yesterday's count", () => {
    recordVigilTextDelivered(db, "2026-10-11");
    expect(getVigilTextsSpent(db, budgetDay(now()))).toBe(0);
    expect(canSendVigilText(db, now())).toBe(true);
    expect(db.query("SELECT * FROM vigil_budget").all()).toEqual([
      { budget_day: "2026-10-11", texts_spent: 1 },
    ]);
    expect(TABLE_NAMES).toContain("vigil_budget");
  });

  test("only explicit confirmed deliveries spend; after three the fourth is refused", () => {
    for (let spent = 0; spent < 3; spent++) {
      // Checking an attempt's eligibility does not record a delivery.
      expect(canSendVigilText(db, now())).toBe(true);
      expect(canSendVigilText(db, now())).toBe(true);
      expect(getVigilTextsSpent(db, budgetDay(now()))).toBe(spent);
      recordVigilTextDelivered(db, budgetDay(now()));
    }
    expect(canSendVigilText(db, now())).toBe(false);
    expect(getVigilTextsSpent(db, budgetDay(now()))).toBe(3);
    clock = Date.parse("2026-10-13T06:59:59+02:00");
    expect(budgetDay(now())).toBe("2026-10-12");
    expect(canSendVigilText(db, now())).toBe(false);
    clock += 1000;
    expect(canSendVigilText(db, now())).toBe(true);
    expect(getVigilTextsSpent(db, budgetDay(now()))).toBe(0);
    expect(getVigilTextsSpent(db, "2026-10-12")).toBe(3);
  });

  test("quiet-hours refusal does not create or change a count", () => {
    clock = Date.parse("2026-10-12T06:59:59+02:00");
    expect(canSendVigilText(db, now())).toBe(false);
    expect(db.query("SELECT * FROM vigil_budget").all()).toEqual([]);
    clock = Date.parse("2026-10-12T21:59:59+02:00");
    recordVigilTextDelivered(db, budgetDay(now()));
    expect(canSendVigilText(db, now())).toBe(true);
    clock += 1000;
    expect(canSendVigilText(db, now())).toBe(false);
    expect(getVigilTextsSpent(db, budgetDay(now()))).toBe(1);
  });
});

test("budget schema upgrades an existing MC DB, survives reopen and repeated init", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-budget-"));
  const path = join(dir, "mc.sqlite");
  let db: Database | undefined;
  try {
    db = initDatabase(path);
    db.run("INSERT INTO tasks (id, title, principal_id, source_system) VALUES ('existing', 'Task', 'test', 'internal')");
    db.run("DROP TABLE vigil_budget"); // Existing MC schema before this migration.
    db.close();
    db = initDatabase(path);
    expect(db.query("SELECT id FROM tasks").all()).toEqual([{ id: "existing" }]);
    recordVigilTextDelivered(db, "2026-10-11");
    recordVigilTextDelivered(db, "2026-10-12");
    recordVigilTextDelivered(db, "2026-10-12");
    const version = db.query("PRAGMA schema_version").get();
    const reopened = initDatabase(path);
    try {
      expect(reopened.query("PRAGMA schema_version").get()).toEqual(version);
      expect(getVigilTextsSpent(reopened, "2026-10-11")).toBe(1);
      expect(getVigilTextsSpent(reopened, "2026-10-12")).toBe(2);
      recordVigilTextDelivered(reopened, "2026-10-12");
      expect(getVigilTextsSpent(db, "2026-10-12")).toBe(3);
    } finally {
      reopened.close();
    }
    db.close();
    db = initDatabase(path);
    expect(getVigilTextsSpent(db, "2026-10-12")).toBe(3);
    expect(getVigilTextsSpent(db, "2026-10-13")).toBe(0);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
