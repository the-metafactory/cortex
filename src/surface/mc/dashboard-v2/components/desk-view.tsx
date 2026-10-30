/**
 * The Desk (cortex#2770): Mission Control's landing page for the stack's principal.
 *
 * Layout from the chosen prototype "The Day, clean": a briefing, today's timeline with a Now
 * line, the ranked items that need the principal pinned at Now, and a margin with agents,
 * the folded rest, goals and systems. Raw identifiers appear only in the detail panel.
 */

import { useEffect, useMemo, useState } from "react";
import "./desk-view.css";
import { useDesk } from "../hooks/use-desk";
import { ALL_AREAS, briefing, clock, selectItems, URGENCY_LABEL } from "../../desk/present";
import type { DeskAction, DeskEvent, DeskItem, DeskView as DeskViewModel } from "../../desk/types";

interface DeskViewProps {
  onOpenMissionControl: () => void;
}

export function DeskView({ onOpenMissionControl }: DeskViewProps) {
  const { view, enabled, error } = useDesk(true);
  if (!enabled) {
    return (
      <div className="desk desk-off">
        <p>The Desk is turned off for this stack (<code>mc.desk.enabled: false</code>).</p>
        <button type="button" className="desk-btn" onClick={onOpenMissionControl}>Open Mission Control</button>
      </div>
    );
  }
  if (!view) return <div className="desk desk-loading">{error ?? "Loading your Desk…"}</div>;
  return <DeskBody view={view} error={error} onOpenMissionControl={onOpenMissionControl} />;
}

export function DeskBody({ view, error, onOpenMissionControl }: { view: DeskViewModel; error: string | null } & DeskViewProps) {
  const [area, setArea] = useState(ALL_AREAS);
  const [snoozed, setSnoozed] = useState<Set<string>>(() => new Set());
  const [detail, setDetail] = useState<DeskItem | null>(null);
  const [openRest, setOpenRest] = useState(false);
  const [openAgents, setOpenAgents] = useState(false);
  const [openStopped, setOpenStopped] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const selection = useMemo(() => selectItems(view, area, snoozed), [view, area, snoozed]);
  const areaLabel = area === ALL_AREAS ? null : view.areas.find((a) => a.id === area)?.label ?? null;
  const brief = briefing(view, selection, areaLabel);
  const areaById = new Map(view.areas.map((a) => [a.id, a]));
  const inArea = (e: DeskEvent): boolean => area === ALL_AREAS || e.area === area;
  const pastAll = view.today.filter((e) => e.at <= view.generatedAt && inArea(e));
  const stopped = pastAll.filter((e) => e.key.startsWith("event:"));
  const past = pastAll.filter((e) => !e.key.startsWith("event:"));
  const later = view.today.filter((e) => e.at > view.generatedAt && inArea(e));

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
    else if (a.url) window.open(a.url, "_blank", "noopener");
    else setNote(`"${a.label}" is not connected yet. It arrives with the Ranger actions slice.`);
  };

  const focusEvent = (key: string): void => {
    if (key.startsWith("event:")) setOpenStopped(true);
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
                  <span className="dot" style={{ background: a.color || "#a1a1aa" }} />{a.label}
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
              {past.map((e) => (
                <li key={e.key} data-event={e.key} className={`desk-ev${e.kind === "agent" ? " agentrow" : ""}`}>
                  <time>{clock(e.at)}</time>
                  <span className="desk-pin" />
                  <span><span className="t">{e.title}</span>{e.note && <span className="m">{e.note}</span>}</span>
                </li>
              ))}
            </ol>
          )}

          <div className="desk-nowline"><span className="rule" /><span className="pill">Now {clock(view.generatedAt)}</span></div>

          <section className="desk-now" aria-label="Needs you">
            <div className="desk-row desk-nowhead">
              <div className="body">
                <h2>{selection.needsYou.length === 0 ? "You're clear." : `${selection.needsYou.length === 1 ? "One thing needs" : `${selection.needsYou.length} things need`} you, most important first.`}</h2>
                {selection.rest.length > 0 && <p>{selection.rest.length} more can wait; they are in the margin.</p>}
              </div>
            </div>
            {selection.needsYou.map((item, idx) => {
              const a = item.area ? areaById.get(item.area) : undefined;
              const event = item.eventKey ? view.today.find((e) => e.key === item.eventKey) : undefined;
              return (
                <article key={item.key} className="desk-row desk-item">
                  <span className="desk-rank">{idx + 1}</span>
                  <span />
                  <div className="body">
                    <div className="desk-meta">
                      {a && <span className="area"><span className="dot" style={{ background: a.color || "#a1a1aa" }} />{a.label}</span>}
                      <span className={item.urgency === "today" || item.urgency === "now" ? "due" : ""}>{URGENCY_LABEL[item.urgency]}</span>
                    </div>
                    <button type="button" className="desk-title" onClick={() => setDetail(item)}>{item.title}</button>
                    <p className="desk-why">{item.why}</p>
                    <div className="desk-acts">
                      {item.actions.map((act) => (
                        <button
                          key={act.id}
                          type="button"
                          className={`desk-btn${act.role === "primary" ? " pri" : act.id === "snooze" ? " ghost" : ""}`}
                          disabled={!act.wired}
                          title={act.wired ? undefined : "Not connected yet"}
                          onClick={() => run(item, act)}
                        >
                          {act.label}
                        </button>
                      ))}
                      {event && (
                        <button type="button" className="desk-chip" onClick={() => focusEvent(event.key)}>
                          {clock(event.at)} today ↑
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </section>

          {later.length > 0 && (
            <ol className="desk-tl desk-later">
              {later.map((e) => (
                <li key={e.key} data-event={e.key} className={`desk-ev ${e.kind}`}>
                  <time>{clock(e.at)}</time>
                  <span className="desk-pin" />
                  <span><span className="t">{e.title}</span>{e.note && <span className="m">{e.note}</span>}</span>
                </li>
              ))}
            </ol>
          )}
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
              <ul className="desk-sub">
                {selection.groups.map((g) => (
                  <li key={g.kind}><span className="n">{g.count}</span><div>{g.label}<small>{g.example}</small></div></li>
                ))}
              </ul>
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

          <section className="desk-msec">
            <h3 className="desk-mh">Systems</h3>
            {view.systems.length === 0 ? (
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
        {item.actions.filter((a) => a.id !== "detail").map((a) => (
          <button key={a.id} type="button" className={`desk-btn${a.role === "primary" ? " pri" : ""}`} disabled={!a.wired} onClick={() => onAction(a)}>{a.label}</button>
        ))}
      </div>
    </>
  );
}
