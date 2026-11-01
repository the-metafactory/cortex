import { useEffect, useRef } from "react";
import { getJson, postJson } from "../lib/api";
import { RoutineResultSchema } from "../../desk/routine-action-contract";
import { ScheduleDetailSchema, SchedulePreviewSchema, type ScheduleAction, type ScheduleDetail, type SchedulePreview, type ScheduleValue } from "../../desk/routine-schedule-contract";

const endpoint = "/api/desk/routine-schedule";
const weekdays = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [0, "Sunday"]] as const;
export function commonSchedule(expression: string): { days: number[]; time: string } | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6](?:,[0-6])*)$/.exec(expression);
  if (!match) return null;
  const minute = Number(match[1]); const hour = Number(match[2]); const source = match[3];
  if (minute > 59 || hour > 23 || !source) return null;
  const days = source === "*" ? [0, 1, 2, 3, 4, 5, 6] : source === "1-5" ? [1, 2, 3, 4, 5] : source.split(",").map(Number);
  if (new Set(days).size !== days.length) return null;
  return { days, time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}
interface ScheduleDraft extends ScheduleValue { mode: "clock" | "custom"; days: number[]; time: string }
interface ScheduleEdit { kind: "editing"; detail: ScheduleDetail; draft: ScheduleDraft; preview: SchedulePreview | null; intent: ScheduleAction | null; pending: boolean; busy: "idle" | "preview" | "save"; errors: { schedule: string | null; timezone: string | null }; error: string | null }
export type ScheduleSession = { kind: "closed"; notice: string | null } | { kind: "loading" } | { kind: "failed"; error: string } | ScheduleEdit;
export const newScheduleSession = (): ScheduleSession => ({ kind: "closed", notice: null });
const message = (error: unknown): string => error instanceof Error ? error.message : "The routine owner did not answer.";
const zoneLabel = (value: { timezone: string | null; effectiveTimezone: string }): string => value.timezone ?? `Owner default (${value.effectiveTimezone})`;

function clockSchedule(days: number[], time: string): string {
  const parts = /^(\d{2}):(\d{2})$/.exec(time);
  const day = days.length === 7 ? "*" : [...days].sort((a, b) => a - b).join(",");
  return parts && days.length ? `${Number(parts[2])} ${Number(parts[1])} * * ${day}` : "";
}

function ClockFields({ state, change }: { state: ScheduleEdit; change: (draft: ScheduleDraft) => void }) {
  const update = (days: number[], time: string): void => {
    change({ ...state.draft, days, time, schedule: clockSchedule(days, time) });
  };
  return <><fieldset className="routine-schedule-days"><legend>Repeat on</legend>{weekdays.map(([day, name]) => <label key={day}><input type="checkbox" checked={state.draft.days.includes(day)} onChange={(event) => { update(event.target.checked ? [...state.draft.days, day] : state.draft.days.filter((entry) => entry !== day), state.draft.time); }} />{name}</label>)}</fieldset><label>Time<input type="time" value={state.draft.time} onChange={(event) => { update(state.draft.days, event.target.value); }} /></label></>;
}

function ScheduleComparison({ preview }: { preview: SchedulePreview }) {
  return <section className="routine-schedule-comparison" aria-label="Schedule comparison">{[{ label: "Current", value: preview.current }, { label: "Proposed", value: preview.proposed }].map(({ label, value }) => {
    return <div key={label}><h4>{label}</h4><p><code>{value.schedule}</code></p><p>{zoneLabel(value)}</p><strong>Next occurrences</strong>{value.occurrences.length ? <ol>{value.occurrences.map((at) => <li key={at}><time dateTime={at}>{new Intl.DateTimeFormat(undefined, { timeZone: value.effectiveTimezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(at))}</time></li>)}</ol> : <p>No future occurrences.</p>}{value.occurrences.length < 3 && value.occurrences.length > 0 && <p>Only {value.occurrences.length} future {value.occurrences.length === 1 ? "occurrence is" : "occurrences are"} available.</p>}</div>;
  })}</section>;
}

export function RoutineScheduleEditor({ id, paused = false, enabled, active, state, onState, onChanged }: { id: string; paused?: boolean; enabled: boolean; active: boolean; state: ScheduleSession; onState: (state: ScheduleSession) => void; onChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const version = useRef(0);
  useEffect(() => {
    if (active && state.kind !== "closed") { if (!dialog.current?.open) dialog.current?.showModal(); }
    else if (dialog.current?.open) dialog.current.close();
  }, [active, state.kind]);
  const close = (): void => { version.current++; onState({ kind: "closed", notice: state.kind === "editing" && state.pending ? "This schedule change is still unconfirmed. Check the pending change before starting another." : null }); };
  const open = async (): Promise<void> => {
    const request = ++version.current; onState({ kind: "loading" });
    try {
      const detail = ScheduleDetailSchema.parse(await getJson(`${endpoint}?id=${encodeURIComponent(id)}`));
      if (detail.id !== id) throw new Error("The owner returned a different routine schedule.");
      if (request !== version.current) return;
      if (!detail.writable) { onState({ kind: "failed", error: detail.reason || "This schedule is read-only." }); return; }
      const clock = commonSchedule(detail.current.schedule);
      onState({ kind: "editing", detail, draft: { schedule: detail.current.schedule, timezone: detail.current.timezone, mode: clock ? "clock" : "custom", days: clock?.days ?? [1, 2, 3, 4, 5], time: clock?.time ?? "09:00" }, preview: null, intent: null, pending: false, busy: "idle", errors: { schedule: null, timezone: null }, error: null });
    } catch (error) { if (request === version.current) onState({ kind: "failed", error: message(error) }); }
  };
  const change = (draft: ScheduleDraft): void => { if (state.kind === "editing") onState({ ...state, draft, preview: null, intent: null, error: null, errors: { schedule: null, timezone: null } }); };
  const preview = async (): Promise<void> => {
    if (state.kind !== "editing") return;
    const errors = { schedule: state.draft.schedule.trim() ? null : "Choose a time and at least one day, or enter a supported expression.", timezone: state.draft.timezone === "" ? "Enter a timezone or choose the owner default." : null };
    if (errors.schedule || errors.timezone) { onState({ ...state, errors, preview: null, intent: null }); return; }
    onState({ ...state, busy: "preview", error: null });
    try {
      const result = SchedulePreviewSchema.parse(await postJson(endpoint, { id, revision: state.detail.revision, schedule: state.draft.schedule, timezone: state.draft.timezone }));
      if (result.id !== id || result.revision !== state.detail.revision || result.proposed.schedule !== state.draft.schedule || result.proposed.timezone !== state.draft.timezone) throw new Error("The owner returned a different proposed schedule.");
      onState({ ...state, busy: "idle", preview: result, intent: { requestId: crypto.randomUUID(), action: "schedule", target: id, revision: result.revision, proposedRevision: result.proposedRevision, schedule: state.draft.schedule, timezone: state.draft.timezone }, errors: { schedule: null, timezone: null }, error: null });
    } catch (error) { const text = message(error); onState({ ...state, busy: "idle", preview: null, intent: null, error: text, errors: { schedule: text.includes("schedule:") ? text : null, timezone: text.includes("timezone:") ? text : null } }); }
  };
  const save = async (): Promise<void> => {
    if (state.kind !== "editing" || !state.intent) return;
    onState({ ...state, busy: "save", error: null });
    try {
      const response = await fetch("/api/desk/routines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.intent) });
      const result = RoutineResultSchema.parse(await response.json());
      if (result.ok) onState({ kind: "closed", notice: result.message });
      else onState({ ...state, busy: "idle", pending: result.uncertain === true, error: result.error });
    } catch (error) { onState({ ...state, busy: "idle", pending: true, error: `The schedule result is unconfirmed. Check this same change again. ${message(error)}` }); }
    finally { onChanged(); }
  };
  const editing = state.kind === "editing" ? state : null;
  return <><button className="desk-btn" type="button" disabled={!enabled} onClick={() => { void open(); }}>Edit schedule</button>{!enabled && <small className="soft">Schedule is read-only.</small>}{state.kind === "closed" && state.notice && <p role="status">{state.notice}</p>}
    <dialog className="routine-schedule-dialog" ref={dialog} aria-labelledby={`schedule-title-${id}`} onCancel={(event) => { event.preventDefault(); if (!editing || editing.busy === "idle") close(); }}>
      <h2 id={`schedule-title-${id}`}>Edit schedule</h2>{state.kind === "loading" && <p role="status">Reading the installed schedule…</p>}{state.kind === "failed" && <p role="alert">{state.error}</p>}
      {editing && <><p>Review the current and proposed schedule before saving.</p>{paused && <p>This routine is paused. Saving its schedule keeps it paused.</p>}{editing.error && <p role="alert">{editing.error}</p>}<fieldset disabled={editing.busy !== "idle" || editing.pending} className="routine-schedule-fields"><legend>Proposed schedule</legend>
        <label>Schedule format<select value={editing.draft.mode} onChange={(event) => {
          if (event.target.value === "custom") change({ ...editing.draft, mode: "custom" });
          else { const days = editing.draft.days.length ? editing.draft.days : [1, 2, 3, 4, 5]; change({ ...editing.draft, mode: "clock", days, schedule: clockSchedule(days, editing.draft.time) }); }
        }}><option value="clock">Days and time</option><option value="custom">Custom expression</option></select></label>
        {editing.draft.mode === "clock" ? <ClockFields state={editing} change={change} /> : <label>Schedule expression<textarea rows={3} value={editing.draft.schedule} maxLength={1000} onChange={(event) => { change({ ...editing.draft, schedule: event.target.value }); }} aria-invalid={Boolean(editing.errors.schedule)} /><small>Preserved exactly. Validation and future occurrences come from the routine owner.</small></label>}
        {editing.errors.schedule && <p role="alert">{editing.errors.schedule}</p>}
        <label><input type="checkbox" checked={editing.draft.timezone === null} onChange={(event) => { change({ ...editing.draft, timezone: event.target.checked ? null : editing.detail.current.effectiveTimezone }); }} />Use owner default timezone</label>
        <label>Timezone<input value={editing.draft.timezone ?? ""} placeholder={editing.detail.current.effectiveTimezone} disabled={editing.draft.timezone === null} maxLength={100} onChange={(event) => { change({ ...editing.draft, timezone: event.target.value }); }} aria-invalid={Boolean(editing.errors.timezone)} /></label>{editing.errors.timezone && <p role="alert">{editing.errors.timezone}</p>}
      </fieldset>{editing.preview && <ScheduleComparison preview={editing.preview} />}<div className="desk-acts"><button className="desk-btn" type="button" disabled={editing.busy !== "idle" || editing.pending} onClick={() => { void preview(); }}>{editing.busy === "preview" ? "Reading preview…" : "Preview schedule"}</button><button className="desk-btn pri" type="button" disabled={editing.busy !== "idle" || !editing.intent || editing.intent.revision === editing.intent.proposedRevision} onClick={() => { void save(); }}>{editing.busy === "save" ? "Checking…" : editing.pending ? "Check this change" : "Save schedule"}</button></div></>}
      <button className="desk-btn" type="button" disabled={editing !== null && editing.busy !== "idle"} onClick={close}>{editing?.pending ? "Close; keep pending change" : "Cancel"}</button>
    </dialog></>;
}
