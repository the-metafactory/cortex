import type { DeskItem } from "../../desk/types";
import "./desk-mail-draft.css";

export interface ReplyDraft {
  requestId: string;
  commitment?: import("../../desk/mail-yes-filter").Commitment;
  intent: import("../../desk/mail-yes-filter").MailDecision["intent"];
  key: string;
  text: string;
  note: string | null;
}

export const newReplyDraft = (key: string): ReplyDraft => ({ key, text: "", note: null, intent: "reply", requestId: crypto.randomUUID() });

export function prepareDeclineDraft(draft: ReplyDraft): ReplyDraft {
  return { ...draft, intent: "decline", requestId: crypto.randomUUID(), text: draft.text.trim() ? draft.text : "Thank you for thinking of me. I cannot take this on.", note: null };
}

export function prepareAcceptDraft(draft: ReplyDraft): ReplyDraft {
  return { ...draft, intent: "accept", requestId: crypto.randomUUID(), text: draft.text.trim() ? draft.text : "Thank you for the invitation. I am glad to accept.", note: null };
}

export function prepareProposalDraft(draft: ReplyDraft, text: string, note: string | null): ReplyDraft {
  return { ...draft, intent: "propose", requestId: crypto.randomUUID(), text, note };
}

export function ReplyDraftBox({ reply, draft, sending, onChange, onConfirm, onCancel, nudge = false }: {
  nudge?: boolean;
  reply: NonNullable<DeskItem["reply"]>;
  draft: ReplyDraft;
  sending: boolean;
  onChange: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="desk-reply" aria-label={nudge ? "Draft a nudge" : "Draft a reply"}>
      <div className="desk-sec">{nudge ? "Draft a nudge" : "Draft a reply"}</div>
      <p className="desk-reply-head">To: {reply.to}</p>
      <p className="desk-reply-head">Subject: {reply.subject}</p>
      <textarea
        aria-label={nudge ? "Your nudge" : "Your reply"}
        rows={6}
        value={draft.text}
        placeholder={nudge ? "A short follow-up to your mail. It is saved in Drafts for you to send." : "Your reply. It is saved in Drafts for you to send."}
        onChange={(e) => onChange(e.target.value)}
      />
      {draft.intent === "decline" && <p>Edit this draft into your decline before saving. It is not sent.</p>}
      {draft.intent === "accept" && <p>Edit this draft into your acceptance before saving. It is not sent.</p>}
      {draft.intent === "propose" && <p>These times are free in your calendars. Edit the draft before saving. It is not sent.</p>}
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
