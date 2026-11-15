import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, findNode, type AppState, type OutlineNode, type Recurrence } from "../../../balance";
import { handleDeskMyDay } from "../api/desk-my-day";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import type { MyDayCommand } from "../desk/my-day-schema";
import { desk } from "./desk-day-fixture";

const at = (iso: string) => new Date(`${iso}T10:00:00`).getTime();
const leaf = (id: string, repeat?: Recurrence, extra: Partial<OutlineNode> = {}): OutlineNode => ({ id, title: id, weight: 50, ordering: "parallel", children: [], effort: 1, ...(repeat ? { repeat } : {}), ...extra });
const seed = (): AppState => ({
  outline: { id: "desk:outline", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [
    leaf("calendar", { unit: "week", interval: 1, weekdays: [1, 4], mode: "calendar", anchor: "2026-11-02" }),
    leaf("completion", { unit: "day", interval: 3, mode: "completion" }),
    leaf("finite", { unit: "day", interval: 1, mode: "completion", count: 2, timesDone: 1 }),
    leaf("limited", { unit: "week", interval: 1, mode: "calendar", anchor: "2026-11-02", until: "2026-11-05" }),
    leaf("plain"),
    leaf("finished", { unit: "day", interval: 1, mode: "completion" }, { done: true, completedAt: "2026-11-12" }),
  ] }] },
  log: [], settings: { ...DEFAULT_SETTINGS }, dayState: null, history: { deficits: {}, lastSurfaced: {} },
});

describe("outline-skip over the Desk My day route", () => {
  let dir: string;
  let path: string;
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desk-outline-skip-"));
    path = join(dir, "store.sqlite");
    db = initDatabase(path);
    saveBalanceState(db, seed());
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const runtime = () => ({ options: desk, ledger: new HandledLedger() });
  const get = async (day: string) => (await (await handleDeskMyDay(new Request("http://localhost/api/desk/my-day"), db, runtime(), undefined, at(day))).json()) as { revision: number };
  const post = (day: string, command: MyDayCommand, requestId: string = crypto.randomUUID()) =>
    handleDeskMyDay(new Request("http://localhost/api/desk/my-day", { method: "POST", body: JSON.stringify({ date: day, requestId, command }) }), db, runtime(), undefined, at(day));
  const skip = async (day: string, id: string, revision?: number) => post(day, { op: "outline-skip", id, revision: revision ?? (await get(day)).revision, confirm: true });
  const reopenStore = (): AppState => {
    db.close();
    db = initDatabase(path);
    const state = loadBalanceState(db);
    if (!state) throw new Error("The store is empty.");
    return state;
  };
  const row = (state: AppState, id: string): OutlineNode => findNode(state.outline, id) ?? (() => { throw new Error(`Missing ${id}`); })();

  it("skips a calendar occurrence, records it, marks the gap missed and keeps the anchor", async () => {
    expect((await skip("2026-11-12", "calendar")).status).toBe(200);
    const state = reopenStore();
    const node = row(state, "calendar");
    expect(node.repeat?.occurrence).toBe("2026-11-16");
    expect(node.repeat?.anchor).toBe("2026-11-02");
    expect(node.repeat?.timesDone).toBeUndefined();
    expect(state.log).toEqual([]);
    expect(state.outcomes).toEqual([
      { taskId: "calendar", planned: "2026-11-02", status: "skipped", skippedOn: "2026-11-12", recordedOn: "2026-11-12" },
      { taskId: "calendar", planned: "2026-11-05", status: "missed", recordedOn: "2026-11-12" },
      { taskId: "calendar", planned: "2026-11-09", status: "missed", recordedOn: "2026-11-12" },
      { taskId: "calendar", planned: "2026-11-12", status: "missed", recordedOn: "2026-11-12" },
    ]);
  });
  it("counts a completion-based interval from the skip date", async () => {
    expect((await skip("2026-11-10", "completion")).status).toBe(200);
    const state = reopenStore();
    expect(row(state, "completion").completedAt).toBe("2026-11-10");
    expect(state.outcomes).toEqual([{ taskId: "completion", planned: "2026-11-10", status: "skipped", skippedOn: "2026-11-10", recordedOn: "2026-11-10" }]);
    const view = (await (await handleDeskMyDay(new Request("http://localhost/api/desk/my-day"), db, runtime(), undefined, at("2026-11-10"))).json()) as { outline: OutlineNode & { recurrence?: unknown } };
    expect((row({ ...seed(), outline: view.outline }, "completion") as OutlineNode & { recurrence?: unknown }).recurrence).toEqual({ returnsOn: "2026-11-13", finished: false, reappearsOn: "2026-11-13" });
  });
  it("never consumes a finite completion target", async () => {
    expect((await skip("2026-11-10", "finite")).status).toBe(200);
    const node = row(reopenStore(), "finite");
    expect(node.repeat?.timesDone).toBe(1);
    expect(node.repeat?.count).toBe(2);
  });
  it("keeps the end date in force", async () => {
    expect((await skip("2026-11-04", "limited")).status).toBe(200);
    const state = reopenStore();
    expect(row(state, "limited").repeat?.occurrence).toBe("2026-11-09");
    const view = (await (await handleDeskMyDay(new Request("http://localhost/api/desk/my-day"), db, runtime(), undefined, at("2026-11-04"))).json()) as { outline: OutlineNode };
    expect((findNode(view.outline, "limited") as OutlineNode & { recurrence?: unknown }).recurrence).toEqual({ returnsOn: null, finished: true, reappearsOn: null });
  });
  it("lets a retry with the stale original revision skip nothing more", async () => {
    const { revision } = await get("2026-11-12");
    expect((await skip("2026-11-12", "calendar", revision)).status).toBe(200);
    const once = JSON.stringify(reopenStore());
    const retry = await skip("2026-11-12", "calendar", revision);
    expect(retry.status).toBe(409);
    expect(JSON.stringify(reopenStore())).toBe(once);
    expect(row(reopenStore(), "calendar").repeat?.occurrence).toBe("2026-11-16");
  });
  it("answers the same request id from its receipt without a second outcome", async () => {
    const requestId = crypto.randomUUID();
    const { revision } = await get("2026-11-12");
    const command: MyDayCommand = { op: "outline-skip", id: "calendar", revision, confirm: true };
    expect((await post("2026-11-12", command, requestId)).status).toBe(200);
    expect((await post("2026-11-12", command, requestId)).status).toBe(200);
    expect(reopenStore().outcomes?.filter(o => o.status === "skipped")).toHaveLength(1);
  });
  it("refuses a missing task, a non-repeating row and a finished occurrence without changing state", async () => {
    const before = JSON.stringify(loadBalanceState(db));
    for (const id of ["nothing", "plain", "finished"]) {
      const response = await skip("2026-11-12", id);
      expect(response.status).toBe(409);
      expect(JSON.stringify(reopenStore())).toBe(before);
    }
  });
  it("rejects a skip without confirmation", async () => {
    const response = await post("2026-11-12", { op: "outline-skip", id: "calendar", revision: 0, confirm: false } as unknown as MyDayCommand);
    expect(response.status).toBe(400);
  });
});
