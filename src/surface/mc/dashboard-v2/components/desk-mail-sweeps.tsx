import { useState } from "react";
import type { MailSweepView } from "../../desk/mail-sweep";
import type { MoveTarget } from "../../desk/mail-move";
import { ALL_AREAS } from "../../desk/present";
import "./desk-mail-sweeps.css";

const VERB: Record<MoveTarget, string> = { archive: "Archive", junk: "Move to Spam", trash: "Delete" };
const LOGGED: Record<MoveTarget, string> = { archive: "an archive", junk: "a spam", trash: "a delete" };
const SHOWN = 3;

export const sweepsInArea = (sweeps: readonly MailSweepView[], area: string): MailSweepView[] =>
  area === ALL_AREAS ? [...sweeps] : sweeps.filter((s) => s.area === null || s.area === area);

export const previewLabel = (s: MailSweepView, count = s.mails.length): string => `Preview and ${VERB[s.target].toLowerCase()} ${count}`;

export function MailSweeps({ sweeps, onPreview }: { sweeps: readonly MailSweepView[]; onPreview: (s: MailSweepView) => void }) {
  if (sweeps.length === 0) return null;
  return (
    <div className="desk-sweeps" aria-label="Bundles and sweeps">
      {sweeps.map((s) => (
        <article key={s.id} className="desk-sweep" data-sweep={s.id}>
          <div className="desk-sweep-head">
            <span>{s.kind === "bundle" ? `${s.mails.length} like these` : "Sweep"}</span>
            <span className="desk-sweep-tag">{s.label}</span>
          </div>
          <h3>{s.title}</h3>
          <p className={s.kind === "bundle" ? "desk-sweep-learned" : "desk-why"}>{s.kind === "bundle" && <b>Learned </b>}{s.why}</p>
          {s.kind === "bundle" && (
            <ul className="desk-sweep-list">
              {s.mails.slice(0, SHOWN).map((m) => <li key={m.key}>{m.from}: {m.subject}</li>)}
              {s.mails.length > SHOWN && <li className="more">and {s.mails.length - SHOWN} more</li>}
            </ul>
          )}
          <div className="desk-acts">
            <button type="button" className="desk-btn pri" onClick={() => onPreview(s)}>{previewLabel(s)}</button>
          </div>
        </article>
      ))}
    </div>
  );
}

export function SweepPreview({ sweep, busy, onConfirm, onCancel }: { sweep: MailSweepView; busy: boolean; onConfirm: (keys: string[]) => void; onCancel: () => void }) {
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const keys = sweep.mails.map((m) => m.key).filter((k) => !kept.has(k));
  const toggle = (key: string): void => setKept((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  return (
    <div className="desk-sweep-preview">
      <div className="desk-panel-top">
        <span className="area">{sweep.kind === "bundle" ? "Bundle" : "Sweep"} · {sweep.label}</span>
        <button type="button" className="desk-close" aria-label="Close" onClick={onCancel}>×</button>
      </div>
      <h3>{VERB[sweep.target]} {keys.length} {keys.length === 1 ? "mail" : "mails"}</h3>
      <p className="desk-why">Untick a mail to keep it in your inbox.</p>
      <ul className="desk-sweep-check">
        {sweep.mails.map((m) => (
          <li key={m.key}>
            <label>
              <input type="checkbox" checked={!kept.has(m.key)} onChange={() => toggle(m.key)} disabled={busy} />
              <span><b>{m.subject}</b><small>{m.from}</small></span>
            </label>
          </li>
        ))}
      </ul>
      <p className="desk-why">Each one is logged as {LOGGED[sweep.target]} decision. Done for you gets one line with Undo for all of them.</p>
      <div className="desk-panel-acts">
        <button type="button" className="desk-btn pri" disabled={busy || keys.length === 0} onClick={() => onConfirm(keys)}>{busy ? "Moving…" : `${VERB[sweep.target]} ${keys.length}`}</button>
        <button type="button" className="desk-btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
