import type { AreaPolicy } from "../types";
import type { IvyNote, MaterialLink, StudioCapture, StudioTarget } from "./format";
import type { StudioProblem, StudioProposalView, StudioThreadView, StudioView } from "./view";

const DAY_MS = 86_400_000;
const EVENING_MS = 6 * 3_600_000;
const UNKNOWN_AREA_COLOR = "#a1a1aa";

export type BoardArea = StudioView["areas"][number];

export interface SharedSource {
  slug: string;
  question: string;
  label: string;
}

export interface BoardCard {
  kind: "thread";
  place: number;
  thread: StudioThreadView;
  stand: string;
  latest: IvyNote | null;
  waitsOnYou: boolean;
  areas: BoardArea[];
  shared: SharedSource[];
}

export interface BoardFree {
  kind: "free";
  place: number;
  incoming: string[];
}

export type BoardPlace = BoardCard | BoardFree;

export type BoardTarget = { kind: "thread"; slug: string; place: number } | { kind: "free"; place: number };

export interface BoardLoose {
  id: string;
  target: BoardTarget | null;
  reason: string | null;
  sentence: string;
}

export interface BoardCapture extends BoardLoose {
  capture: StudioCapture;
}

export interface BoardProposal extends BoardLoose {
  proposal: StudioProposalView;
  areas: BoardArea[];
}

export interface SharedPair {
  a: string;
  b: string;
  label: string;
}

export interface Board {
  summary: string;
  thoughtAbout: string[];
  places: BoardPlace[];
  overCap: StudioThreadView[];
  inbox: BoardCapture[];
  proposals: BoardProposal[];
  shared: SharedPair[];
  parked: StudioThreadView[];
  closed: StudioThreadView[];
  problems: StudioProblem[];
}

export interface BoardClock {
  now: number;
  startOfToday: number;
  lastLook: number | null;
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const atWord = cut.replace(/\s+\S*$/, "");
  return `${(atWord.length > max / 2 ? atWord : cut).replace(/[\s,;:.]+$/, "")}…`;
}

export const plainQuestion = (q: string): string => q.trim().replace(/[?.!]+$/, "");

const joinAnd = (parts: string[]): string => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`);

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

export function latestNote(notes: readonly IvyNote[]): IvyNote | null {
  let best: IvyNote | null = null;
  for (const n of notes) if (best === null || time(n.at) >= time(best.at)) best = n;
  return best;
}

export function waitsOnYou(thread: Pick<StudioThreadView, "notes" | "responses">): boolean {
  const latest = latestNote(thread.notes);
  if (latest?.status !== "open") return false;
  const at = time(latest.at);
  return !thread.responses.some((r) => time(r.at) >= at);
}

export function normaliseLabel(label: string): string {
  return label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function sameSource(a: MaterialLink, b: MaterialLink): boolean {
  const href = a.href?.trim();
  if (href && href === b.href?.trim()) return true;
  const la = normaliseLabel(a.label);
  return la.length > 0 && la === normaliseLabel(b.label);
}

export function sharedPairs(threads: readonly StudioThreadView[]): SharedPair[] {
  const pairs: SharedPair[] = [];
  threads.forEach((a, i) => {
    for (const b of threads.slice(i + 1)) {
      const hit = a.material.find((m) => b.material.some((n) => sameSource(m, n)));
      if (hit) pairs.push({ a: a.slug, b: b.slug, label: hit.label });
    }
  });
  return pairs;
}

export function areaLookup(areas: readonly BoardArea[]): (id: string) => BoardArea {
  const byId = new Map(areas.map((a) => [a.id, a]));
  return (id) => byId.get(id) ?? { id, label: id, color: UNKNOWN_AREA_COLOR, policy: "local" satisfies AreaPolicy };
}

function lookWindow(clock: BoardClock): { since: number; lead: string } {
  if (clock.lastLook === null) return { since: clock.now - DAY_MS, lead: "In the last day," };
  const lastEvening = clock.lastLook < clock.startOfToday && clock.lastLook >= clock.startOfToday - EVENING_MS;
  return { since: clock.lastLook, lead: lastEvening ? "Overnight" : "Since you last looked," };
}

function placesSentence(used: number, max: number, waiting: number): string {
  const inUse = used === 1 ? `1 of ${max} places is in use` : `${used} of ${max} places are in use`;
  if (waiting === 0) return `${inUse}.`;
  return `${inUse}, and I wait on you in ${waiting === 1 ? "one of them" : `${waiting} of them`}.`;
}

const viaName = (via: string): string => (via === "voice" ? "the voice note" : via === "mail" ? "the forwarded mail" : "a capture");

export function buildBoard(studio: StudioView, clock: BoardClock): Board {
  const area = areaLookup(studio.areas);
  const placed = studio.active.filter((t): t is StudioThreadView & { place: number } => t.place !== undefined);
  const pairs = sharedPairs(placed);
  const bySlug = new Map(placed.map((t) => [t.slug, t]));
  const freePlaces = Array.from({ length: studio.maxActive }, (_, i) => i + 1).filter((p) => !placed.some((t) => t.place === p));
  const firstFree = freePlaces[0];

  const resolve = (target: StudioTarget | undefined): BoardTarget | null => {
    if (!target) return null;
    if (target.thread !== undefined) {
      const t = bySlug.get(target.thread);
      return t ? { kind: "thread", slug: t.slug, place: t.place } : null;
    }
    return firstFree === undefined ? null : { kind: "free", place: firstFree };
  };

  const looseSentence = (target: StudioTarget | undefined, resolved: BoardTarget | null, proposal: boolean): string => {
    if (!target) return "Ivy has no place for it yet.";
    if (resolved?.kind === "thread") {
      const t = bySlug.get(resolved.slug);
      return `Ivy would file it into “${clip(plainQuestion(t?.question ?? resolved.slug), 40)}”, place ${resolved.place}.`;
    }
    if (resolved?.kind === "free") {
      const under = target.area ? `, under ${area(target.area).label}` : "";
      return proposal ? `Ivy would put it in place ${resolved.place}${under}.` : `Ivy would make it a thread in place ${resolved.place}${under}.`;
    }
    if (target.thread !== undefined) return "Ivy would file it into a thread that is not on the board.";
    return "Every place is taken, so opening it would park a thread.";
  };

  const inbox: BoardCapture[] = studio.inbox.map((capture) => {
    const target = resolve(capture.target);
    return { id: capture.id, capture, target, reason: capture.target?.reason ?? null, sentence: looseSentence(capture.target, target, false) };
  });
  const proposals: BoardProposal[] = studio.proposals.map((proposal) => {
    const target = resolve(proposal.target);
    return {
      id: proposal.id,
      proposal,
      areas: proposal.areas.map(area),
      target,
      reason: proposal.target.reason,
      sentence: looseSentence(proposal.target, target, true),
    };
  });

  const incoming = (place: number): string[] => [
    ...inbox.filter((c) => c.target?.kind === "free" && c.target.place === place).map((c) => viaName(c.capture.via)),
    ...proposals.filter((p) => p.target?.kind === "free" && p.target.place === place).map(() => "Ivy's proposed thread"),
  ];

  const places: BoardPlace[] = Array.from({ length: studio.maxActive }, (_, i) => {
    const place = i + 1;
    const thread = placed.find((t) => t.place === place);
    if (!thread) return { kind: "free", place, incoming: incoming(place) };
    const shared = pairs
      .filter((p) => p.a === thread.slug || p.b === thread.slug)
      .map((p) => {
        const other = bySlug.get(p.a === thread.slug ? p.b : p.a);
        return { slug: other?.slug ?? "", question: other?.question ?? "", label: p.label };
      });
    return {
      kind: "thread",
      place,
      thread,
      stand: clip(thread.stand, 120),
      latest: latestNote(thread.notes),
      waitsOnYou: waitsOnYou(thread),
      areas: thread.areas.map(area),
      shared,
    };
  });

  const { since, lead } = lookWindow(clock);
  const thought = [...studio.active, ...studio.parked].filter((t) => t.notes.some((n) => time(n.at) > since && time(n.at) <= clock.now));
  const thoughtAbout = thought.map((t) => `“${clip(plainQuestion(t.question), 48)}”`);
  const waiting = places.filter((p) => p.kind === "thread" && p.waitsOnYou).length;
  const thoughtSentence = thought.length === 0 ? "" : `${lead} I thought about ${thought.length === 1 ? "1 thread" : `${thought.length} threads`}: ${joinAnd(thoughtAbout)}. `;

  return {
    summary: `${thoughtSentence}${placesSentence(placed.length, studio.maxActive, waiting)}`,
    thoughtAbout: thought.map((t) => t.slug),
    places,
    overCap: studio.active.filter((t) => t.overCap),
    inbox,
    proposals,
    shared: pairs,
    parked: studio.parked,
    closed: studio.closed,
    problems: studio.problems,
  };
}
