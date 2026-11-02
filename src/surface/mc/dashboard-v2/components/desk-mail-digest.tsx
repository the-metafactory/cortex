import { useState } from "react";
import type { MailDigestView } from "../../desk/mail-digest";
import type { SweepMailView } from "../../desk/mail-sweep";
import "./desk-mail-sweeps.css";
import { DeskLink } from "./desk-link";
import "./desk-mail-digest.css";

export const digestsInArea = (digests: readonly MailDigestView[], area: string): MailDigestView[] =>
  digests.filter((d) => !area || d.area === null || d.area === area);

const headline = (d: MailDigestView): string => d.title.replace(/: [^:]*\?$/, "");

export type UnsubscribeAsk = "unsubscribe" | "unsubscribe.rule";

function UnsubscribeButton({ mail, busy, onUnsubscribe }: { mail: SweepMailView; busy: boolean; onUnsubscribe: (key: string, ask: UnsubscribeAsk) => void }) {
  const [sure, setSure] = useState(false);
  const offer = mail.unsubscribe;
  if (!offer) return null;
  if (offer.kind === "page" && offer.url) return <a className="desk-btn ghost" href={offer.url} title={offer.url} target="_blank" rel="noopener noreferrer">Unsubscribe page: {offer.host}</a>;
  if (offer.kind === "rule") return <button type="button" className="desk-btn ghost" disabled={busy} onClick={() => onUnsubscribe(mail.key, "unsubscribe.rule")}>Archive what still arrives</button>;
  return (
    <button type="button" className="desk-btn ghost" disabled={busy} onClick={() => { if (sure) { setSure(false); onUnsubscribe(mail.key, "unsubscribe"); } else setSure(true); }}>
      {sure ? `Yes, unsubscribe via ${offer.host}` : "Unsubscribe"}
    </button>
  );
}

export function MailDigests({ digests, busy, onArchive, onKeep, onUnsubscribe, onOpen }: { digests: readonly MailDigestView[]; busy: boolean; onArchive: (d: MailDigestView) => void; onKeep: (key: string) => void; onUnsubscribe?: (key: string, ask: UnsubscribeAsk) => void; onOpen?: (key: string) => void }) {
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
                      {m.url && <DeskLink className="desk-btn ghost" url={m.url} {...(onOpen ? { onClick: () => onOpen(m.key) } : {})}>Open</DeskLink>}
                      <button type="button" className="desk-btn ghost" disabled={busy} onClick={() => onKeep(m.key)}>Keep</button>
                      {onUnsubscribe && <UnsubscribeButton mail={m} busy={busy} onUnsubscribe={onUnsubscribe} />}
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
