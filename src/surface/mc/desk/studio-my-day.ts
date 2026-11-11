import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { DeskOptions } from "./compose";
import { readMyDay } from "./my-day";
import { syncBalance } from "./balance-sync";
import { readStudioFiles } from "./studio/read";
import { buildStudioView, type StudioView } from "./studio/view";
import { acquireStudioLock } from "./studio/write-lock";
import { studioNamespace, type StudioProjection } from "./studio-outline";
import type { BalanceDayProjection } from "./balance-day";

export async function withStudioProjection<T>(desk: DeskOptions, take: (source: StudioProjection | undefined, studio: StudioView | null) => T, strict = false): Promise<T> {
  if (!desk.studio) return take({ namespace: "", threads: [] }, null);
  const options = desk.studio;
  const directory = await realpath(options.dir).catch(() => resolve(options.dir));
  const namespace = studioNamespace(directory);
  const release = await acquireStudioLock(directory);
  if (!release) {
    if (strict) throw new Error("Studio is busy or unavailable. Retry this response when its files are ready.");
    return take(undefined, null);
  }
  try {
    const { files, problems } = await readStudioFiles(directory);
    const studio = buildStudioView(files, options, desk.areas, problems);
    const threads = [...studio.active, ...studio.parked, ...studio.closed];
    const identities = threads.flatMap(t => t.id ? [t.id] : []);
    if (new Set(identities).size !== identities.length || problems.some(p => p.path === "." || p.path.startsWith("threads/")) || threads.length !== files.threads.length) {
      if (strict) throw new Error("Studio thread files could not be read. Restore them before responding.");
      return take(undefined, studio);
    }
    return take({ namespace, areas: desk.areas.map(a => a.id), threads }, studio);
  } finally { await release(); }
}
export function readStudioMyDay(db: Database, desk: DeskOptions, now: number, strict = false) {
  return withStudioProjection(desk, source => readMyDay(db, desk, now, source), strict);
}

export function withSyncedBalance<T>(db: Database, desk: DeskOptions, now: number, take: (source: StudioProjection | undefined, studio: StudioView | null) => T, strict = false): Promise<T> {
  return withStudioProjection(desk, (source, studio) => {
    syncBalance(db, desk, now, source);
    return take(source, studio);
  }, strict);
}
export function readSyncedMyDay(db: Database, desk: DeskOptions, now: number, strict = false, projection?: BalanceDayProjection) {
  return withSyncedBalance(db, desk, now, source => readMyDay(db, desk, now, source, projection), strict);
}
export function readObservedMyDay(db: Database, desk: DeskOptions, now: number, observe: (() => Promise<BalanceDayProjection | null>) | undefined, strict = false) {
  return withSyncedBalance(db, desk, now, async source => {
    const projection = observe ? await observe() : null;
    return readMyDay(db, desk, now, source, projection ?? undefined);
  }, strict);
}
export function syncStudioBalance(db: Database, desk: DeskOptions, now: number, strict = false): Promise<void> {
  return withSyncedBalance(db, desk, now, () => undefined, strict);
}
