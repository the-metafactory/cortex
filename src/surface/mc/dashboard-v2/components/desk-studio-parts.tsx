import type { BoardArea } from "../../desk/studio/board";
import { MONTHS } from "../../desk/studio/labels";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const hhmm = (at: Date): string => at.toTimeString().slice(0, 5);
export const dayMonthTime = (at: Date): string => `${at.getDate()} ${MONTHS[at.getMonth()] ?? ""}, ${hhmm(at)}`;
export const weekdayDayTime = (at: Date): string => `${WEEKDAYS[at.getDay()] ?? ""} ${dayMonthTime(at)}`;

export function AreaChips({ areas }: { areas: BoardArea[] }) {
  return (
    <>
      {areas.map((a) => (
        <span key={a.id} className="dst-area"><span className="dot" style={{ background: a.color }} />{a.label}</span>
      ))}
    </>
  );
}

export function ModelBadge({ policy }: { policy: "local" | "cloud" }) {
  return policy === "local"
    ? <span className="dst-model local" title="A local area keeps this thread on the local model">Stays local</span>
    : <span className="dst-model">Cloud model</span>;
}
