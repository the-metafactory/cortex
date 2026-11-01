import { useRef, useState } from "react";
import type { MyDayView } from "../../desk/my-day";
import type { MyDayCommand } from "../../desk/my-day-schema";
import { ApiFailure } from "../lib/api";
import { submitMyDay } from "../lib/desk-my-day-action";

interface DayIntent { date: string; command: MyDayCommand; requestId: string; onSaved?: () => void }

export function useMyDay(day: MyDayView, onChanged: () => void) {
  const [local, setLocal] = useState<MyDayView | null>(null);
  const current = local?.date === day.date && local.revision > day.revision ? local : day;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryable, setRetryable] = useState(false);
  const inFlight = useRef(false);
  const pending = useRef<DayIntent | null>(null);
  const send = async (intent: DayIntent): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    pending.current = intent;
    setBusy(true);
    try {
      const result = await submitMyDay(intent.date, intent.command, intent.requestId);
      pending.current = null;
      setRetryable(false);
      setLocal(result.view);
      intent.onSaved?.();
      setNote(result.notice ?? (intent.command.op === "defer" ? "Set aside for today. Undo is kept below." : "Saved."));
      onChanged();
      return true;
    } catch (error) {
      const uncertain = !(error instanceof ApiFailure) || error.info.status === 0 || error.info.status >= 500;
      setRetryable(uncertain);
      if (!uncertain) pending.current = null;
      setNote(error instanceof Error ? error.message : "Could not save. Try again.");
      if (!uncertain) onChanged();
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const change = (command: MyDayCommand, onSaved?: () => void): Promise<boolean> => {
    if (pending.current) {
      if (JSON.stringify({ date: pending.current.date, command: pending.current.command }) === JSON.stringify({ date: current.date, command })) return send(pending.current);
      setNote("Retry the pending change before making another change. Your original request is kept.");
      return Promise.resolve(false);
    }
    return send({ date: current.date, command, requestId: crypto.randomUUID(), ...(onSaved ? { onSaved } : {}) });
  };
  const retry = (): Promise<boolean> => pending.current ? send(pending.current) : Promise.resolve(false);
  return { current, note, busy, retryable, change, retry };
}
