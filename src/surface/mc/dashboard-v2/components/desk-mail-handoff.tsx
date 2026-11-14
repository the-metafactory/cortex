import type { DeskItem } from "../../desk/types";
import { MAX_INSTRUCTION } from "../../desk/mail-handoff-schema";
import "./desk-mail-draft.css";
import { useAssistantName } from "../lib/assistant-name";

export interface HandoffAsk {
  key: string;
  requestId: string;
  instruction: string;
  note: string | null;
}

export const newHandoffAsk = (key: string): HandoffAsk => ({ key, requestId: crypto.randomUUID(), instruction: "", note: null });

export const handoffBody = (ask: HandoffAsk): { action: "ivy.hand"; key: string; requestId: string; instruction?: string } => ({
  action: "ivy.hand", key: ask.key, requestId: ask.requestId, ...(ask.instruction.trim() ? { instruction: ask.instruction.trim() } : {}),
});

export const handoffKeyFor = (item: DeskItem, target: string | undefined): string => (target ? `ivy:${target}` : item.key);

export function MailHandoffBox({ ask, sending, onChange, onConfirm, onCancel }: {
  ask: HandoffAsk;
  sending: boolean;
  onChange: (instruction: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const name = useAssistantName();
  return (
    <section className="desk-reply" aria-label={`Hand to ${name}`}>
      <div className="desk-sec">Hand to {name}</div>
      <p className="desk-reply-head">{name} researches this mail and drafts a reply. It is filed as a task on the first task map set up for the command bar, with the sender, subject, summary and a link; the mail text is not filed. The result comes back as a card; nothing is sent.</p>
      <textarea
        aria-label={`Your instruction for ${name}`}
        rows={3}
        maxLength={MAX_INSTRUCTION}
        value={ask.instruction}
        disabled={sending}
        placeholder={`Optional: what ${name} should find out, or how to answer.`}
        onChange={(e) => onChange(e.target.value)}
      />
      {ask.note && <p className="desk-why desk-unsent" role="alert">{ask.note}</p>}
      <div className="desk-reply-acts">
        <button type="button" className="desk-btn pri" disabled={sending} aria-busy={sending} onClick={onConfirm}>
          {sending ? "Handing over…" : ask.note ? "Try again" : `Hand to ${name}`}
        </button>
        <button type="button" className="desk-btn" disabled={sending} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

export function HandoffStatus({ item }: { item: DeskItem }) {
  const name = useAssistantName();
  const handoff = item.handoff;
  if (!handoff) return null;
  if (item.kind === "mail-handoff" && handoff.findings?.length) {
    return (
      <ul className="desk-why desk-findings" aria-label={`${name}'s findings`}>
        {handoff.findings.map((f, i) => <li key={i}>{f}</li>)}
      </ul>
    );
  }
  if (item.kind === "mail-handoff") return null;
  return <p className={`desk-why ${handoff.state === "failed" ? "desk-unsent" : "desk-waiting"}`}>{handoff.line}</p>;
}
