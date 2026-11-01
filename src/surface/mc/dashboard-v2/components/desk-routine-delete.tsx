import { useEffect, useRef } from "react";
import { getJson } from "../lib/api";
import { RemovalDetailSchema, type RemovalAction, type RemovalDetail } from "../../desk/routine-removal-contract";
import { RoutineResultSchema } from "../../desk/routine-action-contract";
interface Confirmation { detail: RemovalDetail; intent: RemovalAction }
export interface DeleteSession { open: boolean; busy: boolean; confirmation: Confirmation | null; pending: boolean; error: string | null }
export const newDeleteSession = (): DeleteSession => ({ open: false, busy: false, confirmation: null, pending: false, error: null });
export function RoutineDelete({ id, active, state, onState, onChanged, onDeleted }: { id: string; active: boolean; state: DeleteSession; onState: (change: (state: DeleteSession) => DeleteSession) => void; onChanged: () => void; onDeleted: (id: string, message: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { open, busy, confirmation, pending, error } = state;
  const setOpen = (open: boolean): void => { onState((s) => ({ ...s, open })); };
  const setBusy = (busy: boolean): void => { onState((s) => ({ ...s, busy })); };
  const setConfirmation = (confirmation: Confirmation | null): void => { onState((s) => ({ ...s, confirmation })); };
  const setPending = (pending: boolean): void => { onState((s) => ({ ...s, pending })); };
  const setError = (error: string | null): void => { onState((s) => ({ ...s, error })); };
  useEffect(() => { if (active && open) { if (!dialog.current?.open) dialog.current?.showModal(); } else if (dialog.current?.open) dialog.current.close(); }, [active, open]);
  const prepare = async (): Promise<void> => {
    setOpen(true);
    if (pending) return;
    setBusy(true); setError(null); setConfirmation(null);
    try {
      const detail = RemovalDetailSchema.parse(await getJson(`/api/desk/routine-removal?id=${encodeURIComponent(id)}`));
      if (detail.id !== id) throw new Error("The owner returned a different routine.");
      if (!detail.writable) throw new Error(detail.reason || "This routine cannot be deleted by its owner.");
      setConfirmation({ detail, intent: { requestId: crypto.randomUUID(), action: "delete", target: id, revision: detail.revision } });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The owner could not prepare deletion."); }
    finally { setBusy(false); }
  };
  const remove = async (): Promise<void> => {
    if (!confirmation || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/desk/routines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(confirmation.intent) });
      const result = RoutineResultSchema.parse(await response.json());
      if (result.ok) { setOpen(false); setPending(false); onDeleted(confirmation.intent.target, result.message); }
      else { setPending(result.uncertain === true); setError(result.error); }
    } catch (failure) { setPending(true); setError(`Deletion is unconfirmed. Check this same deletion again. ${failure instanceof Error ? failure.message : "The owner did not answer."}`); }
    finally { setBusy(false); onChanged(); }
  };
  const close = (): void => { if (!busy) setOpen(false); };
  return <div><button className="desk-btn" type="button" disabled={busy} onClick={() => { void prepare(); }}>{pending ? "Check pending deletion" : "Delete routine"}</button>
    <dialog className="routine-schedule-dialog" ref={dialog} aria-labelledby={`delete-title-${id}`} onCancel={(event) => { event.preventDefault(); close(); }}><h2 id={`delete-title-${id}`}>Delete routine?</h2>
      {busy && <p role="status">Checking with the routine owner…</p>}{error && <p role="alert">{error}</p>}
      {confirmation && <><h3>{confirmation.detail.name}</h3><p><code>{confirmation.detail.schedule}</code> · {confirmation.detail.timezone ?? "Owner local timezone"}{confirmation.detail.paused ? " · Paused" : ""}</p><p>Future triggers and pending requests are removed. Existing execution evidence remains in Activity. An already started execution is not cancelled.</p><button className="desk-btn pri" type="button" disabled={busy} onClick={() => { void remove(); }}>{pending ? "Check this same deletion" : "Delete routine"}</button></>}
      <button className="desk-btn" type="button" disabled={busy} onClick={close}>{pending ? "Close; keep pending deletion" : "Keep routine"}</button>
    </dialog></div>;
}
