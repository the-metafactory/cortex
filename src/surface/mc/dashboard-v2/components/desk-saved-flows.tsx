import { useEffect, useRef, useState } from "react";
import type { FlowRoutine, SavedFlow, SavedFlowDefinition } from "../../../../conversations/saved-flow-contract";
import { flowReadError, loadSavedFlowDefinition, makeRoutineFromFlow, newRoutineStart, type RoutineStart, type ShownFlowsState } from "../lib/desk-flows";
import { formatRelativeTime } from "../lib/agents-display";
import { useAssistantName } from "../lib/assistant-name";

export type FlowDefinitionState = { status: "closed" | "loading" } | { status: "ready"; definition: SavedFlowDefinition } | { status: "error"; error: string };

export interface RoutineAction { busy: boolean; error: string | null; conversationId: string | null; onMake: () => void; onOpen: (id: string) => void }

export function SavedFlowRow({ flow, now, state, onToggle, routine }: { flow: SavedFlow; now: number; state: FlowDefinitionState; onToggle: () => void; routine?: RoutineAction }) {
  const expanded = state.status !== "closed";
  const panel = `saved-flow-${flow.name}`;
  return <li className="desk-set-card saved-flow-row"><h3>{flow.name}</h3><p className="soft"><time dateTime={flow.savedAt} title={new Date(flow.savedAt).toLocaleString()}>Saved {formatRelativeTime(Date.parse(flow.savedAt), now)}</time>{" · "}{flow.origin === "conversation" ? flow.conversationId ? <a href={`/conversations/${encodeURIComponent(flow.conversationId)}`}>From a conversation</a> : "From a conversation" : "From the command line"}</p><button className="desk-btn" type="button" aria-expanded={expanded} aria-controls={panel} onClick={onToggle}>{expanded ? "Hide definition" : "Show definition"}</button>{routine && <> <button className="desk-btn" type="button" disabled={routine.busy} onClick={routine.onMake}>Make a routine</button>{routine.error && <p role="alert">{routine.error}{routine.conversationId && <> <a href={`/conversations/${encodeURIComponent(routine.conversationId)}`} onClick={(event) => { event.preventDefault(); routine.onOpen(routine.conversationId ?? ""); }}>Open the conversation to try again</a></>}</p>}</>}<div id={panel} hidden={!expanded}>{state.status === "loading" && <p role="status">Reading the flow definition…</p>}{state.status === "error" && <p role="alert">{state.error}</p>}{state.status === "ready" && <pre className="saved-flow-yaml" tabIndex={0} aria-label={`${flow.name} definition`}><code>{state.definition.yaml}</code></pre>}</div></li>;
}

function SavedFlowEntry({ flow, now, routine, onConversation }: { flow: SavedFlow; now: number; routine?: FlowRoutine; onConversation: (id: string) => void }) {
  const [state, setState] = useState<FlowDefinitionState>({ status: "closed" });
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  const toggle = (): void => {
    request.current?.abort();
    if (state.status !== "closed") { setState({ status: "closed" }); return; }
    const abort = new AbortController(); request.current = abort; setState({ status: "loading" });
    void loadSavedFlowDefinition(flow.name, abort.signal).then((definition) => {
      if (!abort.signal.aborted) setState({ status: "ready", definition });
    }).catch((error: unknown) => { if (!abort.signal.aborted) setState({ status: "error", error: flowReadError(error) }); });
  };
  const start = useRef<RoutineStart>(newRoutineStart());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ error: string; conversationId: string | null } | null>(null);
  const make = (): void => {
    if (!routine || busy) return;
    setBusy(true); setFailure(null);
    void makeRoutineFromFlow(flow.name, routine, start.current).then((result) => {
      if (result.status === "opened") { start.current = newRoutineStart(); onConversation(result.conversationId); }
      else setFailure({ error: result.error, conversationId: result.conversationId ?? null });
    }).finally(() => { setBusy(false); });
  };
  const action = routine ? { busy, error: failure?.error ?? null, conversationId: failure?.conversationId ?? null, onMake: make, onOpen: onConversation } : undefined;
  return <SavedFlowRow flow={flow} now={now} state={state} onToggle={toggle} {...(action ? { routine: action } : {})} />;
}

export function DeskSavedFlows({ state, now = Date.now(), onConversation = () => undefined }: { state: ShownFlowsState; now?: number; onConversation?: (id: string) => void }) {
  const name = useAssistantName();
  if (state.status === "error") return <p role="alert">{state.error}</p>;
  return <section aria-label="Saved flows"><h2>Saved flows</h2>{state.flows.length === 0 ? <p>No saved flows yet. Ask {name} to make a flow in a conversation.</p> : <ul className="saved-flow-list">{state.flows.map((flow) => <SavedFlowEntry key={`${flow.name}:${flow.sha256}:${flow.savedAt}`} flow={flow} now={now} onConversation={onConversation} {...(state.status === "ready" && state.routine ? { routine: state.routine } : {})} />)}</ul>}</section>;
}
