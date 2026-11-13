import type { InterruptReasonCode, InterruptReasonView } from "../../desk/types";
import { postJson } from "../lib/api";

export interface InterruptionSwitch {
  code: InterruptReasonCode;
  target?: string;
  on: boolean;
}

export const INTERRUPTIONS_UNAVAILABLE = "Turned off for this stack.";
const BY_FEEDBACK = "Off after you said it was not important enough.";

type Post = (path: string, body: InterruptionSwitch) => Promise<{ message?: string }>;

/** Switches one interruption reason and answers the line to show: the Desk's message, or why the switch failed. */
export async function switchInterruption(change: InterruptionSwitch, post: Post = (path, body) => postJson(path, body)): Promise<{ ok: boolean; text: string }> {
  try {
    const result = await post("/api/desk/interruptions", change);
    return { ok: true, text: result.message ?? "Done." };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : "Could not switch the interruption." };
  }
}

const rowKey = (r: InterruptReasonView): string => `${r.code}:${r.target ?? ""}`;

export function InterruptionsSection({ reasons, onSwitch }: { reasons: InterruptReasonView[]; onSwitch: (change: InterruptionSwitch) => void }) {
  if (reasons.length === 0) return null;
  return (
    <section className="desk-msec" aria-label="Interruptions">
      <h3 className="desk-mh">Interruptions</h3>
      <ul className="desk-vips desk-interruptions">
        {reasons.map((r) => (
          <li key={rowKey(r)}>
            <label>
              <input
                type="checkbox"
                aria-label={`${r.label} interrupts you`}
                checked={r.on}
                disabled={!r.available}
                onChange={(e) => { onSwitch({ code: r.code, ...(r.target ? { target: r.target } : {}), on: e.target.checked }); }}
              />
              <span>{r.label}</span>
            </label>
            {!r.available && <small>{INTERRUPTIONS_UNAVAILABLE}</small>}
            {r.available && r.setBy === "feedback" && !r.on && <small>{BY_FEEDBACK}</small>}
          </li>
        ))}
      </ul>
    </section>
  );
}
