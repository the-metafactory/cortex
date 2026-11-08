import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./desk-extension-prototype.css";

/* eslint-disable @typescript-eslint/no-explicit-any */
type View = { messages: any[]; drafts: Record<string, any>; results: Record<string, any>; day: any[]; adapters: any[]; catalog: any[] };
type Run = (path: string, body?: unknown) => Promise<void>;
const PROTOCOL = "1.0.0";
const FRAME_READY_MS = 2500;
const MAX_FRAME_HEIGHT = 640;
const FRAME_MESSAGE_TYPES = new Set(["ready", "resize", "renderer:error", "host:navigate"]);

function AdapterFrame({ entry, projection, onFail, run }: { entry: any; projection: unknown; onFail: (reason: string) => void; run: Run }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);
  const [state, setState] = useState("mounting");
  const load = () => {
    const target = frame.current?.contentWindow;
    if (!target) return;
    const instance = crypto.randomUUID();
    const channel = new MessageChannel();
    const identity = { instance, release: entry.releaseDigest, protocol: PROTOCOL };
    let ready = false;
    const fail = (reason: string) => { channel.port1.close(); setState("failed"); void fetch("/api/frame-incident", { method: "POST", body: JSON.stringify({ adapterId: entry.adapterId, reason }) }); onFail(reason); };
    const timer = setTimeout(() => { if (!ready) fail("no-handshake"); }, FRAME_READY_MS);
    channel.port1.onmessage = event => {
      const data = event.data as Record<string, unknown> | null;
      const type = typeof data?.type === "string" ? data.type : "";
      if (!data || data.instance !== instance || data.release !== entry.releaseDigest || data.protocol !== PROTOCOL || !FRAME_MESSAGE_TYPES.has(type)) { clearTimeout(timer); fail(`forged-or-unknown:${type}`); return; }
      if (type === "ready") {
        if (ready) { fail("duplicate-ready"); return; }
        ready = true; clearTimeout(timer); setState("ready");
        channel.port1.postMessage({ type: "host:projection", ...identity, projection, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" });
      } else if (type === "resize" && typeof data.height === "number") setHeight(Math.min(Math.max(data.height, 60), MAX_FRAME_HEIGHT));
      else if (type === "renderer:error") fail("renderer-error");
      else if (type === "host:navigate") void run("/api/draft/current", { id: data.draftId });
    };
    channel.port1.start();
    target.postMessage({ type: "desk:init", ...identity }, "*", [channel.port2]);
  };
  return <iframe ref={frame} data-frame-state={state} data-adapter={entry.adapterId} title="Adapter view" sandbox="allow-scripts" referrerPolicy="no-referrer" src={entry.src} onLoad={load} style={{ width: "100%", height, border: 0, display: "block" }} />;
}

function viewFor(view: View, adapterId: string, objectType: string): any {
  const entry = view.catalog.find(item => item.adapterId === adapterId);
  return entry?.views.some((candidate: any) => candidate.objectType === objectType) ? entry : null;
}

function ObjectResult({ view, adapterId, objectType, object, objectRef, fallback, run }: { view: View; adapterId: string; objectType: string; object: unknown; objectRef: unknown; fallback: React.ReactNode; run: Run }) {
  const entry = viewFor(view, adapterId, objectType);
  const [failed, setFailed] = useState(false);
  if (!entry || failed) return <div data-rendered-by="host">{fallback}</div>;
  return <div data-rendered-by="adapter"><AdapterFrame entry={entry} projection={{ view: "result", objectType, object, ref: objectRef }} onFail={() => { setFailed(true); }} run={run} /></div>;
}

const display = (value: unknown, draft: any): string => {
  if (value && typeof value === "object" && "canonicalId" in value) return draft.destinationLabels.find((entry: any) => entry.id === (value as { canonicalId: string }).canonicalId)?.label ?? "Chosen";
  return Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value);
};

function FieldInput({ field, value, draft, onChange }: { field: any; value: unknown; draft: any; onChange: (value: unknown) => void }) {
  const label = field.label + (field.required ? " *" : "");
  if (field.kind === "unsupported") return <p className="dep-unsupported">{field.label} can’t be edited here.</p>;
  if (field.kind === "long") return <label>{label}<textarea aria-label={field.label} value={String(value ?? "")} onChange={event => { onChange(event.target.value); }} /></label>;
  if (field.kind === "enum") return <label>{label}<select aria-label={field.label} value={String(value ?? "")} onChange={event => { onChange(event.target.value); }}><option value="">Not set</option>{field.options.map((option: string) => <option key={option}>{option}</option>)}</select></label>;
  if (field.kind === "reference") return <label>{label}<select aria-label={field.label} value={(value as { canonicalId?: string } | undefined)?.canonicalId ?? ""} onChange={event => { onChange(event.target.value); }}><option value="">Choose</option>{draft.destinationLabels.map((option: any) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>;
  if (field.kind === "boolean") return <label><input type="checkbox" checked={value === true} onChange={event => { onChange(event.target.checked); }} /> {label}</label>;
  return <label>{label}<input aria-label={field.label} type={field.kind === "date" ? "date" : field.kind === "number" ? "number" : "text"} value={Array.isArray(value) ? value.join(", ") : String(value ?? "")} onChange={event => { onChange(event.target.value); }} /></label>;
}

function DraftCard({ draft, view, run }: { draft: any; view: View; run: Run }) {
  const [edit, setEdit] = useState<Record<string, unknown> | null>(null);
  const title = draft.spec.find((field: any) => field.role === "title");
  const summary = draft.spec.find((field: any) => field.role === "summary");
  const destination = draft.spec.filter((field: any) => field.kind === "reference" && draft.fields[field.name]).map((field: any) => display(draft.fields[field.name], draft)).join(" · ");
  const rest = draft.spec.filter((field: any) => field !== title && field !== summary && field.kind !== "reference" && draft.fields[field.name] !== undefined);
  const missing = draft.blockers.filter((entry: string) => entry.startsWith("missing:")).map((entry: string) => entry.slice(8));
  const unresolved = Object.entries(draft.alternatives as Record<string, any[]>);
  const saved = draft.status === "saved";
  const blocked = draft.blockers.length > 0 || unresolved.length > 0;
  const generic = <><h2>{draft.receipt?.title ?? display(title ? draft.fields[title.name] : "", draft)}</h2><p className="dcp-note">{summary ? display(draft.fields[summary.name], draft) : ""}</p>{rest.length > 0 && <dl className="dep-facts">{rest.map((field: any) => <div key={field.name}><dt>{field.label}</dt><dd>{display(draft.fields[field.name], draft)}</dd></div>)}</dl>}</>;
  return <article className="dcp-card" aria-label={`${saved ? "Saved" : "Proposed"} ${draft.objectLabel}`} data-draft-id={draft.id} data-draft-status={draft.status} data-revision={draft.revision} data-adapter={draft.adapterId}>
    <div className="dcp-card-meta"><span className="dcp-balance">{draft.adapterLabel}</span><span>{destination.length ? destination : unresolved.length || missing.length ? "Destination not chosen" : draft.objectLabel}</span></div>
    {edit ? <form className="dcp-edit" onSubmit={event => { event.preventDefault(); void run("/api/draft/edit", { id: draft.id, revision: draft.revision, changes: edit }).then(() => { setEdit(null); }); }}>
      {draft.spec.map((field: any) => <FieldInput key={field.name} field={field} draft={draft} value={field.name in edit ? edit[field.name] : draft.fields[field.name]} onChange={value => { setEdit(current => ({ ...current, [field.name]: value })); }} />)}
      <div className="dcp-actions"><button type="submit" className="dcp-primary">Save changes</button><button type="button" onClick={() => { setEdit(null); }}>Cancel</button></div>
    </form> : <>
      {saved && draft.current?.available ? <ObjectResult view={view} adapterId={draft.adapterId} objectType={draft.objectType} object={draft.current.object} objectRef={draft.receipt.ref} fallback={generic} run={run} /> : generic}
      {draft.stale && !saved && <p className="dcp-update">New details are available in our conversation.</p>}
      {unresolved.map(([name, options]) => <div className="dcp-clarification" key={name}><p>Where should this go?</p>{options.map((option: any) => <button type="button" key={option.ref.canonicalId} onClick={() => { void run("/api/draft/edit", { id: draft.id, revision: draft.revision, changes: { [name]: option.ref.canonicalId } }); }}>{option.label}</button>)}</div>)}
      {!unresolved.length && missing.length > 0 && !saved && <p className="dcp-error" role="alert">Add {missing.join(", ")} before approving.</p>}
      {draft.blockers.includes("unsupported") && <p className="dcp-error" role="alert">Desk can’t fill in everything this needs, so it can’t be approved from here.</p>}
      {draft.blockers.includes("unavailable") && !saved && <p className="dcp-error" role="alert">{draft.adapterLabel} isn’t available any more. Your draft is kept.</p>}
      {draft.error && <p className="dcp-error" role="alert">{draft.error}</p>}
      {saved ? <div className="dcp-saved"><p role="status" className="dcp-created">✓ Added to {draft.adapterLabel}</p>{draft.current && !draft.current.available && <p className="dcp-note">The saved result is preserved, but its current details are unavailable.</p>}</div> : <div className="dcp-actions"><button type="button" className="dcp-primary" disabled={blocked || draft.status === "saving" || draft.status === "uncertain"} onClick={() => { void run("/api/draft/approve", { id: draft.id, revision: draft.revision, digest: draft.digest }); }}>Approve</button><button type="button" disabled={draft.blockers.includes("unavailable")} onClick={() => { setEdit({}); }}>Edit</button></div>}
      {!saved && Object.keys(draft.origins).length > 0 && <details className="dcp-why"><summary>Why these details?</summary>{draft.spec.filter((field: any) => draft.origins[field.name]).map((field: any) => <div key={field.name}><strong>{field.label}</strong><p>{draft.origins[field.name]}</p></div>)}</details>}
    </>}
  </article>;
}

function ResultsCard({ id, result, view, run }: { id: string; result: any; view: View; run: Run }) {
  return <section className="dep-results" aria-label="Results">{result.groups.map((group: any) => <article className="dcp-card" key={group.capabilityId} data-group={group.adapterId} data-status={group.status}>
    <div className="dcp-card-meta"><span className="dcp-balance">{group.label}</span></div>
    {group.items.map((item: any) => <div className="dep-result" key={item.ref.canonicalId}><ObjectResult view={view} adapterId={group.adapterId} objectType={group.objectType} object={item.object} objectRef={item.ref} run={run} fallback={<><h3>{item.title}</h3>{item.summary && <p className="dcp-note">{item.summary}</p>}</>} /></div>)}
    {group.status === "no-match" && <p className="dcp-note">No matches in what this connection can read.</p>}
    {group.note && <p className="dcp-update" role="status">{group.note}</p>}
    {group.more && <div className="dcp-actions"><button type="button" onClick={() => { void run("/api/results/more", { id, more: group.more }); }}>Load more</button></div>}
  </article>)}</section>;
}

function Conversation({ view, run }: { view: View; run: Run }) {
  const [input, setInput] = useState("");
  const send = () => { const text = input.trim(); if (text) { setInput(""); void run("/api/say", { text }); } };
  return <><div className="dcp-heading"><h1>Sample discussion</h1></div>
    <section className="dcp-thread" aria-label="Conversation">{view.messages.map(message => <div key={message.id} className="dcp-turn"><div className={`dcp-message ${message.speaker === "You" ? "dcp-you" : "dcp-ivy"}`}><strong>{message.speaker}</strong><p>{message.text}</p></div>
      {message.card?.kind === "draft" && view.drafts[message.card.id] && <DraftCard draft={view.drafts[message.card.id]} view={view} run={run} />}
      {message.card?.kind === "results" && view.results[message.card.id] && <ResultsCard id={message.card.id} result={view.results[message.card.id]} view={view} run={run} />}
    </div>)}</section>
    <form className="dcp-composer" onSubmit={event => { event.preventDefault(); send(); }}><textarea aria-label="Message Ivy" placeholder="Message Ivy…" value={input} onChange={event => { setInput(event.target.value); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} /><button type="submit" aria-label="Send message" disabled={!input.trim()}>Send</button></form></>;
}

function Day({ view, run }: { view: View; run: Run }) {
  return <section aria-label="Day"><div className="dcp-heading dep-row"><h1>Today</h1><button type="button" onClick={() => { void run("/api/refresh"); }}>Check now</button></div>
    <ul className="dep-day">{view.day.map(item => <li key={item.key} data-kind={item.kind} data-adapter={item.adapter ?? ""}><div className="dep-day-source">{item.source}{item.area ? ` · ${item.area}` : ""}</div><strong>{item.title}</strong>{item.why && <p>{item.why}</p>}{item.due && <small>Due {item.due}</small>}{item.stale && <small className="dcp-update"> May be out of date</small>}</li>)}</ul></section>;
}

function Adapters({ view, run, restart }: { view: View; run: Run; restart: () => void }) {
  return <section aria-label="Adapters"><div className="dcp-heading dep-row"><h1>Adapters</h1><button type="button" data-restart onClick={restart}>Restart Desk</button></div>
    <ul className="dep-adapters">{view.adapters.map(adapter => <li key={adapter.sample} data-sample={adapter.sample} data-state={adapter.removing ? "removing" : adapter.state ?? (adapter.installed ? "installed" : "absent")}>
      <div className="dep-row"><strong>{adapter.label ?? adapter.sample}</strong><div className="dep-buttons">
        {!adapter.installed && <button type="button" data-do="install" onClick={() => { void run("/api/adapters/install", { sample: adapter.sample }); }}>Install</button>}
        {adapter.state === "awaiting-approval" && !adapter.approved && <button type="button" data-do="approve" onClick={() => { void run("/api/adapters/approve", { packageId: adapter.packageId, releaseDigest: adapter.releaseDigest }); }}>Approve this release</button>}
        {adapter.state === "active" && !adapter.removing && !adapter.connection?.enabled && <button type="button" data-do="connect" onClick={() => { void run("/api/adapters/connect", { adapterId: adapter.adapterId }); }}>Connect</button>}
        {adapter.state === "active" && !adapter.removing && adapter.connection?.enabled && <button type="button" data-do="disconnect" onClick={() => { void run("/api/adapters/disconnect", { adapterId: adapter.adapterId }); }}>Disconnect</button>}
        {adapter.installed && !adapter.removing && <button type="button" data-do="remove" onClick={() => { void run("/api/adapters/remove", { sample: adapter.sample }); }}>Remove</button>}
      </div></div>
      {adapter.removing ? <p className="dcp-note">Removed from Desk. Saved results stay; its files go at the next restart.</p> : adapter.installed && !adapter.loadedThisRun ? <p className="dcp-note">Installed. Nothing runs until you approve it and restart Desk.</p> : adapter.state === "awaiting-approval" ? <p className="dcp-note">{adapter.approved ? "Approved. Restart Desk to start it." : adapter.message}</p> : adapter.state === "unavailable" ? <p className="dcp-error" data-code={adapter.code}>{adapter.message}</p> : null}
      {adapter.connection?.enabled && adapter.connection.destinations.length > 0 && <table className="dep-scope"><thead><tr><th>Place</th><th>Read</th><th>Add</th></tr></thead><tbody>{adapter.connection.destinations.map((place: any) => <tr key={place.id} data-place={place.label}><td>{place.label}</td>{(["read", "write"] as const).map(kind => <td key={kind}><input type="checkbox" aria-label={`${kind} ${place.label}`} checked={place[kind]} onChange={event => { void run("/api/adapters/destination", { adapterId: adapter.adapterId, id: place.id, kind, allowed: event.target.checked }); }} /></td>)}</tr>)}</tbody></table>}
    </li>)}</ul></section>;
}

function App() {
  const [view, setView] = useState<View | null>(null);
  const [pane, setPane] = useState<"conversation" | "day" | "adapters">(() => { const value = new URLSearchParams(location.search).get("desk"); return value === "day" || value === "adapters" ? value : "conversation"; });
  const [restarting, setRestarting] = useState(false);
  const load = useCallback(async () => { const response = await fetch("/api/view"); setView(await response.json() as View); }, []);
  useEffect(() => { void load(); }, [load]);
  const run: Run = useCallback(async (path, body) => { const response = await fetch(path, { method: "POST", body: JSON.stringify(body ?? {}) }); if (response.ok) setView(await response.json() as View); }, []);
  const restart = () => {
    setRestarting(true);
    void fetch("/api/adapters/restart", { method: "POST", body: "{}" }).finally(() => {
      const wait = () => { setTimeout(() => { void load().then(() => { setRestarting(false); }, wait); }, 300); };
      wait();
    });
  };
  if (!view) return <p className="dep-loading">Loading…</p>;
  return <div className="dcp" data-extension-prototype data-restarting={restarting}>
    <header className="dcp-top"><span className="dcp-brand"><span className="desk-mark" />Desk</span><nav className="dep-nav">{(["conversation", "day", "adapters"] as const).map(name => <button type="button" key={name} aria-current={pane === name ? "page" : undefined} onClick={() => { setPane(name); }}>{name === "conversation" ? "Conversation" : name === "day" ? "Day" : "Adapters"}</button>)}</nav><span className="dcp-sample">Sample data</span></header>
    <main className="dcp-main">{restarting ? <p role="status">Restarting Desk…</p> : pane === "conversation" ? <Conversation view={view} run={run} /> : pane === "day" ? <Day view={view} run={run} /> : <Adapters view={view} run={run} restart={restart} />}</main>
  </div>;
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<App />);
