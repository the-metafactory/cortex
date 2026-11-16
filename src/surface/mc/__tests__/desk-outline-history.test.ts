import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { DEFAULT_SETTINGS, type AppState, type OutlineNode, type RecurrenceOutcome } from "../../../balance";
import { DESK_OUTLINE_HISTORY_PATH, handleDeskOutlineHistory, OUTLINE_HISTORY_MAX_LIMIT, type OutlineHistoryPage } from "../api/desk-outline-history";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import { saveBalanceState } from "../desk/balance-store";
import { desk } from "./desk-day-fixture";

const leaf = (id: string): OutlineNode => ({ id, title: id, weight: 50, ordering: "parallel", children: [], effort: 1, repeat: { unit: "day", interval: 1, mode: "completion" } });
const outcome = (taskId: string, planned: string, status: RecurrenceOutcome["status"], extra: Partial<RecurrenceOutcome> = {}): RecurrenceOutcome => ({ taskId, planned, status, recordedOn: planned, ...extra });
const stateWith = (outcomes: RecurrenceOutcome[]): AppState => ({
  outline: { id: "desk:outline", title: "Outline", weight: 100, ordering: "parallel", children: [
    { id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [leaf("task"), leaf("other")] },
    { id: "area:retired", title: "Retired", weight: 50, ordering: "parallel", children: [leaf("hidden")] },
  ] },
  log: [], settings: { ...DEFAULT_SETTINGS }, dayState: null, history: { deficits: {}, lastSurfaced: {} }, outcomes,
});
const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
const seeded = (): RecurrenceOutcome[] => [
  outcome("task", day(1), "completed", { completedOn: day(3) }),
  outcome("task", day(2), "skipped", { skippedOn: day(2) }),
  outcome("task", day(3), "missed", { recordedOn: day(9) }),
  outcome("task", day(4), "completed", { completedOn: day(4), recordedOn: day(4) }),
  outcome("task", day(4), "skipped", { skippedOn: day(5), recordedOn: day(5) }),
  outcome("task", day(4), "skipped", { skippedOn: day(5), recordedOn: day(5) }),
  outcome("task", day(5), "missed", { recordedOn: day(9) }),
  outcome("other", day(1), "completed", { completedOn: day(1) }),
  outcome("hidden", day(1), "completed", { completedOn: day(1) }),
];

describe("GET /api/desk/outline/history over HTTP", () => {
  let dir: string;
  let path: string;
  let db: Database;
  let server: ReturnType<typeof Bun.serve>;
  let options = desk;
  const open = (): void => {
    db = initDatabase(path);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => handleDeskOutlineHistory(req, db, { options, ledger: new HandledLedger() }) });
  };
  const close = async (): Promise<void> => {
    await server.stop(true);
    db.close();
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desk-outline-history-"));
    path = join(dir, "store.sqlite");
    options = desk;
    open();
    saveBalanceState(db, stateWith(seeded()));
  });
  afterEach(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });
  const get = async (query: Record<string, string>, method = "GET") => {
    const url = new URL(DESK_OUTLINE_HISTORY_PATH, server.url);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, { method });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, unknown> : null };
  };
  const walk = async (task: string, limit: number): Promise<{ pages: OutlineHistoryPage[]; all: OutlineHistoryPage["outcomes"] }> => {
    const pages: OutlineHistoryPage[] = [];
    let cursor: string | null = null;
    do {
      const res = await get({ task, limit: String(limit), ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      const page = res.body as unknown as OutlineHistoryPage;
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    return { pages, all: pages.flatMap(p => p.outcomes) };
  };
  const stored = () => db.query<{ data: string }, []>("SELECT data FROM desk_balance WHERE id = 1").get()?.data;

  it("pages newest planned date first with outcome and action date, and a missed outcome has none", async () => {
    const { pages, all } = await walk("task", 3);
    expect(pages.map(p => p.outcomes.length)).toEqual([3, 3, 1]);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    expect(all).toEqual([
      { planned: day(5), outcome: "missed", actionDate: null, recordedOn: day(9) },
      { planned: day(4), outcome: "skipped", actionDate: day(5), recordedOn: day(5) },
      { planned: day(4), outcome: "skipped", actionDate: day(5), recordedOn: day(5) },
      { planned: day(4), outcome: "completed", actionDate: day(4), recordedOn: day(4) },
      { planned: day(3), outcome: "missed", actionDate: null, recordedOn: day(9) },
      { planned: day(2), outcome: "skipped", actionDate: day(2), recordedOn: day(2) },
      { planned: day(1), outcome: "completed", actionDate: day(3), recordedOn: day(1) },
    ]);
  });

  it("returns each outcome once across every page size, including equal-date events", async () => {
    const reference = (await walk("task", OUTLINE_HISTORY_MAX_LIMIT)).all;
    expect(reference).toHaveLength(7);
    for (const size of [1, 2, 3, 4, 6]) expect((await walk("task", size)).all).toEqual(reference);
  });

  it("reads the same history after the store is reopened, with the cursor still valid", async () => {
    const first = (await get({ task: "task", limit: "2" })).body as unknown as OutlineHistoryPage;
    const before = (await walk("task", 2)).all;
    await close();
    open();
    const after = (await walk("task", 2)).all;
    expect(after).toEqual(before);
    const resumed = (await get({ task: "task", limit: "2", cursor: first.nextCursor ?? "" })).body as unknown as OutlineHistoryPage;
    expect(resumed.outcomes).toEqual(before.slice(2, 4));
  });

  it("does not invent dates for legacy outcomes that have none", async () => {
    saveBalanceState(db, stateWith([outcome("task", day(1), "completed"), outcome("task", day(2), "skipped")]));
    const { all } = await walk("task", 10);
    expect(all.map(o => [o.outcome, o.actionDate])).toEqual([["skipped", null], ["completed", null]]);
  });

  it("returns an empty history for a task with no outcomes", async () => {
    saveBalanceState(db, stateWith([]));
    expect((await get({ task: "task" })).body).toEqual({ task: "task", outcomes: [], nextCursor: null });
  });

  it("refuses malformed cursors, invalid limits and a missing task id explicitly", async () => {
    for (const cursor of ["not-a-cursor", "", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ v: 1, t: "task", p: "soon", r: day(1), o: 0 })).toString("base64url")]) {
      expect(await get({ task: "task", cursor })).toMatchObject({ status: 400, body: { ok: false, code: "invalid_cursor" } });
    }
    for (const limit of ["0", "-1", "abc", "1.5", String(OUTLINE_HISTORY_MAX_LIMIT + 1)]) {
      expect(await get({ task: "task", limit })).toMatchObject({ status: 400, body: { code: "invalid_limit" } });
    }
    expect(await get({})).toMatchObject({ status: 400, body: { code: "task_required" } });
  });

  it("refuses a cursor taken from another task and leaks nothing from either", async () => {
    const page = (await get({ task: "task", limit: "2" })).body as unknown as OutlineHistoryPage;
    const crossed = await get({ task: "other", cursor: page.nextCursor ?? "" });
    expect(crossed).toMatchObject({ status: 400, body: { ok: false, code: "cursor_other_task" } });
    expect(JSON.stringify(crossed.body)).not.toContain("2026-10");
  });

  it("refuses a missing task, an area id and a task in an area the Desk no longer lists, with identical bodies", async () => {
    options = { ...desk, areas: desk.areas.filter(a => a.id !== "retired") };
    const refusals = await Promise.all(["nope", "area:work", "hidden"].map(task => get({ task })));
    for (const refusal of refusals) expect(refusal).toMatchObject({ status: 404, body: { ok: false, code: "task_not_found" } });
    expect(new Set(refusals.map(r => JSON.stringify(r.body))).size).toBe(1);
    expect(JSON.stringify(refusals[2]?.body)).not.toContain("2026-10");
  });

  it("refuses when the Desk is off and for methods other than GET, and never writes", async () => {
    const before = stored();
    options = { ...desk, enabled: false };
    expect(await get({ task: "task" })).toMatchObject({ status: 409, body: { code: "desk_off" } });
    options = desk;
    for (const method of ["POST", "PUT", "DELETE"]) expect((await get({ task: "task" }, method)).status).toBe(405);
    await walk("task", 2);
    expect(stored()).toBe(before);
  });

  it("is served uncached", async () => {
    expect((await get({ task: "task" })).headers.get("cache-control")).toBe("no-store");
  });
});
