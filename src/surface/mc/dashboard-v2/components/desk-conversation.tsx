import { ApiFailure } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { memo, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { SessionEnd } from "../../desk/studio/session-schema";
import {
  chooseOutcome, continueInDiscord, entryViews, visibleEntries, failureText as failure, modelLine, organize as organizeConversation, readConversation, readEntries, saveDraft, sendInput, sourceLabel, statusLabel,
  type ConversationDetail, type ConversationEntry, type OperationRecord,
} from "../lib/conversations";
import { ConversationResponseUpdateSchema, laneName, type Organize, type SourceView } from "../../../../conversations/types";
import { CreationPanel } from "./desk-conversation-create";
import { DeskMakePanel } from "./desk-draft-editor";
import { EMPTY_TRANSCRIPT, transcriptReducer } from "../lib/conversation-stream";
import "./desk-conversation.css";
import { useAssistantName } from "../lib/assistant-name";

const BUSY_MS = 2_000;
const IDLE_MS = 15_000;
const DRAFT_MS = 600;

export function useConversation(id: string) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [transcript, dispatch] = useReducer(transcriptReducer, EMPTY_TRANSCRIPT);
  const { entries, liveText, generation } = transcript;
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraftState] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const unsent = useRef<{ inputId: string; text: string; mode: "queue" | "steer" } | null>(null);
  const saved = useRef<string | null>(null);
  const latest = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef("");
  const sentFromCursor = useRef<number | null>(null);

  const load = useCallback(async (signal?: AbortSignal, full = true): Promise<void> => {
    try {
      const next = await readConversation(id, signal);
      const signature = JSON.stringify([next.conversation.activity, next.pending.map(p => [p.inputId, p.status])]);
      const list = full || signature !== seen.current ? await readEntries(id, signal) : null;
      if (signal?.aborted) return;
      seen.current = signature;
      setDetail(next); setError(null);
      if (list) dispatch({ type: "history", entries: list, working: next.pending.length > 0 || next.conversation.activity.status === "working" });
      if (saved.current === null) { saved.current = next.draft; latest.current = next.draft; setDraftState(next.draft); }
    } catch (err) {
      if (!signal?.aborted) setError(failure(err, "The conversation could not be read. Retry when Mission Control is available."));
    }
  }, [id]);

  const busy = transcript.working || (sending && transcript.cursor === sentFromCursor.current);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const every = setInterval(() => { void load(controller.signal, !busy); }, busy ? BUSY_MS : IDLE_MS);
    return () => { controller.abort(); clearInterval(every); };
  }, [load, busy]);

  useEffect(() => {
    const source = new EventSource(`/api/conversations/${id}/stream`);
    source.addEventListener("response", (event: MessageEvent<string>) => {
      try {
        const update = ConversationResponseUpdateSchema.parse(JSON.parse(event.data));
        dispatch({ type: "stream", update });
      } catch (error) { console.error("conversations: invalid response stream", error); }
    });
    source.onerror = () => { dispatch({ type: "disconnected" }); void load(); };
    return () => { source.close(); };
  }, [id, load]);

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
    sentFromCursor.current = transcript.cursor;
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
  }, [id, sending, flush, load, transcript.cursor]);

  const retry = useCallback(async (text: string): Promise<void> => {
    if (!text || sending) return;
    sentFromCursor.current = transcript.cursor;
    setSending(true); setError(null);
    try { await sendInput(id, { inputId: crypto.randomUUID(), text, mode: "queue" }); await load(); }
    catch (err) { setError(failure(err, "Mission Control did not confirm the retry. Nothing was sent; try again.")); }
    finally { setSending(false); }
  }, [id, sending, load, transcript.cursor]);

  const organize = useCallback(async (change: Organize): Promise<boolean> => {
    if (organizing) return false;
    setOrganizing(true); setError(null);
    try {
      await organizeConversation(id, change);
      await load();
      return true;
    } catch (err) {
      setError(`Not confirmed: ${failure(err, "Mission Control did not answer.")} Try again; repeating it is safe and changes nothing twice.`);
      return false;
    } finally { setOrganizing(false); }
  }, [id, organizing, load]);

  return { detail, entries, liveText, generation, error, draft: draft ?? "", ready: draft !== null, setDraft, send, retry, sending, busy, retrying: unsent.current !== null, reload: load, flush, organize, organizing };
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
          <label>{studio.scope === "note" ? "Reworded idea or stand" : "Optional proposed stand"}<textarea aria-label={studio.scope === "note" ? "Reworded idea or stand" : "Optional proposed stand"} value={text} maxLength={4000} onChange={e => { setText(e.target.value); }} /></label>
          <div className="dcv-acts">{options.map(o => <button key={o.label} type="button" className={`desk-btn${o.primary ? " pri" : ""}`} disabled={pending || (o.needsText === true && !text.trim())} onClick={() => void choose(o.make(text.trim()))}>{o.label}</button>)}</div>
        </>}
    {error && <p className="desk-unsent" role="alert">{error}</p>}
    <p className="dcv-quiet">Your stand or idea changes only when you choose it here. If the idea changed meanwhile, nothing is applied.</p>
  </section>;
}

export function ConversationWorkspace({ id, onLeave, onOrganized }: { id: string; onLeave: () => void; onOrganized?: () => void }) {
  const name = useAssistantName();
  const c = useConversation(id);
  const leave = (): void => { void c.flush(true); onLeave(); };
  if (!c.detail) return <section className="dcv" aria-label={`Conversation with ${name}`}><header className="dcv-head"><button type="button" className="desk-btn ghost" onClick={leave}>Leave</button></header><p role={c.error ? "alert" : "status"}>{c.error ?? "Opening the conversation…"}</p></section>;
  return <WorkspaceView detail={c.detail} entries={c.entries} liveText={c.liveText} generation={c.generation} draft={c.draft} ready={c.ready} busy={c.busy} sending={c.sending} retrying={c.retrying} error={c.error} onDraft={c.setDraft} onSend={mode => void c.send(mode)} onRetry={text => void c.retry(text)} onLeave={leave} onSaved={() => void c.reload()}
    organizing={c.organizing} onOrganize={change => { void c.organize(change).then(done => { if (done) onOrganized?.(); }); }} />;
}

export interface WorkspaceProps {
  detail: ConversationDetail;
  entries: ConversationEntry[];
  liveText?: string | null;
  generation?: string | null;
  draft: string;
  ready: boolean;
  busy: boolean;
  sending: boolean;
  retrying: boolean;
  error: string | null;
  onDraft: (text: string) => void;
  onSend: (mode: "queue" | "steer") => void;
  onRetry: (text: string) => void;
  onLeave: () => void;
  onSaved: () => void;
  organizing: boolean;
  onOrganize: (change: Organize) => void;
}

export function DiscordStrip({ detail, onSaved }: { detail: ConversationDetail; onSaved: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; retry: boolean } | null>(null);
  const { conversation, discord } = detail;
  if (!discord) return null;
  const attach = (retry: boolean): void => {
    setPending(true);
    setError(null);
    void continueInDiscord(conversation.id, retry).then(onSaved, (failed: unknown) => { setError({ text: failure(failed, "Discord did not take the thread. Nothing was sent."), retry: failed instanceof ApiFailure && failed.info.status === 409 }); }).finally(() => { setPending(false); });
  };
  const used = conversation.discord !== undefined;
  const local = conversation.policy === "local";
  return <div className="dcv-discord" role="group" aria-label="Discord">
    {discord.url
      ? <a className="desk-btn ghost" href={discord.url} target="_blank" rel="noreferrer">Open the Discord thread</a>
      : discord.available && !local && conversation.state === "current" && <button type="button" className="desk-btn ghost" disabled={pending} onClick={() => { attach(false); }}>Continue in Discord</button>}
    {used && local && <p className="dcv-quiet">Earlier messages stay in the Discord thread; they were not recalled. From now on this conversation stays private on the web, and Discord gets only a link back here.</p>}
    {discord.blocked && <p className="desk-unsent" role="alert">Nothing is sent to the Discord thread: {discord.blocked}.</p>}
    {error && <p className="desk-unsent" role="alert">{error.text}{error.retry && <button type="button" className="desk-btn" disabled={pending} onClick={() => { attach(true); }}>Create a new thread</button>}</p>}
  </div>;
}

export function ModelPicker({ models, disabled, onChoose }: { models: ConversationDetail["models"]; disabled: boolean; onChoose: (cloud: string | null) => void }) {
  const line = modelLine(models);
  const first = models.cloud[0];
  return <div className="dcv-model" role="group" aria-label="Cloud model">
    {line.choose
      ? <label>Cloud model <select value={models.chosen ?? ""} disabled={disabled} onChange={e => { onChoose(e.target.value || null); }}>
          {first && <option value="">Default · {laneName(first)}</option>}
          {models.cloud.map(lane => <option key={lane.id} value={lane.id}>{lane.id} · {laneName(lane)}</option>)}
          {line.missing && <option value={line.missing}>{line.missing} · no longer configured</option>}
        </select></label>
      : line.text && <span className="dcv-quiet">Cloud model {line.text}</span>}
    {line.missing && <p className="desk-unsent" role="alert">The cloud model {line.missing} chosen for this conversation is no longer configured. Choose another; nothing is sent until you do, and no other model is used.</p>}
  </div>;
}

const withoutHtmlComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "").trim();
const webUrl = (url: string | undefined): string | null => url && /^https?:\/\//i.test(url) ? url : null;

function AvailableSource({ source }: { source: Extract<SourceView, { state: "available" }> }) {
  const body = source.context ? withoutHtmlComments(source.context) : "";
  const url = webUrl(source.url);
  return <div className="dcv-source"><small>{sourceLabel(source.ref)}</small><strong>{source.title}</strong>
    {body && <div className="dcv-markdown">{renderMarkdown(body)}</div>}
    {url && <a className="desk-btn ghost" href={url} target="_blank" rel="noreferrer">Open the full node</a>}
  </div>;
}

const IvyAnswer = memo(function IvyAnswer({ text }: { text: string }) {
  return <div className="dcv-markdown">{renderMarkdown(text)}</div>;
});

export function WorkspaceView(c: WorkspaceProps) {
  const name = useAssistantName();
  const stream = useRef<HTMLDivElement>(null);
  const count = c.entries.length;
  useEffect(() => { stream.current?.scrollTo({ top: stream.current.scrollHeight }); }, [count, c.liveText]);
  const { conversation, sources, studio } = c.detail;
  const views = visibleEntries(c.entries, c.busy ? c.generation ?? null : null).flatMap(entry => entryViews(entry).map((view, i) => ({ key: `${entry.id}-${i}`, view })));
  const archived = conversation.state === "archived";
  const said = c.entries.filter(entry => entry.role === "user" && entry.text).at(-1);
  return <section className="dcv" aria-label={`Conversation with ${name}: ${conversation.title}`}>
    <header className="dcv-head">
      <div className="dcv-title"><h2>{conversation.title}</h2>
        <div className="dcv-acts">
          <button type="button" className="desk-btn ghost" disabled={c.organizing} aria-pressed={conversation.pinned} onClick={() => { c.onOrganize({ pinned: !conversation.pinned }); }}>{conversation.pinned ? "Unpin" : "Pin"}</button>
          <button type="button" className={`desk-btn${archived ? " pri" : " ghost"}`} disabled={c.organizing} onClick={() => { c.onOrganize({ state: archived ? "current" : "archived" }); }}>{archived ? "Restore" : "Archive"}</button>
          <button type="button" className="desk-btn ghost" onClick={c.onLeave}>Leave</button>
        </div>
      </div>
      <p className="dcv-meta">
        <span className={`dcv-badge${conversation.policy === "local" ? " local" : ""}`}>{conversation.policy === "local" ? "Local only · local model" : "Cloud allowed"}</span>
        <span>{statusLabel(conversation.activity.status)}</span>
        {archived && <span>Archived · read-only until you restore it</span>}
      </p>
      {conversation.policy === "cloud" && <ModelPicker models={c.detail.models} disabled={c.organizing || archived} onChoose={cloud => { c.onOrganize({ cloud }); }} />}
      <DiscordStrip detail={c.detail} onSaved={c.onSaved} />
    </header>
    <aside className="dcv-sources" aria-label="Linked work">
      {sources.map(source => source.state === "available"
        ? <AvailableSource key={`${source.ref.owner}:${source.ref.id}`} source={source} />
        : <div key={`${source.ref.owner}:${source.ref.id}`} className="dcv-source gone"><small>{sourceLabel(source.ref)}</small><strong>Unavailable</strong><p>This source is gone or not authorized here. Its content is not shown; this conversation and its history stay.</p></div>)}
      {sources.length === 0 && <p className="dcv-quiet">No linked work.</p>}
    </aside>
    <div className="dcv-stream" ref={stream} aria-live="polite">
      {views.map(({ key, view }, i) => {
        if (view.kind === "message") return <article key={key} className={`dcv-msg ${view.who}`}><small>{view.who === "you" ? "You" : name}{view.note ? ` · ${view.note}` : ""}</small>{view.who === "ivy" ? <IvyAnswer text={view.text} /> : <p>{view.text}</p>}</article>;
        if (view.kind === "activity") return <p key={key} className="dcv-activity">{view.text}</p>;
        const retry = i === views.length - 1 && !archived && !c.busy && said?.text;
        return <p key={key} className="dcv-activity dcv-failed" role="alert">{view.text} Your message stays in the record; no other engine was used.
          {retry && <button type="button" className="desk-btn" disabled={c.sending} onClick={() => { c.onRetry(said.text ?? ""); }}>Retry</button>}</p>;
      })}
      {c.liveText && <article className="dcv-msg ivy" aria-label={`${name} is answering`}><small>{name} · answering…</small><IvyAnswer text={c.liveText} /></article>}
      {c.busy && <div className="dcv-waiting" role="status" aria-label={`${name} is working`}><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></div>}
      {views.length === 0 && !c.liveText && !c.busy && <p className="dcv-quiet">No messages yet. Your exchange is saved as you go.</p>}
    </div>
    <form className="dcv-composer" onSubmit={e => { e.preventDefault(); if (!archived) c.onSend("queue"); }}>
      <label>Message {name}<textarea aria-label={`Message ${name}`} value={c.draft} disabled={!c.ready || archived} maxLength={20_000} onChange={e => { c.onDraft(e.target.value); }} placeholder="Continue the thought…" /></label>
      <div className="dcv-acts">
        <button className="desk-btn pri" disabled={archived || c.sending || !c.draft.trim()}>{c.retrying ? "Send again" : c.busy ? "Queue message" : "Send"}</button>
        {c.busy && !archived && <button type="button" className="desk-btn" disabled={c.sending || !c.draft.trim()} onClick={() => { c.onSend("steer"); }}>Use this now</button>}
      </div>
      <p className="dcv-quiet">{archived ? "This conversation is archived. Restore it to continue with the same history; opening it never resumes it." : c.busy ? `${name} is working. Queue waits for the current turn; Use this now joins at ${name}'s next safe point and never interrupts a running change.` : "Your unsent draft is saved here. Leave keeps the conversation; nothing ends."}</p>
      {c.error && <p className="desk-unsent" role="alert">{c.error}</p>}
    </form>
    <CreationPanel id={conversation.id} archived={archived} revision={c.entries.at(-1)?.id ?? ""} seed={{ entryId: said?.id ?? null, text: said?.text ?? "" }} />
    <DeskMakePanel key={conversation.id} conversationId={conversation.id} entryId={said?.id ?? null} archived={archived} />
    {studio && !archived && <StudioOutcome id={conversation.id} studio={studio} onSaved={c.onSaved} />}
  </section>;
}
