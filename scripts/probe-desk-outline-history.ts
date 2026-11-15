import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type AppState, type OutlineNode, type RecurrenceOutcome } from "../src/balance";
import { handleDeskOutlineHistory, type OutlineHistoryPage } from "../src/surface/mc/api/desk-outline-history";
import { initDatabase } from "../src/surface/mc/db/init";
import { HandledLedger } from "../src/surface/mc/desk/actions";
import { saveBalanceState } from "../src/surface/mc/desk/balance-store";
import { deskFixtureOptions } from "../src/surface/mc/__tests__/fixtures/desk-options-fixture";

const dir = mkdtempSync(join(tmpdir(), "probe-desk-outline-history-"));
const db = initDatabase(join(dir, "store.sqlite"));
const task: OutlineNode = { id: "weekly", title: "Weekly review", weight: 50, ordering: "parallel", effort: 1, children: [], repeat: { unit: "week", interval: 1, mode: "calendar", anchor: "2026-11-02" } };
const outcomes: RecurrenceOutcome[] = [
  { taskId: "weekly", planned: "2026-10-05", status: "completed", completedOn: "2026-10-07", recordedOn: "2026-10-07" },
  { taskId: "weekly", planned: "2026-10-12", status: "skipped", skippedOn: "2026-10-12", recordedOn: "2026-10-12" },
  { taskId: "weekly", planned: "2026-10-19", status: "missed", recordedOn: "2026-10-26" },
  { taskId: "weekly", planned: "2026-10-26", status: "completed", completedOn: "2026-10-26", recordedOn: "2026-10-26" },
  { taskId: "weekly", planned: "2026-10-26", status: "skipped", skippedOn: "2026-10-27", recordedOn: "2026-10-27" },
];
const state: AppState = { outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [task] }] }, settings: { ...DEFAULT_SETTINGS }, history: { deficits: {}, lastSurfaced: {} }, log: [], dayState: null, outcomes };
saveBalanceState(db, state);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => handleDeskOutlineHistory(req, db, { options: deskFixtureOptions, ledger: new HandledLedger() }) });
try {
  const pages: OutlineHistoryPage[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL("/api/desk/outline/history", server.url);
    url.searchParams.set("task", "weekly");
    url.searchParams.set("limit", "2");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const page = (await response.json()) as OutlineHistoryPage;
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  const all = pages.flatMap(p => p.outcomes);
  assert.ok(pages.length >= 2);
  assert.equal(all.length, outcomes.length);
  assert.deepEqual(all.map(o => `${o.planned}:${o.outcome}:${o.actionDate}`).sort(), outcomes.map(o => `${o.planned}:${o.status}:${o.completedOn ?? o.skippedOn ?? null}`).sort());
  assert.equal(all.find(o => o.outcome === "missed")?.actionDate, null);
  console.log(JSON.stringify({ pages: pages.length, sizes: pages.map(p => p.outcomes.length), total: all.length, timeline: all.map(o => [o.planned, o.outcome, o.actionDate]), temporaryStackOnly: true }));
} finally {
  await server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
