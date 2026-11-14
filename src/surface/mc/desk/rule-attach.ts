import type { Database } from "bun:sqlite";
import type { DeskOptions } from "./compose";
import { taskTargetOrWhy } from "./links";
import { addMailToStudio, mailForStudio } from "./mail-studio";
import type { RuleAttach, RuleTarget } from "./mail-rules";
import { readMyDay } from "./my-day";
import { sourceBoundary } from "./source-boundary";
import type { SourceReading } from "./sources/command";
import { captureId, undoStudioCapture } from "./studio/capture";
import { oneLine } from "./studio/edit";
import { withSyncedBalance } from "./studio-my-day";

const NO_STUDIO = { ok: false as const, status: 409, error: "The Studio is not set up on this stack." };

export type RulePick = { kind: "task"; id: string } | { kind: "thread"; slug: string };

/** Why a rule target cannot take mail now: a task that is done or gone, a thread that is closed, or a Studio that could not be read. */
export type RuleTargetWhy = "is done" | "is gone" | "is closed" | "is unavailable";

/** One rule for what counts as a target: a task in the synced outline that is not done, or an active Studio thread. */
export function ruleTargetOf(db: Database, desk: DeskOptions, pick: RulePick, now: number): Promise<RuleTarget | RuleTargetWhy> {
  return withSyncedBalance(db, desk, now, (source, studio): RuleTarget | RuleTargetWhy => {
    if (pick.kind === "task") {
      const task = taskTargetOrWhy(readMyDay(db, desk, now, source), pick.id);
      return typeof task === "string" ? task : { kind: "task", key: task.key, title: task.title };
    }
    if (!studio) return "is unavailable";
    const thread = studio.active.find((t) => t.slug === pick.slug);
    return thread ? { kind: "thread", key: thread.slug, title: oneLine(thread.question) } : "is closed";
  });
}

/** The live targets an attach rule reaches: tasks in the synced outline, and Studio threads through Add to thread. */
export function ruleAttach(db: Database, desk: DeskOptions, readings: () => readonly SourceReading[], now: () => number = Date.now): RuleAttach {
  return {
    task: async (id) => ruleTargetOf(db, desk, { kind: "task", id }, now()),
    thread: async (mail, slug, runId) => {
      const studio = desk.studio;
      if (!studio) return { ...NO_STUDIO, gone: false };
      if ((await ruleTargetOf(db, desk, { kind: "thread", slug }, now())) === "is closed") return { ok: false, status: 409, error: "That thread is no longer active.", gone: true };
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
