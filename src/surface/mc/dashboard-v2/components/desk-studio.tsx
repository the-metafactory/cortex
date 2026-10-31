import type { StartDiscussion } from "./desk-studio-session";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildBoard, clip, plainQuestion, type Board, type BoardCapture, type BoardCard, type BoardFree, type BoardLoose, type BoardProposal, type BoardTarget } from "../../desk/studio/board";
import { dayMonth, outcomeLabel, TYPE_LABEL } from "../../desk/studio/labels";
import { buildThreadPage } from "../../desk/studio/page";
import { NO_CONTEXT, type RelatesContext } from "../../desk/studio/relates";
import type { StudioView } from "../../desk/studio/view";
import type { DeskView } from "../../desk/types";
import { startOfDay } from "../../desk/time";
import { useStudioActs, type StudioActs } from "../hooks/use-studio-act";
import { OpenSheet, type OpenRequest } from "./desk-studio-acts";
import { AreaChips, ModelBadge, dayMonthTime, hhmm } from "./desk-studio-parts";
import { ThreadMissing, ThreadPageView, useThreadZoom } from "./desk-studio-thread";
import "./desk-studio.css";

const LAST_LOOK_KEY = "desk.studio.lastLook";

export interface LookStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function takeLastLook(store: LookStore | null, now: number): number | null {
  if (!store) return null;
  try {
    const raw = Number(store.getItem(LAST_LOOK_KEY));
    store.setItem(LAST_LOOK_KEY, String(now));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

const browserStore = (): LookStore | null => (typeof window === "undefined" ? null : window.localStorage);

function wroteWhen(iso: string, startOfToday: number): string {
  const at = new Date(iso);
  return at.getTime() >= startOfToday ? `today, ${hhmm(at)}` : `on ${dayMonthTime(at)}`;
}

const viaLabel = (via: string): string => (via === "voice" ? "Voice note" : via === "mail" ? "Forwarded mail" : via.charAt(0).toUpperCase() + via.slice(1));
const targetKey = (t: BoardTarget | null): string => (t === null ? "" : t.kind === "thread" ? `t:${t.slug}` : `p:${t.place}`);

export function DeskModeSwitch({ hasStudio, inStudio, onGo }: { hasStudio: boolean; inStudio: boolean; onGo: (mode: "day" | "studio") => void }) {
  if (!hasStudio) return null;
  return (
    <div className="desk-seg desk-mode" role="tablist" aria-label="View">
      <button type="button" role="tab" aria-selected={!inStudio} onClick={() => onGo("day")}>Day</button>
      <button type="button" role="tab" aria-selected={inStudio} onClick={() => onGo("studio")}>Studio</button>
    </div>
  );
}

export type StudioDay = Pick<DeskView, "generatedAt" | "today" | "ahead" | "goals">;

export function useFreshStudio(studio: StudioView): [StudioView, (view: StudioView) => void] {
  const [fresh, setFresh] = useState<{ base: StudioView; view: StudioView } | null>(null);
  const current = useRef(studio);
  current.current = studio;
  const take = useCallback((view: StudioView) => setFresh({ base: current.current, view }), []);
  return [fresh?.base === studio ? fresh.view : studio, take];
}

export function DeskStudio({ studio: polled, thread, onOpenThread, at, day, onDiscuss }: { studio: StudioView; thread: string | null; onOpenThread: (slug: string | null) => void; at?: number; day?: StudioDay; onDiscuss?: StartDiscussion }) {
  const [studio, takeStudio] = useFreshStudio(polled);
  const acts = useStudioActs(takeStudio);
  const [sheet, setSheet] = useState<OpenRequest | null>(null);
  const bringBack = useCallback((slug: string, question: string) => setSheet({ kind: "unpark", slug, question }), []);
  const now = useMemo(() => at ?? Date.now(), [at, studio]);
  const [lastLook] = useState(() => takeLastLook(browserStore(), now));
  const board = useMemo(() => buildBoard(studio, { now, startOfToday: startOfDay(now), lastLook }), [studio, now, lastLook]);
  const root = useRef<HTMLDivElement>(null);
  const zoom = useThreadZoom(thread, root);
  const context = useMemo<RelatesContext>(() => (day ? { now: day.generatedAt, events: [...day.today, ...day.ahead], goals: day.goals } : { ...NO_CONTEXT, now }), [day, now]);
  const page = useMemo(() => (zoom.shown === null ? null : buildThreadPage(studio, zoom.shown, context)), [studio, zoom.shown, context]);
  const back = (): void => onOpenThread(null);
  return (
    <div className="dst" ref={root}>
      <section className="dst-lead">
        <p>
          <strong>Studio.</strong> {board.summary}
          {board.shared[0] && <span className="dst-shared">These two threads share a source: {board.shared[0].label}.</span>}
        </p>
        {acts.note && <p className={acts.note.ok ? "dst-said" : "dst-said desk-unsent"} role="status">{acts.note.text}</p>}
      </section>
      {zoom.shown !== null
        ? page
          ? <ThreadPageView key={page.thread.slug} page={page} onBack={back} onOpen={onOpenThread} zoom={zoom} acts={acts} onBringBack={bringBack} {...(onDiscuss ? { onDiscuss } : {})} />
          : <ThreadMissing slug={zoom.shown} onBack={back} zoom={zoom} />
        : (
            <>
              <StudioBoard board={board} now={now} onOpen={onOpenThread} onSheet={setSheet} acts={acts} />
              <StudioStrip board={board} onOpen={onOpenThread} onBringBack={bringBack} acts={acts} />
            </>
          )}
      {sheet && <OpenSheet request={sheet} studio={studio} acts={acts} onDone={() => setSheet(null)} />}
    </div>
  );
}

function StudioBoard({ board, now, onOpen, onSheet, acts }: { board: Board; now: number; onOpen: (slug: string) => void; onSheet: (r: OpenRequest) => void; acts: StudioActs }) {
  const ref = useRef<HTMLElement>(null);
  const lines = useBoardLines(ref, board);
  const startOfToday = startOfDay(now);
  return (
    <section className="dst-board" aria-label="Thread board" ref={ref}>
      <svg className="dst-lines" aria-hidden="true">
        {lines.paths.map((p) => (
          <g key={p.key}>
            <path className={p.shared ? "dst-ln shared" : "dst-ln"} d={p.d} />
            {p.why && <path className="dst-hit" d={p.d}><title>{p.why}</title></path>}
            <circle cx={p.end[0]} cy={p.end[1]} r={3.5} className={p.shared ? "dst-end shared" : "dst-end"} />
          </g>
        ))}
      </svg>
      <div className="dst-pills">
        {lines.pills.map((p) => (
          <span key={p.key} className="dst-pill" style={{ left: p.x, top: p.y, maxWidth: p.width }} title={`Both threads draw on the same source: ${p.label}.`}><i />{p.label}</span>
        ))}
      </div>
      <aside className="dst-edge left" aria-label="Inbox">
        <h4 className="dst-h">Inbox <span className="n">{board.inbox.length ? `${board.inbox.length} loose` : "empty"}</span></h4>
        {board.inbox.length ? board.inbox.map((c) => <Sticky key={c.id} item={c} onSheet={onSheet} acts={acts} />) : <p className="dst-none">Nothing loose. Captures that match no thread land here.</p>}
      </aside>
      <div className="dst-slots">
        {board.places.map((p) => (p.kind === "thread" ? <Card key={p.place} card={p} startOfToday={startOfToday} onOpen={onOpen} /> : <Free key={p.place} free={p} />))}
      </div>
      <aside className="dst-edge right" aria-label="Ivy proposes">
        <h4 className="dst-h">Ivy proposes</h4>
        {board.proposals.length ? board.proposals.map((p) => <Proposal key={p.id} item={p} onSheet={onSheet} acts={acts} />) : <p className="dst-none">No proposal right now. Ivy proposes a thread when a theme keeps coming back.</p>}
        <div className="dst-legend">
          <span><i />Two threads share a source</span>
          <span><i className="dotted" />Where Ivy would file it (hover for why)</span>
        </div>
      </aside>
    </section>
  );
}

function Card({ card, startOfToday, onOpen }: { card: BoardCard; startOfToday: number; onOpen: (slug: string) => void }) {
  const t = card.thread;
  return (
    <div className="dst-slot">
      <button type="button" className={card.waitsOnYou ? "dst-card waits" : "dst-card"} data-card={t.slug} data-open={t.slug} aria-label={`Open: ${t.question}`} onClick={() => onOpen(t.slug)}>
        <span className="hd"><span className="dst-type">{TYPE_LABEL[t.type]}</span>{card.waitsOnYou && <span className="dst-badge">Ivy waits on you</span>}</span>
        <span className="dst-q">{t.question}</span>
        {card.stand && <span className="dst-stand"><b>Where I stand</b>{card.stand}</span>}
        {card.shared.map((s) => (
          <span key={s.slug} className="dst-sharedtxt">Shares a source with “{clip(plainQuestion(s.question), 40)}”: {s.label}.</span>
        ))}
        <span className="dst-act">
          <b className="k">Ivy's latest</b>
          {card.latest
            ? <><span className="who">Ivy wrote {wroteWhen(card.latest.at, startOfToday)}.</span> {clip(card.latest.trigger, 78)}</>
            : <><span className="who quiet">Ivy has not written here yet.</span> Opened {dayMonth(t.opened)}.</>}
          {t.thinkTonight && <span className="tn"> On Ivy's list for tonight.</span>}
        </span>
        <span className="dst-meta"><AreaChips areas={card.areas} /><ModelBadge policy={t.policy} /><span className="dst-pnum">Place {card.place}</span></span>
      </button>
    </div>
  );
}

function Free({ free }: { free: BoardFree }) {
  return (
    <div className="dst-slot">
      <div className={free.incoming.length ? "dst-free target" : "dst-free"} data-free={free.place}>
        <b>Place {free.place} is free</b>
        {free.incoming.length ? `Ivy would put ${free.incoming.join(" or ")} here.` : "Accept a proposal or turn a capture into a thread."}
      </div>
    </div>
  );
}

const lineAttrs = (item: BoardLoose, key: string, side: "l" | "r") => ({
  "data-line": key,
  "data-target": targetKey(item.target),
  "data-side": side,
  "data-why": item.reason ? `${item.sentence} Why: ${item.reason}` : item.sentence,
});

function LooseSentence({ item }: { item: BoardLoose }) {
  return <span className="dst-sug">{item.sentence}{item.reason && <i> Why: {item.reason}</i>}</span>;
}

function Sticky({ item, onSheet, acts }: { item: BoardCapture; onSheet: (r: OpenRequest) => void; acts: StudioActs }) {
  const c = item.capture;
  return (
    <div className="dst-sticky" {...lineAttrs(item, `cap-${item.id}`, "l")}>
      <span className="via">{viaLabel(c.via)}, {dayMonthTime(new Date(c.at))}</span>
      {clip(c.text, 140)}
      <LooseSentence item={item} />
      <span className="dst-acts">
        <button type="button" className="desk-btn" disabled={acts.pending} onClick={() => onSheet({ kind: "open", from: "capture", id: c.id, question: c.text, area: c.target?.area ?? null, reason: c.target?.reason ?? null })}>Make it a thread</button>
      </span>
    </div>
  );
}

function Proposal({ item, onSheet, acts }: { item: BoardProposal; onSheet: (r: OpenRequest) => void; acts: StudioActs }) {
  const p = item.proposal;
  return (
    <div className="dst-ghostp" {...lineAttrs(item, `prop-${item.id}`, "r")}>
      <span className="who">A new thread, waiting outside the board</span>
      <h4>{p.question}</h4>
      {p.why && <p>{p.why}</p>}
      <LooseSentence item={item} />
      <span className="dst-meta"><AreaChips areas={item.areas} /><ModelBadge policy={p.policy} /></span>
      <span className="dst-acts">
        <button type="button" className="desk-btn pri" disabled={acts.pending} onClick={() => onSheet({ kind: "open", from: "proposal", id: p.id, question: p.question, area: p.target.area ?? p.areas[0] ?? null, reason: p.target.reason })}>Open it</button>
      </span>
    </div>
  );
}

function StudioStrip({ board, onOpen, onBringBack, acts }: { board: Board; onOpen: (slug: string) => void; onBringBack: (slug: string, question: string) => void; acts: StudioActs }) {
  const [journal, setJournal] = useState(false);
  return (
    <>
      <div className="dst-strip">
        {board.overCap.length > 0 && (
          <div><span className="lbl">Over the cap</span>{board.overCap.map((t) => clip(t.question, 40)).join(" · ")}. Park one to make room.</div>
        )}
        <div>
          <span className="lbl">Parked</span>
          {board.parked.length
            ? board.parked.map((t, i) => (
                <span key={t.slug}>
                  {i > 0 && " · "}
                  <button type="button" className="dst-link" data-open={t.slug} onClick={() => onOpen(t.slug)}>{clip(t.question, 40)}</button>{" "}
                  <button type="button" className="dst-link quiet" disabled={acts.pending} onClick={() => onBringBack(t.slug, t.question)}>Bring back</button>
                </span>
              ))
            : "The shelf is empty."}
        </div>
        <button type="button" className="dst-journal" aria-expanded={journal} onClick={() => setJournal((j) => !j)}>
          Decision journal <span>{board.closed.length} closed {journal ? "‹" : "›"}</span>
        </button>
      </div>
      {journal && (
        <section className="dst-jlist" aria-label="Decision journal">
          {board.closed.length === 0 && <p className="dst-none">No thread is closed yet. Closed threads and what you expected land here.</p>}
          {board.closed.map((t) => (
            <button type="button" key={t.slug} className="dst-jrow" data-open={t.slug} onClick={() => onOpen(t.slug)}>
              <b>{t.question}</b>
              <span>{outcomeLabel(t)}{t.closed ? ` ${t.closed}` : ""}{t.expect ? `. Expected: ${t.expect}` : ""}{t.reviewOn ? `. Review on ${t.reviewOn}.` : ""}</span>
            </button>
          ))}
        </section>
      )}
      {board.problems.length > 0 && (
        <details className="dst-problems">
          <summary>{board.problems.length === 1 ? "1 Studio file could not be read." : `${board.problems.length} Studio files could not be read.`}</summary>
          <ul>{board.problems.map((p) => <li key={`${p.path}:${p.reason}`}><code>{p.path}</code>: {p.reason}</li>)}</ul>
        </details>
      )}
    </>
  );
}

interface LinePath {
  key: string;
  d: string;
  end: [number, number];
  shared: boolean;
  why: string | null;
}

interface LinePill {
  key: string;
  label: string;
  x: number;
  y: number;
  width: number;
}

interface Rect {
  l: number;
  r: number;
  t: number;
  b: number;
  cx: number;
  h: number;
}

type Point = [number, number];

export function ortho(pts: Point[], rad = 10): string {
  const first = pts[0];
  const last = pts.at(-1);
  if (!first || !last) return "";
  let d = `M${first[0]},${first[1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1] ?? first;
    const [x, y] = pts[i] ?? first;
    const [nx, ny] = pts[i + 1] ?? last;
    const r1 = Math.min(rad, Math.hypot(x - px, y - py) / 2);
    const r2 = Math.min(rad, Math.hypot(nx - x, ny - y) / 2);
    d += ` L${x - Math.sign(x - px) * r1},${y - Math.sign(y - py) * r1} Q${x},${y} ${x + Math.sign(nx - x) * r2},${y + Math.sign(ny - y) * r2}`;
  }
  return `${d} L${last[0]},${last[1]}`;
}

const PHONE_QUERY = "(max-width: 760px)";

function useBoardLines(ref: RefObject<HTMLElement | null>, board: Board): { paths: LinePath[]; pills: LinePill[] } {
  const [lines, setLines] = useState<{ paths: LinePath[]; pills: LinePill[] }>({ paths: [], pills: [] });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setTick((n) => n + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia(PHONE_QUERY).matches) {
      setLines({ paths: [], pills: [] });
      return;
    }
    setLines(measureLines(el, board));
  }, [ref, board, tick]);

  return lines;
}

function measureLines(boardEl: HTMLElement, board: Board): { paths: LinePath[]; pills: LinePill[] } {
  const box = boardEl.getBoundingClientRect();
  const rect = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, cx: r.left + r.width / 2 - box.left, h: r.height };
  };
  const slotsEl = boardEl.querySelector(".dst-slots");
  if (!slotsEl) return { paths: [], pills: [] };
  const slotsR = rect(slotsEl);
  const slots = [...boardEl.querySelectorAll(".dst-slot")].map(rect);
  const rowTops = [...new Set(slots.map((s) => Math.round(s.t)))].sort((a, b) => a - b);
  const rowOf = (r: Rect): number => rowTops.findIndex((y) => Math.abs(y - r.t) < 4);
  const rowSlots = (row: number): Rect[] => slots.filter((s) => rowOf(s) === row).sort((a, b) => a.l - b.l);
  const laneAbove = (row: number): number => {
    if (row <= 0) return slotsR.t - 13;
    const above = rowSlots(row - 1).map((s) => s.b);
    return ((rowTops[row] ?? 0) + Math.max(...above)) / 2;
  };
  const laneBelow = (row: number): number => (row + 1 < rowTops.length ? laneAbove(row + 1) : (rowSlots(row)[0]?.b ?? slotsR.b) + 18);
  const used = new Map<number, number>();
  const lane = (y: number): number => {
    const k = Math.round(y);
    const n = (used.get(k) ?? 0) + 1;
    used.set(k, n);
    return y + 8 + (n - 1) * 7;
  };
  const slotOf = (el: Element): Rect | null => {
    const s = el.closest(".dst-slot");
    return s ? rect(s) : null;
  };
  const find = (selector: string): Element | null => boardEl.querySelector(selector);

  const paths: LinePath[] = [];
  const pills: LinePill[] = [];

  for (const pair of board.shared) {
    const ea = find(`[data-card="${CSS.escape(pair.a)}"]`);
    const eb = find(`[data-card="${CSS.escape(pair.b)}"]`);
    if (!ea || !eb) continue;
    let a = rect(ea);
    let b = rect(eb);
    if (a.l > b.l) [a, b] = [b, a];
    const ra = rowOf(a);
    const rb = rowOf(b);
    let pts: Point[];
    if (ra === rb) {
      const y = laneBelow(ra) - 8;
      pts = [[a.cx, a.b], [a.cx, y], [b.cx, y], [b.cx, b.b]];
    } else {
      const [top, bot] = ra < rb ? [a, b] : [b, a];
      const y = laneAbove(Math.max(ra, rb)) - 8;
      pts = [[top.cx, top.b], [top.cx, y], [bot.cx, y], [bot.cx, bot.t]];
    }
    const [sx, sy] = pts[0] ?? [0, 0];
    const [ex, ey] = pts.at(-1) ?? [0, 0];
    paths.push({ key: `shared-${pair.a}-${pair.b}`, d: ortho(pts), end: [ex, ey], shared: true, why: null });
    pills.push({ key: `pill-${pair.a}-${pair.b}`, label: pair.label, x: (sx + ex) / 2, y: pts[1]?.[1] ?? sy, width: Math.max(160, Math.abs(ex - sx) + 60) });
  }

  for (const src of boardEl.querySelectorAll<HTMLElement>("[data-line][data-target]")) {
    const tg = src.dataset.target ?? "";
    const el = tg.startsWith("t:") ? find(`[data-card="${CSS.escape(tg.slice(2))}"]`) : tg.startsWith("p:") ? find(`[data-free="${CSS.escape(tg.slice(2))}"]`) : null;
    const slot = el && slotOf(el);
    if (!el || !slot) continue;
    const s = rect(src);
    const t = rect(el);
    const left = src.dataset.side === "l";
    const row = rowOf(slot);
    const inRow = rowSlots(row);
    const edge = left ? inRow[0] : inRow.at(-1);
    const y1 = s.t + Math.min(s.h / 2, 34);
    const x1 = left ? s.r : s.l;
    const gx = left ? slotsR.l - 18 : slotsR.r + 18;
    let pts: Point[];
    if (edge && Math.abs(edge.l - slot.l) < 4) {
      const ty = Math.max(t.t + 18, Math.min(t.b - 18, y1));
      pts = Math.abs(ty - y1) < 2 ? [[x1, y1], [left ? t.l : t.r, y1]] : [[x1, y1], [gx, y1], [gx, ty], [left ? t.l : t.r, ty]];
    } else {
      const ly = lane(laneAbove(row));
      const tx = left ? t.l + 30 : t.r - 30;
      pts = [[x1, y1], [gx, y1], [gx, ly], [tx, ly], [tx, t.t]];
    }
    const end = pts.at(-1) ?? [x1, y1];
    paths.push({ key: src.dataset.line ?? tg, d: ortho(pts), end, shared: false, why: src.dataset.why ?? null });
  }

  return { paths, pills };
}
