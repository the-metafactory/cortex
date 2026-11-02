import { useCallback, useEffect, useRef, useState } from "react";
import { failureText as failure, readOverview, sourceLabel, statusLabel, type OverviewRow } from "../lib/conversations";
import { ConversationWorkspace } from "./desk-conversation";
import "./desk-conversation.css";

const SEARCH_MS = 300;
type Shelf = "current" | "archived";

interface OverviewState {
  rows: OverviewRow[];
  next: string | null;
  loadedAt: number | null;
  error: string | null;
  loading: boolean;
}

export function useOverview(shelf: Shelf, query: string, revision: number) {
  const [state, setState] = useState<OverviewState>({ rows: [], next: null, loadedAt: null, error: null, loading: true });
  const shown = useRef(`${shelf}\n${query}`);
  const [retries, setRetries] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const key = `${shelf}\n${query}`;
    const same = shown.current === key;
    setState(s => same ? { ...s, loading: true } : { rows: [], next: null, loadedAt: null, error: null, loading: true });
    readOverview({ state: shelf, q: query }, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      shown.current = key;
      setState({ rows: page.rows, next: page.next ?? null, loadedAt: Date.now(), error: null, loading: false });
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      setState(s => ({ ...s, loading: false, error: failure(err, "Mission Control did not answer.") }));
    });
    return () => controller.abort();
  }, [shelf, query, revision, retries]);

  const more = useCallback(async (): Promise<void> => {
    const cursor = state.next;
    if (!cursor || state.loading) return;
    setState(s => ({ ...s, loading: true }));
    try {
      const page = await readOverview({ state: shelf, q: query, cursor });
      setState(s => ({ ...s, rows: [...s.rows, ...page.rows.filter(r => !s.rows.some(seen => seen.conversation.id === r.conversation.id))], next: page.next ?? null, error: null, loading: false }));
    } catch (err) {
      setState(s => ({ ...s, loading: false, error: failure(err, "Mission Control did not answer.") }));
    }
  }, [shelf, query, state.next, state.loading]);

  return { ...state, more, retry: () => setRetries(n => n + 1) };
}

const day = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function OverviewRowView({ row, selected, searching, onOpen }: { row: OverviewRow; selected: boolean; searching: boolean; onOpen: (id: string) => void }) {
  const { conversation, linked, latest, match } = row;
  const line = searching && match ? match : latest;
  return <li>
    <button type="button" className={`dcv-row${selected ? " active" : ""}`} aria-current={selected ? "true" : undefined} onClick={() => onOpen(conversation.id)}>
      <strong>{conversation.pinned && <span className="dcv-pin">Pinned · </span>}{conversation.title}</strong>
      <span className="dcv-excerpt">{line ? `${line.who === "you" ? "You" : "Ivy"}: ${line.text}` : "No messages yet"}</span>
      {linked.length > 0 && <small>{linked.map(l => `${sourceLabel(l)}: ${l.title ?? "unavailable"}`).join(" · ")}</small>}
      <small>{statusLabel(conversation.activity.status)} · {day(conversation.activity.lastAt)}{conversation.policy === "local" ? " · Local only" : ""}</small>
    </button>
  </li>;
}

export interface OverviewProps {
  shelf: Shelf;
  search: string;
  selected: string | null;
  rows: OverviewRow[];
  next: string | null;
  loadedAt: number | null;
  error: string | null;
  loading: boolean;
  onShelf: (shelf: Shelf) => void;
  onSearch: (text: string) => void;
  onOpen: (id: string) => void;
  onMore: () => void;
  onRetry: () => void;
}

export function OverviewView(p: OverviewProps) {
  const searching = p.search.trim().length > 0;
  const stale = p.error !== null && p.loadedAt !== null;
  return <aside className="dcv-overview" aria-label="Conversations">
    <h2>Conversations</h2>
    <input type="search" aria-label="Search conversations and history" placeholder="Search titles and history" value={p.search} maxLength={200} onChange={e => p.onSearch(e.target.value)} />
    <div className="desk-seg" role="tablist" aria-label="Shelf">
      <button type="button" role="tab" aria-selected={p.shelf === "current"} onClick={() => p.onShelf("current")}>Current</button>
      <button type="button" role="tab" aria-selected={p.shelf === "archived"} onClick={() => p.onShelf("archived")}>Archived</button>
    </div>
    {p.error && <div className="desk-unsent" role="alert">
      <p>{stale ? `The list could not be refreshed: ${p.error} It shows what was loaded at ${new Date(p.loadedAt ?? 0).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.` : `Conversations could not be loaded: ${p.error} This is not an empty history.`}</p>
      <button type="button" className="desk-btn" onClick={p.onRetry}>Retry</button>
    </div>}
    <ul className="dcv-rows">
      {p.rows.map(row => <OverviewRowView key={row.conversation.id} row={row} selected={row.conversation.id === p.selected} searching={searching} onOpen={p.onOpen} />)}
    </ul>
    {p.loadedAt !== null && p.rows.length === 0 && !p.error && <p className="dcv-quiet">{searching ? "No conversation matches. Search covers titles and saved messages; earlier Studio sessions appear once opened." : p.shelf === "archived" ? "Nothing archived." : "No current conversations."}</p>}
    {p.loading && <p className="dcv-quiet" role="status">Loading…</p>}
    {p.next && !p.loading && <button type="button" className="desk-btn ghost" onClick={p.onMore}>Show older</button>}
  </aside>;
}

export function ConversationsArea({ selected, onOpen, onLeave }: { selected: string | null; onOpen: (id: string) => void; onLeave: () => void }) {
  const [shelf, setShelf] = useState<Shelf>("current");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const overview = useOverview(shelf, query, revision);
  return <div className="dcv-area">
    <OverviewView shelf={shelf} search={search} selected={selected} rows={overview.rows} next={overview.next} loadedAt={overview.loadedAt} error={overview.error} loading={overview.loading}
      onShelf={setShelf} onSearch={setSearch} onOpen={onOpen} onMore={() => void overview.more()} onRetry={overview.retry} />
    {selected
      ? <ConversationWorkspace key={selected} id={selected} onLeave={onLeave} onOrganized={() => setRevision(n => n + 1)} />
      : <section className="dcv-empty"><h2>Return to a conversation</h2><p className="dcv-quiet">Choose one from the overview. Archived conversations open read-only until you restore them.</p></section>}
  </div>;
}
