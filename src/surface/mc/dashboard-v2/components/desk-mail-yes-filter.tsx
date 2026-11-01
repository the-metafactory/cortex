import { useState } from "react";
import type { Commitment, MailDecisionSummary, MailYesFilter } from "../../desk/mail-yes-filter";

export function MailYesFilterBox({ filter, selected, canDraft, disabled, onChoose, onDecline }: { filter: MailYesFilter; selected?: Commitment; canDraft: boolean; disabled: boolean; onChoose: (commitment: Commitment | undefined) => void; onDecline: () => void }) {
  const [open, setOpen] = useState(false);
  return <section className="desk-reply" aria-label="Yes-filter">
    <div className="desk-sec">Before a new Yes</div>
    <ul>{filter.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
    <button className="desk-btn" type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>Which current commitment falls away?</button>
    {open && <div>
      {filter.problems.map(p => <p role="alert" key={p}>{p}</p>)}
      {filter.commitments.length ? <label>Current commitment<select aria-label="Current commitment" disabled={disabled || !canDraft} value={selected ? JSON.stringify([selected.kind, selected.id]) : ""} onChange={e => onChoose(filter.commitments.find(c => JSON.stringify([c.kind, c.id]) === e.target.value))}>
        <option value="">No commitment chosen</option>
        {filter.commitments.map(c => <option key={JSON.stringify([c.kind, c.id])} value={JSON.stringify([c.kind, c.id])}>{c.kind === "thread" ? "Thread" : "Focus project"}: {c.label}</option>)}
      </select></label> : <p>No active threads or current focus projects are available.</p>}
      <p>Your choice is recorded locally with the reply draft. It does not change that commitment or appear in your reply.</p>
    </div>}
    {selected && <p>Chosen: {selected.label}</p>}
    {canDraft && <button className="desk-btn" type="button" disabled={disabled} onClick={onDecline}>Prepare a decline</button>}
  </section>;
}

export function RecordedMailDecision({ decision }: { decision: MailDecisionSummary }) {
  const states = { saved: "saved", pending: "pending; check Drafts before retrying", failed: "not saved", uncertain: "outcome uncertain; check Drafts before retrying" };
  return <section className="desk-reply" aria-label="Recorded commitment decision">
    <div className="desk-sec">{decision.intent === "decline" ? "Decline draft" : "Reply draft"}: {states[decision.status]}</div>
    <p>{decision.commitment ? `Recorded choice: ${decision.commitment.label}` : "No commitment was chosen."}</p>
    <p>This record stays here. No commitment has been changed.</p>
  </section>;
}
