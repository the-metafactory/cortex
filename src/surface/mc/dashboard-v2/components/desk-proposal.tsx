import { useEffect, useState } from "react";
import { proposalTime, type AskKind, type AskMap, type DeskProposal } from "../../desk/ask";
import { clock } from "../../desk/time";

type FieldType = "text" | "long" | "time" | "map";

const FIELDS: Record<AskKind, { key: string; label: string; type: FieldType }[]> = {
  reminder: [{ key: "text", label: "What", type: "text" }, { key: "due", label: "When", type: "time" }],
  note: [{ key: "text", label: "Note", type: "long" }],
  task: [{ key: "title", label: "Task", type: "text" }, { key: "details", label: "Details", type: "long" }, { key: "map", label: "Map", type: "map" }],
  goal: [{ key: "wording", label: "Goal", type: "long" }],
  calendar: [
    { key: "title", label: "Title", type: "text" },
    { key: "start", label: "Starts", type: "time" },
    { key: "end", label: "Ends", type: "time" },
    { key: "location", label: "Where", type: "text" },
  ],
};

const pad = (n: number): string => String(n).padStart(2, "0");

export function toLocalInput(iso: unknown): string {
  if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function whenText(at: number, now: number, allDay = false): string {
  const d = new Date(at);
  const day = d.toDateString() === new Date(now).toDateString() ? "Today" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return allDay ? day : `${day}, ${clock(at)}`;
}

export function proposalTitle(p: DeskProposal): string {
  const f = p.fields;
  return String(f.text ?? f.title ?? f.wording ?? p.label);
}

interface ProposalCardProps {
  proposal: DeskProposal;
  said: string;
  maps: AskMap[];
  now: number;
  busy: boolean;
  onConfirm: (fields: Record<string, unknown>) => void;
  onCancel: () => void;
  onGoto: () => void;
  onFieldsChange: (fields: Record<string, unknown>) => void;
}

export function ProposalCard({ proposal, said, maps, now, busy, onConfirm, onCancel, onGoto, onFieldsChange }: ProposalCardProps) {
  const [fields, setFields] = useState<Record<string, unknown>>(proposal.fields);
  useEffect(() => onFieldsChange(fields), [fields]);
  const unwritable = proposal.unwritable === true;
  const [editing, setEditing] = useState(Boolean(proposal.problem) && !unwritable);
  const allDay = fields.allDay === true;
  const missing = FIELDS[proposal.kind].some((f) => f.type === "time" && f.key !== "end" && !fields[f.key]) || (proposal.kind === "task" && !fields.map);
  const set = (key: string, value: unknown): void => setFields((cur) => {
    const next = { ...cur };
    if (value === "" || value === undefined) delete next[key];
    else next[key] = value;
    return next;
  });

  const display = (key: string, type: FieldType): string => {
    const v = fields[key];
    if (type === "time") return typeof v === "string" && Number.isFinite(Date.parse(v)) ? whenText(Date.parse(v), now, allDay) : "";
    if (type === "map") return maps.find((m) => m.ref === v)?.label ?? (typeof v === "string" ? v : "");
    return typeof v === "string" ? v : "";
  };

  const input = (key: string, label: string, type: FieldType) => {
    const v = fields[key];
    if (type === "time") {
      return <input type="datetime-local" aria-label={label} value={toLocalInput(v)} onChange={(e) => set(key, e.target.value ? new Date(e.target.value).toISOString() : "")} />;
    }
    if (type === "map") {
      return (
        <select aria-label={label} value={typeof v === "string" ? v : ""} onChange={(e) => set(key, e.target.value)}>
          <option value="">Choose a map</option>
          {maps.map((m) => <option key={m.ref} value={m.ref}>{m.label}</option>)}
        </select>
      );
    }
    const text = typeof v === "string" ? v : "";
    return <textarea aria-label={label} rows={type === "long" || text.length > 70 ? 3 : 1} value={text} onChange={(e) => set(key, e.target.value)} />;
  };

  const at = proposalTime(proposal.kind, fields).at ?? NaN;
  const blocked = unwritable || missing;

  return (
    <div className="desk-row desk-propwrap">
      <span />
      <span />
      <div className="body">
        <article className="desk-prop" aria-label={`Proposed ${proposal.label.toLowerCase()}`}>
          <div className="desk-prop-head">
            <span className="desk-prop-kind">{proposal.label}</span>
            <span className="desk-prop-note">From “{said}”. Nothing happens until you confirm.</span>
          </div>
          <dl className="desk-fields">
            {FIELDS[proposal.kind].map((f) => (editing || display(f.key, f.type)) ? (
              <div key={f.key} className="desk-field">
                <dt>{f.label}</dt>
                <dd>{editing ? input(f.key, f.label, f.type) : display(f.key, f.type)}</dd>
              </div>
            ) : null)}
          </dl>
          {Number.isFinite(at) && (
            <p className="desk-lands">Lands on the timeline: <button type="button" onClick={onGoto}>{whenText(at, now, allDay)} {new Date(at).toDateString() === new Date(now).toDateString() ? "↓" : "↘"}</button></p>
          )}
          {proposal.problem && (unwritable || missing) && <p className="desk-prop-problem" role="alert">{unwritable ? `${proposal.problem} Nothing will be created.` : proposal.problem}</p>}
          <div className="desk-acts">
            <button type="button" className="desk-btn pri" disabled={blocked || busy} aria-busy={busy} onClick={() => onConfirm(fields)}>{busy ? "Creating…" : "Confirm"}</button>
            {!unwritable && <button type="button" className="desk-btn" disabled={busy} onClick={() => setEditing((e) => !e)}>{editing ? "Done editing" : "Edit"}</button>}
            <button type="button" className="desk-btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        </article>
      </div>
    </div>
  );
}
