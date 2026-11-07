import { SETTINGS_GROUPS, type SettingsGroup } from "../hooks/use-settings-location";
import { CalendarSettings } from "./desk-calendar-settings";
import { MailRuleSettings } from "./desk-mail-rules";
import { TrustedSenderSettings } from "./desk-trusted-senders";
import { GraphRepositorySettings } from "./desk-graph-repositories";
import type { TrustedView } from "../../desk/mail-trust";
import type { MailRuleView } from "../../desk/mail-rules";
import type { DeskCalendar } from "../../desk/calendars";
import { useEffect, useState, type ReactNode } from "react";
import { changeSenders, type SenderChange, type SenderListId, type SenderRow } from "../lib/desk-settings";
import { browserNotifyEnv, NOTIFY_LINE, notifyState, requestNotifications, type NotifyState } from "../lib/desk-notify";
import type { DeskMailClassifier, DeskView } from "../../desk/types";
import type { MyDayView } from "../../desk/my-day";
import { useMyDay } from "../hooks/use-my-day";
import "./desk-view.css";

interface ListState {
  rows: SenderRow[] | null;
  note: string | null;
}

const EMPTY: ListState = { rows: null, note: null };

export function DeskSettings({ view, onBack, group, onGroup }: { view: DeskView; onBack: () => void; group: SettingsGroup; onGroup: (group: SettingsGroup) => void }) {
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
      day={view.myDay}
      group={group}
      onGroup={onGroup}
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
      {...(view.mailRules ? { mailRules: view.mailRules } : {})}
      trusted={view.mailTrusted ?? []}
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
  day?: MyDayView;
  group?: SettingsGroup;
  onGroup?: (group: SettingsGroup) => void;
  vips: SenderListProps;
  unimportant: SenderListProps;
  busy: boolean;
  onBack: () => void;
  notify: NotifyState;
  onEnableNotify: () => void;
  classifier?: DeskMailClassifier | null;
  calendars?: DeskCalendar[];
  mailRules?: MailRuleView[];
  trusted?: TrustedView[];
}

export function classifierLines(c: DeskMailClassifier | null): string[] {
  if (!c) return ["The Desk sorts inbox mail by the words it shares with your meetings. Set mc.desk.mail.classifier in the stack config to let a model sort it."];
  const key = !c.keyNeeded ? "It needs no API key." : c.keyFound ? "Its API key was found." : "Its API key was not found, so the Desk sorts mail by shared words until it is.";
  const who = c.kind === "command" ? `A command sorts your inbox mail: ${c.command}.` : `A model sorts your inbox mail: ${c.model} at ${c.host}.`;
  return [who, key, ...(c.localModel ? [`Mail from local-policy sources goes to ${c.localModel}, the configured local route, without research tools.`] : []), ...(c.localProblem ? [`The local mail model failed, so that mail stays with the rules: ${c.localProblem}`] : []), ...(c.heldMail ? [`${c.heldMail} mail ${c.heldMail === 1 ? "item stays" : "items stay"} with the rules because their sources require a local model or have no cloud-approved area.`] : []), "Change it in the stack config."];
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
                  <button type="button" className="desk-btn ghost" aria-label={`Remove ${v.address}`} disabled={busy} onClick={() => { list.onRemove(v.address); }}>Remove</button>
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
            <input value={draft} onChange={(e) => { setDraft(e.target.value); }} placeholder="ada@example.org or @example.org" aria-label={text.addLabel} disabled={busy} />
            <button type="submit" className="desk-btn pri" disabled={busy || !draft.trim()}>Add</button>
          </form>
          {list.note && <p className="desk-set-err" role="alert">{list.note}</p>}
        </>
      )}
    </section>
  );
}

export function SettingsBody({ day, group = "calendars", onGroup, vips, unimportant, busy, onBack, notify, onEnableNotify, classifier = null, calendars = [], mailRules, trusted = [] }: SettingsBodyProps) {
  const panel = (id: SettingsGroup, content: ReactNode): ReactNode => (
    <div key={id} id={`settings-panel-${id}`} role="tabpanel" aria-labelledby={`settings-tab-${id}`} hidden={group !== id} tabIndex={0}>{content}</div>
  );
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

        <div className="desk-set-layout">
          <div className="desk-set-tabs" role="tablist" aria-label="Settings groups" aria-orientation="vertical">
            {SETTINGS_GROUPS.map((item, index) => (
              <button
                key={item.id}
                id={`settings-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={group === item.id}
                aria-controls={`settings-panel-${item.id}`}
                tabIndex={group === item.id ? 0 : -1}
                onClick={() => onGroup?.(item.id)}
                onKeyDown={(event) => {
                  const offset = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                  const target = event.key === "Home" ? SETTINGS_GROUPS[0] : event.key === "End" ? SETTINGS_GROUPS.at(-1) : offset ? SETTINGS_GROUPS[(index + offset + SETTINGS_GROUPS.length) % SETTINGS_GROUPS.length] : undefined;
                  if (!target) return;
                  event.preventDefault();
                  onGroup?.(target.id);
                  document.getElementById(`settings-tab-${target.id}`)?.focus();
                }}
              >{item.label}</button>
            ))}
          </div>
          <div className="desk-set-pages">
            {panel("calendars", <CalendarSettings initial={calendars} />)}
            {panel("day-limits", day ? <DayLimitSettings day={day} /> : <section className="desk-set-card" aria-label="Day limits"><h2>Day limits</h2><p role="status">Your saved day limits are unavailable. Return to the Desk to refresh and retry.</p></section>)}
            {panel("vips", <SenderCard text={VIP_TEXT} list={vips} busy={busy} />)}
            {panel("unimportant", <SenderCard text={UNIMPORTANT_TEXT} list={unimportant} busy={busy} />)}
            {panel("notifications", <section className="desk-set-card" aria-label="Notifications">
              <h2>Notifications</h2>
              <p className="desk-set-sub">{NOTIFY_LINE[notify]}</p>
              {notify === "default" && <button type="button" className="desk-btn pri" onClick={onEnableNotify}>Turn on notifications</button>}
            </section>)}
            {panel("mail-sorting", <section className="desk-set-card" aria-label="Mail sorting">
              <h2>Mail sorting</h2>
              <p className="desk-set-sub">{classifierLines(classifier).join(" ")}</p>
            </section>)}
            {panel("mail-rules", mailRules ? <MailRuleSettings initial={mailRules} /> : <section className="desk-set-card" aria-label="Mail rules">
              <h2>Mail rules</h2>
              <p className="desk-set-sub">Mail rules need the move command. Set mc.desk.mail.actions.move in the stack config.</p>
            </section>)}
            {panel("not-phishing", <TrustedSenderSettings initial={trusted} />)}
            {panel("graph-repositories", <GraphRepositorySettings active={group === "graph-repositories"} />)}
          </div>
        </div>
      </main>
    </div>
  );
}

function DayLimitSettings({ day }: { day: MyDayView }) {
  const { current, busy, change, note, retryable, retry } = useMyDay(day, () => undefined);
  return <section className="desk-set-card" aria-label="Day limits">
    <h2>Day limits</h2>
    <p className="desk-set-sub">Choose how many items appear in My day and Needs you.</p>
    <div className="desk-set-limits">
      <label>My day <input aria-label="My day cap" type="range" min="1" max="7" value={current.cap} disabled={busy || retryable} onChange={event => { void change({ op: "cap", cap: Number(event.target.value) }); }} /><output>{current.cap}</output></label>
      <label>Needs you <input aria-label="Needs you cap" type="range" min="1" max="10" value={current.topN} disabled={busy || retryable} onChange={event => { void change({ op: "topN", topN: Number(event.target.value) }); }} /><output>{current.topN}</output></label>
    </div>
    <p className="desk-set-sub">{current.capsOverridden ? "Your saved caps apply until Reset." : "Using your defaults."} Defaults: {current.configuredCaps.cap} My day / {current.configuredCaps.topN} Needs you.</p>
    {current.capsOverridden && <button type="button" className="desk-btn ghost" disabled={busy || retryable} onClick={() => { void change({ op: "reset-caps" }); }}>Reset</button>}
    {note && <p role="status">{note}</p>}
    {retryable && <button type="button" className="desk-btn" disabled={busy} onClick={() => { void retry(); }}>Retry saved change</button>}
  </section>;
}
