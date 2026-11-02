import type { MailDigestView } from "../../desk/mail-digest";
import "./desk-mail-sweeps.css";
import "./desk-mail-digest.css";

export const digestsInArea = (digests: readonly MailDigestView[], area: string): MailDigestView[] =>
  digests.filter((d) => !area || d.area === null || d.area === area);

const headline = (d: MailDigestView): string => d.title.replace(/: [^:]*\?$/, "");

export function MailDigests({ digests, busy, onArchive, onKeep }: { digests: readonly MailDigestView[]; busy: boolean; onArchive: (d: MailDigestView) => void; onKeep: (key: string) => void }) {
  if (digests.length === 0) return null;
  return (
    <div className="desk-digests" aria-label="Newsletter digests">
      {digests.map((d) => {
        const flagged = new Map(d.flags.map((f) => [f.key, f.line]));
        const mails = [...d.mails].sort((a, b) => Number(flagged.has(b.key)) - Number(flagged.has(a.key)));
        return (
          <article key={d.id} className="desk-digest" data-digest={d.id}>
            <div className="desk-sweep-head">
              <span>Newsletter digest</span>
              {d.flags.length > 0 && <span className="desk-sweep-tag">{d.why}</span>}
            </div>
            <h3>{headline(d)}</h3>
            <ul className="desk-digest-list">
              {mails.map((m) => {
                const line = flagged.get(m.key);
                return (
                  <li key={m.key} className={line ? "flag" : undefined}>
                    {line && <span className="desk-digest-chip">worth reading</span>}
                    <span className="desk-digest-line">
                      <span>{m.from}: {m.subject}</span>
                      {line && <small>{line}</small>}
                    </span>
                    <span className="desk-digest-acts">
                      {m.url && <a className="desk-btn ghost" href={m.url} target="_blank" rel="noopener noreferrer">Open</a>}
                      <button type="button" className="desk-btn ghost" disabled={busy} onClick={() => onKeep(m.key)}>Keep</button>
                    </span>
                  </li>
                );
              })}
            </ul>
            {d.flags.length === 0 && <p className="desk-why">{d.why}</p>}
            <div className="desk-acts">
              <button type="button" className="desk-btn pri" disabled={busy} onClick={() => onArchive(d)}>Archive all {d.mails.length}</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
