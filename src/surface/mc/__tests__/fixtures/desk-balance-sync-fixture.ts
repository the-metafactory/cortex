import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deskFixtureOptions } from "./desk-options-fixture";
import { DEFAULT_SETTINGS, type AppState } from "../../../../balance";
import { handleDeskMyDay } from "../../api/desk-my-day";
import { initDatabase } from "../../db/init";
import { HandledLedger } from "../../desk/actions";
import type { DeskOptions, DeskRuntime } from "../../desk/compose";
import type { MyDayView } from "../../desk/my-day";

export const SYNC_NOW = new Date(2026, 10, 1, 10).getTime();
export const SYNC_DATE = "2026-11-01";
export function syncFixtureState(): AppState {
  return {
    outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [
      { id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [
        { id: "task", title: "Prepare a sketch", weight: 50, ordering: "parallel", effort: 1, children: [] },
        { id: "repeat", title: "Review the sketch", weight: 50, ordering: "parallel", effort: 1, children: [], done: true, completedAt: "2026-10-31", repeat: { unit: "day", interval: 1 } },
      ] },
    ] },
    settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
  };
}
export async function balanceSyncFixture() {
  const root = await mkdtemp(join(tmpdir(), "desk-balance-sync-"));
  const directory = join(root, "studio");
  await mkdir(join(directory, ".git"), { recursive: true });
  await mkdir(join(directory, "threads"));
  const db = initDatabase(join(root, "store.sqlite"));
  const runtime: DeskRuntime & { options: DeskOptions } = {
    options: { ...deskFixtureOptions, studio: { dir: directory, maxActive: 5 } },
    ledger: new HandledLedger(),
  };
  let now = SYNC_NOW;
  const readRoute = () => handleDeskMyDay(new Request("http://localhost/api/desk/my-day"), db, runtime, undefined, now);
  const read = async (): Promise<MyDayView> => {
    const response = await readRoute();
    if (response.status !== 200) throw new Error(`My Day route returned ${response.status}: ${await response.text()}`);
    return response.json() as Promise<MyDayView>;
  };
  const bytes = () => JSON.stringify([
    db.query("SELECT id, data FROM desk_balance ORDER BY id").all(),
    db.query("SELECT id, data FROM desk_my_day ORDER BY id").all(),
  ]);
  const note = () => writeFile(join(directory, "threads/sketch.md"), `---
studioId: 120e1a58-09a5-4a1d-8ef2-61ef4e66a0ba
type: question
areas: [work]
state: active
opened: 2026-11-01
---
## Question
Which sketch?
## Where I stand
Try one.
## Ivy's notes
### 2026-11-01T09:00:00Z
trigger: A design check
model: local

Try a small sketch.
## Log
`);
  return {
    root, directory, db, runtime, readRoute, read, bytes, note,
    setNow: (value: number) => { now = value; },
    close: async () => { db.close(); await rm(root, { recursive: true, force: true }); },
  };
}
