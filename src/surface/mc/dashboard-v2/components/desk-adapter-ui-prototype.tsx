import { useEffect, useRef, useState, type ReactNode } from "react";
import "./desk-adapter-ui-prototype.css";

type AdapterId = "graph" | "balance";
type Stage = "summary" | "detail" | "editor" | "query" | "proposed" | "saved";
type Fields = Record<string, string>;
type Field = { name: string; label: string; required?: boolean; long?: boolean; date?: boolean };
const schemas: Record<AdapterId, Field[]> = {
  graph: [{ name: "repository", label: "Repository", required: true }, { name: "parent", label: "Parent node", required: true }, { name: "title", label: "Title", required: true }, { name: "body", label: "Body", long: true }, { name: "checkpoint", label: "Checkpoint", required: true }],
  balance: [{ name: "area", label: "Area", required: true }, { name: "project", label: "Project" }, { name: "title", label: "Title", required: true }, { name: "note", label: "Note", long: true }, { name: "due", label: "Due", date: true }],
};
const initial: Record<AdapterId, Fields> = {
  graph: { repository: "example/project", parent: "lifecycle-map", title: "Investigate receipt preservation", body: "Compare persisted receipts with owner lookup. Document the crash immediately after acceptance, then propose a regression test.", checkpoint: "receipt-restart-evidence" },
  balance: { area: "Reliability", project: "Lifecycle review", title: "Review restart receipts", note: "Compare the preserved receipt and canonical owner lookup. Review the crash cases and regression proposal.", due: "" },
};
const stages: Stage[] = ["summary", "detail", "editor", "query", "proposed", "saved"];
const variants = ["A", "B", "C"] as const;
type Variant = typeof variants[number];
const names: Record<Variant, string> = { A: "Object workspace", B: "Conversation workbench", C: "Review journey" };
const release = "generation-a";
const protocol = "1.0.0-prototype";
const nonJsonFramePayload = null;
const frameJson = (value: unknown): string | null => { try { return JSON.stringify(value) ?? nonJsonFramePayload; } catch { return nonJsonFramePayload; } };
type FrameMessage = { type: string; instance: string; release: string; protocol: string; [key: string]: unknown };
interface LayoutProps { tools: ReactNode; tabs: ReactNode; content: ReactNode; inspector: ReactNode }
export function VariantA({ tools, tabs, content, inspector }: LayoutProps) {
  return <div className="dap-workspace"><aside className="dap-rail"><h2>Connected objects</h2>{tools}<p>Choose an adapter, then inspect its object without leaving Desk.</p></aside><main>{tabs}<div className="dap-surface">{content}</div></main><aside className="dap-inspector">{inspector}</aside></div>;
}
export function VariantB({ tools, tabs, content, inspector }: LayoutProps) {
  return <div className="dap-workbench"><main><h1>Make the next step concrete</h1><div className="dap-exchange"><strong>Conversation outcome</strong><p>The importer can lose acceptance receipts on restart. Compare the persisted receipt with owner lookup, document the crash cases and propose a regression test.</p><small>Synthetic conversation · explicitly selected context</small></div><div className="dap-inline-tools">{tools}</div>{tabs}<div className="dap-surface">{content}</div></main><aside className="dap-inspector"><h2>Alongside the conversation</h2>{inspector}</aside></div>;
}
export function VariantC({ tools, tabs, content, inspector }: LayoutProps) {
  return <main className="dap-journey"><div className="dap-journey-head"><div><small>From discussion to an owner artefact</small><h1>Review one step at a time</h1></div><div className="dap-inline-tools">{tools}</div></div>{tabs}<div className="dap-journey-grid"><section className="dap-surface">{content}</section><aside className="dap-inspector">{inspector}</aside></div></main>;
}

function SchemaEditor({ fields, values, errors, onChange }: { fields: Field[]; values: Fields; errors: string[]; onChange: (name: string, value: string) => void }) {
  return <div className="dap-form">{fields.map(field => <label key={field.name}>{field.label}{field.required && <span aria-hidden="true"> *</span>}{field.long ? <textarea aria-label={field.label} value={values[field.name] ?? ""} onChange={event => { onChange(field.name, event.target.value); }} /> : <input aria-label={field.label} type={field.date ? "date" : "text"} value={values[field.name] ?? ""} aria-invalid={errors.includes(field.name)} onChange={event => { onChange(field.name, event.target.value); }} />}{errors.includes(field.name) && <small className="dap-error">{field.label} is required.</small>}</label>)}</div>;
}

export function DeskAdapterUiPrototype() {
  const [variant, setVariant] = useState<Variant>(() => { const value = new URLSearchParams(location.search).get("variant"); return variants.includes(value as Variant) ? value as Variant : "A"; });
  const [adapter, setAdapter] = useState<AdapterId>("graph");
  const [stage, setStage] = useState<Stage>("summary");
  const [drafts, setDrafts] = useState(initial);
  const [dirty, setDirty] = useState<Record<AdapterId, boolean>>({ graph: false, balance: false });
  const [renderer, setRenderer] = useState("schema");
  const [theme, setTheme] = useState("light");
  const [condition, setCondition] = useState("ready");
  const [frameFailure, setFrameFailure] = useState("");
  const [mount, setMount] = useState(0);
  const [bridge, setBridge] = useState("unmounted");
  const [errors, setErrors] = useState<string[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [writes, setWrites] = useState(0);
  const [receipts, setReceipts] = useState<Record<AdapterId, null | { adapter: AdapterId; canonicalId: string; fields: Fields }>>({ graph: null, balance: null });
  const receipt = receipts[adapter];
  const [pending, setPending] = useState<null | { adapter: AdapterId; fields: Fields }>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const instance = useRef("");
  const latest = useRef({ adapter, stage, fields: drafts[adapter], theme });
  latest.current = { adapter, stage, fields: drafts[adapter], theme };
  const note = (message: string) => { setEvents(current => [...current.slice(-15), message]); };
  const change = (name: string, value: string) => { setDrafts(current => ({ ...current, [adapter]: { ...current[adapter], [name]: value } })); setDirty(current => ({ ...current, [adapter]: true })); setPending(null); setErrors([]); };
  const selectStage = (value: Stage) => { setStage(value); setErrors([]); };
  const cycle = (delta: number) => { setVariant(current => { const next = variants[(variants.indexOf(current) + delta + variants.length) % variants.length] ?? "A"; const url = new URL(location.href); url.searchParams.set("variant", next); history.replaceState(null, "", url); return next; }); };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => { const target = event.target as HTMLElement | null; if (target?.closest("input,textarea,select,[contenteditable]")) return; if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); cycle(event.key === "ArrowLeft" ? -1 : 1); } };
    const ambient = (event: MessageEvent) => { if (event.source === frame.current?.contentWindow) note("Ambient frame message ignored; no authority."); };
    window.addEventListener("keydown", keyboard); window.addEventListener("message", ambient);
    return () => { window.removeEventListener("keydown", keyboard); window.removeEventListener("message", ambient); };
  }, []);
  useEffect(() => { if (bridge === "ready") port.current?.postMessage({ type: "host:projection", ...latest.current }); }, [adapter, stage, drafts, theme, bridge]);
  useEffect(() => () => { port.current?.close(); port.current = null; }, [adapter, renderer, mount, condition, variant]);
  const connect = () => {
    const target = frame.current?.contentWindow;
    if (!target) return;
    port.current?.close();
    const channel = new MessageChannel();
    const current = crypto.randomUUID();
    instance.current = current;
    port.current = channel.port1;
    setBridge("handshaking");
    let ready = false;
    setTimeout(() => { if (!ready && port.current === channel.port1) { channel.port1.close(); port.current = null; setBridge("closed"); setFrameFailure("Frame did not complete the matched handshake; generic fallback."); } }, 1000);
    channel.port1.onmessage = event => {
      if (port.current !== channel.port1 || instance.current !== current) return;
      const raw = event.data as FrameMessage;
      const fail = (reason: string) => { channel.port1.close(); port.current = null; setBridge("closed"); setFrameFailure(reason); note(reason); };
      if (typeof raw !== "object" || raw === null || Array.isArray(raw) || frameJson(raw) === null || (frameJson(raw)?.length ?? 0) > 8192 || raw.instance !== current || raw.release !== release || raw.protocol !== protocol) { fail("Frame identity or generation mismatch; generic fallback."); return; }
      const allowed: Record<string, string[]> = { ready: [], "draft:change": ["name", "value"], "action:propose": [], "host:navigate": ["stage"], "probe:result": ["attack", "result"], "renderer:error": ["message"] };
      const keys = typeof raw.type === "string" && Object.hasOwn(allowed, raw.type) ? allowed[raw.type] : undefined;
      if (!keys || Object.keys(raw).some(key => !["type", "instance", "release", "protocol", ...keys].includes(key))) { fail("Unsupported frame event; generic fallback."); return; }
      if (raw.type === "ready") { ready = true; setBridge("ready"); channel.port1.postMessage({ type: "host:projection", ...latest.current }); }
      if (raw.type === "draft:change") { if (typeof raw.name !== "string" || typeof raw.value !== "string" || raw.value.length > 20000 || !schemas[adapter].some(field => field.name === raw.name)) { fail("Invalid draft patch; generic fallback."); return; } change(raw.name, raw.value); }
      if (raw.type === "action:propose") { selectStage("proposed"); note("Frame requested a proposal; host confirmation remains separate."); }
      if (raw.type === "host:navigate") { if (!stages.includes(raw.stage as Stage)) { fail("Unknown navigation target; generic fallback."); return; } selectStage(raw.stage as Stage); }
      if (raw.type === "probe:result") note(`${String(raw.attack)}: ${String(raw.result)}`);
      if (raw.type === "renderer:error") { fail("Renderer failed; draft retained in generic fallback."); }
    };
    channel.port1.start();
    target.postMessage({ type: "desk:init", instance: current, release, protocol, attackOrigin: `${location.protocol}//${location.hostname}:${Number(location.port) + 1}` }, "*", [channel.port2]);
  };
  const propose = () => { const missing = schemas[adapter].filter(field => field.required && !drafts[adapter][field.name]?.trim()).map(field => field.name); setErrors(missing); if (missing.length) { setStage("editor"); note("Host validation blocked an incomplete proposal."); return; } setPending({ adapter, fields: structuredClone(drafts[adapter]) }); setStage("proposed"); };
  const confirm = () => { if (!pending || pending.adapter !== adapter || JSON.stringify(pending.fields) !== JSON.stringify(drafts[adapter])) return; setWrites(current => current + 1); setReceipts(current => ({ ...current, [adapter]: { ...pending, canonicalId: `${adapter}-synthetic-object` } })); setPending(null); setStage("saved"); note("Host confirmed one synthetic owner call; no external provider."); };
  const title = drafts[adapter].title ?? "Untitled draft";
  const fallback = renderer === "custom" && frameFailure;
  const state = { prototype: true, variant, adapter, stage, renderer, condition, bridge, frameFailure, dirty, drafts, pending, receipt, receipts, syntheticOwnerWrites: writes, externalOwnerWrites: 0, instance: instance.current, release, events };
  const tools = <><label className="dap-control">Adapter<select aria-label="Adapter" value={adapter} onChange={event => { setAdapter(event.target.value as AdapterId); setFrameFailure(""); setPending(null); }}><option value="graph">Work graph</option><option value="balance">Balance</option></select></label><label className="dap-control">Renderer<select aria-label="Renderer" value={renderer} onChange={event => { setRenderer(event.target.value); setFrameFailure(""); }}><option value="schema">Host schema fallback</option><option value="custom">Isolated custom module</option></select></label></>;
  const tabs = <nav className="dap-stages" aria-label="Object views">{stages.map(value => <button type="button" key={value} aria-current={stage === value ? "page" : undefined} onClick={() => { selectStage(value); }}>{value}</button>)}</nav>;
  let hostContent: ReactNode;
  if (stage === "editor") hostContent = <><h2>Edit the draft</h2><SchemaEditor fields={schemas[adapter]} values={drafts[adapter]} errors={errors} onChange={change} /><button type="button" className="dap-primary" onClick={propose}>Review proposal</button></>;
  else if (stage === "query") hostContent = <><h2>Selected scope</h2><p>One synthetic result · {adapter === "graph" ? "example/project → lifecycle-map" : "Reliability → Lifecycle review"}</p><button type="button" className="dap-object" onClick={() => { selectStage("detail"); }}><strong>{title}</strong><span>Canonical reference: {adapter}/connection-example/object-example</span></button><p className="dap-muted">Current scope only. No provider was queried.</p></>;
  else if (stage === "proposed") hostContent = <><h2>Host-owned confirmation</h2><p>The adapter can request a proposal. Only this host control confirms the exact current fields.</p><pre>{JSON.stringify(pending?.fields ?? drafts[adapter], null, 2)}</pre>{pending ? <button type="button" className="dap-primary" onClick={confirm}>Confirm synthetic save</button> : <button type="button" className="dap-primary" onClick={propose}>Validate exact draft</button>}</>;
  else if (stage === "saved") hostContent = <><h2>{receipt ? "Synthetic saved result" : "Nothing saved"}</h2><p>{receipt ? `Preserved receipt: ${receipt.canonicalId}` : "Drafting and navigation have made zero owner calls."}</p><pre>{JSON.stringify(receipt, null, 2)}</pre><p>No external object exists. Reopening this view does not call the owner again.</p></>;
  else hostContent = <><small>{adapter === "graph" ? "Research node · approval required" : "Task · local connection"}</small><h1>{title}</h1><p>{drafts[adapter].body ?? drafts[adapter].note}</p>{stage === "detail" && <dl>{schemas[adapter].filter(field => field.name !== "title").map(field => <div key={field.name}><dt>{field.label}</dt><dd>{drafts[adapter][field.name] || "Not specified"}</dd></div>)}</dl>}<div className="dap-actions"><button type="button" className="dap-primary" onClick={() => { selectStage("editor"); }}>Edit draft</button><button type="button" onClick={() => { selectStage("query"); }}>Inspect source scope</button></div></>;
  const customVisible = renderer === "custom" && !frameFailure && condition === "ready";
  const content = <>{condition === "loading" ? <p role="status">Loading the synthetic renderer…</p> : condition === "unavailable" ? <div role="status"><h2>Connection unavailable</h2><p>Draft and host history are retained. Actions are disabled until a supported connection returns.</p></div> : <>{fallback && <p role="alert" className="dap-error">{frameFailure}</p>}{customVisible ? <><iframe key={`${adapter}-${mount}`} ref={frame} title={`${adapter} custom adapter`} sandbox="allow-scripts" src="/prototype-assets/generation-a/module.html" onLoad={connect} />{(stage === "proposed" || stage === "saved") && hostContent}</> : hostContent}</>}</>;
  const inspector = <><h2>Host boundary</h2><p><strong>{dirty[adapter] ? "Unsaved edit retained" : "Seeded synthetic draft"}</strong></p><p>Confirmation, scope checks and receipts belong to the host. This frame receives synthetic data only.</p><label className="dap-control">State<select aria-label="Simulated state" value={condition} onChange={event => { setCondition(event.target.value); }}><option value="ready">Ready</option><option value="loading">Loading</option><option value="unavailable">Unavailable</option></select></label><button type="button" onClick={() => { setTheme(current => current === "light" ? "dark" : "light"); }}>Theme: {theme}</button><button type="button" onClick={() => { setFrameFailure(""); setBridge("mounting"); setMount(current => current + 1); }}>Remount renderer</button><details><summary>Boundary probes</summary><p>Synthetic-only checks; not a general browser isolation proof.</p>{["parent", "fetch", "image", "worker", "ambient", "wrong-generation", "unknown-event", "prototype-event", "constructor-event", "proto-event", "array-payload", "cyclic-payload", "bigint-payload", "self-navigation", "renderer-error"].map(attack => <button type="button" key={attack} onClick={() => { port.current?.postMessage({ type: "host:probe", attack }); }}>Probe {attack}</button>)}</details><details open><summary>Current state and candidate events</summary><p className="dap-muted">Candidate: draft:change, action:propose, host:navigate. No execute or confirm event.</p><pre data-prototype-state>{JSON.stringify(state, null, 2)}</pre></details></>;
  const Layout = variant === "A" ? VariantA : variant === "B" ? VariantB : VariantC;
  return <div className={`desk dap${theme === "dark" ? " dap-dark" : ""}`}><header className="desk-top"><div className="dap-top"><div className="desk-brand"><span className="desk-mark" />Desk</div><nav aria-label="Desk"><span>Day</span><span>Catch-up</span><strong>Adapter prototype</strong></nav><span className="dap-badge">Throwaway · synthetic only</span></div></header><div className="dap-banner">Question: which host/render contract makes adapter-owned objects useful without losing drafts or granting authority?</div><Layout tools={tools} tabs={tabs} content={content} inspector={inspector} /><div className="dap-switcher" aria-label="Prototype variants"><button type="button" aria-label="Previous variant" onClick={() => { cycle(-1); }}>←</button><span>{variant} · {names[variant]}</span><button type="button" aria-label="Next variant" onClick={() => { cycle(1); }}>→</button></div></div>;
}
