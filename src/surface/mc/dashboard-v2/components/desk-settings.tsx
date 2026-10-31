import { useEffect, useState } from "react";
import { changeVips, type DeskVipRow, type VipChange } from "../lib/desk-settings";
import "./desk-view.css";

export function DeskSettings({ onBack }: { onBack: () => void }) {
  const [vips, setVips] = useState<DeskVipRow[] | null>(null);
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
      onAdd={(address) => apply({ op: "add", address })}
      onRemove={(address) => void apply({ op: "remove", address })}
    />
  );
}

export interface SettingsBodyProps {
  vips: DeskVipRow[] | null;
  note: string | null;
  busy: boolean;
  onBack: () => void;
  onAdd: (address: string) => Promise<boolean>;
  onRemove: (address: string) => void;
}

export function SettingsBody({ vips, note, busy, onBack, onAdd, onRemove }: SettingsBodyProps) {
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
      </main>
    </div>
  );
}
