import { useRef, useState } from "react";
import type { DeskProposal } from "../../desk/ask";
import { askDesk, createFromProposal } from "../lib/desk-ask";
import { ProposalCard } from "./desk-proposal";

export function RoutineCreation({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const inFlight = useRef(false);
  const [proposal, setProposal] = useState<{ value: DeskProposal; requestId: string; said: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const prepare = async (): Promise<void> => {
    if (inFlight.current || !text.trim()) return; inFlight.current = true; setBusy(true); setNotice(null);
    try {
      const result = await askDesk(text);
      if (!result.ok) { setNotice(result.text); return; }
      if (result.proposal.kind !== "routine") { setNotice("Describe a recurring routine with its schedule and steps. Nothing was installed."); return; }
      setProposal({ value: result.proposal, requestId: crypto.randomUUID(), said: text });
    } finally { inFlight.current = false; setBusy(false); }
  };
  const confirm = async (fields: Record<string, unknown>): Promise<void> => {
    if (!proposal || inFlight.current) return; inFlight.current = true; setBusy(true); setNotice(null);
    try {
      const result = await createFromProposal(proposal.requestId, "routine", fields); setNotice(result.text);
      if (result.ok) { setProposal(null); onCreated(); }
    } finally { inFlight.current = false; setBusy(false); }
  };
  return <section hidden={!open} className="desk-set-card routine-creation" aria-label="Create a routine"><div className="routine-calendar-toolbar"><h2>New routine</h2><button className="desk-btn" type="button" disabled={busy} onClick={onClose}>Close new routine</button></div><p>Describe what should happen and when. Review the schedule and steps, then confirm. New routines ask you before each fire.</p><form onSubmit={(event) => { event.preventDefault(); void prepare(); }}><label htmlFor="routine-create-request">Recurring request</label><textarea id="routine-create-request" maxLength={2000} value={text} onChange={(event) => { setText(event.target.value); }} placeholder="Every weekday at 07:30, prepare my morning briefing…" /><button className="desk-btn" type="submit" disabled={busy || !text.trim()}>{busy ? "Checking…" : "Preview routine"}</button></form>{notice && <p role="status">{notice}</p>}{proposal && <ProposalCard proposal={proposal.value} said={proposal.said} maps={[]} now={Date.now()} busy={busy} onConfirm={(fields) => { void confirm(fields); }} onCancel={() => { setProposal(null); }} onGoto={() => { setNotice("Review this routine schedule before confirming."); }} onFieldsChange={() => undefined} />}</section>;
}
