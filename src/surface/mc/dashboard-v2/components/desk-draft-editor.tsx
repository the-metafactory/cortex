import { useEffect, useState } from "react";
import type { EditChange } from "../../../../conversations/domain-adapters/drafting-types";
import type { EditorField } from "../../desk/draft-editor-contract";
import { changeDraftDestination, confirmDraft, draftDetails, draftTargets, editDraft, makeDraft, readDraft, refreshDraft, type DraftDetails, type DraftEditorView, type DraftTarget, type MakeDraftReply } from "../lib/desk-drafts";
import "./desk-draft-editor.css";

const valueText = (value: unknown): string => value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
const errorText = (error: unknown): string => error instanceof Error ? error.message : "The draft could not be updated.";
const targetKey = (target: DraftTarget): string => JSON.stringify([target.capabilityId, target.connectionId]);

export function DeskMakePanel({ conversationId, entryId, archived = false }: { conversationId: string; entryId: string | null; archived?: boolean }) {
  const [targets, setTargets] = useState<DraftTarget[]>([]);
  const [target, setTarget] = useState("");
  const [editor, setEditor] = useState<DraftEditorView | null>(null);
  const [candidates, setCandidates] = useState<Extract<MakeDraftReply, { kind: "select" }>["candidates"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setEditor(null); setCandidates([]); setError("");
    void draftTargets(controller.signal).then(reply => { if (!controller.signal.aborted) { setTargets(reply.targets); setTarget(reply.targets[0] ? targetKey(reply.targets[0]) : ""); } }).catch((err: unknown) => { if (!controller.signal.aborted) setError(errorText(err)); });
    return () => { controller.abort(); };
  }, [conversationId]);
  async function make(selectDraftId?: string, newDraft?: boolean): Promise<void> {
    const selected = targets.find(item => targetKey(item) === target);
    if (!selected || !entryId) return;
    setBusy(true); setError("");
    try {
      const reply = await makeDraft({ conversationId, entryId, capabilityId: selected.capabilityId, connectionId: selected.connectionId, ...(selectDraftId ? { selectDraftId } : {}), ...(newDraft ? { newDraft } : {}) });
      if (reply.kind === "draft") { setEditor(reply); setCandidates([]); }
      else setCandidates(reply.candidates);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }
  if (targets.length === 0 && !error) return null;
  return <section className="desk-make" aria-label="Make from this exchange">
    <h3>Make</h3>
    {error && <p role="alert">{error}</p>}
    <label>What to make<select value={target} disabled={busy || archived} onChange={event => { setTarget(event.target.value); setEditor(null); setCandidates([]); }}>{targets.map(item => <option key={targetKey(item)} value={targetKey(item)}>{item.label}</option>)}</select></label>
    <button disabled={busy || archived || !entryId || !target} onClick={() => { void make(); }}>Make</button>
    {candidates.length > 0 && <div><p>Choose a saved draft to reopen.</p>{candidates.map(item => <button key={item.draftId} disabled={busy} onClick={() => { void make(item.draftId); }}>Reopen draft from {item.updatedAt}</button>)}<button disabled={busy || archived} onClick={() => { void make(undefined, true); }}>Make another draft</button></div>}
    {editor && <DeskDraftEditor key={editor.view.draft.draftId} editor={editor} targets={targets} disabled={archived} onChanged={setEditor} />}
  </section>;
}

export function DeskDraftEditor({ editor, targets, disabled = false, onChanged }: { editor: DraftEditorView; targets: DraftTarget[]; disabled?: boolean; onChanged: (next: DraftEditorView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const { draft } = editor.view;
  const changes = editor.destinationChanges;
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  async function act(run: () => Promise<DraftEditorView>): Promise<void> {
    setBusy(true); setError(""); setConfirmation("");
    try { onChanged(await run()); }
    catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }
  const target = targets.find(item => item.capabilityId === draft.capabilityId && item.connectionId === draft.connectionId);
  return <article className="desk-draft" aria-label="Draft editor" data-revision={draft.revision}>
    <h4>{target?.label ?? "Saved draft"}</h4>
    <p role="status">{editor.view.status === "needs-input" ? "Needs input" : "Ready for confirmation"}. Draft saved.</p>
    <label>Destination<select aria-label="Draft destination" disabled={busy || disabled} value={target ? targetKey(target) : ""} onChange={event => { const next = targets.find(item => targetKey(item) === event.target.value); if (next) void act(() => changeDraftDestination(draft.draftId, draft.revision, next)); }}>{targets.map(item => <option key={targetKey(item)} value={targetKey(item)}>{item.label}</option>)}</select></label>
    {editor.view.outdated.length > 0 && <p role="status">Review needed: {editor.view.outdated.join(", ")}. Refresh explicitly to use current context.</p>}
    {!editor.view.automaticDrafting.available && <p>{editor.view.automaticDrafting.reason}. You can still edit this draft.</p>}
    {draft.limitations.map((item, index) => <p key={`${item.code}:${index}`}>{item.message}</p>)}
    {editor.view.withheld.length > 0 && <p>Policy withholds some draft fields in this context.</p>}
    {changes.length > 0 && <aside aria-label="Destination changes"><p>Destination changed. Review before confirming.</p>{changes.map(change => <p key={change.pointer}>{change.pointer}: {valueText(change.before)} → {valueText(change.after)}</p>)}<label><input type="checkbox" checked={reviewedRevision === draft.revision} onChange={event => { setReviewedRevision(event.target.checked ? draft.revision : null); }} />I reviewed the destination changes</label></aside>}
    {editor.fields.map(field => <DraftFieldEditor key={`${draft.draftId}:${draft.revision}:${field.pointer}`} field={field} editor={editor} disabled={busy || disabled || editor.view.withheld.includes(field.pointer)} save={change => act(() => editDraft(draft.draftId, draft.revision, field.pointer, change))} />)}
    {editor.view.unsupported.length > 0 && <p>Fields outside the current schema are kept: {editor.view.unsupported.join(", ")}</p>}
    {editor.view.blocking.map(item => <p key={`${item.pointer}:${item.code}`} role="status">{item.pointer}: {item.code}</p>)}
    {error && <p role="alert">{error}</p>}
    {confirmation && <p role="status">{confirmation}</p>}
    <div className="desk-draft-actions">
      <button disabled={busy || disabled || !editor.view.automaticDrafting.available} onClick={() => { void act(() => refreshDraft(draft.draftId, draft.revision)); }}>Refresh draft</button>
      <button disabled={busy} onClick={() => { void act(() => readDraft(draft.draftId)); }}>Reopen draft</button>
      <button disabled={busy || disabled || editor.view.blocking.length > 0 || changes.length > 0 && reviewedRevision !== draft.revision} onClick={() => {
        setBusy(true); setError("");
        void confirmDraft(draft.draftId, draft.revision).then(({ confirmation: result }) => { setConfirmation(result.kind === "blocked" ? result.reason : `Accepted. Operation ${result.operationId}.`); }).catch((err: unknown) => { setError(errorText(err)); }).finally(() => { setBusy(false); });
      }}>Confirm draft</button>
    </div>
  </article>;
}

function DraftFieldEditor({ field, editor, disabled, save }: { field: EditorField; editor: DraftEditorView; disabled: boolean; save: (change: EditChange) => Promise<void> }) {
  const current = editor.view.draft.fields[field.pointer];
  const [text, setText] = useState(current?.presence === "present" ? valueText(current.value) : "");
  const [details, setDetails] = useState<DraftDetails | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const types = Array.isArray(field.schema.type) ? field.schema.type : [field.schema.type];
  const string = types.includes("string");
  const bool = types.includes("boolean");
  const choices = Array.isArray(field.schema.enum) ? field.schema.enum : null;
  const label = `${field.label}${field.required ? " (required)" : ""}`;
  const update = (): void => {
    try { const value: unknown = string ? text : JSON.parse(text); setError(""); void save({ kind: "set", value }); }
    catch (err) { setError(`Enter a valid ${bool ? "boolean" : "JSON value"}: ${errorText(err)}`); }
  };
  return <fieldset className="desk-draft-field" disabled={disabled}>
    <legend>{field.label}{field.destination ? " · Destination" : ""}</legend>
    <label>{label}{choices || bool ? <select aria-label={label} value={text} onChange={event => { setText(event.target.value); }}><option value="">Choose…</option>{(choices ?? [true, false]).map(value => <option key={JSON.stringify(value)} value={string ? String(value) : JSON.stringify(value)}>{String(value)}</option>)}</select> : field.long || !string ? <textarea aria-label={label} value={text} onChange={event => { setText(event.target.value); }} /> : <input aria-label={label} value={text} onChange={event => { setText(event.target.value); }} />}</label>
    <span>{current?.origin === "suggested" ? "Suggested" : current?.origin === "principal" ? "Edited by you" : current?.origin === "generated" ? "From conversation" : current?.origin === "default" ? "Default" : "Not filled"}{current?.presence === "absent" ? " · Cleared" : current?.presence === "null" ? " · Null" : ""}</span>
    {current?.unresolved && <p>{current.unresolved}</p>}
    <div className="desk-draft-actions"><button onClick={update}>Save {field.label}</button><button onClick={() => { void save({ kind: "omit" }); }}>Clear {field.label}</button>{types.includes("null") && <button onClick={() => { void save({ kind: "null" }); }}>Set {field.label} to null</button>}
      <button disabled={!current || loading} onClick={() => {
        setLoading(true); setError("");
        void draftDetails(editor.view.draft.draftId, field.pointer).then(reply => { setDetails(reply.details); }).catch((err: unknown) => { setError(errorText(err)); }).finally(() => { setLoading(false); });
      }}>Sources for {field.label}</button></div>
    {error && <p role="alert">{error}</p>}
    {details && <aside aria-label={`Sources for ${field.label}`}><p>Origin: {details.origin}. {details.reason}</p>{details.sources.map(source => <p key={source.id}>{source.kind}: {source.id}, revision {source.revision}</p>)}{details.hiddenSources > 0 && <p>{details.hiddenSources} sources withheld by policy.</p>}{details.alternatives.map((alternative, index) => <button key={index} onClick={() => { void save({ kind: "set", value: alternative.value }); }}>Use {valueText(alternative.value)}</button>)}</aside>}
  </fieldset>;
}
