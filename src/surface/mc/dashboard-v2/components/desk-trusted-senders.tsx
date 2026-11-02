import { useState } from "react";
import type { TrustedView } from "../../desk/mail-trust";
import { submitMailAction } from "../lib/desk-action";

const when = (at: number): string => new Date(at).toLocaleDateString();

export function TrustedSenderSettings({ initial }: { initial: TrustedView[] }) {
  const [rows, setRows] = useState(initial);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async (sender: string): Promise<void> => {
    setBusy(true);
    const r = await submitMailAction({ action: "not-phishing.remove", sender });
    setBusy(false);
    setNote(r.text);
    if (r.ok) setRows((all) => all.filter((x) => x.sender !== sender));
  };
  return <TrustedSenderBody rows={rows} note={note} busy={busy} onRemove={(sender) => void remove(sender)} />;
}

export function TrustedSenderBody({ rows, note, busy, onRemove }: { rows: TrustedView[]; note: string | null; busy: boolean; onRemove: (sender: string) => void }) {
  return (
    <section className="desk-set-card" aria-label="Not phishing">
      <h2>Not phishing</h2>
      <p className="desk-set-sub">Senders you marked as not phishing. A Reply-To, sender-name or link finding is waived for that exact address; a failed authentication check or the classifier's verdict only for the one mail. Mail from the address that fails its checks is still flagged. Take a sender off this list to check its mail in full again.</p>
      {rows.length === 0 ? <p className="desk-set-empty">No senders yet. Use "Not phishing" on a mail the Desk flagged.</p> : (
        <ul className="desk-set-list">
          {rows.map((r) => (
            <li key={r.sender}>
              <span>
                {r.sender}
                <small>{r.sentence} Since {when(r.at)}.</small>
              </span>
              <button type="button" className="desk-btn ghost" aria-label={`Remove ${r.sender}`} disabled={busy} onClick={() => { onRemove(r.sender); }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="desk-set-sub" role="status">{note}</p>}
    </section>
  );
}
