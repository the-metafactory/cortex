import { RoutineDetailSchema, parameterError, type RoutineDetail, type RoutinePatch, type RoutineStep } from "../../desk/routine-editor-contract";
import { postJson } from "../lib/api";
const endpoint = "/api/desk/routine-editor";
const message = (error: unknown): string => error instanceof Error ? error.message : "The routine owner did not answer.";
const stepKey = (step: RoutineStep): string => JSON.stringify(step.path);

interface FlowStepNode { step: RoutineStep; index: number; children: FlowStepNode[] }

export function routineStepTree(steps: RoutineStep[]): FlowStepNode[] {
  const roots: FlowStepNode[] = [];
  const ancestors: FlowStepNode[] = [];
  for (const [index, step] of steps.entries()) {
    while (ancestors.length) {
      const parent = ancestors.at(-1);
      if (parent && parent.step.path.length < step.path.length && parent.step.path.every((part, position) => part === step.path[position])) break;
      ancestors.pop();
    }
    const node = { step, index, children: [] } satisfies FlowStepNode;
    const parent = ancestors.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);
    ancestors.push(node);
  }
  return roots;
}

function FlowOutline({ nodes, selected, onSelect, label = "Installed flow steps" }: { nodes: FlowStepNode[]; selected: number; onSelect: (index: number) => void; label?: string }) {
  return <ol aria-label={label}>{nodes.map(({ step, index, children }) => <li key={stepKey(step)}><button type="button" className="desk-btn" aria-pressed={selected === index} onClick={() => { onSelect(index); }}>{index + 1}. {step.action}</button><small>{step.purpose}</small>{children.length > 0 && <FlowOutline nodes={children} selected={selected} onSelect={onSelect} label={`Steps inside ${step.action}`} />}</li>)}</ol>;
}

interface ParameterDraft { editing: boolean; revision: string; draft: Record<string, string>; errors: Record<string, string> }
export interface RoutineEditorSession {
  selected: string | null; text: string; proposal: { patches: RoutinePatch[]; revision: string; before: RoutineStep[] } | null;
  busy: boolean; error: string | null; saved: boolean; parameters: Record<string, ParameterDraft>;
}
export const newRoutineEditorSession = (): RoutineEditorSession => ({ selected: null, text: "", proposal: null, busy: false, error: null, saved: false, parameters: {} });
function ParameterEditor({ detail, step, onSave, busy, state, onState }: { detail: RoutineDetail; step: RoutineStep; onSave: (patches: RoutinePatch[], revision: string) => Promise<boolean>; busy: boolean; state: ParameterDraft | undefined; onState: (state: ParameterDraft) => void }) {
  const { editing, draft, errors, revision } = state ?? { editing: false, revision: detail.revision, draft: {}, errors: {} };
  const changed = editing && revision !== detail.revision;
  const save = async (): Promise<void> => {
    const patches: RoutinePatch[] = [];
    const problems: Record<string, string> = {};
    for (const field of step.editable) {
      const raw = draft[field.name];
      if (raw === undefined) continue;
      const value = field.type === "number" ? (raw.trim() ? Number(raw) : NaN) : field.type === "boolean" ? raw === "true" : raw;
      const problem = parameterError(field, value);
      if (problem) problems[field.name] = problem;
      else patches.push({ path: [...step.path, step.action, field.name], value });
    }
    onState({ editing, draft, revision, errors: problems });
    if (Object.keys(problems).length || !patches.length) return;
    if (await onSave(patches, revision)) onState({ editing: false, draft: {}, revision: detail.revision, errors: {} });
  };
  return <section className="desk-set-card" aria-label={`Step ${step.action}`}>
    <h2>{step.action}</h2><p>{step.purpose}</p>
    <dl>{step.parameters.map((parameter) => <div key={parameter.name}><dt>{parameter.name}</dt><dd>{parameter.kind === "redacted" ? "Hidden for privacy" : parameter.kind === "binding" ? `Binding: ${String(parameter.value)}` : String(parameter.value)}</dd></div>)}</dl>
    <p className="soft">{detail.writable ? step.reason : detail.reason}</p>
    {detail.writable && step.editable.length > 0 && !editing && <button type="button" className="desk-btn" onClick={() => { onState({ editing: true, revision: detail.revision, errors: {}, draft: Object.fromEntries(step.editable.map((field) => [field.name, String(step.parameters.find((p) => p.name === field.name && p.kind === "literal")?.value ?? "")])) }); }}>Edit step parameters</button>}
    {changed && <p role="alert">The installed routine changed. Your edits are preserved with their original revision. Discard these edits before starting from the newer revision.</p>}
    {editing && <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {step.editable.map((field) => {
        const id = `routine-field-${detail.id}-${field.name}`;
        const current = step.parameters.find((p) => p.name === field.name && p.kind === "literal")?.value;
        const value = draft[field.name] ?? (current === undefined ? "" : String(current));
        return <div className="desk-routine-field" key={field.name}><label htmlFor={id}>{field.name}</label>
          {field.enum || field.type === "boolean" ? <select id={id} value={value} onChange={(event) => { onState({ editing, revision, errors, draft: { ...draft, [field.name]: event.target.value } }); }}><option value="">Choose a value</option>{(field.enum ?? [true, false]).map((choice) => <option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}</select> : <input id={id} type={field.type === "number" ? "number" : "text"} min={field.minimum} max={field.maximum} step={field.type === "number" ? 1 : undefined} value={value} aria-invalid={Boolean(errors[field.name])} aria-describedby={errors[field.name] ? `${id}-error` : undefined} onChange={(event) => { onState({ editing, revision, errors, draft: { ...draft, [field.name]: event.target.value } }); }} />}
          {errors[field.name] && <p id={`${id}-error`} role="alert">{errors[field.name]}</p>}
        </div>;
      })}
      <div className="desk-acts"><button className="desk-btn pri" type="submit" disabled={busy || changed}>Save parameters</button><button className="desk-btn" type="button" disabled={busy} onClick={() => { onState({ editing: false, revision: detail.revision, draft: {}, errors: {} }); }}>Discard edits</button></div>
    </form>}
  </section>;
}

export function RoutineDetailPage({ detail, onUpdated, session, onSession }: { detail: RoutineDetail; onUpdated: (detail: RoutineDetail) => void; session: RoutineEditorSession; onSession: (change: (session: RoutineEditorSession) => RoutineEditorSession) => void }) {
  const { text, proposal, busy, error, saved } = session;
  const selected = Math.max(0, detail.flow?.steps.findIndex((step) => stepKey(step) === session.selected) ?? 0);
  const setText = (text: string): void => { onSession((s) => ({ ...s, text })); };
  const setProposal = (proposal: RoutineEditorSession["proposal"]): void => { onSession((s) => ({ ...s, proposal })); };
  const setBusy = (busy: boolean): void => { onSession((s) => ({ ...s, busy })); };
  const setError = (error: string | null): void => { onSession((s) => ({ ...s, error })); };
  const setSaved = (saved: boolean): void => { onSession((s) => ({ ...s, saved })); };
  const apply = async (patches: RoutinePatch[], revision = detail.revision): Promise<boolean> => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = RoutineDetailSchema.parse(await postJson(endpoint, { action: "update", id: detail.id, revision, patches }));
      if (result.id !== detail.id) throw new Error("The routine owner returned a different routine after saving.");
      setProposal(null); setSaved(true); onUpdated(result); return true;
    } catch (failure) { setError(message(failure)); return false; }
    finally { setBusy(false); }
  };
  const ask = async (): Promise<void> => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = await postJson<{ action: string; id: string; revision: string; text: string }, { patches: RoutinePatch[]; revision: string }>(endpoint, { action: "propose", id: detail.id, revision: detail.revision, text });
      if (result.revision !== detail.revision) throw new Error("The proposal refers to a different installed revision. Ask for a new proposal.");
      setProposal({ ...result, before: detail.flow?.steps ?? [] });
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };
  const step = detail.flow?.steps[selected];
  return <div className="desk-routine-detail">
    <h3>Installed flow{detail.flow && detail.flow.name !== detail.id ? ` · ${detail.flow.name}` : ""}</h3>
    {detail.reason && <p>{detail.reason}</p>}
    {error && <p role="alert">{error}</p>}{saved && <p role="status">Parameters saved and verified.</p>}
    {detail.flow && <><div className="desk-routine-flow"><FlowOutline nodes={routineStepTree(detail.flow.steps)} selected={selected} onSelect={(index) => { const chosen = detail.flow?.steps[index]; if (chosen) onSession((s) => ({ ...s, selected: stepKey(chosen) })); }} />
      {step && <ParameterEditor detail={detail} step={step} busy={busy} onSave={apply} state={session.parameters[stepKey(step)]} onState={(draft) => { onSession((s) => ({ ...s, parameters: { ...s.parameters, [stepKey(step)]: draft } })); }} />}</div>
      {detail.writable && detail.flow.steps.some((entry) => entry.editable.length > 0) && <section className="desk-set-card" aria-label="AI routine editing"><h3>Ask Ivy to change this routine</h3><p>Ivy can propose changes to the parameters shown here. Nothing changes until you apply a proposal.</p>
        <form onSubmit={(event) => { event.preventDefault(); void ask(); }}><label htmlFor={`routine-edit-request-${detail.id}`}>Requested change</label><textarea id={`routine-edit-request-${detail.id}`} value={text} maxLength={2000} onChange={(event) => { setText(event.target.value); }} /><button className="desk-btn" type="submit" disabled={busy || !text.trim()}>{proposal ? "Revise proposal" : "Propose change"}</button></form>
        {proposal && <div><h4>Proposed changes</h4>{proposal.revision !== detail.revision && <p role="alert">The installed routine changed after this proposal. The original comparison is preserved. Ask for a new proposal before applying.</p>}{proposal.patches.length === 0 && <p>No supported parameter changes were proposed. Revise your request.</p>}<dl>{proposal.patches.map((patch) => {
          const entry = proposal.before.find((s) => JSON.stringify([...s.path, s.action]) === JSON.stringify(patch.path.slice(0, -1)));
          const name = String(patch.path.at(-1));
          const before = entry?.parameters.find((p) => p.name === name && p.kind === "literal")?.value;
          return <div key={JSON.stringify(patch.path)}><dt>{entry?.action} · {name}</dt><dd>{before === undefined ? "Not set" : String(before)} → {String(patch.value)}</dd></div>;
        })}</dl><div className="desk-acts"><button className="desk-btn pri" type="button" disabled={busy || !proposal.patches.length || proposal.revision !== detail.revision} onClick={() => { void apply(proposal.patches, proposal.revision); }}>Apply proposed changes</button><button className="desk-btn" type="button" disabled={busy} onClick={() => { setProposal(null); }}>Cancel proposal</button></div></div>}
      </section>}
    </>}
  </div>;
}

