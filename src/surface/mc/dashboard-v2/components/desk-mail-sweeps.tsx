import { useState } from "react";
import type { MailSweepView } from "../../desk/mail-sweep";
import { SWEEP_WORDS } from "../../desk/mail-sweep-schema";
import type { MoveTarget } from "../../desk/mail-move";
import "./desk-mail-sweeps.css";

const capital = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const SHOWN = 3;
const SWEEP_NAMES: Record<MailSweepView["kind"], string> = { bundle: "Bundle", sweep: "Sweep", digest: "Digest" };

export const previewLabel = (s: MailSweepView, count = s.mails.length, target: MoveTarget = s.target): string => `Preview and ${SWEEP_WORDS[target].verb} ${count}`;

const OTHER_LABEL: Record<MoveTarget, string> = { archive: "Archive", junk: "Spam", trash: "Delete" };
const MOVES = Object.keys(OTHER_LABEL) as MoveTarget[];

export function OtherMoves({ group, busy = false, onPreview }: { group: MailSweepView; busy?: boolean; onPreview: (target: MoveTarget) => void }) {
  return MOVES.filter((t) => t !== group.target).map((t) => (
    <button key={t} type="button" className="desk-btn" disabled={busy} aria-label={previewLabel(group, group.mails.length, t)} onClick={() => onPreview(t)}>{OTHER_LABEL[t]}</button>
  ));
}

export function MailSweeps({ sweeps, onPreview }: { sweeps: readonly MailSweepView[]; onPreview: (s: MailSweepView, target: MoveTarget) => void }) {
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
            <button type="button" className="desk-btn pri" onClick={() => onPreview(s, s.target)}>{previewLabel(s)}</button>
            <OtherMoves group={s} onPreview={(t) => onPreview(s, t)} />
          </div>
        </article>
      ))}
    </div>
  );
}

export function SweepPreview({ sweep, target = sweep.target, busy, onConfirm, onCancel }: { sweep: MailSweepView; target?: MoveTarget; busy: boolean; onConfirm: (keys: string[]) => void; onCancel: () => void }) {
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const keys = sweep.mails.map((m) => m.key).filter((k) => !kept.has(k));
  const toggle = (key: string): void => setKept((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const words = SWEEP_WORDS[target];
  const corrected = target === sweep.target ? "" : ` The Desk suggested to ${SWEEP_WORDS[sweep.target].verb} them; where it predicted that, your choice is logged as a correction it learns from.`;
  const verb = capital(words.verb);
  return (
    <div className="desk-sweep-preview">
      <div className="desk-panel-top">
        <span className="area">{SWEEP_NAMES[sweep.kind]} · {sweep.label}</span>
        <button type="button" className="desk-close" aria-label="Close" onClick={onCancel}>×</button>
      </div>
      <h3>{verb} {keys.length} {keys.length === 1 ? "mail" : "mails"}</h3>
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
      <p className="desk-why">Each one is logged as {words.logged} decision.{corrected} Done for you gets one line with Undo for all of them.</p>
      <div className="desk-panel-acts">
        <button type="button" className="desk-btn pri" disabled={busy || keys.length === 0} onClick={() => onConfirm(keys)}>{busy ? "Moving…" : `${verb} ${keys.length}`}</button>
        <button type="button" className="desk-btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
