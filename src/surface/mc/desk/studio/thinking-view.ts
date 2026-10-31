import type { StudioThreadView, StudioView } from "./view";

export type ThreadThinking =
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; budgetSpent: boolean; runs: { id: string; mode: string; status: "pending" | "failed"; reason: string }[] };

export function threadThinking(studio: StudioView, thread: StudioThreadView, now = new Date()): ThreadThinking {
  const thinking = studio.thinking;
  if (!thinking || thinking.kind === "unavailable") return { kind: "unavailable", reason: thinking?.reason ?? "The thinking queue has not loaded yet." };
  const today = now.toISOString().slice(0, 10);
  const spent = thinking.runs.filter(run => run.startedAt?.slice(0, 10) === today && run.policy === thread.policy).length;
  return {
    kind: "ready",
    budgetSpent: spent >= thinking.dailyRuns[thread.policy],
    runs: thinking.runs.filter(run => run.params.thread === thread.slug && run.params.requestId && !thread.notes.some(note => note.run === run.runUuid)).map(run => ({
      id: run.runUuid,
      mode: run.params.mode ?? "think",
      status: run.status === "failed" ? "failed" : "pending",
      reason: run.reason ?? (run.status === "running" ? "Ivy is thinking. The note will appear here." : run.status === "succeeded" ? "The run finished; waiting for its note to appear." : "Queued. Ivy is waiting to start."),
    })),
  };
}
