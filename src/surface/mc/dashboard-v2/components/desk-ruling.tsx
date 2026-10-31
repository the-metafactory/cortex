import type { DeskItem } from "../../desk/types";
import "./desk-ruling.css";

export interface RulingDraft {
  key: string;
  requestId: string;
  text: string;
  note: string | null;
  recorded: boolean;
  locked: boolean;
  open: boolean;
}

export const newRuling = (key: string, requestId: string): RulingDraft => ({ key, requestId, text: "", note: null, recorded: false, locked: false, open: true });

/**
 * The draft after a failed Confirm: the line to show, whether the ruling is in the node, and whether its text is
 * locked. A ruling that may be recorded keeps its text and request id, so the next Confirm cannot record other words.
 */
export function afterFailure(draft: RulingDraft, result: { text: string; recorded?: boolean; uncertain?: boolean }): RulingDraft {
  const recorded = draft.recorded || result.recorded === true;
  return { ...draft, note: result.text, recorded, locked: draft.locked || recorded || result.uncertain === true };
}

/** Cancel closes the box; a draft that may be recorded is kept, so opening it again reuses its request id. */
export const cancelRuling = (draft: RulingDraft | null): RulingDraft | null => (draft?.locked ? { ...draft, open: false } : null);

export function RulingBox({ item, draft, sending, onChange, onConfirm, onCancel }: {
  item: DeskItem;
  draft: RulingDraft;
  sending: boolean;
  onChange: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const question = item.question;
  const issue = item.detail.links[0];
  return (
    <section className="desk-ruling" aria-label="Your ruling">
      <div className="desk-sec">The agent asks</div>
      {question?.condition && <p className="desk-ruling-ask">Resume once: {question.condition}</p>}
      <p className="desk-why">{question?.reason ?? item.detail.summary}</p>
      {issue && <a className="desk-ruling-link" href={issue.url} target="_blank" rel="noopener noreferrer">Open the issue ↗</a>}
      <textarea
        aria-label="Your ruling"
        rows={4}
        value={draft.text}
        readOnly={draft.locked}
        placeholder="Your ruling, in a few sentences"
        onChange={(e) => onChange(e.target.value)}
      />
      {draft.note && <p className="desk-why desk-unsent" role="alert">{draft.note}</p>}
      <div className="desk-ruling-acts">
        <button type="button" className="desk-btn pri" disabled={sending || draft.text.trim() === ""} aria-busy={sending} onClick={onConfirm}>
          {sending ? "Recording…" : draft.recorded ? "Resume again" : draft.locked ? "Try again" : "Confirm"}
        </button>
        <button type="button" className="desk-btn" disabled={sending} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
