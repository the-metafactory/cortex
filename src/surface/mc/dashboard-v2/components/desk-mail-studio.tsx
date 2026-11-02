import type { MailStudioProposal } from "../../desk/mail-studio";
import "./desk-mail-draft.css";

export interface StudioPick {
  key: string;
  requestId: string;
  proposal: MailStudioProposal | null;
  thread: string | null;
  includeText: boolean;
  note: string | null;
}

export const newStudioPick = (key: string): StudioPick => ({ key, requestId: crypto.randomUUID(), proposal: null, thread: null, includeText: false, note: null });

export const withProposal = (pick: StudioPick, proposal: MailStudioProposal): StudioPick => ({ ...pick, proposal, thread: proposal.thread, note: null });

export const studioBody = (pick: StudioPick): { action: "studio.add"; key: string; requestId: string; thread: string | null; reason?: string; includeText: boolean } => ({
  action: "studio.add", key: pick.key, requestId: pick.requestId, thread: pick.thread, includeText: pick.includeText,
  ...(pick.proposal?.thread && pick.thread === pick.proposal.thread ? { reason: pick.proposal.reason } : {}),
});

const INBOX = "";

export function MailStudioBox({ pick, sending, onChoose, onIncludeText, onConfirm, onCancel }: {
  pick: StudioPick;
  sending: boolean;
  onChoose: (thread: string | null) => void;
  onIncludeText: (include: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const proposal = pick.proposal;
  const suggested = proposal?.threads.find((t) => t.slug === proposal.thread);
  return (
    <section className="desk-reply" aria-label="Add to a Studio thread">
      <div className="desk-sec">Add to a Studio thread</div>
      {!proposal && !pick.note && <p className="desk-reply-head" role="status">Asking the Studio filer…</p>}
      {proposal && (
        <>
          <p className="desk-reply-head">{suggested ? `Suggested: “${suggested.question}”. ${proposal.reason}` : proposal.reason}</p>
          <label>
            Thread
            <select aria-label="Thread" value={pick.thread ?? INBOX} disabled={sending} onChange={(e) => onChoose(e.target.value === INBOX ? null : e.target.value)}>
              {proposal.threads.map((t) => <option key={t.slug} value={t.slug}>{t.question}</option>)}
              <option value={INBOX}>Studio inbox</option>
            </select>
          </label>
          {proposal.canIncludeText && (
            <label>
              <input type="checkbox" checked={pick.includeText} disabled={sending} onChange={(e) => onIncludeText(e.target.checked)} /> Include the text
            </label>
          )}
          <p className="desk-reply-head">The thread gets the summary, sender, date and a link to the mail{pick.includeText ? ", and the mail's text" : ""}.</p>
        </>
      )}
      {pick.note && <p className="desk-why desk-unsent" role="alert">{pick.note}</p>}
      <div className="desk-reply-acts">
        <button type="button" className="desk-btn pri" disabled={sending || !proposal} aria-busy={sending} onClick={onConfirm}>
          {sending ? "Adding…" : "Add"}
        </button>
        <button type="button" className="desk-btn" disabled={sending} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
