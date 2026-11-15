import type { DeskAction, JunkReviewMail } from "../../desk/types";

export function JunkReview({ mails, sending, onAction }: { mails: JunkReviewMail[]; sending: boolean; onAction: (action: DeskAction) => void }) {
  return <ul className="desk-set-list" aria-label="Recent junk mail">
    {mails.map(mail => <li key={mail.key}>
      <span>{mail.from.name ?? mail.from.address}<small>{mail.from.address} · {mail.subject} · <time dateTime={mail.receivedAt}>{new Date(mail.receivedAt).toLocaleDateString()}</time></small></span>
      <button type="button" className="desk-btn ghost" disabled={sending || !mail.action.wired} onClick={() => { onAction(mail.action); }}>{mail.action.label}</button>
    </li>)}
  </ul>;
}
