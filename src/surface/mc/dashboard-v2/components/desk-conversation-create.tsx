import { useCallback, useEffect, useMemo, useState } from "react";
import { SUBJECT_FIELDS } from "../../../../conversations/catalog";
import { failureText } from "../lib/conversations";
import { check, confirm, feedbackLabel, propose, readCapabilities, readCreation, revise, revoke, type Capability, type CreationView, type GrantScope, type ProposalView } from "../lib/conversation-creation";

const QUICK = ["graph-node", "balance-task", "routine", "flow"] as const;
const SETTLING_MS = 3_000;

export interface CreationSeed { entryId: string | null; text: string }

export function useCreation(id: string, revision: number) {
  const [types, setTypes] = useState<Capability[]>([]);
  const [view, setView] = useState<CreationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const [caps, next] = await Promise.all([readCapabilities(signal), readCreation(id, signal)]);
      if (signal?.aborted) return;
      setTypes(caps.types); setView(next); setError(null);
    } catch (err) {
      if (!signal?.aborted) setError(failureText(err, "Proposals could not be read. Retry when Mission Control is available."));
    }
  }, [id]);
  const settling = Boolean(view?.proposals.some(p => p.feedback === "accepted"));
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const every = settling ? setInterval(() => { void load(controller.signal); }, SETTLING_MS) : null;
    return () => { controller.abort(); if (every) clearInterval(every); };
  }, [load, revision, settling]);
  return { types, view, error, setError, reload: load };
}

type Act = (run: () => Promise<unknown>, fallback: string) => Promise<void>;

export function CreationPanel({ id, archived, revision, seed }: { id: string; archived: boolean; revision: number; seed: CreationSeed }) {
  const c = useCreation(id, revision);
  const [busy, setBusy] = useState(false);
  const act = async (run: () => Promise<unknown>, fallback: string): Promise<void> => {
    if (busy) return;
    setBusy(true); c.setError(null);
    try { await run(); }
    catch (err) { c.setError(failureText(err, fallback)); }
    finally { setBusy(false); await c.reload(); }
  };
  return <CreationSection id={id} archived={archived} types={c.types} view={c.view} error={c.error} busy={busy} seed={seed} act={act} />;
}

export function CreationSection({ id, archived, types, view, error, busy, seed, act }: { id: string; archived: boolean; types: Capability[]; view: CreationView | null; error: string | null; busy: boolean; seed: CreationSeed; act: Act }) {
  const byType = useMemo(() => new Map(types.map(t => [t.type, t])), [types]);
  const creatable = types.filter(t => t.status !== "unsupported");
  const start = (type: string | null): void => {
    const title = seed.text.split("\n")[0]?.slice(0, 200) ?? "";
    const spec = type ? byType.get(type) : undefined;
    const subject = SUBJECT_FIELDS.find(name => spec?.fields.some(f => f.name === name)) ?? "title";
    void act(() => propose(id, { proposalId: crypto.randomUUID(), ...(type ? { type } : { intent: "card" }), fields: title ? { [subject]: title } : {}, ...(seed.entryId ? { entryId: seed.entryId } : {}) }), "The proposal was not saved. Try again; nothing was created.");
  };
  const proposals = view?.proposals ?? [];
  const grants = view?.grants ?? [];
  const active = grants.filter(g => !g.revokedAt);
  const revoked = grants.length - active.length;
  return <section className="dcv-create" aria-label="Create from this exchange">
    {proposals.map(p => <ProposalCard key={p.proposal.proposalId} id={id} view={p} types={creatable} busy={busy} archived={archived} act={act} />)}
    {!archived && <div className="dcv-acts" role="group" aria-label="Create from this exchange">
      <span className="dcv-quiet">Create from this exchange:</span>
      {QUICK.map(type => { const t = byType.get(type); return t ? <button key={type} type="button" className="desk-btn" disabled={busy} onClick={() => start(type)}>{t.label}</button> : null; })}
      <button type="button" className="desk-btn" disabled={busy} onClick={() => start(null)}>Card…</button>
    </div>}
    <div className="dcv-grants" aria-label="Standing creation permissions">
      <h4>Standing creation permissions</h4>
      {active.length === 0 && <p className="dcv-quiet">None. Ivy asks before every creation.</p>}
      <ul>{active.map(g => <li key={g.grantId}><span>{byType.get(g.type)?.label ?? g.type} · {g.scope === "global" ? "all your conversations" : g.conversationId === id ? "this conversation" : "another conversation"}</span>
        <button type="button" className="desk-btn ghost" disabled={busy} onClick={() => void act(() => revoke(g.grantId), "The permission was not revoked. Try again.")}>Revoke</button></li>)}</ul>
      <p className="dcv-quiet">Creation only: running a flow or enabling a routine always needs its own decision. Revoking stops future creation without asking; objects already created stay as they are{revoked > 0 ? ` (${revoked} revoked, kept in the history)` : ""}.</p>
    </div>
    {error && <p className="desk-unsent" role="alert">{error}</p>}
  </section>;
}

function ProposalCard({ id, view, types, busy, archived, act }: { id: string; view: ProposalView; types: Capability[]; busy: boolean; archived: boolean; act: Act }) {
  const { proposal, capability } = view;
  const [fields, setFields] = useState<Record<string, string>>(proposal.fields);
  const [type, setType] = useState<string>(proposal.type ?? "");
  const [standing, setStanding] = useState(false);
  const [scope, setScope] = useState<GrantScope>("conversation");
  const savedFields = JSON.stringify(proposal.fields);
  useEffect(() => { setFields(JSON.parse(savedFields) as Record<string, string>); setType(proposal.type ?? ""); }, [proposal.revision, savedFields, proposal.type]);
  const dirty = JSON.stringify(fields) !== JSON.stringify(proposal.fields);
  const open = view.feedback === "proposed" || view.feedback === "unavailable" || view.feedback === "choose" || view.feedback === "failed";
  const editable = open && !archived;
  const settled = view.operation?.state === "created";
  const save = (): Promise<ProposalView> => revise(id, proposal.proposalId, { revision: proposal.revision, fields });
  const doConfirm = (): void => void act(async () => {
    const current = dirty ? await save() : view;
    await confirm(id, proposal.proposalId, { revision: current.proposal.revision, digest: current.digest, ...(standing ? { grant: { scope } } : {}) });
  }, "Mission Control did not confirm this. Confirm again: it repeats the same operation and never creates twice.");
  const last = view.operation?.history.at(-1)?.detail;
  let why = proposal.entryId ? `From this exchange · revision ${proposal.revision}` : `Revision ${proposal.revision}`;
  if (view.feedback === "unavailable") why = capability?.reason ?? "This type is unavailable here.";
  else if (view.refusal) why = view.refusal;
  else if (view.missing.length > 0 && open) why = `Fill in ${view.missing.join(", ")} before confirming.`;
  else if (view.feedback === "accepted") why = "The owner accepted it and has not reported the result yet.";
  else if (view.feedback === "uncertain") why = `${last ?? "The result is unknown."} Nothing is retried on its own.`;
  else if (view.feedback === "failed") why = last ?? "The owner refused it.";
  return <article className={`dcv-proposal ${view.feedback}`} aria-label={feedbackLabel(view)}>
    <small>{feedbackLabel(view)}</small>
    <p className="dcv-sentence">{view.sentence}</p>
    <p className="dcv-quiet">{why}</p>
    {view.feedback === "choose" && !archived && <div className="dcv-choose">
      <label>What to create and where<select aria-label="What to create" value={type} onChange={e => setType(e.target.value)}>
        <option value="">Choose a type…</option>
        {types.map(t => <option key={t.type} value={t.type}>{t.label}{t.status === "ready" ? "" : " · unavailable"}</option>)}
      </select></label>
      <button type="button" className="desk-btn" disabled={busy || !type} onClick={() => void act(() => revise(id, proposal.proposalId, { revision: proposal.revision, type }), "The choice was not saved. Try again.")}>Use this type</button>
    </div>}
    {capability && view.feedback !== "choose" && <div className="dcv-fields">
      {capability.fields.map(f => <label key={f.name}>{f.label}{f.required ? "" : " (optional)"}{f.destination ? " · destination" : ""}
        {f.kind === "long"
          ? <textarea aria-label={f.label} value={fields[f.name] ?? ""} disabled={!editable} maxLength={20_000} onChange={e => setFields({ ...fields, [f.name]: e.target.value })} />
          : <input aria-label={f.label} type={f.kind === "date" ? "date" : f.kind === "datetime" ? "datetime-local" : "text"} value={fields[f.name] ?? ""} disabled={!editable} onChange={e => setFields({ ...fields, [f.name]: e.target.value })} />}
      </label>)}
      {capability.fixed.map(t => <p key={t.label} className="dcv-quiet"><strong>{t.label}:</strong> {t.value}</p>)}
    </div>}
    {settled && <p role="status">Created {capability?.label.toLowerCase()} {view.operation?.canonicalId}{view.operation?.url ? <> · <a href={view.operation.url}>Open it</a></> : null}. It links back to this exchange.</p>}
    {editable && view.feedback === "proposed" && <div className="dcv-standing">
      <label><input type="checkbox" checked={standing} onChange={e => setStanding(e.target.checked)} /> Allow future {capability?.label.toLowerCase()} creation without asking</label>
      {standing && <select aria-label="Standing permission scope" value={scope} onChange={e => setScope(e.target.value === "global" ? "global" : "conversation")}>
        <option value="conversation">This conversation only</option>
        <option value="global">All my conversations</option>
      </select>}
    </div>}
    <div className="dcv-acts">
      {editable && view.feedback === "proposed" && <button type="button" className="desk-btn pri" disabled={busy || view.missing.length > 0 && !dirty || Boolean(view.refusal)} onClick={doConfirm}>Confirm creation</button>}
      {(view.feedback === "uncertain" || view.feedback === "accepted") && <button type="button" className="desk-btn pri" disabled={busy} onClick={() => void act(() => check(id, proposal.proposalId), "The owner could not be asked. Check again later.")}>Check</button>}
      {view.feedback === "failed" && !archived && <button type="button" className="desk-btn pri" disabled={busy} onClick={() => void act(() => revise(id, proposal.proposalId, { revision: proposal.revision, fields }), "Not saved. Try again.")}>Try again</button>}
      {editable && dirty && <button type="button" className="desk-btn" disabled={busy} onClick={() => void act(save, "Your edits were not saved. They are still here; try again.")}>Save edits</button>}
      {editable && <button type="button" className="desk-btn ghost" disabled={busy} onClick={() => void act(() => revise(id, proposal.proposalId, { revision: proposal.revision, dismiss: true }), "Not dismissed. Try again.")}>Dismiss</button>}
    </div>
  </article>;
}
