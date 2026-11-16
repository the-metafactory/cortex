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
import { balanceDetails } from "../desk/balance-command";
import type { MyDayCommand } from "../desk/my-day-schema";
import { desk } from "./desk-day-fixture";

const DAY = "2026-11-12";
const at = (iso: string) => new Date(`${iso}T10:00:00`).getTime();
const leaf = (id: string, extra: Partial<OutlineNode> = {}): OutlineNode => ({ id, title: id, weight: 50, ordering: "parallel", children: [], effort: 1, ...extra });
const legacy: Recurrence = { unit: "day", interval: 3, timesDone: 2 };
const seed = (): AppState => ({
  outline: { id: "desk:outline", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [
    leaf("legacy", { repeat: legacy, startDate: "2026-11-10", deferredUntil: "2026-11-14", dueDate: "2026-11-20" }),
    leaf("plain"),
    leaf("calendar", { dueDate: "2026-11-02", repeat: { unit: "week", interval: 2, weekdays: [1, 4], mode: "calendar", anchor: "2026-11-02", timesDone: 1 } }),
    { id: "project", title: "project", weight: 50, ordering: "parallel", done: true, children: [leaf("child")] },
  ] }] },
  log: [], settings: { ...DEFAULT_SETTINGS }, dayState: null, history: { deficits: {}, lastSurfaced: {} },
});

describe("outline start, put-away and repeat over the Desk My day route", () => {
  let dir: string;
  let path: string;
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desk-outline-time-"));
    path = join(dir, "store.sqlite");
    db = initDatabase(path);
    saveBalanceState(db, seed());
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const runtime = () => ({ options: desk, ledger: new HandledLedger() });
  const view = async () => (await (await handleDeskMyDay(new Request("http://localhost/api/desk/my-day"), db, runtime(), undefined, at(DAY))).json()) as { revision: number; outline: OutlineNode; items: { task: OutlineNode }[] };
  const post = (command: MyDayCommand, requestId: string = crypto.randomUUID()) =>
    handleDeskMyDay(new Request("http://localhost/api/desk/my-day", { method: "POST", body: JSON.stringify({ date: DAY, requestId, command }) }), db, runtime(), undefined, at(DAY));
  const row = (state: AppState, id: string): OutlineNode => findNode(state.outline, id) ?? (() => { throw new Error(`Missing ${id}`); })();
  const stored = (): AppState => {
    db.close();
    db = initDatabase(path);
    const state = loadBalanceState(db);
    if (!state) throw new Error("The store is empty.");
    return state;
  };
  const edit = async (id: string, patch: Record<string, unknown>): Promise<Response> => {
    const current = await view();
    const details = { ...balanceDetails(row({ ...seed(), outline: current.outline }, id), DAY), ...patch };
    return post({ op: "outline-edit", id, revision: current.revision, details, yes: false } as MyDayCommand);
  };
  const add = async (fields: Record<string, unknown>): Promise<{ response: Response; id?: string }> => {
    const { revision } = await view();
    const response = await post({ op: "outline-add", revision, parent: "area:work", title: "New", ...fields } as MyDayCommand);
    const body = (await response.clone().json().catch(() => ({}))) as { outlineId?: string };
    return { response, id: body.outlineId };
  };

  it("adds a row with a start date, a put-away date and a planned-date repeat that defaults to calendar", async () => {
    const { response, id } = await add({ dueDate: "2026-11-16", startDate: "2026-11-13", deferredUntil: "2026-11-14", repeat: { unit: "week", interval: 2, weekdays: [4, 1, 1], count: 5, until: "2027-01-01" } });
    expect(response.status).toBe(200);
    const node = row(stored(), id ?? "");
    expect(node.startDate).toBe("2026-11-13");
    expect(node.deferredUntil).toBe("2026-11-14");
    expect(node.repeat).toEqual({ unit: "week", interval: 2, weekdays: [1, 4], count: 5, until: "2027-01-01", mode: "calendar", anchor: "2026-11-16" });
    const served = findNode((await view()).outline, id ?? "");
    expect(served?.repeat?.mode).toBe("calendar");
    expect(served?.startDate).toBe("2026-11-13");
  });
  it("anchors a repeat without a due date to the day of the add", async () => {
    const { id } = await add({ repeat: { unit: "day", interval: 1 } });
    expect(row(stored(), id ?? "").repeat).toEqual({ unit: "day", interval: 1, mode: "calendar", anchor: DAY });
  });
  it("adds a completion-based repeat when asked", async () => {
    const { id } = await add({ repeat: { unit: "day", interval: 7, mode: "completion" } });
    expect(row(stored(), id ?? "").repeat).toEqual({ unit: "day", interval: 7, mode: "completion" });
  });
  it("leaves an older client's add and edit untouched by the new fields", async () => {
    const { response, id } = await add({ dueDate: "2026-11-16" });
    expect(response.status).toBe(200);
    const node = row(stored(), id ?? "");
    expect(node.startDate).toBeUndefined();
    expect(node.deferredUntil).toBeUndefined();
    expect(node.repeat).toBeUndefined();
    const current = await view();
    const details = balanceDetails(findNode(current.outline, "legacy") as OutlineNode, DAY);
    expect(Object.keys(details)).not.toContain("repeat");
    expect((await post({ op: "outline-edit", id: "legacy", revision: current.revision, details, yes: false })).status).toBe(200);
    const after = row(stored(), "legacy");
    expect(after.startDate).toBe("2026-11-10");
    expect(after.deferredUntil).toBe("2026-11-14");
    expect(after.repeat).toEqual(legacy);
  });
  it("sets each field on an edit and keeps an existing repeat completion-based", async () => {
    expect((await edit("legacy", { startDate: "2026-11-11", deferredUntil: "2026-11-15", repeat: { unit: "day", interval: 5 } })).status).toBe(200);
    const node = row(stored(), "legacy");
    expect(node.startDate).toBe("2026-11-11");
    expect(node.deferredUntil).toBe("2026-11-15");
    expect(node.repeat).toEqual({ unit: "day", interval: 5, timesDone: 2 });
    expect(node.repeat?.mode).toBeUndefined();
  });
  it("switches a legacy repeat to the planned date only when asked, anchoring it to the due date", async () => {
    expect((await edit("legacy", { repeat: { unit: "week", interval: 2, weekdays: [1, 4], mode: "calendar" } })).status).toBe(200);
    expect(row(stored(), "legacy").repeat).toEqual({ unit: "week", interval: 2, weekdays: [1, 4], mode: "calendar", anchor: "2026-11-20", timesDone: 2 });
  });
  it("keeps a calendar repeat's anchor and place in its cycle when only the stopping settings change", async () => {
    expect((await edit("calendar", { repeat: { unit: "week", interval: 2, weekdays: [1, 4], count: 4 } })).status).toBe(200);
    expect(row(stored(), "calendar").repeat).toEqual({ unit: "week", interval: 2, weekdays: [1, 4], count: 4, mode: "calendar", anchor: "2026-11-02", timesDone: 1 });
  });
  it("switches a calendar repeat to completion and back", async () => {
    expect((await edit("calendar", { repeat: { unit: "day", interval: 2, mode: "completion" } })).status).toBe(200);
    expect(row(stored(), "calendar").repeat).toEqual({ unit: "day", interval: 2, mode: "completion", timesDone: 1 });
  });
  it("clears the start, the put-away date and the repeat one at a time", async () => {
    expect((await edit("legacy", { startDate: "" })).status).toBe(200);
    let node = row(stored(), "legacy");
    expect([node.startDate, node.deferredUntil, node.repeat?.interval]).toEqual([undefined, "2026-11-14", 3]);
    expect((await edit("legacy", { deferredUntil: "" })).status).toBe(200);
    node = row(stored(), "legacy");
    expect([node.deferredUntil, node.repeat?.interval]).toEqual([undefined, 3]);
    expect((await edit("legacy", { repeat: null })).status).toBe(200);
    node = row(stored(), "legacy");
    expect(node.repeat).toBeUndefined();
    expect(node.dueDate).toBe("2026-11-20");
  });
  it("shares one put-away value between the card's Not today and the outline", async () => {
    const first = await view();
    const card = first.items.find(item => item.task.id === "plain");
    expect(card).toBeDefined();
    expect((await post({ op: "defer", id: "plain" })).status).toBe(200);
    const tomorrow = "2026-11-13";
    expect(row(stored(), "plain").deferredUntil).toBe(tomorrow);
    expect(findNode((await view()).outline, "plain")?.deferredUntil).toBe(tomorrow);
    expect((await view()).items.some(item => item.task.id === "plain")).toBe(false);
    expect((await edit("plain", { deferredUntil: "" })).status).toBe(200);
    expect(row(stored(), "plain").deferredUntil).toBeUndefined();
    expect((await view()).items.some(item => item.task.id === "plain")).toBe(true);
    expect((await edit("plain", { deferredUntil: "2026-11-18" })).status).toBe(200);
    expect(row(stored(), "plain").deferredUntil).toBe("2026-11-18");
    expect((await view()).items.some(item => item.task.id === "plain")).toBe(false);
  });
  it("rejects invalid dates and repeat values before any mutation", async () => {
    const snapshot = JSON.stringify(stored());
    const bad: Record<string, unknown>[] = [
      { startDate: "2026-02-31" },
      { deferredUntil: "tomorrow" },
      { startDate: "2026-11-25" },
      { repeat: { unit: "day", interval: 0 } },
      { repeat: { unit: "fortnight", interval: 1 } },
      { repeat: { unit: "day", interval: 1, weekdays: [1] } },
      { repeat: { unit: "week", interval: 1, weekdays: [7] } },
      { repeat: { unit: "day", interval: 1, mode: "elapsed" } },
      { repeat: { unit: "day", interval: 1, count: 0 } },
      { repeat: { unit: "day", interval: 1, until: "soon" } },
      { repeat: { unit: "day", interval: 1, anchor: "2026-11-01" } },
    ];
    for (const patch of bad) expect((await edit("legacy", patch)).status).not.toBe(200);
    expect((await add({ startDate: "2026-02-31" })).response.status).not.toBe(200);
    expect((await add({ kind: "project", repeat: { unit: "day", interval: 1 } })).response.status).not.toBe(200);
    expect((await edit("project", { repeat: { unit: "day", interval: 1 } })).status).not.toBe(200);
    expect(JSON.stringify(stored())).toBe(snapshot);
  });
  it("preserves every field on a stale revision and on a denied write", async () => {
    const snapshot = JSON.stringify(stored());
    const current = await view();
    const details = { ...balanceDetails(findNode(current.outline, "legacy") as OutlineNode, DAY), startDate: "", deferredUntil: "", repeat: null };
    const stale = await post({ op: "outline-edit", id: "legacy", revision: current.revision + 1, details, yes: false });
    expect(stale.status).toBe(409);
    const denied = await post({ op: "outline-edit", id: "not-in-a-configured-area", revision: current.revision, details, yes: false });
    expect(denied.status).not.toBe(200);
    expect(JSON.stringify(stored())).toBe(snapshot);
  });
});
