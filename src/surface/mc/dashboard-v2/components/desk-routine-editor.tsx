import { useEffect, useRef, useState } from "react";
import { getJson, postJson } from "../lib/api";
import { RoutineDetailSchema, RoutineInventorySchema, parameterError, type RoutineDetail, type RoutineInventory, type RoutinePatch, type RoutineStep } from "../../desk/routine-editor-contract";

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

function ParameterEditor({ detail, step, onSave, busy }: { detail: RoutineDetail; step: RoutineStep; onSave: (patches: RoutinePatch[]) => Promise<void>; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
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
    setErrors(problems);
    if (Object.keys(problems).length || !patches.length) return;
    await onSave(patches);
  };
  return <section className="desk-set-card" aria-label={`Step ${step.action}`}>
    <h2>{step.action}</h2><p>{step.purpose}</p>
    <dl>{step.parameters.map((parameter) => <div key={parameter.name}><dt>{parameter.name}</dt><dd>{parameter.kind === "redacted" ? "Hidden for privacy" : parameter.kind === "binding" ? `Binding: ${String(parameter.value)}` : String(parameter.value)}</dd></div>)}</dl>
    <p className="soft">{detail.writable ? step.reason : detail.reason}</p>
    {detail.writable && step.editable.length > 0 && !editing && <button type="button" className="desk-btn" onClick={() => { setEditing(true); }}>Edit step parameters</button>}
    {editing && <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {step.editable.map((field) => {
        const id = `routine-field-${field.name}`;
        const current = step.parameters.find((p) => p.name === field.name && p.kind === "literal")?.value;
        const value = draft[field.name] ?? (current === undefined ? "" : String(current));
        return <div className="desk-routine-field" key={field.name}><label htmlFor={id}>{field.name}</label>
          {field.enum || field.type === "boolean" ? <select id={id} value={value} onChange={(event) => { setDraft({ ...draft, [field.name]: event.target.value }); }}><option value="">Choose a value</option>{(field.enum ?? [true, false]).map((choice) => <option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}</select> : <input id={id} type={field.type === "number" ? "number" : "text"} min={field.minimum} max={field.maximum} step={field.type === "number" ? 1 : undefined} value={value} aria-invalid={Boolean(errors[field.name])} aria-describedby={errors[field.name] ? `${id}-error` : undefined} onChange={(event) => { setDraft({ ...draft, [field.name]: event.target.value }); }} />}
          {errors[field.name] && <p id={`${id}-error`} role="alert">{errors[field.name]}</p>}
        </div>;
      })}
      <div className="desk-acts"><button className="desk-btn pri" type="submit" disabled={busy}>Save parameters</button><button className="desk-btn" type="button" disabled={busy} onClick={() => { setEditing(false); setDraft({}); setErrors({}); }}>Discard edits</button></div>
    </form>}
  </section>;
}

function RoutineDetailPage({ detail, onUpdated }: { detail: RoutineDetail; onUpdated: (detail: RoutineDetail) => void }) {
  const [selected, setSelected] = useState(0);
  const [text, setText] = useState("");
  const [proposal, setProposal] = useState<{ patches: RoutinePatch[]; revision: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const apply = async (patches: RoutinePatch[], revision = detail.revision): Promise<void> => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = RoutineDetailSchema.parse(await postJson(endpoint, { action: "update", id: detail.id, revision, patches }));
      setProposal(null); setSaved(true); onUpdated(result);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };
  const ask = async (): Promise<void> => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = await postJson<{ action: string; id: string; revision: string; text: string }, { patches: RoutinePatch[]; revision: string }>(endpoint, { action: "propose", id: detail.id, revision: detail.revision, text });
      setProposal(result);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };
  const step = detail.flow?.steps[selected];
  return <div className="desk-routine-detail">
    <h2>{detail.flow?.name ?? detail.id}</h2>
    {detail.reason && <p>{detail.reason}</p>}
    {error && <p role="alert">{error}</p>}{saved && <p role="status">Parameters saved and verified.</p>}
    {detail.flow && <><div className="desk-routine-flow"><FlowOutline nodes={routineStepTree(detail.flow.steps)} selected={selected} onSelect={setSelected} />
      {step && <ParameterEditor key={`${detail.revision}:${stepKey(step)}`} detail={detail} step={step} busy={busy} onSave={apply} />}</div>
      {detail.writable && detail.flow.steps.some((entry) => entry.editable.length > 0) && <section className="desk-set-card" aria-label="AI routine editing"><h3>Ask Ivy to change this routine</h3><p>Ivy can propose changes to the parameters shown here. Nothing changes until you apply a proposal.</p>
        <form onSubmit={(event) => { event.preventDefault(); void ask(); }}><label htmlFor="routine-edit-request">Requested change</label><textarea id="routine-edit-request" value={text} maxLength={2000} onChange={(event) => { setText(event.target.value); }} /><button className="desk-btn" type="submit" disabled={busy || !text.trim()}>{proposal ? "Revise proposal" : "Propose change"}</button></form>
        {proposal && <div><h4>Proposed changes</h4>{proposal.patches.length === 0 && <p>No supported parameter changes were proposed. Revise your request.</p>}<dl>{proposal.patches.map((patch) => {
          const entry = detail.flow?.steps.find((s) => JSON.stringify([...s.path, s.action]) === JSON.stringify(patch.path.slice(0, -1)));
          const name = String(patch.path.at(-1));
          const before = entry?.parameters.find((p) => p.name === name && p.kind === "literal")?.value;
          return <div key={JSON.stringify(patch.path)}><dt>{entry?.action} · {name}</dt><dd>{before === undefined ? "Not set" : String(before)} → {String(patch.value)}</dd></div>;
        })}</dl><div className="desk-acts"><button className="desk-btn pri" type="button" disabled={busy || !proposal.patches.length} onClick={() => { void apply(proposal.patches, proposal.revision); }}>Apply proposed changes</button><button className="desk-btn" type="button" disabled={busy} onClick={() => { setProposal(null); }}>Cancel proposal</button></div></div>}
      </section>}
    </>}
  </div>;
}

export function DeskRoutineEditor({ onBack }: { onBack: () => void }) {
  const [inventory, setInventory] = useState<RoutineInventory | null>(null);
  const [detail, setDetail] = useState<RoutineDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedId = useRef<string | null>(null);
  const choose = (id: string | null): void => { selectedId.current = id; setSelected(id); };
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async (): Promise<void> => {
    setError(null);
    try { setInventory(RoutineInventorySchema.parse(await getJson(endpoint))); }
    catch (failure) { setError(message(failure)); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    setLoading(true); setError(null); setDetail(null);
    void getJson(`${endpoint}?id=${encodeURIComponent(selected)}`, { signal: abort.signal }).then((value) => {
      if (!abort.signal.aborted) setDetail(RoutineDetailSchema.parse(value));
    }).catch((failure: unknown) => { if (!abort.signal.aborted) setError(message(failure)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); };
  }, [selected]);
  return <div className="desk desk-settings desk-routine-page"><header className="desk-top"><div className="desk-top-in"><span className="desk-brand">Routines</span><button className="desk-btn" type="button" onClick={onBack}>Back to the Desk</button></div></header><main className="desk-set-main"><h1>Routines</h1>
    <button className="desk-btn" type="button" onClick={() => { choose(null); setDetail(null); void load(); }}>Refresh routines</button>
    {error && <p role="alert">{error}</p>}
    {!inventory && !error && <p role="status">Reading installed routines…</p>}
    {inventory?.length === 0 && <p>No installed routines were returned by the configured owner.</p>}
    <div className="desk-routine-layout"><nav aria-label="Installed routines"><ul>{inventory?.map((routine) => <li key={routine.id}><button type="button" className="desk-btn" aria-current={selected === routine.id ? "page" : undefined} onClick={() => { choose(routine.id); }}>{routine.name ?? routine.id}</button><small>{routine.schedule} · {routine.timezone ?? "Timezone not specified"}<br />{routine.policy === "auto" ? "Automatic" : routine.policy === "disabled" ? "Disabled" : "Approval required"}{routine.readOnly ? " · Read-only" : ""}</small></li>)}</ul></nav><div>
      {loading && <p role="status">Reading the installed flow…</p>}
      {detail && <RoutineDetailPage key={detail.id} detail={detail} onUpdated={(result) => { if (selectedId.current === result.id) setDetail(result); }} />}
      {!selected && <p>Select a routine to inspect its installed flow.</p>}
    </div></div>
  </main></div>;
}
