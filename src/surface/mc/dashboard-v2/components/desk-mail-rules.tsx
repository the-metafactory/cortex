import { useState } from "react";
import type { MailRuleView } from "../../desk/mail-rules";
import { RULE_ACTIONS, RULE_MATCHES } from "../../desk/mail-rules-schema";
import { submitMailRule, type MailRuleBody } from "../lib/desk-action";

const MATCH_LABEL: Record<(typeof RULE_MATCHES)[number], string> = { sender: "Sender", domain: "Domain", list: "List-Id", subject: "Subject contains" };
const ACTION_LABEL: Record<(typeof RULE_ACTIONS)[number], string> = { archive: "Archive", junk: "Junk", trash: "Delete", digest: "Digest" };

const when = (at: number | null): string => (at === null ? "never ran" : `last ran ${new Date(at).toLocaleString()}`);

export function MailRuleSettings({ initial }: { initial: MailRuleView[] }) {
  const [rows, setRows] = useState(initial);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = async (body: MailRuleBody, next: (rows: MailRuleView[], rule?: MailRuleView) => MailRuleView[]): Promise<boolean> => {
    setBusy(true);
    const r = await submitMailRule(body);
    setBusy(false);
    setNote(r.text);
    if (r.ok) setRows((all) => next(all, r.rule));
    return r.ok;
  };
  const replace = (all: MailRuleView[], rule?: MailRuleView): MailRuleView[] => (rule ? all.map((x) => (x.id === rule.id ? rule : x)) : all);
  return <MailRuleSettingsBody rows={rows} note={note} busy={busy} onChange={(body) => change(body, body.op === "delete" ? (all) => all.filter((x) => x.id !== body.rule) : replace)} />;
}

export function MailRuleSettingsBody({ rows, note, busy, onChange }: { rows: MailRuleView[]; note: string | null; busy: boolean; onChange: (body: MailRuleBody & { rule: string }) => Promise<boolean> }) {
  const [editing, setEditing] = useState<{ id: string; match: string; value: string; action: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <section className="desk-set-card" aria-label="Mail rules">
      <h2>Mail rules</h2>
      <p className="desk-set-sub">Rules you approved from a Desk proposal. They handle matching mail before any model sees it, never touch a VIP's mail, and list each mail under Done for you with Undo.</p>
      {rows.length === 0 && <p className="desk-set-empty">No rules yet. The Desk proposes one when your decisions about a sender or list agree often enough.</p>}
      <ul className="desk-set-list">
        {rows.map((r) => (
          <li key={r.id}>
            {editing?.id === r.id ? (
              <form
                className="desk-set-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onChange({ op: "edit", rule: r.id, match: editing.match, value: editing.value, action: editing.action }).then((ok) => { if (ok) setEditing(null); });
                }}
              >
                <select aria-label="Match" value={editing.match} disabled={busy} onChange={(e) => setEditing({ ...editing, match: e.target.value })}>
                  {RULE_MATCHES.map((m) => <option key={m} value={m}>{MATCH_LABEL[m]}</option>)}
                </select>
                <input aria-label="Match value" value={editing.value} disabled={busy} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
                <select aria-label="Action" value={editing.action} disabled={busy} onChange={(e) => setEditing({ ...editing, action: e.target.value })}>
                  {RULE_ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
                </select>
                <button type="submit" className="desk-btn pri" disabled={busy || !editing.value.trim()}>Save</button>
                <button type="button" className="desk-btn ghost" onClick={() => setEditing(null)}>Cancel</button>
              </form>
            ) : (
              <>
                <span>
                  {r.sentence}
                  <small>{r.on ? "On" : "Off"} · handled {r.count} {r.count === 1 ? "mail" : "mails"} · {when(r.lastRunAt)}{r.held !== null ? ` · paused, ${r.held} waiting` : ""}</small>
                </span>
                <span>
                  <button type="button" className="desk-btn" disabled={busy} onClick={() => void onChange({ op: r.on ? "stop" : "start", rule: r.id })}>{r.on ? "Turn off" : "Turn on"}</button>
                  <button type="button" className="desk-btn ghost" disabled={busy} onClick={() => setEditing({ id: r.id, match: r.match, value: r.value, action: r.action })}>Edit</button>
                  <button
                    type="button"
                    className="desk-btn ghost"
                    aria-label={confirm === r.id ? `Confirm delete: ${r.sentence}` : `Delete: ${r.sentence}`}
                    disabled={busy}
                    onClick={() => {
                      if (confirm !== r.id) { setConfirm(r.id); return; }
                      setConfirm(null);
                      void onChange({ op: "delete", rule: r.id });
                    }}
                  >{confirm === r.id ? "Delete, sure?" : "Delete"}</button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      {note && <p className="desk-set-sub" role="status">{note}</p>}
    </section>
  );
}
