import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { DeskOptions } from "./compose";
import { readMyDay } from "./my-day";
import { readStudioFiles } from "./studio/read";
import { buildStudioView } from "./studio/view";
import { acquireStudioLock } from "./studio/write-lock";
import { studioNamespace, type StudioProjection } from "./studio-outline";

export async function withStudioProjection<T>(desk: DeskOptions, take: (source: StudioProjection | undefined) => T, strict = false): Promise<T> {
  if (!desk.studio) return take({ namespace: "", threads: [] });
  const options = desk.studio;
  const directory = await realpath(options.dir).catch(() => resolve(options.dir));
  const namespace = studioNamespace(directory);
  const release = await acquireStudioLock(directory);
  if (!release) {
    if (strict) throw new Error("Studio is busy or unavailable. Retry this response when its files are ready.");
    return take(undefined);
  }
  try {
    const { files, problems } = await readStudioFiles(directory);
    const studio = buildStudioView(files, options, desk.areas, problems);
    const threads = [...studio.active, ...studio.parked, ...studio.closed];
    const identities = threads.flatMap(t => t.id ? [t.id] : []);
    if (new Set(identities).size !== identities.length || problems.some(p => p.path === "." || p.path.startsWith("threads/")) || threads.length !== files.threads.length) {
      if (strict) throw new Error("Studio thread files could not be read. Restore them before responding.");
      return take(undefined);
    }
    return take({ namespace, areas: desk.areas.map(a => a.id), threads });
  } finally { await release(); }
}
export function readStudioMyDay(db: Database, desk: DeskOptions, now: number, strict = false) {
  return withStudioProjection(desk, source => readMyDay(db, desk, now, source), strict);
}
