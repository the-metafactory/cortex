import { useEffect, useState } from "react";
import type { MyDayView } from "../../desk/my-day";
import { getJson } from "../lib/api";
import { balanceItemSearch } from "../hooks/use-balance-location";
import { balanceEntries, TaskSummary } from "./desk-task-details";

type SavedTaskReading = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; day: MyDayView };

export function useConversationBalanceTasks(tasks: string) {
  const [reading, setReading] = useState<SavedTaskReading>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!tasks) return;
    const controller = new AbortController();
    setReading({ kind: "loading" });
    void getJson<MyDayView>("/api/desk/my-day", { signal: controller.signal }).then(day => {
      if (!controller.signal.aborted) setReading({ kind: "ready", day });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setReading({ kind: "error", message: error instanceof Error ? error.message : "Saved Balance task details could not be read." });
    });
    return () => { controller.abort(); };
  }, [tasks, retry]);
  return { reading, reload: (): void => { setRetry(value => value + 1); } };
}
export type ConversationBalanceTasks = ReturnType<typeof useConversationBalanceTasks>;

export function ConversationBalanceTask({ id, balance }: { id: string | undefined; balance: ConversationBalanceTasks }) {
  if (!id) return <p role="status">The created Balance task has no saved reference. It cannot be opened here.</p>;
  if (balance.reading.kind === "error") return <div><p role="alert">{balance.reading.message}</p><button type="button" className="desk-btn" onClick={balance.reload}>Retry task</button></div>;
  if (balance.reading.kind === "loading") return <p role="status">Loading saved Balance task…</p>;
  return <ConversationBalanceTaskDetails id={id} day={balance.reading.day} onEdit={() => { window.location.assign(`${window.location.pathname}${balanceItemSearch(window.location.search, id)}${window.location.hash}`); }} />;
}

export function ConversationBalanceTaskDetails({ id, day, onEdit }: { id: string; day: MyDayView; onEdit: () => void }) {
  const entry = balanceEntries(day.outline).find(value => value.node.id === id);
  if (!entry) return <p role="status">This created Balance task is no longer available in the saved outline.</p>;
  return <div className="dtd"><TaskSummary node={entry.node} entry={entry} day={day} titled busy={false} onEdit={onEdit} /></div>;
}
