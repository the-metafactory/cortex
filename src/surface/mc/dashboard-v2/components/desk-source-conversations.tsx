import { useEffect, useRef, useState } from "react";
import { failureText as failure, importSession, readSource, startConversation, type ObjectRef, type SourceConversations } from "../lib/conversations";
import "./desk-conversation.css";

export function SourceConversationList({ data, pending, onResume, onImport, onNew, newLabel }: {
  data: SourceConversations;
  pending: boolean;
  onResume: (id: string) => void;
  onImport: (sessionId: string) => void;
  onNew?: () => void;
  newLabel: string;
}) {
  const gone = data.source.state === "unavailable";
  return <section className="dcv-src" aria-label="Conversations about this">
    <h4>Conversations with Ivy</h4>
    {gone && <p className="dcv-quiet">This source is unavailable. Its conversations stay below.</p>}
    <ul>
      {data.conversations.map(c => <li key={c.id}><button type="button" className="desk-btn ghost" onClick={() => onResume(c.id)}>Resume · {c.title}{c.state === "archived" ? " (archived)" : ""} · {c.activity.status === "working" ? "Ivy is working" : c.activity.status === "waiting" ? "waiting for you" : "ready"}</button></li>)}
      {data.sessions.map(s => <li key={s.id}>{s.phase === "ending"
        ? <span className="dcv-quiet">Earlier exchange “{s.subject}” is still being saved by the Studio; it opens here afterwards.</span>
        : <button type="button" className="desk-btn ghost" disabled={pending} onClick={() => onImport(s.id)}>Open earlier exchange · {s.subject} ({s.turns} turn{s.turns === 1 ? "" : "s"}{s.phase === "ended" ? ", saved" : ""})</button>}</li>)}
    </ul>
    {data.conversations.length === 0 && data.sessions.length === 0 && <p className="dcv-quiet">No conversations yet.</p>}
    {onNew && !gone && <button type="button" className="desk-btn" disabled={pending} onClick={onNew}>{newLabel}</button>}
  </section>;
}

export function useStartConversation(onOpen: (id: string) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startId = useRef<{ key: string; id: string } | null>(null);
  const run = async (work: () => Promise<{ conversation: { id: string } }>): Promise<void> => {
    if (pending) return;
    setPending(true); setError(null);
    try { const { conversation } = await work(); startId.current = null; onOpen(conversation.id); }
    catch (err) { setError(failure(err, "Mission Control did not answer. Try again; a repeated start opens the same conversation.")); }
    finally { setPending(false); }
  };
  const start = (source: ObjectRef): Promise<void> => {
    const key = `${source.owner}:${source.id}`;
    if (startId.current?.key !== key) startId.current = { key, id: crypto.randomUUID() };
    const id = startId.current.id;
    return run(() => startConversation(source, id));
  };
  const open = (sessionId: string): Promise<void> => run(() => importSession(sessionId));
  return { pending, error, start, open };
}

export function SourceConversations({ source, onOpen, newLabel = "New conversation", offerNew = true }: { source: ObjectRef; onOpen: (id: string) => void; newLabel?: string; offerNew?: boolean }) {
  const [data, setData] = useState<SourceConversations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const starter = useStartConversation(onOpen);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(null);
    readSource(source, controller.signal).then(setData).catch((err: unknown) => { if (!controller.signal.aborted) setError(failure(err, "Conversations are unavailable right now.")); });
    return () => controller.abort();
  }, [source.owner, source.id]);
  if (!data) return error ? <p className="dcv-quiet" role="status">{error}</p> : null;
  return <>
    <SourceConversationList data={data} pending={starter.pending} onResume={onOpen} onImport={id => void starter.open(id)} {...(offerNew ? { onNew: () => void starter.start(source) } : {})} newLabel={newLabel} />
    {starter.error && <p className="desk-unsent" role="alert">{starter.error}</p>}
  </>;
}
