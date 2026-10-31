import { useEffect, useMemo, useRef, useState } from "react";
import { getJson, postJson } from "../lib/api";
import { submitDeskAction } from "../lib/desk-action";
import { chimeForNew } from "../lib/desk-chime";
import { askDesk, createFromProposal } from "../lib/desk-ask";
import { ProposalCard, proposalTitle } from "./desk-proposal";
import { proposalTime, type DeskProposal } from "../../desk/ask";
import { DAY_MS, startOfDay } from "../../desk/time";
import "./desk-view.css";
import { useDesk } from "../hooks/use-desk";
import { ALL_AREAS, briefing, canSee, clock, openGroup, selectItems, URGENCY_LABEL } from "../../desk/present";
import type { DeskAction, DeskArea, DeskCorrection, DeskCorrectionMode, DeskEvent, DeskFoldedGroup, DeskItem, DeskItemKind, DeskView as DeskViewModel } from "../../desk/types";

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
  const [sending, setSending] = useState<ReadonlyMap<string, string>>(() => new Map());
  const inFlight = useRef(new Set<string>());
  const [askText, setAskText] = useState("");
  const [asking, setAsking] = useState(false);
  const [proposal, setProposal] = useState<{ p: DeskProposal; said: string; requestId: string; fields: Record<string, unknown> } | null>(null);
  const [creating, setCreating] = useState(false);
  const askInput = useRef<HTMLInputElement>(null);

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
  const ghost = proposal ? ghostEvent({ ...proposal.p, fields: proposal.fields }) : null;
  const upcomingGhost = ghost !== null && ghost.at > view.generatedAt ? ghost : null;
  const ghostToday = upcomingGhost !== null && upcomingGhost.at < startOfDay(view.generatedAt) + DAY_MS;
  const withGhost = (list: DeskEvent[], include: boolean): DeskEvent[] => (upcomingGhost && include ? [...list, upcomingGhost].sort((a, b) => a.at - b.at) : list);
  const laterReal = timed.filter((e) => e.at > view.generatedAt && inArea(e));
  const nextMeeting = laterReal.find((e) => e.kind === "meeting");
  const later = withGhost(laterReal, ghostToday);
  const ahead = withGhost(view.ahead.filter(inArea), !ghostToday);

  useEffect(() => {
    chimeForNew(view);
  }, [view]);

  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        askInput.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ask = async (): Promise<void> => {
    const text = askText.trim();
    if (!text || asking) return;
    setAsking(true);
    const result = await askDesk(text);
    setAsking(false);
    if (!result.ok) {
      setNote(result.text);
      return;
    }
    setGroupKind(null);
    setProposal({ p: result.proposal, said: text, requestId: crypto.randomUUID(), fields: result.proposal.fields });
    setAskText("");
  };

  const confirm = async (fields: Record<string, unknown>): Promise<void> => {
    if (!proposal || creating) return;
    setCreating(true);
    const result = await createFromProposal(proposal.requestId, proposal.p.kind, fields);
    setCreating(false);
    setNote(result.text);
    if (!result.ok && !result.uncertain) return;
    setProposal(null);
    onChanged();
  };

  const doneNote = async (id: string, itemKey: string | null): Promise<void> => {
    try {
      await postJson("/api/desk/notes/done", { id: Number(id) });
      if (itemKey) setSnoozed((s) => new Set(s).add(itemKey));
      onChanged();
    } catch {
      setNote("Could not mark that done.");
    }
  };

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(t);
  }, [note]);

  const run = (item: DeskItem, a: DeskAction): void => {
    if (a.id === "detail") setDetail(item);
    else if (a.id === "snooze") setSnoozed((s) => new Set(s).add(item.key));
    else if (a.id === "vip.add" && a.target) void addVip(a.target, item.title.split(" wrote:")[0] ?? null);
    else if (a.id === "reminder.done" && a.target) {
      setDetail((d) => (d?.key === item.key ? null : d));
      void doneNote(a.target, item.key);
    }
    else if (a.id.startsWith("ranger.") && a.wired) void send(item, a);
    else if (a.url) openLink(a.url);
    else setNote(`"${a.label}" is not connected yet.`);
  };

  const send = async (item: DeskItem, action: DeskAction): Promise<void> => {
    if (inFlight.current.has(item.key)) return;
    inFlight.current.add(item.key);
    setSending((m) => new Map(m).set(item.key, action.id));
    let result: { ok: boolean; text: string };
    try {
      result = await submitDeskAction({ action: action.id, key: item.key });
    } finally {
      inFlight.current.delete(item.key);
      setSending((m) => {
        const next = new Map(m);
        next.delete(item.key);
        return next;
      });
    }
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

  const promote = async (action: string, on: boolean): Promise<void> => {
    try {
      const r = await postJson<{ action: string; on: boolean }, { message?: string }>("/api/desk/autonomy", { action, on });
      setNote(r.message ?? "Done.");
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not change that.");
    }
  };

  const correct = async (kind: DeskItemKind, source: string, mode: DeskCorrectionMode | null): Promise<void> => {
    try {
      const r = mode
        ? await postJson<{ kind: string; source: string; mode: DeskCorrectionMode }, { message?: string }>("/api/desk/corrections", { kind, source, mode })
        : await getJson<{ message?: string }>(`/api/desk/corrections?kind=${encodeURIComponent(kind)}&source=${encodeURIComponent(source)}`, { method: "DELETE" });
      setNote(r.message ?? "Done.");
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not change the ranking.");
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
      sending={sending.get(item.key) ?? null}
      onFocusEvent={focusEvent}
      onCorrect={(mode) => void correct(item.kind, item.source, mode)}
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
                  void ask();
                }}
              >
                <span className="desk-ask-lead">Ivy,</span>
                <input
                  ref={askInput}
                  className="desk-input"
                  aria-label="Ask Ivy"
                  placeholder="remind me…, note…, ask an agent to…, schedule…"
                  value={askText}
                  disabled={asking}
                  onChange={(e) => setAskText(e.target.value)}
                />
                {asking ? <span className="desk-ask-busy" role="status">Thinking…</span> : <kbd className="desk-kbd">⌘K</kbd>}
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
            {proposal && (
              <ProposalCard
                key={proposal.requestId}
                proposal={proposal.p}
                said={proposal.said}
                maps={view.ask.maps}
                now={view.generatedAt}
                busy={creating}
                onConfirm={(fields) => void confirm(fields)}
                onCancel={() => setProposal(null)}
                onGoto={() => focusEvent(GHOST_KEY)}
                onFieldsChange={(fields) => setProposal((cur) => (cur ? { ...cur, fields } : cur))}
              />
            )}
            {selection.needsYou.map(itemRow)}
          </section>
          )}

          {later.length > 0 && (
            <ol className="desk-tl desk-later">
              {later.map((e) => <TimelineRow key={e.key} event={e} className={e.key === GHOST_KEY ? "ghost" : e.kind} />)}
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

          <DoneForYou autonomy={view.autonomy} onPromote={(action, on) => void promote(action, on)} />

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

          {view.notes.length > 0 && (
            <section className="desk-msec">
              <h3 className="desk-mh">Keep in mind</h3>
              <ul className="desk-vips desk-notes">
                {view.notes.map((n) => (
                  <li key={n.id}>
                    <span>{n.text}</span>
                    <button type="button" aria-label={`Put away "${n.text}"`} title="Put away" onClick={() => void doneNote(String(n.id), null)}>×</button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <RankingSection corrections={view.corrections} onUndo={(c) => void correct(c.kind, c.source, null)} />

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
        {detail && <DetailPanel item={detail} area={detail.area ? areaById.get(detail.area)?.label : undefined} onClose={() => setDetail(null)} onAction={(a) => run(detail, a)} sending={sending.get(detail.key) ?? null} />}
      </aside>

      {note && <div className="desk-note" role="status">{note}</div>}
    </div>
  );
}

function DetailPanel({ item, area, onClose, onAction, sending }: { item: DeskItem; area?: string; onClose: () => void; onAction: (a: DeskAction) => void; sending: string | null }) {
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
        {item.actions.filter((a) => a.id !== "detail").map((a) => <ActionButton key={a.id} action={a} onRun={onAction} sending={sending} />)}
      </div>
    </>
  );
}

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

const GHOST_KEY = "ghost:proposal";

function ghostEvent(p: DeskProposal): DeskEvent | null {
  const { at, end } = proposalTime(p.kind, p.fields);
  if (at === undefined) return null;
  return {
    key: GHOST_KEY,
    at,
    ...(end !== undefined ? { end } : {}),
    title: proposalTitle(p),
    note: `Proposed ${p.label.toLowerCase()}`,
    area: null,
    kind: p.kind === "calendar" ? "meeting" : "reminder",
  };
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
  sending: string | null;
  onFocusEvent: (key: string) => void;
  onCorrect: (mode: DeskCorrectionMode | null) => void;
}

function DeskItemRow({ item, rank, area, event, onOpen, onAction, sending, onFocusEvent, onCorrect }: DeskItemRowProps) {
  return (
    <article className="desk-row desk-item">
      <span className="desk-rank">{rank}</span>
      <span />
      <div className="body">
        <div className="desk-meta">
          {area && <span className="area"><AreaDot area={area} />{area.label}</span>}
          <span className={item.urgency === "today" || item.urgency === "now" ? "due" : ""}>{URGENCY_LABEL[item.urgency]}</span>
          {item.correction && <span className="desk-corr">{CORRECTION_TAG[item.correction]}</span>}
        </div>
        <button type="button" className="desk-title" onClick={onOpen}>{item.title}</button>
        <p className="desk-why">{item.why}</p>
        {item.interrupt?.delivery === "failed" && <p className="desk-why desk-unsent">Not pushed: {item.interrupt.error}</p>}
        {item.excerpt && <blockquote className="desk-excerpt">{item.excerpt}</blockquote>}
        <div className="desk-acts">
          {item.actions.map((a) => <ActionButton key={a.id} action={a} onRun={onAction} sending={sending} />)}
          {event && (
            <button type="button" className="desk-chip" onClick={() => onFocusEvent(event.key)}>
              {clock(event.at)} today ↑
            </button>
          )}
          <ItemMenu current={item.correction} onCorrect={onCorrect} />
        </div>
      </div>
    </article>
  );
}

const CORRECTION_TAG: Record<DeskCorrectionMode, string> = { less: "Less like this", always: "Always shown" };

const MENU: { mode: DeskCorrectionMode; label: string }[] = [
  { mode: "less", label: "Less like this" },
  { mode: "always", label: "Always show this" },
];

export function ItemMenu({ current, onCorrect, open: startOpen = false }: { current?: DeskCorrectionMode; onCorrect: (mode: DeskCorrectionMode | null) => void; open?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const pick = (mode: DeskCorrectionMode | null): void => {
    setOpen(false);
    onCorrect(mode);
  };
  return (
    <span className="desk-more">
      <button type="button" className="desk-btn ghost" aria-label="Ranking options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <span className="desk-menu" role="menu">
          {MENU.filter((m) => m.mode !== current).map((m) => (
            <button key={m.mode} type="button" role="menuitem" onClick={() => pick(m.mode)}>{m.label}</button>
          ))}
          {current && <button type="button" role="menuitem" onClick={() => pick(null)}>Rank by the base rules again</button>}
        </span>
      )}
    </span>
  );
}

export function RankingSection({ corrections, onUndo }: { corrections: DeskCorrection[]; onUndo: (c: DeskCorrection) => void }) {
  if (corrections.length === 0) return null;
  return (
    <section className="desk-msec" aria-label="Ranking">
      <h3 className="desk-mh">Ranking</h3>
      <ul className="desk-vips">
        {corrections.map((c) => (
          <li key={`${c.kind}:${c.source}`}>
            <span>{CORRECTION_TAG[c.mode]}: {c.label}</span>
            <button type="button" aria-label={`Undo "${CORRECTION_TAG[c.mode]}" for ${c.label}`} title="Undo" onClick={() => onUndo(c)}>×</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ActionButton({ action, onRun, sending }: { action: DeskAction; onRun: (a: DeskAction) => void; sending: string | null }) {
  const style = action.role === "primary" ? " pri" : action.id === "snooze" ? " ghost" : "";
  const busy = sending === action.id;
  return (
    <button
      type="button"
      className={`desk-btn${style}`}
      disabled={!action.wired || sending !== null}
      aria-busy={busy}
      title={action.wired ? undefined : "Not connected yet"}
      onClick={() => onRun(action)}
    >
      {busy ? "Sending…" : action.label}
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
              <li key={e.key} data-event={e.key} className={e.key === GHOST_KEY ? "ghost" : undefined}>
                {(e.kind === "meeting" || e.kind === "reminder") && <time>{clock(e.at)}</time>}
                <span className="ttl">{e.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export function DoneForYou({ autonomy, onPromote }: { autonomy: DeskViewModel["autonomy"]; onPromote: (action: string, on: boolean) => void }) {
  if (autonomy.types.length === 0 && autonomy.done.length === 0) return null;
  const anyOn = autonomy.types.some((t) => t.on);
  return (
    <section className="desk-msec" aria-label="Done for you">
      <h3 className="desk-mh">Done for you</h3>
      <ul className="desk-sub desk-done">
        {autonomy.done.map((d) => (
          <li key={d.key} className={d.ok ? undefined : "failed"}>
            <div>{d.ok ? `Retried "${d.title}"` : `Could not retry "${d.title}"`}<small>{d.ok ? `at ${clock(d.at)}` : d.message}</small></div>
          </li>
        ))}
        {autonomy.done.length === 0 && anyOn && <li><div>Nothing yet<small>What the Desk does on its own shows here.</small></div></li>}
        {autonomy.types.map((t) => (
          <li key={t.action}>
            <div>
              {t.label}
              <small>{t.on ? `The Desk does this on its own. ${t.note}` : "The Desk asks you first."}</small>
              <button type="button" className="desk-btn ghost" onClick={() => onPromote(t.action, !t.on)}>
                {t.on ? "Stop doing this on your own" : "Handle this yourself"}
              </button>
            </div>
          </li>
        ))}
      </ul>
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
