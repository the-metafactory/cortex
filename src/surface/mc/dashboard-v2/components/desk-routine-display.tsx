import { useCallback, useEffect, useRef, useState } from "react";
import type { RoutineDisplayMode } from "../../desk/routine-display-contract";
import { readDisplay, sameScope, saveDisplay, withDisplay, type DisplayPreferences } from "../lib/routine-display";

export interface DisplayChange { mode: RoutineDisplayMode; busy: boolean; error: string | null }
const failure = (error: unknown): string => error instanceof Error ? error.message : "The display preference was not saved.";
export function useRoutineDisplay(revision: number) {
  const [preferences, setPreferences] = useState<DisplayPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<Record<string, DisplayChange>>({});
  const current = useRef(preferences); current.current = preferences;
  const tokens = useRef(new Map<string, number>());
  const clearChange = useCallback((routineId: string): void => { setChanges(({ [routineId]: _removed, ...rest }) => rest); }, []);
  useEffect(() => {
    const abort = new AbortController(); setError(null);
    void readDisplay(abort.signal).then((next) => {
      if (abort.signal.aborted) return;
      if (!sameScope(current.current?.scope, next.scope)) { setChanges({}); tokens.current.clear(); }
      setPreferences(next);
    }).catch((failed: unknown) => { if (!abort.signal.aborted) setError(failure(failed)); });
    return () => { abort.abort(); };
  }, [revision]);
  const change = useCallback((routineId: string, mode: RoutineDisplayMode): void => {
    const scope = current.current?.scope;
    if (!scope) { setChanges((previous) => ({ ...previous, [routineId]: { mode, busy: false, error: "Display preferences are unavailable. Refresh routines before choosing a display." } })); return; }
    const token = (tokens.current.get(routineId) ?? 0) + 1; tokens.current.set(routineId, token);
    setChanges((previous) => ({ ...previous, [routineId]: { mode, busy: true, error: null } }));
    void saveDisplay(scope, routineId, mode).then((result) => {
      if (tokens.current.get(routineId) !== token || !sameScope(current.current?.scope, result)) return;
      setPreferences((previous) => previous ? withDisplay(previous, result) : previous);
      clearChange(routineId);
    }).catch((failed: unknown) => {
      if (tokens.current.get(routineId) !== token) return;
      setChanges((previous) => ({ ...previous, [routineId]: { mode, busy: false, error: failure(failed) } }));
    });
  }, [clearChange]);
  const dismiss = useCallback((routineId: string): void => {
    tokens.current.set(routineId, (tokens.current.get(routineId) ?? 0) + 1);
    clearChange(routineId);
  }, [clearChange]);
  return { preferences, error, changes, change, dismiss };
}

const label = (mode: RoutineDisplayMode): string => mode === "background" ? "Background" : "Scheduled starts";
export function RoutineDisplayChoice({ routineId, saved, available, pending, onChange, onDismiss }: { routineId: string; saved: RoutineDisplayMode; available: boolean; pending: DisplayChange | undefined; onChange: (routineId: string, mode: RoutineDisplayMode) => void; onDismiss: (routineId: string) => void }) {
  const chosen = pending?.mode ?? saved;
  return <fieldset className="routine-display-choice" disabled={!available || pending?.busy}>
    <legend>Calendar display</legend>
    {(["scheduled", "background"] as const).map((mode) => <label key={mode}><input type="radio" name={`routine-display-${routineId}`} value={mode} checked={chosen === mode} onChange={() => { onChange(routineId, mode); }} /> {label(mode)}<small>{mode === "background" ? "One row in Background routines beneath the calendar for the whole period." : "Each planned start in its own calendar slot."}</small></label>)}
    <p className="soft">Display only. The schedule, timezone, pause state, handling policy, approvals and execution stay unchanged.</p>
    {!available && <p role="status">Display preferences are unavailable; the calendar shows every scheduled start.</p>}
    {pending?.busy && <p role="status">Saving {label(pending.mode)}…</p>}
    {pending?.error && <div role="alert"><p>{pending.error} The calendar still shows {label(saved)}. Your choice of {label(pending.mode)} was not saved.</p><div className="desk-acts"><button className="desk-btn" type="button" onClick={() => { onChange(routineId, pending.mode); }}>Retry {label(pending.mode)}</button><button className="desk-btn" type="button" onClick={() => { onDismiss(routineId); }}>Keep {label(saved)}</button></div></div>}
  </fieldset>;
}

export function DisplayFailureAlert({ routineId, name, change, onRetry, onKeep }: { routineId: string; name: string; change: DisplayChange; onRetry: (routineId: string, mode: RoutineDisplayMode) => void; onKeep: (routineId: string) => void }) {
  return <div role="alert"><p>{name}: {change.error} The previous display is unchanged.</p><div className="desk-acts"><button className="desk-btn" type="button" onClick={() => { onRetry(routineId, change.mode); }}>Retry display change</button><button className="desk-btn" type="button" onClick={() => { onKeep(routineId); }}>Keep previous display</button></div></div>;
}
