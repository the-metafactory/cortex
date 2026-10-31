import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { clip, plainQuestion } from "../../desk/studio/board";
import type { IvyNote } from "../../desk/studio/format";
import { dayMonth, localDate } from "../../desk/studio/labels";
import type { ThreadPage } from "../../desk/studio/page";
import { relationCount, type Relation } from "../../desk/studio/relates";
import type { StudioActs } from "../hooks/use-studio-act";
import { Sparring } from "./desk-studio-sparring";
import { CloseForm, RespondBox } from "./desk-studio-acts";
import { AreaChips, ModelBadge, dayMonthTime, weekdayDayTime } from "./desk-studio-parts";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const STACKED = "(max-width: 1100px)";
const GROW = { duration: 340, easing: "cubic-bezier(.2,.85,.25,1)" };
const SHRINK = { duration: 240, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" as const };
const DISCUSS_LATER = "Discuss arrives with live sessions with Ivy.";
const NO_WRITES = "The Studio cannot write from here.";

interface DocRect {
  left: number;
  top: number;
  width: number;
}

type Motion = { kind: "grow"; from: DocRect | null } | { kind: "hop" } | { kind: "none" };

const canAnimate = (el: HTMLElement | null): el is HTMLElement =>
  el !== null && typeof el.animate === "function" && !window.matchMedia(REDUCED_MOTION).matches;

function openerRect(root: HTMLElement | null, slug: string): DocRect | null {
  const el = root?.querySelector(`[data-open="${CSS.escape(slug)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width };
}

export interface ThreadZoom {
  shown: string | null;
  closing: boolean;
  motion: RefObject<Motion>;
  cardAt: (slug: string) => DocRect | null;
  closed: () => void;
}

export function useThreadZoom(thread: string | null, root: RefObject<HTMLElement | null>): ThreadZoom {
  const [shown, setShown] = useState(thread);
  const [closing, setClosing] = useState(false);
  const motion = useRef<Motion>({ kind: "none" });
  const cards = useRef(new Map<string, DocRect>());
  const returnTo = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (thread === shown) {
      if (closing) setClosing(false);
      return;
    }
    if (thread === null) {
      if (canAnimate(root.current)) setClosing(true);
      else setShown(null);
      return;
    }
    if (shown === null) {
      const from = openerRect(root.current, thread);
      if (from) cards.current.set(thread, from);
      returnTo.current = window.scrollY;
      motion.current = { kind: "grow", from };
    } else {
      motion.current = { kind: "hop" };
    }
    setClosing(false);
    setShown(thread);
  }, [thread, shown, closing, root]);

  useLayoutEffect(() => {
    if (shown !== null || returnTo.current === null) return;
    window.scrollTo({ top: returnTo.current });
    returnTo.current = null;
  }, [shown]);

  const closed = useCallback(() => {
    setClosing(false);
    setShown(null);
  }, []);
  const cardAt = useCallback((slug: string) => cards.current.get(slug) ?? null, []);
  return useMemo(() => ({ shown, closing, motion, cardAt, closed }), [shown, closing, cardAt, closed]);
}

function cardFrame(card: DocRect, to: DOMRect, opacity: number): Keyframe {
  const s = card.width / to.width;
  return { transform: `translate(${card.left - window.scrollX - to.left}px,${card.top - window.scrollY - to.top}px) scale(${s})`, borderRadius: `${16 / s}px`, opacity };
}

const PAGE_FRAME: Keyframe = { transform: "none", borderRadius: "22px", opacity: 1 };

function useZoomMotion(ref: RefObject<HTMLElement | null>, slug: string, zoom: ThreadZoom | undefined): void {
  useLayoutEffect(() => {
    if (!zoom) return;
    const el = ref.current;
    const m = zoom.motion.current;
    zoom.motion.current = { kind: "none" };
    if (!canAnimate(el) || m.kind === "none") return;
    let to = el.getBoundingClientRect();
    if (to.top < 0) {
      window.scrollTo({ top: to.top + window.scrollY - 12 });
      to = el.getBoundingClientRect();
    }
    if (m.kind === "hop") {
      el.animate([{ opacity: 0.2, transform: "translateX(24px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: GROW.easing });
      return;
    }
    if (!m.from) {
      el.animate([{ opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: GROW.easing });
      return;
    }
    el.animate([cardFrame(m.from, to, 0.5), PAGE_FRAME], GROW);
  }, [ref, slug, zoom]);

  const closing = zoom?.closing ?? false;
  useEffect(() => {
    if (!zoom || !closing) return;
    const el = ref.current;
    if (!canAnimate(el)) {
      zoom.closed();
      return;
    }
    const to = el.getBoundingClientRect();
    const card = zoom.cardAt(slug);
    const frames = card ? [PAGE_FRAME, cardFrame(card, to, 0.3)] : [{ transform: "none", opacity: 1 }, { transform: "scale(.96)", opacity: 0 }];
    const anim = el.animate(frames, SHRINK);
    anim.onfinish = zoom.closed;
    return () => anim.cancel();
  }, [ref, slug, zoom, closing]);
}

interface Wire {
  key: string;
  d: string;
  ivy: boolean;
}

function useWires(ref: RefObject<HTMLElement | null>, page: ThreadPage): Wire[] {
  const [wires, setWires] = useState<Wire[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setTick((n) => n + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(".dst-canvas");
    const hub = el?.querySelector("[data-hub]");
    if (!el || !hub || window.matchMedia(STACKED).matches) {
      setWires([]);
      return;
    }
    const outer = el.getBoundingClientRect();
    const k = outer.width / el.offsetWidth || 1;
    const local = (r: DOMRect) => ({ left: (r.left - outer.left) / k, right: (r.right - outer.left) / k, top: (r.top - outer.top) / k, height: r.height / k });
    const h = local(hub.getBoundingClientRect());
    const hy = h.top + Math.min(h.height / 2, 60);
    const curve = (x1: number, y1: number, x2: number, y2: number): string => {
      const mx = (x1 + x2) / 2;
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    };
    const out: Wire[] = [];
    for (const n of el.querySelectorAll<HTMLElement>("[data-wire]")) {
      const r = local(n.getBoundingClientRect());
      const y = r.top + Math.min(r.height / 2, 24);
      const left = n.dataset.wire === "in";
      const d = left ? curve(r.right, y, h.left, hy) : curve(h.right, hy, r.left, y);
      out.push({ key: n.dataset.key ?? String(out.length), d, ivy: !left });
    }
    setWires(out);
  }, [ref, page, tick]);

  return wires;
}

const modelName = (model: string): string => (model === "local" ? "local model" : model === "cloud" ? "cloud model" : model);

function PageHeader({ onBack, children, actions }: { onBack: () => void; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="dst-zhd">
      <button type="button" className="dst-back" onClick={onBack}>‹ Board</button>
      <span>{children}</span>
      {actions && <span className="dst-zacts">{actions}</span>}
    </div>
  );
}

interface Acting {
  slug: string;
  acts?: StudioActs;
}

function GhostActions({ keep, note, acting, discuss = true }: { keep: string; note: IvyNote; acting: Acting; discuss?: boolean }) {
  const { acts, slug } = acting;
  const off = !acts || acts.pending;
  const send = (act: "keep" | "dismiss") => () => void acts?.send({ act, thread: slug, note: note.at });
  return (
    <span className="dst-acts">
      <button type="button" className="desk-btn" disabled={off} title={acts ? undefined : NO_WRITES} onClick={send("keep")}>{keep}</button>
      {discuss && <button type="button" className="desk-btn ghost" disabled title={DISCUSS_LATER}>Discuss</button>}
      <button type="button" className="desk-btn ghost" disabled={off} title={acts ? undefined : NO_WRITES} onClick={send("dismiss")}>Dismiss</button>
    </span>
  );
}

function ThreadActions({ page, acting, onBringBack }: { page: ThreadPage; acting: Acting; onBringBack?: (slug: string, question: string) => void }) {
  const { acts, slug } = acting;
  const t = page.thread;
  if (t.state === "closed") return null;
  const off = !acts || acts.pending;
  return (
    <>
      <button type="button" className="desk-btn ghost" aria-pressed={t.thinkTonight} disabled={off} onClick={() => void acts?.send({ act: "think", thread: slug, on: !t.thinkTonight })}>
        {t.thinkTonight ? "On Ivy's list tonight" : "Think tonight"}
      </button>
      {t.state === "active"
        ? <button type="button" className="desk-btn ghost" disabled={off} onClick={() => void acts?.send({ act: "park", thread: slug })}>Park</button>
        : <button type="button" className="desk-btn" disabled={off || !onBringBack} onClick={() => onBringBack?.(slug, t.question)}>Bring back</button>}
    </>
  );
}

function noteLabel(note: IvyNote): string {
  const kind = note.kind === "stand" ? "Proposed stand" : note.kind === "idea" ? "Idea" : "Note";
  const status = note.status === "kept" ? " · Kept" : note.status === "dismissed" ? " · Dismissed" : "";
  return `${kind}${status}`;
}

function NoteCard({ note, id, label, className, ghost, wire = true, children }: { note: IvyNote; id: string; label: string; className: string; ghost?: string; wire?: boolean; children?: ReactNode }) {
  return (
    <div className={className} data-ghost={ghost} data-wire={wire ? "out" : undefined} data-key={wire ? id : undefined}>
      <span className="lbl">{label}<span>{dayMonthTime(new Date(note.at))} · {modelName(note.model)}{note.mode ? ` · ${note.mode.replaceAll("-", " ")}` : ""}</span></span>
      <span className="trig">{note.trigger}</span>
      {note.text}
      {note.because && <span className="why">Because: {note.because}</span>}
      {children}
    </div>
  );
}

function RelationItem({ r, onOpen }: { r: Relation; onOpen: (slug: string) => void }) {
  const when = r.at !== undefined ? `${weekdayDayTime(new Date(r.at))}. ` : "";
  const body = <><b>{r.title}</b><span>{when}{r.why}</span></>;
  if (r.open !== undefined) {
    const slug = r.open;
    return <button type="button" className="dst-relitem open" data-rel={r.kind} onClick={() => onOpen(slug)}>{body}</button>;
  }
  if (r.href) return <a className="dst-relitem" data-rel={r.kind} href={r.href} target="_blank" rel="noreferrer">{body}</a>;
  return <div className="dst-relitem" data-rel={r.kind}>{body}</div>;
}

function ProposedRelation({ note, acting }: { note: IvyNote; acting: Acting }) {
  const r = note.relates;
  return (
    <div className="dst-relitem ghost" data-rel="proposed">
      <b>{r ? `${r.kind}: ${r.label}` : "A relation"}</b>
      <span>{note.text || note.trigger}</span>
      <GhostActions keep="Keep" note={note} acting={acting} discuss={false} />
    </div>
  );
}

function RelatesTo({ page, onOpen, acting }: { page: ThreadPage; onOpen: (slug: string) => void; acting: Acting }) {
  const r = page.relations;
  const groups: [string, Relation[]][] = [
    ["Threads", r.threads],
    ["Goal it serves", r.goals],
    ["Coming up", r.events],
    ["People", r.people],
    ["Decision journal", r.decisions],
    ["Also related", r.links],
  ];
  return (
    <section className="dst-rel" aria-label="Relates to">
      <h4 className="dst-h">Relates to <span className="n">derived from the files and your calendar</span></h4>
      {page.proposedRelations.length > 0 && (
        <div className="dst-relgrp">
          <h5>Ivy proposes</h5>
          {page.proposedRelations.map((n) => <ProposedRelation key={n.at} note={n} acting={acting} />)}
        </div>
      )}
      {relationCount(r) === 0
        ? page.proposedRelations.length === 0 && <p className="dst-none">Nothing relates to this thread yet.</p>
        : groups.filter(([, xs]) => xs.length > 0).map(([head, xs]) => (
            <div key={head} className="dst-relgrp">
              <h5>{head}</h5>
              {xs.map((x) => <RelationItem key={x.key} r={x} onOpen={onOpen} />)}
            </div>
          ))}
    </section>
  );
}

function Outcome({ page, acting, today }: { page: ThreadPage; acting: Acting; today: string }) {
  const o = page.outcome;
  const [closing, setClosing] = useState(false);
  const { acts } = acting;
  if (o.open) {
    return (
      <div className="dst-outcome">
        <span className="t"><b>Outcome</b>{o.text || "Open. A thread closes as decided, shipped or dropped."}</span>
        {!closing && <button type="button" className="desk-btn" disabled={!acts} title={acts ? undefined : NO_WRITES} onClick={() => setClosing(true)}>Close with an outcome</button>}
        {closing && acts && <CloseForm slug={acting.slug} acts={acts} today={today} onCancel={() => setClosing(false)} />}
      </div>
    );
  }
  return (
    <div className="dst-outcome closed">
      <span className="t">
        <b>Outcome</b>
        {o.label}{o.closed ? ` ${dayMonth(o.closed)}` : ""}.{o.text && ` ${o.text}`}
        {o.expect && <span className="x">Expected: {o.expect}</span>}
        {o.reviewOn && <span className="x">Review on {dayMonth(o.reviewOn)}.</span>}
      </span>
    </div>
  );
}

export function ThreadPageView({ page, onBack, onOpen, zoom, acts, onBringBack }: {
  page: ThreadPage;
  onBack: () => void;
  onOpen: (slug: string) => void;
  zoom?: ThreadZoom;
  acts?: StudioActs;
  onBringBack?: (slug: string, question: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const t = page.thread;
  useZoomMotion(ref, t.slug, zoom);
  const wires = useWires(ref, page);
  const acting: Acting = { slug: t.slug, ...(acts ? { acts } : {}) };
  return (
    <section className="dst-page" aria-label={`Thread: ${t.question}`} ref={ref} data-thread={t.slug}>
      <PageHeader onBack={onBack} actions={<ThreadActions page={page} acting={acting} {...(onBringBack ? { onBringBack } : {})} />}>{page.typeLabel} · {page.where}</PageHeader>
      <div className="dst-canvas">
        <svg className="dst-wires" aria-hidden="true">
          {wires.map((w) => <path key={w.key} d={w.d} className={w.ivy ? "ivy" : ""} />)}
        </svg>
        <div className="dst-col mid">
          <div className="dst-hub" data-hub>
            <span className="dst-type">{page.typeLabel}</span>
            <h2 className="q">{t.question}</h2>
            <div className="standlbl">Where I stand</div>
            <p className="stand">{t.stand || "Not written yet."}</p>
            <div className="dst-meta"><AreaChips areas={page.areas} /><ModelBadge policy={page.policy} /></div>
            {page.policy === "local" && <div className="dst-modelnote">A local area keeps this thread on the local model.</div>}
          </div>
          {page.standProposal && (
            <NoteCard note={page.standProposal} id="stand" label="Ivy proposes a new stand" className="dst-n ghost" ghost="stand" wire={false}>
              <GhostActions keep="Keep it as my stand" note={page.standProposal} acting={acting} />
            </NoteCard>
          )}
          <Sparring page={page} {...(acts ? { acts } : {})} />
          <Outcome page={page} acting={acting} today={localDate(new Date())} />
        </div>
        <div className="dst-col left">
          <h4 className="dst-h">Material <span className="n">{page.material.length}</span></h4>
          {page.material.length === 0 && <p className="dst-none">No material yet.</p>}
          {page.material.map((m, i) => (
            <div key={`${i}-${m.label}`} className={m.also.length ? "dst-n mat shared" : "dst-n mat"} data-wire="in" data-key={`m-${i}`}>
              <span className="k">{m.kind}</span>
              <span className="lb">{m.href ? <a href={m.href} target="_blank" rel="noreferrer">{m.label}</a> : m.label}</span>
              {m.also.map((o) => (
                <button key={o.slug} type="button" className="also" onClick={() => onOpen(o.slug)}>Also feeds “{clip(plainQuestion(o.question), 40)}”</button>
              ))}
            </div>
          ))}
          <RelatesTo page={page} onOpen={onOpen} acting={acting} />
          <details className="dst-logf">
            <summary>Log <span className="n">{page.log.length === 1 ? "1 entry" : `${page.log.length} entries`}</span></summary>
            {page.log.length
              ? <ul className="dst-log">{page.log.map((l, i) => <li key={`${i}-${l.text}`}>{l.at ? `${dayMonth(l.at)}: ` : ""}{l.text}</li>)}</ul>
              : <p className="dst-none">Nothing logged yet.</p>}
          </details>
        </div>
        <div className="dst-col right">
          <h4 className="dst-h">Ivy's notes <span className="n">dated, append-only</span></h4>
          {page.waitsOnYou && (acts
            ? <RespondBox slug={t.slug} label={`Ivy waits on you: answer the note from ${page.latest ? dayMonthTime(new Date(page.latest.at)) : "Ivy"}.`} acts={acts} />
            : <p className="dst-waits">Ivy waits on you: the latest note has no answer yet.</p>)}
          {page.ideas.map((n, i) => (
            <NoteCard key={`i-${i}-${n.at}`} id={`i-${i}-${n.at}`} note={n} label="Ivy's idea" className="dst-n ghost" ghost="idea">
              <GhostActions keep="Keep" note={n} acting={acting} />
            </NoteCard>
          ))}
          {page.notes.map((n, i) => <NoteCard key={`n-${i}-${n.at}`} id={`n-${i}-${n.at}`} note={n} label={noteLabel(n)} className={n.status === "dismissed" ? "dst-n note dismissed" : "dst-n note"} />)}
          {t.responses.length > 0 && <h4 className="dst-h">Your answers <span className="n">{t.responses.length}</span></h4>}
          {[...t.responses].reverse().map((r) => (
            <div key={r.at} className="dst-n note you">
              <span className="lbl">You answered<span>{dayMonthTime(new Date(r.at))}</span></span>
              {r.text}
            </div>
          ))}
          {page.ideas.length === 0 && page.notes.length === 0 && !page.standProposal && <p className="dst-none">Ivy has not written here yet.</p>}
        </div>
      </div>
    </section>
  );
}

export function ThreadMissing({ slug, onBack, zoom }: { slug: string; onBack: () => void; zoom?: ThreadZoom }) {
  const ref = useRef<HTMLElement>(null);
  useZoomMotion(ref, slug, zoom);
  return (
    <section className="dst-page missing" aria-label="Thread" ref={ref}>
      <PageHeader onBack={onBack}>This thread is not in the Studio. Its file may have moved or been renamed.</PageHeader>
    </section>
  );
}
