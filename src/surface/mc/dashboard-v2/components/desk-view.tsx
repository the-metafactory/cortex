/**
 * The Desk (cortex#2770): Mission Control's landing page for the stack's principal.
 *
 * Layout from the chosen prototype "The Day, clean": a briefing, today's timeline with a Now
 * line, the ranked items that need the principal pinned at Now, and a margin with agents,
 * the folded rest, goals and systems. Raw identifiers appear only in the detail panel.
 */

import { useEffect, useMemo, useState } from "react";
import { getJson, postJson } from "../lib/api";
import { submitDeskAction } from "../lib/desk-action";
import { DESK_STEP_UP_WINDOW_MS } from "../../desk/step-up-window";
import "./desk-view.css";
import { useDesk } from "../hooks/use-desk";
import { ALL_AREAS, briefing, canSee, clock, openGroup, selectItems, URGENCY_LABEL } from "../../desk/present";
import type { DeskAction, DeskArea, DeskEvent, DeskFoldedGroup, DeskItem, DeskItemKind, DeskView as DeskViewModel } from "../../desk/types";

interface DeskViewProps {
  onOpenMissionControl: () => void;
}

export function DeskView({ onOpenMissionControl }: DeskViewProps) {
  const { view, enabled, error, reload } = useDesk(true);
  if (!enabled) {
    return (
      <div className="desk desk-off">
        <p>The Desk is turned off for this stack (<code>mc.desk.enabled: false</code>).</p>
        <button type="button" className="desk-btn" onClick={onOpenMissionControl}>Open Mission Control</button>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="desk desk-loading">
        <p>{error ?? "Loading your Desk…"}</p>
        <button type="button" className="desk-btn" onClick={onOpenMissionControl}>Open Mission Control</button>
      </div>
    );
  }
  return <DeskBody view={view} error={error} onOpenMissionControl={onOpenMissionControl} onChanged={reload} />;
}

export function DeskBody({ view, error, onOpenMissionControl, onChanged = () => {} }: { view: DeskViewModel; error: string | null; onChanged?: () => void } & DeskViewProps) {
  const [area, setArea] = useState(ALL_AREAS);
  const [snoozed, setSnoozed] = useState<Set<string>>(() => new Set());
  const [detail, setDetail] = useState<DeskItem | null>(null);
  const [openRest, setOpenRest] = useState(false);
  const [groupKind, setGroupKind] = useState<DeskItemKind | null>(null);
  const [openAgents, setOpenAgents] = useState(false);
  const [openStopped, setOpenStopped] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<{ item: DeskItem; action: DeskAction } | null>(null);
  const [unlockedUntil, setUnlockedUntil] = useState(0);

  const selection = useMemo(() => selectItems(view, area, snoozed), [view, area, snoozed]);
  const group = groupKind ? openGroup(selection, groupKind) : null;
  const areaLabel = area === ALL_AREAS ? null : view.areas.find((a) => a.id === area)?.label ?? null;
  const brief = briefing(view, selection, areaLabel);
  const areaById = new Map(view.areas.map((a) => [a.id, a]));
  const inArea = (e: DeskEvent): boolean => area === ALL_AREAS || e.area === area;
  const allDay = view.today.filter((e) => e.kind === "all-day" && inArea(e));
  const timed = view.today.filter((e) => e.kind !== "all-day");
  const pastAll = timed.filter((e) => e.at <= view.generatedAt && inArea(e));
  const stopped = pastAll.filter((e) => e.kind === "agent-stop");
  const past = pastAll.filter((e) => e.kind !== "agent-stop");
  const later = timed.filter((e) => e.at > view.generatedAt && inArea(e));
  const nextMeeting = later.find((e) => e.kind === "meeting");
  const ahead = view.ahead.filter(inArea);

  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(t);
  }, [note]);

  const run = (item: DeskItem, a: DeskAction): void => {
    if (a.id === "detail") setDetail(item);
    else if (a.id === "snooze") setSnoozed((s) => new Set(s).add(item.key));
    else if (a.id === "vip.add" && a.target) void addVip(a.target, item.title.split(" wrote:")[0] ?? null);
    else if (a.id.startsWith("ranger.") && a.wired) {
      if (Date.now() < unlockedUntil) void send(item, a, "");
      else setPending({ item, action: a });
    }
    else if (a.url) openLink(a.url);
    else setNote(`"${a.label}" is not connected yet.`);
  };

  const send = async (item: DeskItem, action: DeskAction, code: string): Promise<void> => {
    const sentAt = Date.now();
    const result = await submitDeskAction({ action: action.id, key: item.key }, code);
    setPending(null);
    if (result.needsCode && !code) {
      setUnlockedUntil(0);
      setPending({ item, action });
      return;
    }
    if (result.codeAccepted) setUnlockedUntil(sentAt + DESK_STEP_UP_WINDOW_MS - 30_000);
    setNote(result.text);
    if (!result.ok) return;
    setSnoozed((s) => new Set(s).add(item.key));
    setDetail((d) => (d?.key === item.key ? null : d));
    onChanged();
  };

  const addVip = async (address: string, label: string | null): Promise<void> => {
    try {
      await postJson("/api/desk/vips", { address, label });
      setNote(`Mail from ${label ?? address} will always show from now on.`);
      onChanged();
    } catch {
      setNote(`Could not add ${address} as a VIP.`);
    }
  };

  const removeVip = async (address: string): Promise<void> => {
    try {
      await getJson(`/api/desk/vips?address=${encodeURIComponent(address)}`, { method: "DELETE" });
      onChanged();
    } catch {
      setNote(`Could not remove ${address}.`);
    }
  };

  const itemRow = (item: DeskItem, idx: number) => (
    <DeskItemRow
      key={item.key}
      item={item}
      rank={idx + 1}
      area={item.area ? areaById.get(item.area) : undefined}
      event={item.eventKey ? view.today.find((e) => e.key === item.eventKey) : undefined}
      onOpen={() => setDetail(item)}
      onAction={(a) => run(item, a)}
      onFocusEvent={focusEvent}
    />
  );

  const focusEvent = (key: string): void => {
    if (view.today.some((e) => e.key === key && e.kind === "agent-stop")) setOpenStopped(true);
    requestAnimationFrame(() => document.querySelector(`[data-event="${CSS.escape(key)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  return (
    <div className={`desk${detail ? " panel-open" : ""}`}>
      <div className="desk-top">
        <div className="desk-top-in">
          <div className="desk-left">
            <div className="desk-brand"><span className="desk-mark" />Desk</div>
            <div className="desk-askwrap">
              <form
                className="desk-ask"
                onSubmit={(e) => {
                  e.preventDefault();
                  setNote("Asking Ivy arrives with the command bar slice.");
                }}
              >
                <span className="desk-ask-lead">Ivy,</span>
                <input className="desk-input" aria-label="Ask Ivy" placeholder="remind me…, draft a reply…, what needs me?" />
              </form>
            </div>
          </div>
          {view.areas.length > 0 && (
            <div className="desk-seg" role="tablist" aria-label="Area">
              <button type="button" role="tab" aria-selected={area === ALL_AREAS} onClick={() => setArea(ALL_AREAS)}>All</button>
              {view.areas.map((a) => (
                <button key={a.id} type="button" role="tab" aria-selected={area === a.id} onClick={() => setArea(a.id)}>
                  <AreaDot area={a} />{a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="desk-grid">
        <main>
          <section className="desk-lead">
            <p><strong>{brief.greeting}</strong> {brief.lines.join(" ")}</p>
            {error && <p className="desk-stale">{error}</p>}
          </section>

          <div className="desk-h">
            Today <span className="desk-date">{new Date(view.generatedAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</span>
            {allDay.map((e) => <span key={e.key} className="desk-pill">{e.title}</span>)}
          </div>

          {(past.length > 0 || stopped.length > 0) && (
            <ol className="desk-tl desk-past">
              {stopped.length > 0 && (
                <li className="desk-ev">
                  <time>{clock(stopped[0]!.at)}</time>
                  <span className="desk-pin" />
                  <span>
                    <button type="button" className="desk-dhead" onClick={() => setOpenStopped((o) => !o)} aria-expanded={openStopped}>
                      <b>{stopped.length === 1 ? "An agent stopped" : `${stopped.length} agents stopped`}</b> since {clock(stopped[0]!.at)}
                      <span className={`desk-chev${openStopped ? " open" : ""}`}>›</span>
                    </button>
                  </span>
                </li>
              )}
              {openStopped && stopped.map((e) => (
                <li key={e.key} data-event={e.key} className="desk-ev did">
                  <time>{clock(e.at)}</time>
                  <span className="desk-pin" />
                  <span className="t">{e.note ?? e.title}</span>
                </li>
              ))}
              {past.map((e) => <TimelineRow key={e.key} event={e} className={e.kind === "agent" ? "agentrow" : ""} />)}
            </ol>
          )}

          <div className="desk-nowline"><span className="rule" /><span className="pill">Now {clock(view.generatedAt)}</span></div>

          {group ? (
            <section className="desk-now" aria-label={group.label}>
              <div className="desk-row desk-nowhead">
                <div className="body">
                  <h2>{group.label}</h2>
                  <p>{group.items.length === 0 ? "Nothing left here." : `${group.items.length} that did not make your top ${view.topN}, most important first.`}</p>
                  <button type="button" className="desk-btn" onClick={() => setGroupKind(null)}>Back to what needs you</button>
                </div>
              </div>
              {group.items.map(itemRow)}
            </section>
          ) : (
          <section className="desk-now" aria-label="Needs you">
            <div className="desk-row desk-nowhead">
              <div className="body">
                <h2>{nowHeading(view, selection.needsYou.length, nextMeeting)}</h2>
                {nextMeeting && (
                  <p className="desk-next">
                    <b>{clock(nextMeeting.at)}{nextMeeting.end ? `–${clock(nextMeeting.end)}` : ""}</b> {nextMeeting.title}
                    {nextMeeting.url && <a href={nextMeeting.url} target="_blank" rel="noopener noreferrer">{nextMeeting.online ? "Join" : "Open"}</a>}
                  </p>
                )}
                <p>{nowSubline(view, selection.needsYou.length, selection.rest.length, nextMeeting)}</p>
              </div>
            </div>
            {selection.needsYou.map(itemRow)}
          </section>
          )}

          {later.length > 0 && (
            <ol className="desk-tl desk-later">
              {later.map((e) => <TimelineRow key={e.key} event={e} className={e.kind} />)}
            </ol>
          )}

          {ahead.length > 0 && <AheadStrip events={ahead} />}
        </main>

        <aside className="desk-margin" aria-label="At a glance">
          <section className="desk-msec">
            <h3 className="desk-mh">Agents</h3>
            <button type="button" className="desk-mline" onClick={() => setOpenAgents((o) => !o)} aria-expanded={openAgents}>
              {view.agents.working.length > 0 && <span className="desk-pulse" />}
              {view.agents.line}
              <span className={`desk-chev${openAgents ? " open" : ""}`}>›</span>
            </button>
            {openAgents && (
              <ul className="desk-sub">
                {view.agents.working.map((w) => (
                  <li key={w.title}><span className="desk-pulse" /><div>{w.title}<small>{w.note} · since {clock(w.since)}</small></div></li>
                ))}
                {view.agents.waiting > 0 && <li><div>{view.agents.waiting} agent tasks wait on you<small>They are ranked with everything else.</small></div></li>}
              </ul>
            )}
          </section>

          <section className="desk-msec">
            <h3 className="desk-mh">The rest</h3>
            <button type="button" className="desk-mline" onClick={() => setOpenRest((o) => !o)} aria-expanded={openRest} disabled={selection.rest.length === 0}>
              {selection.rest.length} more <span className="soft">nothing urgent</span>
              <span className={`desk-chev${openRest ? " open" : ""}`}>›</span>
            </button>
            {openRest && (
              <RestGroups groups={selection.groups} active={groupKind} onOpen={setGroupKind} />
            )}
          </section>

          {view.goals.length > 0 && (
            <section className="desk-msec">
              <h3 className="desk-mh">Goals</h3>
              <ul className="desk-goals">
                {view.goals.map((g) => (
                  <li key={g.id}><span>{g.text}</span><span className={`desk-st ${g.state}`}>{g.state.replace("-", " ")}</span></li>
                ))}
              </ul>
            </section>
          )}

          <VipSection vips={view.vips} onAdd={(address) => void addVip(address, null)} onRemove={(address) => void removeVip(address)} />

          <section className="desk-msec">
            <h3 className="desk-mh">Systems</h3>
            {view.systems.length === 0 && canSee(view) ? (
              <p className="desk-health ok">Everything runs.</p>
            ) : (
              view.systems.map((s) => <p key={s} className="desk-health"><i />{s}</p>)
            )}
            <button type="button" className="desk-mline desk-mc" onClick={onOpenMissionControl}>
              Open Mission Control <span className="desk-chev">›</span>
            </button>
          </section>
        </aside>
      </div>

      <div className="desk-scrim" onClick={() => setDetail(null)} />
      <aside className="desk-panel" aria-hidden={!detail} aria-label="Details">
        {detail && <DetailPanel item={detail} area={detail.area ? areaById.get(detail.area)?.label : undefined} onClose={() => setDetail(null)} onAction={(a) => run(detail, a)} />}
      </aside>

      {pending && <StepUpPrompt item={pending.item} action={pending.action} onConfirm={(code) => send(pending.item, pending.action, code)} onCancel={() => setPending(null)} />}
      {note && <div className="desk-note" role="status">{note}</div>}
    </div>
  );
}

function DetailPanel({ item, area, onClose, onAction }: { item: DeskItem; area?: string; onClose: () => void; onAction: (a: DeskAction) => void }) {
  return (
    <>
      <div className="desk-panel-top">
        <span className="area">{area ?? "All"} · {URGENCY_LABEL[item.urgency]}</span>
        <button type="button" className="desk-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <h3>{item.title}</h3>
      <p className="desk-why">{item.why}</p>
      <div className="desk-sec">What this is</div>
      <p className="desk-summary">{item.detail.summary}</p>
      {item.detail.history.length > 0 && (
        <>
          <div className="desk-sec">History</div>
          <ul className="desk-hist">{item.detail.history.map((h) => <li key={h}>{h}</li>)}</ul>
        </>
      )}
      {item.detail.links.length > 0 && (
        <>
          <div className="desk-sec">Open in</div>
          <div className="desk-links">
            {item.detail.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">{l.label}<span>↗</span></a>)}
          </div>
        </>
      )}
      <div className="desk-sec">References</div>
      <ul className="desk-refs">{item.detail.refs.map((r) => <li key={r}>{r}</li>)}</ul>
      <div className="desk-panel-acts">
        {item.actions.filter((a) => a.id !== "detail").map((a) => <ActionButton key={a.id} action={a} onRun={onAction} />)}
      </div>
    </>
  );
}

/** Asks for the step-up code before a Desk action that writes to Ranger. */
export function StepUpPrompt({ item, action, onConfirm, onCancel }: { item: DeskItem; action: DeskAction; onConfirm: (code: string) => Promise<void>; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = /^\d{6}$/.test(code) && !busy;
  return (
    <form
      className="desk-stepup"
      role="dialog"
      aria-label={`${action.label}: confirm with your step-up code`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        void onConfirm(code).finally(() => setBusy(false));
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <p><b>{action.label}</b> {item.title}</p>
      <p className="desk-stepup-hint">One code unlocks Desk actions for {DESK_STEP_UP_WINDOW_MS / 60_000} minutes.</p>
      <label>
        Step-up code
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        />
      </label>
      <button type="submit" className="desk-btn pri" disabled={!ready}>{busy ? "Sending…" : action.label}</button>
      <button type="button" className="desk-btn ghost" onClick={onCancel}>Cancel</button>
    </form>
  );
}

/** The folded rest by kind; each group opens in the main list, and a second click closes it. */
export function RestGroups({ groups, active, onOpen }: { groups: DeskFoldedGroup[]; active: DeskItemKind | null; onOpen: (kind: DeskItemKind | null) => void }) {
  return (
    <ul className="desk-sub">
      {groups.map((g) => (
        <li key={g.kind}>
          <button type="button" className="desk-group" aria-pressed={active === g.kind} onClick={() => onOpen(active === g.kind ? null : g.kind)}>
            <span className="n">{g.count}</span><div>{g.label}<small>{g.example}</small></div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TimelineRow({ event, className }: { event: DeskEvent; className: string }) {
  return (
    <li data-event={event.key} className={`desk-ev ${className}`.trim()}>
      <time>{clock(event.at)}</time>
      <span className="desk-pin" />
      <span>
        <span className="t">{event.title}</span>
        {event.note && <span className="m">{event.note}</span>}
        {event.url && event.kind === "meeting" && <a className="desk-join" href={event.url} target="_blank" rel="noopener noreferrer">{event.online ? "Join" : "Open"}</a>}
      </span>
    </li>
  );
}

function AreaDot({ area }: { area: DeskArea }) {
  return <span className="dot" style={{ background: area.color || "#a1a1aa" }} />;
}

interface DeskItemRowProps {
  item: DeskItem;
  rank: number;
  area?: DeskArea;
  event?: DeskEvent;
  onOpen: () => void;
  onAction: (a: DeskAction) => void;
  onFocusEvent: (key: string) => void;
}

function DeskItemRow({ item, rank, area, event, onOpen, onAction, onFocusEvent }: DeskItemRowProps) {
  return (
    <article className="desk-row desk-item">
      <span className="desk-rank">{rank}</span>
      <span />
      <div className="body">
        <div className="desk-meta">
          {area && <span className="area"><AreaDot area={area} />{area.label}</span>}
          <span className={item.urgency === "today" || item.urgency === "now" ? "due" : ""}>{URGENCY_LABEL[item.urgency]}</span>
        </div>
        <button type="button" className="desk-title" onClick={onOpen}>{item.title}</button>
        <p className="desk-why">{item.why}</p>
        {item.excerpt && <blockquote className="desk-excerpt">{item.excerpt}</blockquote>}
        <div className="desk-acts">
          {item.actions.map((a) => <ActionButton key={a.id} action={a} onRun={onAction} />)}
          {event && (
            <button type="button" className="desk-chip" onClick={() => onFocusEvent(event.key)}>
              {clock(event.at)} today ↑
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function ActionButton({ action, onRun }: { action: DeskAction; onRun: (a: DeskAction) => void }) {
  const style = action.role === "primary" ? " pri" : action.id === "snooze" ? " ghost" : "";
  return (
    <button
      type="button"
      className={`desk-btn${style}`}
      disabled={!action.wired}
      title={action.wired ? undefined : "Not connected yet"}
      onClick={() => onRun(action)}
    >
      {action.label}
    </button>
  );
}

const MEETING_LEAD_MINUTES = 180;

const needsYouLine = (count: number): string => `${count === 1 ? "One thing needs" : `${count} things need`} you, most important first.`;

const minutesUntil = (view: DeskViewModel, next: DeskEvent | undefined): number => (next ? Math.round((next.at - view.generatedAt) / 60_000) : Infinity);

function nowHeading(view: DeskViewModel, count: number, next: DeskEvent | undefined): string {
  if (!canSee(view)) return "The Desk cannot see anything yet.";
  const minutes = minutesUntil(view, next);
  if (next && minutes <= MEETING_LEAD_MINUTES) {
    return `You have ${minutes < 60 ? `${minutes} minutes` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`} before your ${clock(next.at)}.`;
  }
  return count === 0 ? "You're clear." : needsYouLine(count);
}

function nowSubline(view: DeskViewModel, count: number, rest: number, next: DeskEvent | undefined): string {
  const lead = minutesUntil(view, next) <= MEETING_LEAD_MINUTES && canSee(view) && count > 0 ? needsYouLine(count) : "";
  const tail = rest > 0 ? `${rest} more can wait; they are in the margin.` : "";
  return [lead, tail].filter(Boolean).join(" ");
}

/** Web links open a tab and message:// hands off to Apple Mail; any other scheme is refused. */
function openLink(url: string): void {
  if (/^https?:/i.test(url)) window.open(url, "_blank", "noopener");
  else if (/^message:/i.test(url)) window.location.assign(url);
}

function AheadStrip({ events }: { events: DeskEvent[] }) {
  const days = new Map<string, DeskEvent[]>();
  for (const e of events) {
    const day = new Date(e.at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return (
    <section className="desk-days" aria-label="Next days">
      {[...days.entries()].slice(0, 4).map(([day, list]) => (
        <div key={day} className="desk-day">
          <h3>{day}</h3>
          <ul>
            {list.map((e) => (
              <li key={e.key}>
                {e.kind === "meeting" && <time>{clock(e.at)}</time>}
                <span className="ttl">{e.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function VipSection({ vips, onAdd, onRemove }: { vips: DeskViewModel["vips"]; onAdd: (address: string) => void; onRemove: (address: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <section className="desk-msec">
      <h3 className="desk-mh">VIPs</h3>
      <ul className="desk-vips">
        {vips.map((v) => (
          <li key={v.address}>
            <span>{v.label ?? v.address}</span>
            <button type="button" aria-label={`Remove ${v.address}`} onClick={() => onRemove(v.address)}>×</button>
          </li>
        ))}
      </ul>
      <form
        className="desk-vip-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) onAdd(draft.trim());
          setDraft("");
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add an address or @domain" aria-label="Add a VIP" />
      </form>
    </section>
  );
}
