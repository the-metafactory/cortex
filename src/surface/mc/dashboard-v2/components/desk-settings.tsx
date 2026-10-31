import { CalendarSettings } from "./desk-calendar-settings";
import type { DeskCalendar } from "../../desk/calendars";
import { useEffect, useState } from "react";
import { changeSenders, type SenderChange, type SenderListId, type SenderRow } from "../lib/desk-settings";
import { browserNotifyEnv, NOTIFY_LINE, notifyState, requestNotifications, type NotifyState } from "../lib/desk-notify";
import type { DeskMailClassifier, DeskView } from "../../desk/types";
import "./desk-view.css";

interface ListState {
  rows: SenderRow[] | null;
  note: string | null;
}

const EMPTY: ListState = { rows: null, note: null };

export function DeskSettings({ view, onBack }: { view: DeskView; onBack: () => void }) {
  const [lists, setLists] = useState<Record<SenderListId, ListState>>({ vips: EMPTY, unimportant: EMPTY });
  const [notify, setNotify] = useState<NotifyState>(() => notifyState(view.notifications, browserNotifyEnv()));
  const [busy, setBusy] = useState(false);

  const apply = async (list: SenderListId, change: SenderChange): Promise<boolean> => {
    setBusy(true);
    const r = await changeSenders(list, change);
    setBusy(false);
    setLists((all) => ({ ...all, [list]: r.ok ? { rows: r.rows, note: null } : { ...all[list], note: r.text } }));
    return r.ok;
  };

  useEffect(() => {
    void apply("vips", { op: "list" });
    void apply("unimportant", { op: "list" });
  }, []);

  const listProps = (list: SenderListId): SenderListProps => ({
    ...lists[list],
    onAdd: (address) => apply(list, { op: "add", address }),
    onRemove: (address) => void apply(list, { op: "remove", address }),
  });

  return (
    <SettingsBody
      vips={listProps("vips")}
      unimportant={listProps("unimportant")}
      busy={busy}
      onBack={onBack}
      notify={notify}
      onEnableNotify={() => {
        void requestNotifications(view).then((state) => {
          if (state) setNotify(state);
        });
      }}
      calendars={view.calendars ?? []}
      classifier={view.mailClassifier ?? null}
    />
  );
}

export interface SenderListProps {
  rows: SenderRow[] | null;
  note: string | null;
  onAdd: (address: string) => Promise<boolean>;
  onRemove: (address: string) => void;
}

export interface SettingsBodyProps {
  vips: SenderListProps;
  unimportant: SenderListProps;
  busy: boolean;
  onBack: () => void;
  notify: NotifyState;
  onEnableNotify: () => void;
  classifier?: DeskMailClassifier | null;
  calendars?: DeskCalendar[];
}

export function classifierLines(c: DeskMailClassifier | null): string[] {
  if (!c) return ["The Desk sorts unread mail by the words it shares with your meetings. Set mc.desk.mail.classifier in the stack config to let a model sort it."];
  const key = !c.keyNeeded ? "It needs no API key." : c.keyFound ? "Its API key was found." : "Its API key was not found, so the Desk sorts mail by shared words until it is.";
  const who = c.kind === "command" ? `A command sorts your unread mail: ${c.command}.` : `A model sorts your unread mail: ${c.model} at ${c.host}.`;
  return [who, key, "Change it in the stack config."];
}

interface SenderCardText {
  title: string;
  sub: string;
  empty: string;
  addLabel: string;
}

const VIP_TEXT: SenderCardText = {
  title: "VIPs",
  sub: "Mail from these senders always shows on your Desk and ranks high. Add a full address or a whole domain such as @example.ch.",
  empty: "No VIPs yet. Add one here, or use \"Always show mail from …\" on a mail item.",
  addLabel: "Add a VIP",
};

const UNIMPORTANT_TEXT: SenderCardText = {
  title: "Unimportant senders",
  sub: "Mail from these senders counts as bulk and is sorted without asking the model. A VIP always wins. Add a full address or a whole domain such as @example.ch.",
  empty: "No unimportant senders yet. Add one here, or use \"Unimportant\" on a mail item.",
  addLabel: "Add an unimportant sender",
};

function SenderCard({ text, list, busy }: { text: SenderCardText; list: SenderListProps; busy: boolean }) {
  const [draft, setDraft] = useState("");
  return (
    <section className="desk-set-card" aria-label={text.title}>
      <h2>{text.title}</h2>
      <p className="desk-set-sub">{text.sub}</p>
      {list.rows === null ? (
        <p className="desk-set-empty">{list.note ?? "Loading…"}</p>
      ) : (
        <>
          {list.rows.length === 0 ? (
            <p className="desk-set-empty">{text.empty}</p>
          ) : (
            <ul className="desk-set-list">
              {list.rows.map((v) => (
                <li key={v.address}>
                  <span>
                    {v.label ?? v.address}
                    {v.label && <small>{v.address}</small>}
                  </span>
                  <button type="button" className="desk-btn ghost" aria-label={`Remove ${v.address}`} disabled={busy} onClick={() => list.onRemove(v.address)}>Remove</button>
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
              void list.onAdd(address).then((ok) => {
                if (ok) setDraft("");
              });
            }}
          >
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="ada@example.org or @example.org" aria-label={text.addLabel} disabled={busy} />
            <button type="submit" className="desk-btn pri" disabled={busy || !draft.trim()}>Add</button>
          </form>
          {list.note && <p className="desk-set-err" role="alert">{list.note}</p>}
        </>
      )}
    </section>
  );
}

export function SettingsBody({ vips, unimportant, busy, onBack, notify, onEnableNotify, classifier = null, calendars = [] }: SettingsBodyProps) {
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

        <CalendarSettings initial={calendars} />

        <SenderCard text={VIP_TEXT} list={vips} busy={busy} />

        <SenderCard text={UNIMPORTANT_TEXT} list={unimportant} busy={busy} />

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
