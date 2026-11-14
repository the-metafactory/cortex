import type { InterruptReasonCode, InterruptReasonView } from "../../desk/types";
import { submitInterruptSwitch, type Outcome } from "../lib/desk-action";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const MAIL_OFF = "Mail interruptions are turned off for this stack (mc.desk.interruptions.mail).";
const MEETING_OFF = "Meeting interruptions are turned off for this stack (mc.desk.interruptions.meetingMinutes is 0).";
const FROM_FEEDBACK = "Switched off by your feedback.";

const offLine = (code: InterruptReasonCode): string => (code === "meeting.soon" ? MEETING_OFF : MAIL_OFF);

export const reasonLine = (reason: InterruptReasonView): string | null => {
  if (!reason.available) return offLine(reason.code);
  return reason.setBy === "feedback" ? FROM_FEEDBACK : null;
};

export const switchLabel = (reason: InterruptReasonView): string => `${reason.label}: ${reason.on ? "on" : "off"}`;

export interface SwitchDeps {
  fetchImpl?: FetchLike;
  onMessage: (text: string) => void;
  onChanged: () => void;
}

export interface SwitchResult extends Outcome {
  reason: InterruptReasonView;
  on: boolean;
}

/** Posts one switch and says the server's line; the view is refreshed only when the write took, so a failed one leaves the switch where it was. */
export async function switchInterruption(reason: InterruptReasonView, on: boolean, { fetchImpl = fetch, onMessage, onChanged }: SwitchDeps): Promise<SwitchResult> {
  const result = await submitInterruptSwitch({ code: reason.code, ...(reason.target ? { target: reason.target } : {}), on }, fetchImpl);
  onMessage(result.text);
  if (result.ok) onChanged();
  return { ...result, reason, on };
}

export function InterruptionsSection({ reasons, onMessage, onChanged, fetchImpl }: { reasons: InterruptReasonView[]; onMessage: (text: string) => void; onChanged: () => void; fetchImpl?: FetchLike }) {
  if (reasons.length === 0) return null;
  return (
    <section className="desk-msec" aria-label="Interruptions">
      <h3 className="desk-mh">Interruptions</h3>
      <ul className="desk-vips desk-interrupts">
        {reasons.map((reason) => {
          const line = reasonLine(reason);
          return (
            <li key={`${reason.code}:${reason.target ?? ""}`} data-interrupt={`${reason.code}:${reason.target ?? ""}`}>
              <span>
                {reason.label}
                {line && <small>{line}</small>}
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={reason.on}
                  disabled={!reason.available}
                  aria-label={switchLabel(reason)}
                  onChange={(event) => { void switchInterruption(reason, event.target.checked, { ...(fetchImpl ? { fetchImpl } : {}), onMessage, onChanged }); }}
                />
                <span>{reason.on ? "on" : "off"}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
