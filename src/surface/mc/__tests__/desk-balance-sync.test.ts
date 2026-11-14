import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { balanceSyncFixture, SYNC_DATE, SYNC_NOW, syncFixtureState } from "./fixtures/desk-balance-sync-fixture";
import { findNode } from "../../../balance";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import { loadMeta, saveMeta, syncBalance } from "../desk/balance-sync";
import { changeMyDay, readMyDay } from "../desk/my-day";
import { syncStudioBalance, withStudioProjection } from "../desk/studio-my-day";
import { acquireStudioLock } from "../desk/studio/write-lock";
import { handleGetDesk } from "../api/desk";
import { handleDeskMyDay } from "../api/desk-my-day";

describe("Balance owner sync and pure My Day reads", () => {
  let stack: Awaited<ReturnType<typeof balanceSyncFixture>>;
  beforeEach(async () => { stack = await balanceSyncFixture(); });
  afterEach(async () => { await stack.close(); });
  const read = (now = SYNC_NOW) => readMyDay(stack.db, stack.runtime.options, now);
  const command = (value: Parameters<typeof changeMyDay>[0]["command"]) => changeMyDay({ db: stack.db, desk: stack.runtime.options, now: SYNC_NOW, date: SYNC_DATE, requestId: crypto.randomUUID(), command: value });

  test("empty reads create no rows, including when Studio has a new note", async () => {
    await stack.note();
    const before = stack.bytes();
    expect(read().phase).toBe("proposed");
    expect((await withStudioProjection(stack.runtime.options, source => readMyDay(stack.db, stack.runtime.options, SYNC_NOW, source))).items).toEqual([]);
    expect(read(SYNC_NOW + 86_400_000).date).toBe("2026-11-02");
    expect(stack.bytes()).toBe(before);
  });

  test("populated reads preserve raw bytes and do not project, reopen or save a draft", async () => {
    saveBalanceState(stack.db, syncFixtureState());
    await stack.note();
    const before = stack.bytes();
    const fileBefore = await readFile(join(stack.root, "store.sqlite"));
    for (const now of [SYNC_NOW, SYNC_NOW + 60_000, SYNC_NOW + 86_400_000]) {
      expect(read(now).items.map(item => item.task.id)).toEqual(["task"]);
      expect((await withStudioProjection(stack.runtime.options, source => readMyDay(stack.db, stack.runtime.options, now, source))).studioTasks).toEqual([]);
    }
    expect(stack.bytes()).toBe(before);
    expect(await readFile(join(stack.root, "store.sqlite"))).toEqual(fileBefore);
    expect(loadMeta(stack.db).draft).toBeNull();
    expect(findNode(loadBalanceState(stack.db)!.outline, "repeat")?.done).toBe(true);
  });

  test("My Day can be read through a read-only SQLite connection", () => {
    saveBalanceState(stack.db, syncFixtureState());
    command({ op: "draft", ids: ["task"] });
    const before = stack.bytes();
    const readonly = new Database(join(stack.root, "store.sqlite"), { readonly: true });
    try {
      expect(readMyDay(readonly, stack.runtime.options, SYNC_NOW).items.map(item => item.task.id)).toEqual(["task"]);
      expect(stack.bytes()).toBe(before);
    } finally { readonly.close(); }
  });

  for (const op of ["add", "outline-add"] as const) test(`${op} only announces a task that fits the visible proposal cap`, async () => {
    const state = syncFixtureState();
    state.outline.children[0]!.children = state.outline.children[0]!.children.filter(task => task.id !== "repeat");
    findNode(state.outline, "task")!.dueDate = SYNC_DATE;
    saveBalanceState(stack.db, state);
    await stack.read();
    command({ op: "cap", cap: 1 });
    const post = async (dueDate?: string) => {
      const response = await handleDeskMyDay(new Request("http://localhost/api/desk/my-day", {
        method: "POST",
        body: JSON.stringify({ date: SYNC_DATE, requestId: crypto.randomUUID(), command: {
          op, parent: "area:work", kind: "task", title: "Another sketch", revision: read().revision, ...(dueDate ? { dueDate } : {}),
        } }),
      }), stack.db, stack.runtime, undefined, SYNC_NOW);
      expect(response.status).toBe(200);
      return response.json() as Promise<ReturnType<typeof changeMyDay>>;
    };
    const hidden = await post();
    expect(hidden.view.items.map(item => item.task.id)).toEqual(["task"]);
    expect(hidden.notice).toBeUndefined();
    if (op === "outline-add") {
      const visible = await post("2026-10-31");
      expect(visible.view.items.map(item => item.task.id)).toEqual([visible.outlineId!]);
      expect(visible.notice).toContain("Added Another sketch to today's proposal.");
    }
  });

  test("the Desk My Day route syncs a note and recurrence once and keeps reads stable afterward", async () => {
    saveBalanceState(stack.db, syncFixtureState());
    await stack.note();
    const day = await stack.read();
    expect(day.studioStatus).toBe("synced");
    expect(day.items.map(item => item.task.title)).toContain("Respond to the note on Which sketch?");
    expect(findNode(loadBalanceState(stack.db)!.outline, "repeat")).toMatchObject({ done: false, dueDate: SYNC_DATE });
    const saved = stack.bytes();
    expect((await stack.read()).revision).toBe(day.revision);
    expect(read().revision).toBe(day.revision);
    expect(stack.bytes()).toBe(saved);
    expect(loadMeta(stack.db).draft).toBeNull();
  });

  test("automatic picks follow owner changes while a person draft, including an empty one, survives", async () => {
    saveBalanceState(stack.db, syncFixtureState());
    syncBalance(stack.db, stack.runtime.options, SYNC_NOW);
    expect(read().items.map(item => item.task.id)).toContain("repeat");
    expect(loadMeta(stack.db).draft).toBeNull();
    for (const ids of [["task"], []]) {
      command({ op: "draft", ids });
      const before = stack.bytes();
      await stack.note();
      expect(read(SYNC_NOW + 60_000).items.map(item => item.task.id)).toEqual(ids);
      expect(stack.bytes()).toBe(before);
      expect((await stack.read()).items.map(item => item.task.id)).toEqual(ids);
      expect(loadMeta(stack.db).draft).toEqual({ date: SYNC_DATE, ids, origin: "person" });
    }
  });

  test("rollover sync retires yesterday's draft and presents a proposed day without saving picks", async () => {
    saveBalanceState(stack.db, syncFixtureState());
    command({ op: "start", ids: ["task"] });
    command({ op: "close" });
    const yesterday = stack.bytes();
    read(SYNC_NOW + 86_400_000);
    expect(stack.bytes()).toBe(yesterday);
    stack.setNow(SYNC_NOW + 86_400_000);
    const day = await stack.read();
    expect(day).toMatchObject({ date: "2026-11-02", phase: "proposed" });
    expect(day.items.map(item => item.task.id)).toContain("repeat");
    expect(loadMeta(stack.db).draft).toBeNull();
    const saved = stack.bytes();
    expect((await stack.read()).revision).toBe(day.revision);
    expect(stack.bytes()).toBe(saved);
  });

  for (const condition of ["busy", "unreadable"] as const) test(`${condition} Studio leaves the saved rows and revision intact`, async () => {
    await stack.note();
    const day = await stack.read();
    const saved = stack.bytes();
    const release = condition === "busy" ? await acquireStudioLock(stack.directory) : null;
    if (condition === "busy" && !release) throw new Error("Could not acquire fixture lock");
    try {
      if (condition === "unreadable") await writeFile(join(stack.directory, "threads/sketch.md"), "Malformed thread");
      const unavailable = await stack.read();
      expect(unavailable.studioStatus).toBe("unavailable");
      expect(unavailable.items).toEqual(day.items);
      expect(unavailable.revision).toBe(day.revision);
      expect(stack.bytes()).toBe(saved);
    } finally { await release?.(); }
  });

  test("a legacy engine draft is ignored by reads and removed only by owner sync", async () => {
    saveBalanceState(stack.db, syncFixtureState());
    const meta = loadMeta(stack.db);
    meta.draft = { date: SYNC_DATE, ids: [], origin: "engine" };
    saveMeta(stack.db, meta);
    const before = stack.bytes();
    expect(read().items.map(item => item.task.id)).toEqual(["task"]);
    expect(stack.bytes()).toBe(before);
    await syncStudioBalance(stack.db, stack.runtime.options, SYNC_NOW);
    expect(loadMeta(stack.db).draft).toBeNull();
  });

  test("the full Desk read route runs owner sync before presenting Balance", async () => {
    await stack.note();
    const response = await handleGetDesk(stack.db, stack.runtime, undefined);
    expect(response.status).toBe(200);
    expect((await response.json() as { myDay: { studioTasks: unknown[] } }).myDay.studioTasks).toHaveLength(1);
    expect(loadMeta(stack.db).studio).toHaveLength(1);
  });
});
