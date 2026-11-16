import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, findNode, type AppState, type OutlineNode } from "../src/balance";
import { handleDeskAsk, handleDeskCreate } from "../src/surface/mc/api/desk-ask";
import { handleDeskMyDay } from "../src/surface/mc/api/desk-my-day";
import { initDatabase } from "../src/surface/mc/db/init";
import { HandledLedger } from "../src/surface/mc/desk/actions";
import { saveBalanceState } from "../src/surface/mc/desk/balance-store";
import type { DeskRuntime } from "../src/surface/mc/desk/compose";
import type { RoutineRunner } from "../src/surface/mc/desk/routine-command";

const now = new Date(2026, 10, 16, 10).getTime();
const dir = mkdtempSync(join(tmpdir(), "probe-desk-repeating-row-"));
const db = initDatabase(join(dir, "store.sqlite"));
const work: OutlineNode = { id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [] };
const state: AppState = { outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [work] }, settings: { ...DEFAULT_SETTINGS }, history: { deficits: {}, lastSurfaced: {} }, log: [], dayState: null };
saveBalanceState(db, state);
const runtime: DeskRuntime = {
  ledger: new HandledLedger(),
  options: {
    enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], assistantName: "Ivy",
    areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [] }],
    routines: { composer: ["composer"], reflex: ["reflex"], target: "@example/pulse-flow", timeZone: "Europe/Zurich", timeoutSeconds: 10, composeTimeoutSeconds: 10, readTimeoutSeconds: 1 },
  },
};
let composerRuns = 0;
const runRoutine: RoutineRunner = async () => {
  composerRuns += 1;
  return { code: 1, stdout: "", stderr: "the probe has no composer" };
};
const deps = { now: () => now, runRoutine };
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch: request => {
    const path = new URL(request.url).pathname;
    if (path === "/api/desk/ask") return handleDeskAsk(request, runtime, deps, db);
    if (path === "/api/desk/create") return handleDeskCreate(request, db, runtime, deps);
    return handleDeskMyDay(request, db, runtime, undefined, now);
  },
});
const post = async (path: string, body: unknown) => (await fetch(new URL(path, server.url), { method: "POST", body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
type Proposal = { kind: string; label: string; fields: Record<string, unknown>; problem?: string };
try {
  const asked = await post("/api/desk/ask", { text: "every Monday at 9 call the bank", area: "work" }) as { proposal: Proposal; proposals: Proposal[] };
  assert.deepEqual(asked.proposals.map(p => p.label), ["Repeat it for me", "Have Ivy do it"]);
  assert.deepEqual(asked.proposal, asked.proposals[0]);
  assert.equal(composerRuns, 0);
  const row = asked.proposals[0] as Proposal;
  const created = await post("/api/desk/create", { requestId: "probe-repeating-row", kind: row.kind, fields: row.fields }) as { ok: boolean; id: string };
  assert.equal(created.ok, true);
  const day = await (await fetch(new URL("/api/desk/my-day", server.url))).json() as { outline: OutlineNode };
  const written = findNode(day.outline, created.id);
  const parent = day.outline.children.find(node => node.children.some(child => child.id === created.id))?.id;
  assert.equal(parent, "area:work");
  assert.equal(written?.title, "call the bank");
  assert.equal(written?.repeat?.mode, "calendar");
  console.log(JSON.stringify({
    proposals: asked.proposals.map(p => ({ kind: p.kind, label: p.label, fields: p.fields, ...(p.problem ? { problem: p.problem } : {}) })),
    proposalIsFirst: true,
    composerRuns,
    created: { ok: created.ok, parent },
    myDayRow: { title: written?.title, repeat: written?.repeat },
    temporaryStackOnly: true,
  }));
} finally {
  await server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
