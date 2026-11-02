import type { InvitationView } from "../../desk/mail-invitation";
import type { InviteReply } from "../../desk/mail-invitation-schema";
import type { Commitment } from "../../desk/mail-yes-filter";
import "./desk-mail-draft.css";

export interface InviteAsk {
  key: string;
  reply: InviteReply | null;
  requestId: string;
  commitment?: Commitment;
  nothing: boolean;
  note: string | null;
}

export const newInviteAsk = (key: string): InviteAsk => ({ key, reply: null, requestId: crypto.randomUUID(), nothing: false, note: null });

export const canSendInvite = (ask: InviteAsk): boolean => ask.reply === "decline" || (ask.reply === "accept" && (Boolean(ask.commitment) || ask.nothing));

const STATE: Record<NonNullable<InvitationView["decision"]>["status"], string> = { sent: "sent", sending: "being sent", uncertain: "may have been sent; check Sent", failed: "not sent" };

const time = (at: number): string => new Date(at).toTimeString().slice(0, 5);

export function InvitationBox({ view, ask, sending, onNothing, onConfirm, onCancel }: {
  view: InvitationView;
  ask: InviteAsk | null;
  sending: boolean;
  onNothing: (nothing: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const decision = view.decision;
  const answered = decision !== undefined && decision.status !== "failed";
  const reply = ask?.reply;
  return (
    <section className="desk-reply" aria-label="Invitation">
      <div className="desk-sec">Invitation</div>
      <p className="desk-reply-head">{view.summary}</p>
      <p>{view.when}{view.location ? ` · ${view.location}` : ""}</p>
      <p>From {view.organizer}{view.recurring ? " · it repeats" : ""}</p>
      <p className={view.conflicts.kind === "clear" ? "desk-why" : "desk-why desk-unsent"}>{view.conflictLine}</p>
      {view.conflicts.kind === "conflicts" && (
        <ul aria-label="Conflicts">
          {view.conflicts.events.map((e) => <li key={`${e.calendar}-${e.at}-${e.title}`}>{time(e.at)}{e.end !== undefined ? `–${time(e.end)}` : ""} {e.title} ({e.calendar}){e.maybe ? ", may be busy" : ""}</li>)}
        </ul>
      )}
      {decision && <p>{decision.reply === "accept" ? "Acceptance" : "Decline"} {STATE[decision.status]}.{decision.fallsAway ? ` Falls away: ${decision.fallsAway}.` : ""}{decision.calendar ? ` ${decision.calendar}` : ""}</p>}
      {!view.attendee && <p>You are not listed as an attendee, so the Desk does not answer this invitation.</p>}
      {ask && reply && view.canReply && !answered && (
        <div aria-label="Confirm your answer">
          <p>{reply === "accept" ? "Send your acceptance" : "Send your decline"} to {view.organizer}? It goes out as a calendar reply from your mailbox.</p>
          {reply === "accept" && (ask.commitment
            ? <p>Falls away: {ask.commitment.label}</p>
            : <label><input type="checkbox" checked={ask.nothing} disabled={sending} onChange={(e) => onNothing(e.target.checked)} /> Nothing falls away for this Yes</label>)}
          {reply === "accept" && !ask.commitment && !ask.nothing && <p>Choose above which current commitment falls away, or say that nothing does.</p>}
          {ask.note && <p className="desk-why desk-unsent" role="alert">{ask.note}</p>}
          <div className="desk-reply-acts">
            <button type="button" className="desk-btn pri" disabled={sending || !canSendInvite(ask)} aria-busy={sending} onClick={onConfirm}>
              {sending ? "Sending…" : reply === "accept" ? "Send acceptance" : "Send decline"}
            </button>
            <button type="button" className="desk-btn" disabled={sending} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
