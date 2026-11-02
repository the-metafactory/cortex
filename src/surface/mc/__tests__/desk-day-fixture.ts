import { afterEach, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AppState } from "../../../balance";
import { initDatabase } from "../db/init";
import { saveBalanceState } from "../desk/balance-store";
import type { DeskOptions } from "../desk/compose";
import { changeMyDay, localDay } from "../desk/my-day";
import type { MyDayCommand } from "../desk/my-day-schema";

export const NOW = new Date(2026, 9, 31, 10).getTime();
export const DATE = localDay(NOW);
export const desk: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [] }] };

export function dayDatabase(seed: () => AppState) {
  let current: Database | undefined;
  beforeEach(() => { current = initDatabase(":memory:"); saveBalanceState(current, seed()); });
  afterEach(() => { current?.close(); current = undefined; });
  const db = (): Database => {
    if (!current) throw new Error("The day database is only open inside a test.");
    return current;
  };
  return { db, change: (command: MyDayCommand, requestId: string = crypto.randomUUID()) => changeMyDay({ db: db(), desk, now: NOW, date: DATE, requestId, command }) };
}
