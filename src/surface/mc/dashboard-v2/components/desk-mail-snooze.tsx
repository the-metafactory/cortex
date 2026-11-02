import type { DeskEvent, DeskItem } from "../../desk/types";
import { SNOOZE_TIMES, snoozeAt, snoozeWhen, type SnoozeChoice, type SnoozeTime } from "../../desk/mail-snooze-schema";
import "./desk-mail-draft.css";

export interface SnoozeAsk {
  key: string;
  date: string;
  meeting: string;
  address: string;
  note: string | null;
}

const MAX_MEETINGS = 12;

export const snoozeSender = (item: DeskItem): string => item.detail.refs[0] ?? "";

export const newSnoozeAsk = (item: DeskItem): SnoozeAsk => ({ key: item.key, date: "", meeting: "", address: snoozeSender(item), note: null });

/** Meetings a mail can wait for: upcoming or running, with a known end or start, soonest first. */
export function snoozeMeetings(events: readonly DeskEvent[], now: number): DeskEvent[] {
  return events
    .filter((e) => e.kind === "meeting" && e.key.startsWith("cal:") && (e.end ?? e.at) > now)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_MEETINGS);
}

const TIME_LABEL: Record<SnoozeTime, string> = { later: "Later today", tomorrow: "Tomorrow morning", "next-week": "Next week" };

export function MailSnoozeBox({ ask, now, meetings, sending, onChange, onChoose, onCancel }: {
  ask: SnoozeAsk;
  now: number;
  meetings: readonly DeskEvent[];
  sending: boolean;
  onChange: (next: Partial<Pick<SnoozeAsk, "date" | "meeting" | "address">>) => void;
  onChoose: (choice: SnoozeChoice) => void;
  onCancel: () => void;
}) {
  const meeting = ask.meeting || meetings[0]?.key || "";
  return (
    <section className="desk-reply" aria-label="Snooze">
      <div className="desk-sec">Snooze</div>
      <p className="desk-reply-head">The mail leaves the Desk and comes back as a card when the time comes, the meeting ends or the person writes. It stays unread in your mail.</p>
      <div className="desk-reply-acts">
        {SNOOZE_TIMES.map((kind) => {
          const at = snoozeAt({ kind }, now);
          return (
            <button key={kind} type="button" className="desk-btn" disabled={sending} onClick={() => onChoose({ kind })}>
              {TIME_LABEL[kind]}{at !== null ? ` (${snoozeWhen(at, now)})` : ""}
            </button>
          );
        })}
      </div>
      <label>
        Until a date (08:00)
        <input type="date" value={ask.date} disabled={sending} onChange={(e) => onChange({ date: e.target.value })} />
      </label>
      <div className="desk-reply-acts">
        <button type="button" className="desk-btn" disabled={sending || !ask.date} onClick={() => onChoose({ kind: "date", date: ask.date })}>Until this date</button>
      </div>
      {meetings.length > 0 && (
        <>
          <label>
            After a meeting
            <select value={meeting} disabled={sending} onChange={(e) => onChange({ meeting: e.target.value })}>
              {meetings.map((m) => <option key={m.key} value={m.key}>{m.title}, {snoozeWhen(m.at, now)}</option>)}
            </select>
          </label>
          <div className="desk-reply-acts">
            <button type="button" className="desk-btn" disabled={sending || !meeting} onClick={() => onChoose({ kind: "meeting", event: meeting })}>After this meeting</button>
          </div>
        </>
      )}
      <label>
        When this person writes
        <input type="email" value={ask.address} disabled={sending} placeholder="name@example.org" onChange={(e) => onChange({ address: e.target.value })} />
      </label>
      <div className="desk-reply-acts">
        <button type="button" className="desk-btn" disabled={sending || !ask.address.trim()} onClick={() => onChoose({ kind: "person", address: ask.address.trim() })}>When they write</button>
      </div>
      {ask.note && <p className="desk-why desk-unsent" role="alert">{ask.note}</p>}
      <div className="desk-reply-acts">
        <button type="button" className="desk-btn" disabled={sending} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
