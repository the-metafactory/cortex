import { useState } from "react";
import type { DmarcWeek } from "../../desk/mail-dmarc";
import type { MailLogAction, MailLogWhere } from "../../desk/mail-log-schema";
import type { MailMirror, MailMirrorRule, MailMirrorUnread } from "../../desk/mail-mirror";
import { submitMailAction, submitMailRule, type MailRuleBody, type Outcome } from "../lib/desk-action";
import { RuleEditForm, type RuleDraft } from "./desk-mail-rules";

const ACTION_WORD: Record<MailLogAction, string> = {
  archive: "Archived", junk: "Moved to Junk", trash: "Deleted", restore: "Undone", unimportant: "Marked unimportant", draft: "Reply drafted",
  plan: "Planned", todo: "Made a todo", snooze: "Snoozed", opened: "Opened", ignored: "Ignored", kept: "Read and kept", gone: "Gone from the inbox",
  digest: "Kept for the digest", unsubscribe: "Unsubscribed",
  "expect-answer": "Expecting an answer", "no-answer": "Needs no answer", "waiting-done": "Stopped waiting", studio: "Added to the Studio", ivy: "Handed to Ivy", accept: "Invitation accepted", decline: "Invitation declined", "not-phishing": "Not phishing",
};
const WHERE_WORD: Record<MailLogWhere, string> = { desk: "On the Desk", client: "In your mail client", rule: "By your rules", correction: "Corrections you gave", conversation: "In an Ivy conversation" };

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const sourceLabel = (s: { kind: "list" | "sender"; value: string }): string => (s.kind === "list" ? `List ${s.value}` : s.value);
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;

export function timeLine(time: MailMirror["time"]): string {
  if (!time) return "Time on mail is not measured: no mail was opened on the Desk this week.";
  const cap = `${Math.round(time.capMs / 60_000)} min`;
  const untimed = time.untimed > 0 ? ` ${plural(time.untimed, "mail")} opened on the Desk had no decision there and ${time.untimed === 1 ? "is" : "are"} not timed.` : "";
  if (time.mails === 0) return `Time on mail is not measured yet: no mail opened on the Desk was decided there this week.${untimed}`;
  const capped = time.capped > 0 ? ` ${plural(time.capped, "mail")} took longer and ${time.capped === 1 ? "counts" : "count"} as ${cap}.` : "";
  return `Open to decision on the Desk: ${minutes(time.totalMs)} over ${plural(time.mails, "mail")}, median ${minutes(time.medianMs)}. Each mail counts from its first open on the Desk to your next decision there, at most ${cap}.${capped}${untimed} Mail read only in your mail program is not timed.`;
}

function Counts<K extends string>({ label, rows, words }: { label: string; rows: { key: K; count: number }[]; words: Record<K, string> }) {
  return <div><h3>{label}</h3><ul className="dmr-hours">{rows.map(r => <li key={r.key}><strong>{words[r.key]}</strong><span>{r.count}</span></li>)}</ul></div>;
}

export function MirrorMail({ mail, dmarc, onChanged }: { mail: MailMirror | null; dmarc: DmarcWeek | null; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const [sure, setSure] = useState<string | null>(null);
  const run = async (send: () => Promise<Outcome>): Promise<boolean> => {
    setBusy(true);
    const r = await send();
    setBusy(false);
    setNote(r.text);
    if (r.ok) onChanged?.();
    return r.ok;
  };
  const rule = (body: MailRuleBody): Promise<boolean> => run(() => submitMailRule(body));
  const shown = mail !== null && (mail.decisions > 0 || mail.rules.length > 0);
  if (!shown && !dmarc) return null;
  return (
    <section className="dmr-card" aria-labelledby="dmr-mail">
      <h2 id="dmr-mail">Mail this week</h2>
      {mail && shown && <>
        <p>{plural(mail.decisions, "decision")} on {plural(mail.mails, "mail")}, from the Desk's mail log.{mail.partial ? " The log holds more than the mirror reads; these counts are a lower bound." : ""}</p>
        <p className="dmr-quiet">{timeLine(mail.time)}</p>
        {mail.decisions > 0 && <div className="dmr-columns">
          <Counts label="By action" rows={mail.byAction} words={ACTION_WORD} />
          <Counts label="By where" rows={mail.byWhere} words={WHERE_WORD} />
        </div>}
        {mail.senders.length > 0 && <><h3>Took the most of your decisions</h3><ul className="dmr-hours">{mail.senders.map(s => <li key={`${s.kind}:${s.value}`}><strong>{sourceLabel(s)}</strong><span>{plural(s.decisions, "decision")}</span></li>)}</ul></>}
        {mail.rules.length > 0 && <><h3>What your rules did</h3><ul className="dmr-hours">{mail.rules.map(r => <li key={r.id}><strong>{r.sentence}{r.on ? "" : " (off)"}</strong><span>{plural(r.runs, "run")}, {plural(r.undone, "Undo", "Undos")}{r.failed ? `, ${r.failed} failed` : ""}</span></li>)}</ul></>}
        {mail.checkRules.length > 0 && <><h3>Check this rule</h3><p className="dmr-quiet">Undone more than {plural(mail.config.checkAfterUndos, "time")} this week.</p><ul>{mail.checkRules.map(r => <CheckRule key={r.id} rule={r} busy={busy} editing={editing?.id === r.id ? editing : null} onEdit={setEditing} onRule={rule} />)}</ul></>}
        {mail.archivedUnread.length > 0 && <><h3>Archived unread, again and again</h3><p className="dmr-quiet">Senders and lists whose mail you archived or deleted unread at least {plural(mail.config.archivedUnread, "time")} this week.</p><ul>{mail.archivedUnread.map(u => <Unread key={`${u.kind}:${u.value}`} item={u} busy={busy} sure={sure === u.unsubscribe?.key} onSure={setSure} onRule={rule} onUnsubscribe={(key) => run(() => submitMailAction({ action: "unsubscribe", key }))} />)}</ul></>}
      </>}
      {dmarc && <>
        <h3>Mail sent as your domains</h3>
        <p>{dmarc.line}</p>
        {dmarc.domains.length > 0 && <ul className="dmr-hours">{dmarc.domains.map(d => <li key={d.domain}><strong>{d.domain}</strong><span>{d.owned ? `${d.messages} messages, ${d.failures} failing` : `${d.reports} reports, not your domain`}</span></li>)}</ul>}
        {dmarc.refused.map((r, index) => <p className="dmr-quiet" key={`${r.subject}:${index}`}>Not read: {r.subject}. {r.reason}</p>)}
      </>}
      {note && <p role="status">{note}</p>}
    </section>
  );
}

function CheckRule({ rule, busy, editing, onEdit, onRule }: { rule: MailMirrorRule; busy: boolean; editing: RuleDraft | null; onEdit: (d: RuleDraft | null) => void; onRule: (body: MailRuleBody) => Promise<boolean> }) {
  if (editing) return <li><RuleEditForm editing={editing} busy={busy} onEdit={onEdit} onSubmit={onRule} /></li>;
  return (
    <li>
      <strong>{rule.sentence}</strong><span>{plural(rule.undone, "Undo", "Undos")} against {plural(rule.runs, "run")} this week.</span>
      {rule.on && <button type="button" className="desk-btn" disabled={busy} onClick={() => void onRule({ op: "stop", rule: rule.id })}>Disable</button>}
      <button type="button" className="desk-btn ghost" disabled={busy} onClick={() => onEdit({ id: rule.id, match: rule.match, value: rule.value, action: rule.action })}>Edit</button>
    </li>
  );
}

function Unread({ item, busy, sure, onSure, onRule, onUnsubscribe }: { item: MailMirrorUnread; busy: boolean; sure: boolean; onSure: (key: string | null) => void; onRule: (body: MailRuleBody) => Promise<boolean>; onUnsubscribe: (key: string) => Promise<boolean> }) {
  const offer = item.unsubscribe;
  return (
    <li>
      <strong>{sourceLabel(item)}</strong><span>{plural(item.count, "mail")} archived or deleted unread.</span>
      {offer?.view.kind === "one-click" && <button type="button" className="desk-btn" disabled={busy} onClick={() => { if (!sure) { onSure(offer.key); return; } onSure(null); void onUnsubscribe(offer.key); }}>{sure ? `Yes, unsubscribe via ${offer.view.host}` : "Unsubscribe"}</button>}
      {offer?.view.kind === "page" && offer.view.url && <a className="desk-btn" href={offer.view.url} target="_blank" rel="noreferrer noopener">Open unsubscribe page ({offer.view.host})</a>}
      <button type="button" className="desk-btn ghost" disabled={busy} title={item.rule.sentence} onClick={() => void onRule({ op: "create", match: item.rule.match, value: item.rule.value, action: item.rule.action })}>Make a rule: {item.rule.sentence}</button>
    </li>
  );
}
