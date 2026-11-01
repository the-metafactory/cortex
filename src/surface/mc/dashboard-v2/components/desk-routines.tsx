import { useRef, useState } from "react";
import { postJson } from "../lib/api";
import type { RoutineAction, LegacyRoutineAction } from "../../desk/routine-store";
import type { RoutineView } from "../../desk/routine-command";

type RoutineButtonProps = { children: string; onChanged: () => void; onCompleted?: (request: RoutineAction) => void; retryId?: string } & ({ request: RoutineAction; action?: never; target?: never } | { request?: never; action: LegacyRoutineAction["action"]; target: string });
export function RoutineButton(props: RoutineButtonProps) {
  const { children, onChanged, retryId } = props;
  const requestId = useRef(retryId ?? props.request?.requestId ?? crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const request: RoutineAction = props.request ? { ...props.request, requestId: requestId.current } : { requestId: requestId.current, action: props.action, target: props.target };
      const result = await postJson<RoutineAction, { ok?: boolean } | null>("/api/desk/routines", request);
      if (result?.ok !== true) throw new Error("The routine result was not confirmed. Retry this same action.");
      if (retryId === undefined) requestId.current = crypto.randomUUID();
      props.onCompleted?.(request); onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The routine action did not answer.");
    } finally {
      setBusy(false);
    }
  };
  return <><button className="desk-btn" type="button" disabled={busy} onClick={() => void act()}>{busy ? "Checking…" : children}</button>{error && <p role="alert">{error}</p>}</>;
}

export function PendingRoutineChanges({ changes, onChanged, onCompleted }: { changes: RoutineAction[]; onChanged: () => void; onCompleted?: (request: RoutineAction) => void }) {
  return <>{changes.map((change) => <p key={change.requestId}>A routine change is awaiting confirmation. <RoutineButton request={change} retryId={change.requestId} onChanged={onChanged} onCompleted={onCompleted}>Check pending change</RoutineButton></p>)}</>;
}

export function RoutinesSection({ view, onChanged }: { view: RoutineView | undefined; onChanged: () => void }) {
  if (!view) return null;
  return (
    <section className="desk-msec" aria-label="Routines">
      <h3 className="desk-mh">Routines</h3>
      {view.error && <p role="alert">{view.error}</p>}
      <PendingRoutineChanges changes={view.changes} onChanged={onChanged} />
      {!view.error && view.installed.length === 0 && <p className="soft">Ask for something to happen every day, week or minute.</p>}
      <ul className="desk-sub">
        {view.pending.map((p) => <li key={p.decisionId}><div>
          Routine {view.installed.find((r) => r.id === p.blueprintId)?.title} wants to run
          <div className="desk-acts">
            <RoutineButton action="approve" target={p.decisionId} onChanged={onChanged}>Approve</RoutineButton>
            <RoutineButton action="deny" target={p.decisionId} onChanged={onChanged}>Deny</RoutineButton>
          </div>
        </div></li>)}
        {view.installed.map((r) => <li key={r.id}><div>
          {r.title}<small>{r.words}. {!r.runtimeConfirmed ? "Scheduling state unconfirmed. " : r.paused ? "Paused. " : ""}{r.policy === "auto" ? "Handled automatically." : r.policy === "disabled" ? "Disabled." : "Asks you before each fire."}</small>
          {r.lastDecision && <small>Last fire: {r.lastDecision.outcome}{r.lastDecision.reason ? ` — ${r.lastDecision.reason}` : ""}.</small>}
          <div className="desk-acts">
            <RoutineButton key={`${r.id}:${r.policy}`} action={r.policy === "auto" ? "stop" : "auto"} target={r.id} onChanged={onChanged}>{r.policy === "auto" ? "Stop" : "Handle this yourself"}</RoutineButton>
            <a className="desk-btn" href={`?routines=workspace&routine=${encodeURIComponent(r.id)}`}>Open routine workspace</a>
          </div>
        </div></li>)}
      </ul>
    </section>
  );
}

export function RoutineDone({ view, onChanged }: { view: RoutineView | undefined; onChanged: () => void }) {
  const done = view?.done ?? [];
  return <>{done.map((r) => <li key={`routine:${r.decisionId}`}><div>
    {r.title}<small>Automatically dispatched at {new Date(r.at).toLocaleTimeString()}. Execution results appear in Mission Control.</small>
    <RoutineButton action="stop" target={r.routineId} onChanged={onChanged}>Stop</RoutineButton>
  </div></li>)}</>;
}
