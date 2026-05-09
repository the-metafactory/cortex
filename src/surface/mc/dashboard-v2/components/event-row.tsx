/**
 * Event row — single entry in the D/A/H colour-classified event log.
 *
 * Used by the F-7 drill-log (MIG-3) and any future audit views. MIG-1
 * ships only the rendering primitive; per-event-type expansion (text /
 * thinking / tool_use / tool_result / permission.request / state.transition)
 * is the drill-log's concern in MIG-3 per the migration addendum's
 * Decision 11.
 *
 * CSS lives in styles/global.css under .ev / .ev-t / .ev-gut / .ev-body /
 * .ev-kind / .ev-text.
 */

import type { ReactNode } from "react";

export type EventColor = "d" | "a" | "h" | "none";
export type EventWeight = "primary" | "secondary" | "tertiary";

export interface EventRowProps {
  /** Short timestamp string (e.g. "10:23:14"). */
  time: string;
  color: EventColor;
  weight: EventWeight;
  /** Event-type label, rendered as a monospace mini-heading. */
  kind: string;
  /** Optional body content. Strings and nodes both render inside `.ev-text`. */
  body?: ReactNode;
}

export function EventRow({ time, color, weight, kind, body }: EventRowProps) {
  const className = `ev ${weight}`;
  return (
    <div className={className}>
      <div className="ev-t tnum">{time}</div>
      <div className="ev-gut">
        <span className={`dot${color !== "none" ? ` ${color}` : ""}`}></span>
      </div>
      <div className="ev-body">
        <div className="ev-kind">{kind}</div>
        {body !== undefined && body !== null && body !== "" && (
          <div className="ev-text">{body}</div>
        )}
      </div>
    </div>
  );
}
