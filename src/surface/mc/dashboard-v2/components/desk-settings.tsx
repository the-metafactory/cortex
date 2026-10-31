import { useEffect, useState } from "react";
import { changeVips, type DeskVipRow, type VipChange } from "../lib/desk-settings";
import { browserNotifyEnv, NOTIFY_LINE, notifyState, requestNotifications, type NotifyState } from "../lib/desk-notify";
import type { DeskMailClassifier, DeskView } from "../../desk/types";
import "./desk-view.css";

export function DeskSettings({ view, onBack }: { view: DeskView; onBack: () => void }) {
  const [vips, setVips] = useState<DeskVipRow[] | null>(null);
  const [notify, setNotify] = useState<NotifyState>(() => notifyState(view.notifications, browserNotifyEnv()));
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = async (change: VipChange): Promise<boolean> => {
    setBusy(true);
    const r = await changeVips(change);
    setBusy(false);
    if (!r.ok) {
      setNote(r.text);
      return false;
    }
    setVips(r.vips);
    setNote(null);
    return true;
  };

  useEffect(() => {
    void apply({ op: "list" });
  }, []);

  return (
    <SettingsBody
      vips={vips}
      note={note}
      busy={busy}
      onBack={onBack}
      notify={notify}
      onEnableNotify={() => {
        void requestNotifications(view).then((state) => {
          if (state) setNotify(state);
        });
      }}
      onAdd={(address) => apply({ op: "add", address })}
      onRemove={(address) => void apply({ op: "remove", address })}
      classifier={view.mailClassifier ?? null}
    />
  );
}

export interface SettingsBodyProps {
  vips: DeskVipRow[] | null;
  note: string | null;
  busy: boolean;
  onBack: () => void;
  notify: NotifyState;
  onEnableNotify: () => void;
  onAdd: (address: string) => Promise<boolean>;
  onRemove: (address: string) => void;
  classifier?: DeskMailClassifier | null;
}

export function classifierLines(c: DeskMailClassifier | null): string[] {
  if (!c) return ["The Desk sorts unread mail by the words it shares with your meetings. Set mc.desk.mail.classifier in the stack config to let a model sort it."];
  const key = !c.keyNeeded ? "It needs no API key." : c.keyFound ? "Its API key was found." : "Its API key was not found, so the Desk sorts mail by shared words until it is.";
  return [`A model sorts your unread mail: ${c.model} at ${c.host}.`, key, "Change it in the stack config."];
}

export function SettingsBody({ vips, note, busy, onBack, notify, onEnableNotify, onAdd, onRemove, classifier = null }: SettingsBodyProps) {
  const [draft, setDraft] = useState("");
  return (
    <div className="desk desk-settings">
      <div className="desk-top">
        <div className="desk-top-in">
          <div className="desk-left">
            <div className="desk-brand"><span className="desk-mark" />Desk</div>
          </div>
          <div className="desk-topr">
            <button type="button" className="desk-btn" onClick={onBack}>Back to the Desk</button>
          </div>
        </div>
      </div>

      <main className="desk-set-main">
        <h1 className="desk-set-h">Settings</h1>

        <section className="desk-set-card" aria-label="VIPs">
          <h2>VIPs</h2>
          <p className="desk-set-sub">Mail from these senders always shows on your Desk and ranks high. Add a full address or a whole domain such as @example.ch.</p>
          {vips === null ? (
            <p className="desk-set-empty">{note ?? "Loading…"}</p>
          ) : (
            <>
              {vips.length === 0 ? (
                <p className="desk-set-empty">No VIPs yet. Add one here, or use "Always show mail from …" on a mail item.</p>
              ) : (
                <ul className="desk-set-list">
                  {vips.map((v) => (
                    <li key={v.address}>
                      <span>
                        {v.label ?? v.address}
                        {v.label && <small>{v.address}</small>}
                      </span>
                      <button type="button" className="desk-btn ghost" aria-label={`Remove ${v.address}`} disabled={busy} onClick={() => onRemove(v.address)}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="desk-set-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  const address = draft.trim();
                  if (!address) return;
                  void onAdd(address).then((ok) => {
                    if (ok) setDraft("");
                  });
                }}
              >
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="ada@example.org or @example.org" aria-label="Add a VIP" disabled={busy} />
                <button type="submit" className="desk-btn pri" disabled={busy || !draft.trim()}>Add</button>
              </form>
              {note && <p className="desk-set-err" role="alert">{note}</p>}
            </>
          )}
        </section>

        <section className="desk-set-card" aria-label="Notifications">
          <h2>Notifications</h2>
          <p className="desk-set-sub">{NOTIFY_LINE[notify]}</p>
          {notify === "default" && <button type="button" className="desk-btn pri" onClick={onEnableNotify}>Turn on notifications</button>}
        </section>

        <section className="desk-set-card" aria-label="Mail sorting">
          <h2>Mail sorting</h2>
          <p className="desk-set-sub">{classifierLines(classifier).join(" ")}</p>
        </section>
      </main>
    </div>
  );
}
