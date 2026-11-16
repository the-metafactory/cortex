import assert from "node:assert/strict";
import { deskFixtureOptions } from "../src/surface/mc/__tests__/fixtures/desk-options-fixture";
import { HandledLedger } from "../src/surface/mc/desk/actions";
import { loadBalanceState, saveBalanceState } from "../src/surface/mc/desk/balance-store";
import { initDatabase } from "../src/surface/mc/db/init";
import { handleDeskMyDay } from "../src/surface/mc/api/desk-my-day";
import { DEFAULT_SETTINGS, findNode, type AppState, type OutlineNode } from "../src/balance";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

const date = "2026-11-12";
const now = new Date(2026, 10, 12, 10).getTime();
const dir = mkdtempSync(join(tmpdir(), "probe-desk-outline-time-"));
const path = join(dir, "store.sqlite");
let db = initDatabase(path);
const work: OutlineNode = { id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [] };
const state: AppState = { outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [work] }, settings: { ...DEFAULT_SETTINGS }, history: { deficits: {}, lastSurfaced: {} }, log: [], dayState: null };
saveBalanceState(db, state);
const ledger = new HandledLedger();
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => handleDeskMyDay(request, db, { ledger, options: deskFixtureOptions }, undefined, now) });
const url = new URL("/api/desk/my-day", server.url);
type View = { revision: number; outline: OutlineNode; items: { task: OutlineNode }[] };
const read = async () => (await (await fetch(url)).json()) as View;
const send = async (command: Record<string, unknown>) => {
  const response = await fetch(url, { method: "POST", body: JSON.stringify({ date, requestId: crypto.randomUUID(), command }) });
  return { status: response.status, body: (await response.json()) as { outlineId?: string } };
};
const reopen = () => {
  db.close();
  db = initDatabase(path);
  return loadBalanceState(db) as AppState;
};
try {
  const added = await send({ op: "outline-add", revision: (await read()).revision, parent: "area:work", title: "Water plants", dueDate: "2026-11-16", startDate: "2026-11-13", deferredUntil: "2026-11-14", repeat: { unit: "week", interval: 2, weekdays: [1, 4] } });
  assert.equal(added.status, 200);
  const id = added.body.outlineId as string;
  let node = findNode((await read()).outline, id) as OutlineNode;
  assert.equal(node.repeat?.mode, "calendar");
  const afterAdd = { startDate: node.startDate, deferredUntil: node.deferredUntil, repeat: node.repeat };
  const edit = async (patch: Record<string, unknown>) => {
    const current = await read();
    const found = findNode(current.outline, id) as OutlineNode;
    const details = { title: found.title, weight: found.weight, note: found.note ?? "", ordering: found.ordering, focus: false, dueDate: found.dueDate ?? "", context: "", effort: found.effort ?? 1, estimateMinutes: null, ...patch };
    return send({ op: "outline-edit", id, revision: current.revision, details, yes: false });
  };
  assert.equal((await edit({ repeat: { unit: "day", interval: 3, mode: "completion" } })).status, 200);
  const afterEdit = (await read()).outline && findNode((await read()).outline, id)?.repeat;
  assert.equal((await edit({ startDate: "" })).status, 200);
  assert.equal((await edit({ deferredUntil: "" })).status, 200);
  assert.equal((await edit({ repeat: null })).status, 200);
  node = findNode(reopen().outline, id) as OutlineNode;
  assert.equal(node.startDate, undefined);
  assert.equal(node.deferredUntil, undefined);
  assert.equal(node.repeat, undefined);
  const invalid = await edit({ startDate: "2026-02-31" });
  assert.notEqual(invalid.status, 200);
  assert.equal((await send({ op: "defer", id })).status, 200);
  const stored = findNode(reopen().outline, id)?.deferredUntil;
  const served = findNode((await read()).outline, id)?.deferredUntil;
  assert.equal(stored, "2026-11-13");
  assert.equal(served, stored);
  assert.equal((await edit({ deferredUntil: "" })).status, 200);
  assert.equal(findNode(reopen().outline, id)?.deferredUntil, undefined);
  console.log(JSON.stringify({ afterAdd, afterEdit, clearedAll: true, invalidStatus: invalid.status, cardDeferral: stored, outlineDeferral: served, clearedThroughOutline: true, temporaryStackOnly: true }));
} finally {
  await server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
