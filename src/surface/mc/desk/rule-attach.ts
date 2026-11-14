import type { Database } from "bun:sqlite";
import type { DeskOptions } from "./compose";
import { taskTargetOrWhy } from "./links";
import { addMailToStudio, mailForStudio } from "./mail-studio";
import type { RuleAttach } from "./mail-rules";
import { readMyDay } from "./my-day";
import { sourceBoundary } from "./source-boundary";
import type { SourceReading } from "./sources/command";
import { captureId, undoStudioCapture } from "./studio/capture";
import { withSyncedBalance } from "./studio-my-day";

const NO_STUDIO = { ok: false as const, status: 409, error: "The Studio is not set up on this stack." };

/** The live targets an attach rule reaches: tasks in the synced outline, and Studio threads through Add to thread. */
export function ruleAttach(db: Database, desk: DeskOptions, readings: () => readonly SourceReading[], now: () => number = Date.now): RuleAttach {
  return {
    task: (id) => withSyncedBalance(db, desk, now(), (source) => taskTargetOrWhy(readMyDay(db, desk, now(), source), id)),
    thread: async (mail, slug, runId) => {
      const studio = desk.studio;
      if (!studio) return { ...NO_STUDIO, gone: false };
      const active = await withSyncedBalance(db, desk, now(), (_source, view) => view === null ? null : view.active.some((t) => t.slug === slug));
      if (active === false) return { ok: false, status: 409, error: "That thread is no longer active.", gone: true };
      const added = await addMailToStudio(mailForStudio(db, readings(), mail), { requestId: runId, thread: slug, includeText: false, ruleRun: runId }, { localSources: sourceBoundary(desk), options: studio, areas: desk.areas, db, now: new Date(now()) });
      return added.ok ? { ok: true } : { ok: false, status: added.status, error: added.error, gone: false };
    },
    undoThread: async (runId) => {
      const studio = desk.studio;
      if (!studio) return NO_STUDIO;
      const id = captureId(runId);
      const undone = await undoStudioCapture({ options: studio, areas: desk.areas, requestId: `undo-${id}`, id, db, now: new Date(now()) });
      return undone.ok ? { ok: true } : { ok: false, status: undone.status, error: undone.error };
    },
  };
}
