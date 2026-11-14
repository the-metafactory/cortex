import type { AreaPolicy } from "../types";
import type { StudioThreadView, StudioView } from "./view";

export type ThinkingBudget = "open" | "spent" | "off";

export type ThreadThinking =
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; budget: ThinkingBudget; reason: string | null; runs: { id: string; mode: string; status: "pending" | "failed"; reason: string }[] };

const BUDGET_REASON: Record<ThinkingBudget, (policy: AreaPolicy) => string | null> = {
  open: () => null,
  spent: (policy) => `Today's ${policy} thinking budget is spent. Queued requests wait until tomorrow (UTC).`,
  off: (policy) => `${policy[0]?.toUpperCase()}${policy.slice(1)} thinking is turned off: its daily run limit in Ranger is 0.`,
};

export function threadThinking(studio: StudioView, thread: StudioThreadView, now = new Date()): ThreadThinking {
  const thinking = studio.thinking;
  if (!thinking || thinking.kind === "unavailable") return { kind: "unavailable", reason: thinking?.reason ?? "The thinking queue has not loaded yet." };
  const today = now.toISOString().slice(0, 10);
  const spent = thinking.runs.filter(run => run.startedAt?.slice(0, 10) === today && run.policy === thread.policy).length;
  const limit = thinking.dailyRuns[thread.policy];
  const budget: ThinkingBudget = limit === 0 ? "off" : spent >= limit ? "spent" : "open";
  return {
    kind: "ready",
    budget,
    reason: BUDGET_REASON[budget](thread.policy),
    runs: thinking.runs.filter(run => run.params.thread === thread.slug && run.params.requestId && !thread.notes.some(note => note.run === run.runUuid)).map(run => ({
      id: run.runUuid,
      mode: run.params.mode ?? "think",
      status: run.status === "failed" ? "failed" : "pending",
      reason: run.reason ?? (run.status === "running" ? "Ivy is thinking. The note will appear here." : run.status === "succeeded" ? "The run finished; waiting for its note to appear." : "Queued. Ivy is waiting to start."),
    })),
  };
}

export function withThreadThinking(studio: StudioView, now = new Date()): StudioView {
  const each = (threads: StudioThreadView[]): StudioThreadView[] => threads.map(thread => ({ ...thread, thinking: threadThinking(studio, thread, now) }));
  return { ...studio, active: each(studio.active), parked: each(studio.parked), closed: each(studio.closed) };
}
