import { useEffect, useRef } from "react";
import { getJson, postJson } from "../lib/api";
import { LifecycleDetailSchema, LifecyclePreviewSchema, type LifecycleAction, type LifecyclePreview } from "../../desk/routine-lifecycle-contract";
import { RoutineResultSchema } from "../../desk/routine-action-contract";

export interface LifecycleSession { open: boolean; busy: boolean; preview: LifecyclePreview | null; intent: LifecycleAction | null; pending: boolean; error: string | null; notice: string | null }
export const newLifecycleSession = (): LifecycleSession => ({ open: false, busy: false, preview: null, intent: null, pending: false, error: null, notice: null });
const endpoint = "/api/desk/routine-lifecycle";
const message = (error: unknown): string => error instanceof Error ? error.message : "The routine owner did not answer.";
export function RoutineLifecycleEditor({ id, paused, enabled, active, state, onState, onChanged }: { id: string; paused: boolean; enabled: boolean; active: boolean; state: LifecycleSession; onState: (state: LifecycleSession) => void; onChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (active && state.open) { if (!dialog.current?.open) dialog.current?.showModal(); }
    else if (dialog.current?.open) dialog.current.close();
  }, [active, state.open]);
  const close = (): void => { if (!state.busy) onState({ ...state, open: false }); };
  const open = async (): Promise<void> => {
    if (state.pending) { onState({ ...state, open: true }); return; }
    onState({ ...newLifecycleSession(), open: true, busy: true });
    try {
      const detail = LifecycleDetailSchema.parse(await getJson(`${endpoint}?id=${encodeURIComponent(id)}`));
      if (detail.id !== id || detail.current.paused !== paused) throw new Error("The installed state changed. Refresh routines before trying again.");
      if (!detail.writable || !detail.runtimeConfirmed) throw new Error(detail.reason || "The owner cannot confirm the live scheduling state.");
      const preview = LifecyclePreviewSchema.parse(await postJson(endpoint, { id, revision: detail.revision, paused: !paused }));
      if (preview.id !== id || preview.revision !== detail.revision || preview.paused !== !paused || !preview.runtimeConfirmed) throw new Error("The owner returned a different lifecycle preview.");
      onState({ ...newLifecycleSession(), open: true, preview, intent: { requestId: crypto.randomUUID(), action: paused ? "resume" : "pause", target: id, revision: preview.revision, proposedRevision: preview.proposedRevision } });
    } catch (error) { onState({ ...newLifecycleSession(), open: true, error: message(error) }); }
  };
  const save = async (): Promise<void> => {
    if (!state.intent) return;
    onState({ ...state, busy: true, error: null });
    try {
      const response = await fetch("/api/desk/routines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.intent) });
      const result = RoutineResultSchema.parse(await response.json());
      if (result.ok) onState({ ...newLifecycleSession(), notice: result.message });
      else onState({ ...state, busy: false, pending: result.uncertain === true, error: result.error });
    } catch (error) { onState({ ...state, busy: false, pending: true, error: `The result is unconfirmed. Check this same change again. ${message(error)}` }); }
    finally { onChanged(); }
  };
  const action = state.intent?.action ?? (paused ? "resume" : "pause");
  return <div><button className="desk-btn" type="button" disabled={!enabled && !state.pending} onClick={() => { void open(); }}>{state.pending ? "Check pending lifecycle change" : paused ? "Resume routine" : "Pause routine"}</button>{!enabled && <small className="soft">Pause and resume are unavailable for this definition.</small>}{state.notice && <p role="status">{state.notice}</p>}
    <dialog className="routine-schedule-dialog" ref={dialog} aria-labelledby={`lifecycle-title-${id}`} onCancel={(event) => { event.preventDefault(); close(); }}><h2 id={`lifecycle-title-${id}`}>{action === "pause" ? "Pause routine" : "Resume routine"}</h2>
      {state.busy && <p role="status">Checking with the routine owner…</p>}{state.error && <p role="alert">{state.error}</p>}
      {state.preview && <><p>{action === "pause" ? "Stop new scheduled triggers. Existing approval requests and started executions continue normally." : "Allow new scheduled triggers using the saved schedule and handling policy."}</p><p><code>{state.preview.current.schedule}</code> · {state.preview.current.timezone ?? "Owner local timezone"}</p><p>Handling policy: {state.preview.current.policy === "auto" ? "Automatic" : "Approval required"}. {action === "pause" ? "Preserved while paused." : "Preserved when resumed."}</p><button className="desk-btn pri" type="button" disabled={state.busy} onClick={() => { void save(); }}>{state.pending ? "Check this same change" : action === "pause" ? "Confirm pause" : "Confirm resume"}</button></>}
      <button className="desk-btn" type="button" disabled={state.busy} onClick={close}>{state.pending ? "Close; keep pending change" : "Cancel"}</button>
    </dialog></div>;
}
