import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionEnd } from "../../desk/studio/session-schema";
import { ApiFailure } from "../lib/api";
import {
  chooseOutcome, entryViews, pendingLabel, readConversation, readEntries, saveDraft, sendInput, sourceLabel,
  type ConversationDetail, type ConversationEntry, type OperationRecord,
} from "../lib/conversations";
import "./desk-conversation.css";

const BUSY_MS = 2_000;
const IDLE_MS = 15_000;
const DRAFT_MS = 600;

const failure = (error: unknown, fallback: string): string => (error instanceof ApiFailure ? error.info.message : fallback);

export function useConversation(id: string) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraftState] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const unsent = useRef<{ inputId: string; text: string; mode: "queue" | "steer" } | null>(null);
  const saved = useRef<string | null>(null);
  const latest = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const [next, list] = await Promise.all([readConversation(id, signal), readEntries(id, signal)]);
      if (signal?.aborted) return;
      setDetail(next); setEntries(list); setError(null);
      if (saved.current === null) { saved.current = next.draft; latest.current = next.draft; setDraftState(next.draft); }
    } catch (err) {
      if (!signal?.aborted) setError(failure(err, "The conversation could not be read. Retry when Mission Control is available."));
    }
  }, [id]);

  const busy = Boolean(detail && (detail.pending.length > 0 || detail.conversation.activity.status === "working"));
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const every = setInterval(() => { void load(controller.signal); }, busy ? BUSY_MS : IDLE_MS);
    return () => { controller.abort(); clearInterval(every); };
  }, [load, busy]);

  const flush = useCallback(async (keepalive = false): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const text = latest.current;
    if (text === null || text === saved.current) return;
    try { await saveDraft(id, text, keepalive); saved.current = text; }
    catch { setError("Your draft is still here but was not saved. It is retried when you type or leave."); }
  }, [id]);

  const setDraft = useCallback((text: string): void => {
    latest.current = text; setDraftState(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, DRAFT_MS);
  }, [flush]);

  useEffect(() => {
    const leaving = (): void => { void flush(true); };
    window.addEventListener("pagehide", leaving);
    return () => { window.removeEventListener("pagehide", leaving); void flush(true); };
  }, [flush]);

  const send = useCallback(async (mode: "queue" | "steer"): Promise<void> => {
    const text = (unsent.current?.text ?? latest.current ?? "").trim();
    if (!text || sending) return;
    const input = unsent.current?.text === text ? unsent.current : { inputId: crypto.randomUUID(), text, mode };
    unsent.current = input;
    setSending(true); setError(null);
    try {
      await sendInput(id, input);
      unsent.current = null;
      if ((latest.current ?? "").trim() === text) { latest.current = ""; setDraftState(""); }
      await flush();
      await load();
    } catch (err) {
      setError(failure(err, "Mission Control did not confirm your message. It is still here; send again to retry the same message."));
    } finally { setSending(false); }
  }, [id, sending, flush, load]);

  return { detail, entries, error, draft: draft ?? "", ready: draft !== null, setDraft, send, sending, busy, retrying: unsent.current !== null, reload: load, flush };
}

const OUTCOMES_NOTE: { label: string; primary?: boolean; needsText?: boolean; make: (text: string) => SessionEnd }[] = [
  { label: "Keep as is", make: () => ({ kind: "keep" }) },
  { label: "Keep reworded", primary: true, needsText: true, make: text => ({ kind: "reword", text }) },
  { label: "Dismiss", make: () => ({ kind: "dismiss" }) },
  { label: "Save summary note only", make: () => ({ kind: "leave" }) },
];
const OUTCOMES_THREAD: typeof OUTCOMES_NOTE = [
  { label: "Save summary note", make: () => ({ kind: "leave" }) },
  { label: "Save summary and propose stand", primary: true, needsText: true, make: text => ({ kind: "propose", text }) },
];

function StudioOutcome({ id, studio, onSaved }: { id: string; studio: NonNullable<ConversationDetail["studio"]>; onSaved: () => void }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<OperationRecord | null>(studio.outcome);
  const proposal = useRef<{ id: string; outcome: SessionEnd } | null>(null);
  useEffect(() => { setOperation(studio.outcome); }, [studio.outcome]);
  const choose = async (outcome: SessionEnd | "check"): Promise<void> => {
    if (pending) return;
    let proposalId: string;
    if (outcome === "check") {
      if (!operation) return;
      proposalId = operation.proposalId;
    } else {
      const same = proposal.current && JSON.stringify(proposal.current.outcome) === JSON.stringify(outcome);
      proposal.current = same && proposal.current ? proposal.current : { id: crypto.randomUUID(), outcome };
      proposalId = proposal.current.id;
    }
    setPending(true); setError(null);
    try {
      const reply = await chooseOutcome(id, proposalId, outcome);
      if (reply.operation) setOperation(reply.operation);
      if (reply.operation?.state === "created" || reply.operation?.state === "failed") proposal.current = null;
      if (reply.error) setError(reply.error);
      onSaved();
    } catch { setError("Mission Control did not answer. Choose the same outcome again to check whether it was saved."); }
    finally { setPending(false); }
  };
  const uncertain = operation?.state === "uncertain" || operation?.state === "running";
  const options = studio.scope === "note" ? OUTCOMES_NOTE : OUTCOMES_THREAD;
  return <section className="dcv-outcome" aria-label="Save to the Studio">
    <h3>Save to the Studio</h3>
    <p className="dcv-quiet">{studio.scope === "note" ? "Discussed idea" : "Thread"}: {studio.subject}</p>
    {operation?.state === "created" && <p role="status">Saved to the Studio (commit {operation.canonicalId?.slice(0, 7)}). Choosing again adds another note; it never repeats this one.</p>}
    {uncertain && <p role="status">Not confirmed yet. Check asks the Studio whether the note was saved; nothing is written twice.</p>}
    {uncertain
      ? <button type="button" className="desk-btn pri" disabled={pending} onClick={() => void choose("check")}>Check</button>
      : <>
          <label>{studio.scope === "note" ? "Reworded idea or stand" : "Optional proposed stand"}<textarea aria-label={studio.scope === "note" ? "Reworded idea or stand" : "Optional proposed stand"} value={text} maxLength={4000} onChange={e => setText(e.target.value)} /></label>
          <div className="dcv-acts">{options.map(o => <button key={o.label} type="button" className={`desk-btn${o.primary ? " pri" : ""}`} disabled={pending || (o.needsText === true && !text.trim())} onClick={() => void choose(o.make(text.trim()))}>{o.label}</button>)}</div>
        </>}
    {error && <p className="desk-unsent" role="alert">{error}</p>}
    <p className="dcv-quiet">Your stand or idea changes only when you choose it here. If the idea changed meanwhile, nothing is applied.</p>
  </section>;
}

export function ConversationWorkspace({ id, onLeave }: { id: string; onLeave: () => void }) {
  const c = useConversation(id);
  const leave = (): void => { void c.flush(true); onLeave(); };
  if (!c.detail) return <section className="dcv" aria-label="Ivy conversation"><header className="dcv-head"><button type="button" className="desk-btn ghost" onClick={leave}>Leave</button></header><p role={c.error ? "alert" : "status"}>{c.error ?? "Opening the conversation…"}</p></section>;
  return <WorkspaceView detail={c.detail} entries={c.entries} draft={c.draft} ready={c.ready} busy={c.busy} sending={c.sending} retrying={c.retrying} error={c.error} onDraft={c.setDraft} onSend={mode => void c.send(mode)} onLeave={leave} onSaved={() => void c.reload()} />;
}

export interface WorkspaceProps {
  detail: ConversationDetail;
  entries: ConversationEntry[];
  draft: string;
  ready: boolean;
  busy: boolean;
  sending: boolean;
  retrying: boolean;
  error: string | null;
  onDraft: (text: string) => void;
  onSend: (mode: "queue" | "steer") => void;
  onLeave: () => void;
  onSaved: () => void;
}

export function WorkspaceView(c: WorkspaceProps) {
  const stream = useRef<HTMLDivElement>(null);
  const count = c.entries.length;
  useEffect(() => { stream.current?.scrollTo({ top: stream.current.scrollHeight }); }, [count]);
  const { conversation, sources, pending, studio } = c.detail;
  const views = c.entries.flatMap(entry => entryViews(entry).map((view, i) => ({ key: `${entry.id}-${i}`, view })));
  return <section className="dcv" aria-label={`Ivy conversation: ${conversation.title}`}>
    <header className="dcv-head">
      <div className="dcv-title"><h2>{conversation.title}</h2><button type="button" className="desk-btn ghost" onClick={c.onLeave}>Leave</button></div>
      <p className="dcv-meta">
        <span className={`dcv-badge${conversation.policy === "local" ? " local" : ""}`}>{conversation.policy === "local" ? "Local only · local model" : "Cloud allowed"}</span>
        <span>{conversation.activity.status === "working" ? "Ivy is working" : conversation.activity.status === "waiting" ? "Waiting for you" : "Ready to continue"}</span>
        {conversation.state === "archived" && <span>Archived · continuing adds new turns</span>}
      </p>
    </header>
    <aside className="dcv-sources" aria-label="Linked work">
      {sources.map(source => source.state === "available"
        ? <div key={`${source.ref.owner}:${source.ref.id}`} className="dcv-source"><small>{sourceLabel(source.ref)}</small><strong>{source.title}</strong>{source.context && <p>{source.context}</p>}</div>
        : <div key={`${source.ref.owner}:${source.ref.id}`} className="dcv-source gone"><small>{sourceLabel(source.ref)}</small><strong>Unavailable</strong><p>This source is gone or not authorized here. Its content is not shown; this conversation and its history stay.</p></div>)}
      {sources.length === 0 && <p className="dcv-quiet">No linked work.</p>}
    </aside>
    <div className="dcv-stream" ref={stream} aria-live="polite">
      {views.map(({ key, view }) => view.kind === "message"
        ? <article key={key} className={`dcv-msg ${view.who}`}><small>{view.who === "you" ? "You" : "Ivy"}{view.note ? ` · ${view.note}` : ""}</small><p>{view.text}</p></article>
        : <p key={key} className="dcv-activity">{view.text}</p>)}
      {views.length === 0 && <p className="dcv-quiet">No messages yet. Your exchange is saved as you go.</p>}
    </div>
    {pending.length > 0 && <div className="dcv-queue" role="status"><strong>{pending.length === 1 ? "1 message in order" : `${pending.length} messages in order`} · one shared order for web and Discord</strong>
      <ol>{pending.map(p => <li key={p.inputId}>{pendingLabel(p)}</li>)}</ol></div>}
    <form className="dcv-composer" onSubmit={e => { e.preventDefault(); c.onSend("queue"); }}>
      <label>Message Ivy<textarea aria-label="Message Ivy" value={c.draft} disabled={!c.ready} maxLength={20_000} onChange={e => c.onDraft(e.target.value)} placeholder="Continue the thought…" /></label>
      <div className="dcv-acts">
        <button className="desk-btn pri" disabled={c.sending || !c.draft.trim()}>{c.retrying ? "Send again" : c.busy ? "Queue message" : "Send"}</button>
        {c.busy && <button type="button" className="desk-btn" disabled={c.sending || !c.draft.trim()} onClick={() => c.onSend("steer")}>Use this now</button>}
      </div>
      <p className="dcv-quiet">{c.busy ? "Ivy is working. Queue waits for the current turn; Use this now joins at Ivy's next safe point and never interrupts a running change." : "Your unsent draft is saved here. Leave keeps the conversation; nothing ends."}</p>
      {c.error && <p className="desk-unsent" role="alert">{c.error}</p>}
    </form>
    {studio && <StudioOutcome id={conversation.id} studio={studio} onSaved={c.onSaved} />}
  </section>;
}
