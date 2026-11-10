import { useEffect, useState } from "react";
import type { MyDayView } from "../../desk/my-day";
import { getJson } from "../lib/api";
import { balanceItemSearch } from "../hooks/use-balance-location";
import { readBalanceSurfaceTask, type BalanceSurfaceTask } from "../lib/desk-balance-surfaces";
import { balanceEntries, taskSummaryView, TaskSummary } from "./desk-task-details";

type SavedTaskReading = { kind: "checking" } | { kind: "off" } | { kind: "failed" } | { kind: "ready"; task: Exclude<BalanceSurfaceTask, { enabled: false }> };
type LegacyReading = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; day: MyDayView };

const editPath = (id: string): void => { window.location.assign(`${window.location.pathname}${balanceItemSearch(window.location.search, id)}${window.location.hash}`); };

export function useConversationBalanceTask(id: string | undefined, area: string): { reading: SavedTaskReading; reload: () => void } {
  const [reading, setReading] = useState<SavedTaskReading>({ kind: "checking" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setReading({ kind: "checking" });
    readBalanceSurfaceTask(id, area, controller.signal).then(task => {
      if (!controller.signal.aborted) setReading(task.enabled ? { kind: "ready", task } : { kind: "off" });
    }).catch(() => {
      if (!controller.signal.aborted) setReading({ kind: "failed" });
    });
    return () => { controller.abort(); };
  }, [id, area, retry]);
  return { reading, reload: (): void => { setRetry(value => value + 1); } };
}

export function useSavedBalanceDay(retry: number): LegacyReading {
  const [reading, setReading] = useState<LegacyReading>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setReading({ kind: "loading" });
    void getJson<MyDayView>("/api/desk/my-day", { signal: controller.signal }).then(day => {
      if (!controller.signal.aborted) setReading({ kind: "ready", day });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setReading({ kind: "error", message: error instanceof Error ? error.message : "Saved Balance task details could not be read." });
    });
    return () => { controller.abort(); };
  }, [retry]);
  return reading;
}

export function ConversationBalanceTask({ id, area = "" }: { id: string | undefined; area?: string }) {
  const surface = useConversationBalanceTask(id, area);
  if (!id) return <p role="status">The created Balance task has no saved reference. It cannot be opened here.</p>;
  if (surface.reading.kind === "checking") return <p role="status">Loading saved Balance task…</p>;
  if (surface.reading.kind === "failed") return <div><p role="alert">The saved Balance task could not be read.</p><button type="button" className="desk-btn" onClick={surface.reload}>Retry task</button></div>;
  if (surface.reading.kind === "ready") return <BalanceTaskCard id={id} task={surface.reading.task} />;
  return <SavedBalanceTask id={id} />;
}

export function BalanceTaskCard({ id, task }: { id: string; task: Exclude<BalanceSurfaceTask, { enabled: false }> }) {
  if (task.state === "withheld") return <p role="status">This created Balance task's area is no longer available to this connection, so its content is withheld.</p>;
  if (task.state === "unavailable") return <p role="status">This created Balance task is no longer available in the saved outline.</p>;
  const view = { title: task.title, path: task.project ? task.project.split(" / ") : task.area ? [task.area] : [], estimateMinutes: undefined, weight: undefined, dueDate: task.due, context: null, effort: task.effort, note: task.note };
  return <div className="dtd"><TaskSummary view={view} titled busy={false} onEdit={() => { editPath(id); }} /></div>;
}

function SavedBalanceTask({ id }: { id: string }) {
  const [retry, setRetry] = useState(0);
  const reading = useSavedBalanceDay(retry);
  if (reading.kind === "error") return <div><p role="alert">{reading.message}</p><button type="button" className="desk-btn" onClick={() => { setRetry(value => value + 1); }}>Retry task</button></div>;
  if (reading.kind === "loading") return <p role="status">Loading saved Balance task…</p>;
  return <ConversationBalanceTaskDetails id={id} day={reading.day} onEdit={() => { editPath(id); }} />;
}

export function ConversationBalanceTaskDetails({ id, day, onEdit }: { id: string; day: MyDayView; onEdit: () => void }) {
  const entry = balanceEntries(day.outline).find(value => value.node.id === id);
  if (!entry) return <p role="status">This created Balance task is no longer available in the saved outline.</p>;
  return <div className="dtd"><TaskSummary view={taskSummaryView(entry.node, entry, day)} titled busy={false} onEdit={onEdit} /></div>;
}
