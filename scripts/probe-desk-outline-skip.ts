import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, findNode, type AppState, type OutlineNode } from "../src/balance";
import { handleDeskMyDay } from "../src/surface/mc/api/desk-my-day";
import { initDatabase } from "../src/surface/mc/db/init";
import { HandledLedger } from "../src/surface/mc/desk/actions";
import { loadBalanceState, saveBalanceState } from "../src/surface/mc/desk/balance-store";
import { deskFixtureOptions } from "../src/surface/mc/__tests__/fixtures/desk-options-fixture";

const dir = mkdtempSync(join(tmpdir(), "probe-desk-outline-skip-"));
const db = initDatabase(join(dir, "store.sqlite"));
const now = new Date(2026, 10, 12, 10).getTime();
const date = "2026-11-12";
const weeklyTask: OutlineNode = { id: "weekly", title: "Weekly review", weight: 50, ordering: "parallel", effort: 1, children: [], repeat: { unit: "week", interval: 1, weekdays: [1, 4], mode: "calendar", anchor: "2026-11-02", count: 3, timesDone: 1 } };
const work: OutlineNode = { id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [weeklyTask] };
const state: AppState = { outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [work] }, settings: { ...DEFAULT_SETTINGS }, history: { deficits: {}, lastSurfaced: {} }, log: [], dayState: null };
saveBalanceState(db, state);
const runtime = { options: deskFixtureOptions, ledger: new HandledLedger() };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => handleDeskMyDay(req, db, runtime, undefined, now) });
const url = new URL("/api/desk/my-day", server.url);
const outline = async () => (await (await fetch(url)).json()) as { revision: number };
try {
  const { revision } = await outline();
  const body = JSON.stringify({ date, requestId: crypto.randomUUID(), command: { op: "outline-skip", id: "weekly", revision, confirm: true } });
  const first = await fetch(url, { method: "POST", body });
  assert.equal(first.status, 200);
  await outline();
  const retry = await fetch(url, { method: "POST", body: JSON.stringify({ date, requestId: crypto.randomUUID(), command: { op: "outline-skip", id: "weekly", revision, confirm: true } }) });
  assert.equal(retry.status, 409);
  const stored = loadBalanceState(db);
  const weekly = stored && findNode(stored.outline, "weekly");
  assert.ok(weekly?.repeat);
  const skipped = (stored?.outcomes ?? []).filter(o => o.status === "skipped");
  assert.equal(skipped.length, 1);
  assert.equal(weekly.repeat.timesDone, 1);
  assert.equal(weekly.repeat.occurrence, "2026-11-16");
  assert.equal(stored?.log.length, 0);
  console.log(JSON.stringify({ firstStatus: first.status, retryStatus: retry.status, skipOutcomes: skipped.length, planned: skipped[0]?.planned, skippedOn: skipped[0]?.skippedOn, timesDone: weekly.repeat.timesDone, next: weekly.repeat.occurrence, temporaryStackOnly: true }));
} finally {
  await server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
