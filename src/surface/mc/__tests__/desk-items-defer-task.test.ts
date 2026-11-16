import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { DEFAULT_SETTINGS, findNode, type AppState } from "../../../balance";
import { handleDeskItemsDefer } from "../api/desk-items-defer";
import { handleDeskTaskHandoff } from "../api/desk-task-handoff";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import { shiftDays } from "../../../balance";
import { localDay } from "../desk/my-day";
import type { TaskDispatchBus } from "../desk/task-handoff";
import type { DispatchOptions } from "../desk/task-handoff-store";

const NOW = Date.parse("2026-11-14T09:00:00.000Z");
const DISPATCH: DispatchOptions = { agents: [{ id: "luna", label: "Luna", policy: "cloud" }], startTimeoutSeconds: 120, runTimeoutMinutes: 60 };
const leaf = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, weight: 50, ordering: "parallel" as const, children: [], effort: 1 as const, ...extra });
const seed = (): AppState => ({
  outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:lab", title: "Lab", weight: 50, ordering: "parallel", children: [leaf("t1", "Draft the engine notes")] }] },
  settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
});
const HANDOFF = "00000000-0000-4000-8000-000000000001";
const KEY = `handoff:${HANDOFF}`;

let db: Database;
let options: DeskOptions;
let runtime: DeskRuntime;

const bus: TaskDispatchBus = { principal: "ada", stack: "home", publish: async () => { throw new Error("no responders"); } };
const deferredUntil = (id = "t1"): string | undefined => {
  const state = loadBalanceState(db);
  return state ? findNode(state.outline, id)?.deferredUntil : undefined;
};
const post = async (body: unknown, at = NOW): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await handleDeskItemsDefer(new Request("http://localhost/api/desk/items/defer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), db, { ...runtime, now: () => at });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const view = () => composeDesk(db, options, undefined, { now: NOW, handled: runtime.ledger });
const handOff = async (taskId = "t1"): Promise<void> => {
  const act = async (body: unknown) => handleDeskTaskHandoff(new Request("http://localhost/api/desk/task-handoff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), db, runtime, { now: () => NOW, newId: () => HANDOFF });
  const seen = (await (await act({ action: "preview", taskId })).json()) as { preview: { briefHash: string } };
  await act({ action: "hand", requestId: HANDOFF, taskId, agent: "luna", briefHash: seen.preview.briefHash });
};

beforeEach(async () => {
  db = initDatabase(":memory:");
  saveBalanceState(db, seed());
  options = { enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", sources: [], dispatch: DISPATCH, areas: [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "cloud" }] };
  runtime = { options, ledger: new HandledLedger(), dispatch: bus };
  await handOff();
});
afterEach(() => { db.close(); });

describe("deferring a task-handoff card", () => {
  it("writes the task's deferredUntil, lists the card in deferred[] and cancel restores the earlier value", async () => {
    expect((await view()).items.some((i) => i.key === KEY)).toBe(true);
    expect((await post({ action: "defer", key: KEY, until: { kind: "tomorrow" } })).status).toBe(200);
    expect(deferredUntil()).toBe(shiftDays(localDay(NOW), 1));
    const away = await view();
    expect(away.items.some((i) => i.key === KEY)).toBe(false);
    expect(away.deferred.map((d) => d.key)).toContain(KEY);

    expect((await post({ action: "defer.cancel", key: KEY })).status).toBe(200);
    expect(deferredUntil()).toBeUndefined();
    const back = await view();
    expect(back.items.some((i) => i.key === KEY)).toBe(true);
    expect(back.deferred.some((d) => d.key === KEY)).toBe(false);
  });

  it("keeps an earlier deferredUntil across a defer and its cancel", async () => {
    const state = loadBalanceState(db);
    const node = state ? findNode(state.outline, "t1") : null;
    if (!state || !node) throw new Error("seed missing");
    node.deferredUntil = "2026-11-15";
    saveBalanceState(db, state);
    await post({ action: "defer", key: KEY, until: { kind: "next-week" } });
    expect(deferredUntil()).not.toBe("2026-11-15");
    await post({ action: "defer.cancel", key: KEY });
    expect(deferredUntil()).toBe("2026-11-15");
  });

  it("maps a date choice to that day", async () => {
    expect((await post({ action: "defer", key: KEY, until: { kind: "date", date: "2026-12-01" } })).status).toBe(200);
    expect(deferredUntil()).toBe("2026-12-01");
  });

  it("refuses a meeting or person choice and leaves the task unchanged", async () => {
    for (const until of [{ kind: "meeting", event: "x" }, { kind: "person", address: "a@example.org" }]) {
      const res = await post({ action: "defer", key: KEY, until });
      expect(res.status).toBe(400);
      expect(String(res.json.error)).toBe("A task waits until a day.");
    }
    expect(deferredUntil()).toBeUndefined();
    expect(db.query("SELECT COUNT(*) AS n FROM desk_item_defers").get()).toEqual({ n: 0 });
  });

  it("answers 404 and stores nothing when the task is gone from Balance", async () => {
    saveBalanceState(db, { ...seed(), outline: { ...seed().outline, children: [] } });
    const res = await post({ action: "defer", key: KEY, until: { kind: "tomorrow" } });
    expect(res.status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS n FROM desk_item_defers").get()).toEqual({ n: 0 });
  });
});
