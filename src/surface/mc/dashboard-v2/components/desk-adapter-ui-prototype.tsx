import { useRef, useState, type FormEvent } from "react";
import { DeskAdapterUiPrototypeLab } from "./desk-adapter-ui-prototype-lab";
import { adapterFixtures, applyDraftUpdate, draftFromDiscussion, draftMissing, prototypeDiscussion, resolveFixtureDestinations, unresolvedAlternatives, SyntheticDraftOwner, type ConversationDraft, type DiscussionMessage, type DraftContext, type DraftFields, type DraftKind } from "./desk-drafting-prototype-model";
import "./desk-conversation-task-prototype.css";

export function DeskAdapterUiPrototype() {
  return new URLSearchParams(location.search).get("lab") === "1" ? <DeskAdapterUiPrototypeLab /> : <ConversationDraftingPrototype />;
}
function ConversationDraftingPrototype() {
  const scenario = useRef(new URLSearchParams(location.search).get("case") ?? "normal").current;
  const [messages, setMessages] = useState<DiscussionMessage[]>(() => prototypeDiscussion(scenario));
  const [drafts, setDrafts] = useState<ConversationDraft[]>([]);
  const [input, setInput] = useState("");
  const [pane, setPane] = useState<"conversation" | "conversations" | string>("conversation");
  const [editing, setEditing] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<DraftFields>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const context = useRef<DraftContext>({ scenario });
  const owner = useRef(new SyntheticDraftOwner());
  const live = useRef({ messages, drafts });
  live.current = { messages, drafts };
  const inFlight = useRef(new Set<string>());
  const generating = useRef(new Set<DraftKind>());
  const append = (speaker: DiscussionMessage["speaker"], text: string, cardId?: string) => {
    const next: DiscussionMessage = { id: crypto.randomUUID(), speaker, text, ...(cardId ? { cardId } : {}) };
    setMessages(current => [...current, next]);
    return next;
  };
  const replace = (id: string, update: (draft: ConversationDraft) => ConversationDraft) => { setDrafts(current => current.map(draft => draft.id === id ? update(draft) : draft)); };
  const generate = (kind: DraftKind, discussion: DiscussionMessage[], existing?: ConversationDraft) => {
    if (scenario === "local-only") { append("Ivy", "I can’t draft from this private discussion right now. You can still fill in the card yourself."); }
    const candidate = draftFromDiscussion(kind, discussion, context.current);
    const fields = scenario === "local-only" ? { ...candidate.fields, title: "", [adapterFixtures[kind].mainText]: "" } : candidate.fields;
    if (existing) replace(existing.id, draft => applyDraftUpdate(draft, { ...candidate, fields }));
    else {
      const id = crypto.randomUUID();
      const draft: ConversationDraft = { id, kind, revision: 1, editEpoch: 0, fields, origins: candidate.origins, edited: [], missing: candidate.missing, alternatives: candidate.alternatives, stale: false, updating: false, status: "proposed", destinations: candidate.destinations };
      setDrafts(current => [...current, draft]);
      append("Ivy", kind === "balance" ? "Here’s a task for that." : "Here’s a research node for that.", id);
      if (candidate.alternatives.length) append("Ivy", kind === "balance" ? "Which destination or date did you mean? Choose below, or tell me." : "Where should I put the research node?");
    }
  };
  const refresh = (draft: ConversationDraft, discussion: DiscussionMessage[]) => {
    if (["saving", "saved", "uncertain"].includes(draft.status)) { append("Ivy", "Let’s keep the submitted card intact. We can check its result or start a separate draft after it is settled."); return; }
    const revision = draft.revision, epoch = draft.editEpoch;
    replace(draft.id, current => ({ ...current, updating: true }));
    const candidate = draftFromDiscussion(draft.kind, discussion, context.current);
    setTimeout(() => {
      const current = live.current.drafts.find(value => value.id === draft.id);
      if (!current || current.revision !== revision || current.editEpoch !== epoch) {
        replace(draft.id, value => ({ ...value, updating: false }));
        append("Ivy", "You edited the card while I was updating it. I kept your edits; ask me to update again when you’re ready.");
        return;
      }
      replace(draft.id, value => applyDraftUpdate(value, candidate));
      append("Ivy", current.edited.length ? "I updated the untouched details and kept your edits." : "I updated the draft with the new details.");
    }, scenario === "slow" ? 1000 : 220);
  };
  const send = (text: string) => {
    const value = text.trim();
    if (!value) return;
    setInput("");
    const message = append("You", value);
    const discussion = [...live.current.messages, message];
    const kind: DraftKind = /research node|graph node/i.test(value) ? "graph" : "balance";
    const existing = [...live.current.drafts].reverse().find(draft => draft.kind === kind);
    if (/^(?:update|refresh|include (?:the )?new details)/i.test(value)) {
      const requestedKind = /task/i.test(value) ? "balance" : /node/i.test(value) ? "graph" : undefined;
      const target = editing ? live.current.drafts.find(draft => draft.id === editing) : [...live.current.drafts].reverse().find(draft => (!requestedKind || draft.kind === requestedKind) && !["saved", "uncertain", "saving"].includes(draft.status));
      if (target) refresh(target, discussion); else append("Ivy", "There is no editable draft to update yet.");
      return;
    }
    if (/^(?:turn this|make this|create (?:a |the )?)/i.test(value) && /task|node/i.test(value)) {
      if (existing) { append("Ivy", existing.status === "saved" ? "That is already saved. The card and its result are still in this conversation." : existing.status === "uncertain" ? "The original result is still unconfirmed. Let’s check it before making another." : "Your draft is still in this conversation; I’ve kept your edits."); return; }
      if (generating.current.has(kind)) { append("Ivy", "I’m preparing that draft."); return; }
      generating.current.add(kind); setBusy(true);
      setTimeout(() => { generate(kind, discussion); generating.current.delete(kind); setBusy(false); }, 200);
      return;
    }
    if (/^new draft/i.test(value)) {
      if (live.current.drafts.some(draft => ["saving", "uncertain"].includes(draft.status))) { append("Ivy", "Let’s settle the outstanding result before starting another draft."); return; }
      generate(kind, discussion);
      return;
    }
    setDrafts(current => current.map(draft => ["proposed", "failed"].includes(draft.status) ? { ...draft, stale: true } : draft));
    append("Ivy", "I’ve noted that. Ask me to update the draft when you want to include it.");
  };
  const startEdit = (draft: ConversationDraft) => { setEditing(draft.id); setEditFields({ ...draft.fields }); setError(""); };
  const change = (draft: ConversationDraft, name: string, value: string) => { setEditFields(current => ({ ...current, [name]: value })); replace(draft.id, current => ({ ...current, editEpoch: current.editEpoch + 1 })); setError(""); };
  const saveEdit = (event: FormEvent<HTMLFormElement>, draft: ConversationDraft) => {
    event.preventDefault();
    const changed = Object.keys(editFields).filter(key => editFields[key] !== draft.fields[key]);
    replace(draft.id, current => ({ ...current, fields: { ...editFields }, edited: [...new Set([...current.edited, ...changed])], origins: { ...current.origins, ...Object.fromEntries(changed.map(key => [key, { kind: "user" as const, sourceIds: [] }])) }, revision: current.revision + 1, alternatives: unresolvedAlternatives(current.kind, editFields, [...current.edited, ...changed], current.alternatives), missing: draftMissing(current.kind, editFields), destinations: resolveFixtureDestinations(current.kind, editFields), status: "proposed", operationId: undefined }));
    setEditing(null); setError("");
  };
  const choose = (draft: ConversationDraft, selection: string) => {
    const message = append("You", `Use ${selection}.`);
    const dateChoice = ["Friday", "Monday", "No due date"].includes(selection);
    if (dateChoice) { context.current.dueSelection = selection; context.current.dueMessageId = message.id; }
    else context.current.selection = selection;
    const candidate = draftFromDiscussion(draft.kind, [...live.current.messages, message], context.current);
    const selectedFields = dateChoice ? ["due"] : draft.kind === "balance" ? ["area", "project"] : ["repository", "parent"];
    replace(draft.id, current => {
      const updated = applyDraftUpdate(current, candidate);
      for (const key of selectedFields) { updated.fields[key] = candidate.fields[key] ?? ""; updated.origins[key] = { kind: "user", sourceIds: [message.id] }; }
      updated.edited = [...new Set([...updated.edited, ...selectedFields])];
      updated.missing = draftMissing(updated.kind, updated.fields);
      updated.destinations = resolveFixtureDestinations(updated.kind, updated.fields);
      return updated;
    });
  };
  const approve = (draft: ConversationDraft, retry = false) => {
    const missing = draftMissing(draft.kind, draft.fields);
    if (missing.length || draft.alternatives.length || editing === draft.id || !["proposed", "failed"].includes(draft.status)) return;
    const operationId = draft.operationId ?? `${draft.id}:${draft.revision}`;
    if (inFlight.current.has(operationId)) return;
    inFlight.current.add(operationId);
    const fields = { ...draft.fields };
    replace(draft.id, current => ({ ...current, operationId, status: "saving" }));
    setTimeout(() => {
      const result = owner.current.approve(operationId, draft.kind, fields, scenario, retry);
      replace(draft.id, current => ({ ...current, status: result.outcome, ...(result.receipt ? { receipt: result.receipt } : {}) }));
      inFlight.current.delete(operationId);
    }, 300);
  };
  const check = (draft: ConversationDraft) => {
    if (!draft.operationId || checking) return;
    setChecking(draft.id);
    setTimeout(() => {
      const receipt = owner.current.lookup(draft.operationId!);
      if (receipt) replace(draft.id, current => ({ ...current, status: "saved", receipt }));
      setChecking(null);
    }, 220);
  };
  const card = (draft: ConversationDraft, detail = false) => {
    const fixture = adapterFixtures[draft.kind];
    const missingFields = draftMissing(draft.kind, draft.fields);
    const blocked = missingFields.length > 0 || draft.alternatives.length > 0;
    const destinationMissing = missingFields.some(key => ["area", "destination", "repository", "parent"].includes(key));
    const destination = draft.kind === "balance" ? [draft.fields.area, draft.fields.project].filter(Boolean).join(" · ") : [draft.fields.repository, draft.fields.parent].filter(Boolean).join(" · ");
    const saved = draft.status === "saved";
    return <article id={`draft-${draft.id}`} key={draft.id} className="dcp-card" aria-label={`${saved ? "Saved" : "Proposed"} ${fixture.label} ${fixture.action}`} data-draft-id={draft.id} data-revision={draft.revision} data-kind={draft.kind} data-draft-status={draft.status} data-destination-count={draft.destinations.length}>
      <div className="dcp-card-meta"><span className="dcp-balance">{fixture.label}</span><span>{destination || "Destination not chosen"}</span></div>
      {editing === draft.id && !detail ? <form className="dcp-edit" onSubmit={event => { saveEdit(event, draft); }}>
        {fixture.fields.slice(0, 2).map(field => <label key={field.name}>{field.label}{field.long ? <textarea aria-label={field.label} value={editFields[field.name] ?? ""} onChange={event => { change(draft, field.name, event.target.value); }} /> : <input aria-label={field.label} autoFocus value={editFields[field.name] ?? ""} onChange={event => { change(draft, field.name, event.target.value); }} />}</label>)}
        {error && <p className="dcp-error" role="alert">{error}</p>}
        <details><summary>More details</summary><div className="dcp-extra-fields">{fixture.fields.slice(2).map(field => <label key={field.name}>{field.label}<input aria-label={field.label} type={field.name === "due" ? "date" : "text"} value={editFields[field.name] ?? ""} onChange={event => { change(draft, field.name, event.target.value); }} /></label>)}</div></details>
        <div className="dcp-actions"><button type="submit" className="dcp-primary">Save changes</button><button type="button" onClick={() => { setEditing(null); setError(""); }}>Cancel</button></div>
      </form> : <>
        <h2>{draft.fields.title || "Untitled draft"}</h2><p className="dcp-note">{draft.fields[fixture.mainText]}</p>
        {draft.fields.due && <p className="dcp-due">Due {draft.fields.due} <span>· Suggested</span></p>}
        {draft.stale && !saved && <p className="dcp-update">New details are available in our conversation.</p>}
        {draft.updating && <p role="status" className="dcp-thinking">Updating the draft…</p>}
        {draft.alternatives.length > 0 && <div className="dcp-clarification"><p>{draft.alternatives.includes("Friday") ? "Which date would you like?" : draft.kind === "graph" ? "Where should this go?" : "Which project did you mean?"}</p>{draft.alternatives.map(selection => <button type="button" key={selection} onClick={() => { choose(draft, selection); }}>{selection}</button>)}</div>}
        {missingFields.includes("title") && <p className="dcp-error" role="alert">Give this a title before approving.</p>}
        {missingFields.includes("checkpoint") && <p className="dcp-error" role="alert">Add what would count as done before approving.</p>}
        {destinationMissing && !draft.alternatives.length && <div className="dcp-clarification"><p>Where should I put this {fixture.action}?</p>{(draft.kind === "balance" ? ["Reliability", "Inbox"] : ["Lifecycle map"]).map(selection => <button type="button" key={selection} onClick={() => { choose(draft, selection); }}>{selection}</button>)}</div>}
        {draft.status === "uncertain" ? <div className="dcp-save-message"><p role="status">I couldn’t confirm whether this was added. Let’s check the result before trying again.</p><button type="button" onClick={() => { check(draft); }} disabled={checking === draft.id}>{checking === draft.id ? "Checking…" : "Check result"}</button></div> : draft.status === "failed" ? <div className="dcp-save-message"><p role="alert">I couldn’t add this. Your draft is still here.</p><div className="dcp-actions"><button type="button" className="dcp-primary" onClick={() => { approve(draft, true); }}>Try again</button><button type="button" onClick={() => { startEdit(draft); }}>Edit</button></div></div> : saved ? <div className="dcp-saved"><p role="status" className="dcp-created">✓ Added to {fixture.label}</p>{!detail && <button type="button" className="dcp-view-task" onClick={() => { setPane(draft.id); }}>View {fixture.action} →</button>}</div> : <div className="dcp-actions"><button type="button" className="dcp-primary" onClick={() => { approve(draft); }} disabled={blocked || draft.status === "saving" || draft.updating}>{draft.status === "saving" ? "Adding…" : "Approve"}</button><button type="button" onClick={() => { startEdit(draft); }} disabled={draft.status === "saving"}>Edit</button></div>}
        {saved && draft.receipt?.currentAvailable === false && <p className="dcp-note">The saved result is preserved, but its current details are unavailable.</p>}
        <details className="dcp-why"><summary>Why these details?</summary>{fixture.fields.filter(field => draft.fields[field.name] !== undefined).map(field => <div key={field.name}><strong>{field.label}</strong><p>{draft.origins[field.name]?.kind === "user" ? "You edited this field." : draft.origins[field.name]?.kind === "context" ? "From the selected conversation context." : draft.origins[field.name]?.kind === "suggested" ? "Suggested from our discussion." : "From our discussion."}</p>{draft.origins[field.name]?.sourceIds.map(id => { const source = messages.find(message => message.id === id); return source ? <a href={`#message-${id}`} key={id}>“{source.text}”</a> : null; })}</div>)}</details>
      </>}
    </article>;
  };
  const detail = drafts.find(draft => draft.id === pane);
  return <div className="desk dcp" data-drafting-prototype data-owner-calls={owner.current.calls} data-owner-effects={owner.current.effects} data-owner-checks={owner.current.checks} data-external-writes="0">
    <header className="dcp-top"><a className="dcp-brand" href="?desk=adapter-ui-prototype"><span className="desk-mark" />Desk</a><span className="dcp-sample">Sample data</span></header>
    <main className="dcp-main">
      {pane === "conversations" ? <section className="dcp-list"><h1>Conversations</h1><button type="button" onClick={() => { setPane("conversation"); }}>Restart receipt review <span>Continue conversation →</span></button></section> : detail ? <section className="dcp-task-detail"><button type="button" className="dcp-back" onClick={() => { setPane("conversation"); }}>← Back to conversation</button>{card(detail, true)}</section> : <>
        <div className="dcp-heading"><button type="button" className="dcp-back" onClick={() => { setPane("conversations"); }}>← Conversations</button><h1>Restart receipt review</h1></div>
        <section className="dcp-thread" aria-label="Conversation">{messages.map(message => <div key={message.id} id={`message-${message.id}`} className="dcp-turn"><div className={`dcp-message ${message.speaker === "You" ? "dcp-you" : "dcp-ivy"}`}><strong>{message.speaker}</strong><p>{message.text}</p></div>{message.cardId && (() => { const draft = drafts.find(value => value.id === message.cardId); return draft ? card(draft) : null; })()}</div>)}{busy && <p role="status" className="dcp-thinking">Ivy is writing…</p>}</section>
        {drafts.length === 0 && <button type="button" className="dcp-suggestion" onClick={() => { send("Turn this into a task"); }}>Turn this into a task</button>}
        <form className="dcp-composer" onSubmit={event => { event.preventDefault(); send(input); }}><textarea aria-label="Message Ivy" placeholder="Message Ivy…" value={input} onChange={event => { setInput(event.target.value); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button type="submit" aria-label="Send message" disabled={!input.trim() || busy}>Send</button></form>
      </>}
    </main>
  </div>;
}
