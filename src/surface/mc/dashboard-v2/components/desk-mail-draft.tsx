import type { DeskItem } from "../../desk/types";
import "./desk-mail-draft.css";

export interface ReplyDraft {
  key: string;
  text: string;
  note: string | null;
}

export const newReplyDraft = (key: string): ReplyDraft => ({ key, text: "", note: null });

export function ReplyDraftBox({ reply, draft, sending, onChange, onConfirm, onCancel }: {
  reply: NonNullable<DeskItem["reply"]>;
  draft: ReplyDraft;
  sending: boolean;
  onChange: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="desk-reply" aria-label="Draft a reply">
      <div className="desk-sec">Draft a reply</div>
      <p className="desk-reply-head">To: {reply.to}</p>
      <p className="desk-reply-head">Subject: {reply.subject}</p>
      <textarea
        aria-label="Your reply"
        rows={6}
        value={draft.text}
        placeholder="Your reply. It is saved in Drafts for you to send."
        onChange={(e) => onChange(e.target.value)}
      />
      {draft.note && <p className="desk-why desk-unsent" role="alert">{draft.note}</p>}
      <div className="desk-reply-acts">
        <button type="button" className="desk-btn pri" disabled={sending || draft.text.trim() === ""} aria-busy={sending} onClick={onConfirm}>
          {sending ? "Saving draft…" : draft.note ? "Try again" : "Save as draft"}
        </button>
        <button type="button" className="desk-btn" disabled={sending} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
