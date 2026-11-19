import { latestNote, sameSource, time, waitsOnYou } from "./thread-facts";
export { latestNote, normaliseLabel, sameSource, waitsOnYou } from "./thread-facts";
import type { AreaPolicy } from "../types";
import type { AssistantNote, StudioCapture, StudioTarget } from "./format";
import type { StudioProblem, StudioProposalView, StudioThreadView, StudioView } from "./view";
import type { StudioBoard, StudioBoardSharedPair, StudioBoardTarget } from "../../../../desk-api/wire/studio";

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
  latest: AssistantNote | null;
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

type SharedPair = StudioBoardSharedPair;

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

function lookWindow(clock: BoardClock): StudioBoard["look"] {
  if (clock.lastLook === null) return { since: clock.now - DAY_MS, kind: "day" };
  const lastEvening = clock.lastLook < clock.startOfToday && clock.lastLook >= clock.startOfToday - EVENING_MS;
  return { since: clock.lastLook, kind: lastEvening ? "overnight" : "since-look" };
}

function resolveTarget(target: StudioTarget | undefined, bySlug: ReadonlyMap<string, StudioThreadView & { place: number }>, firstFree: number | undefined): StudioBoardTarget {
  if (!target) return { kind: null, why: "no-target" };
  if (target.thread !== undefined) {
    const thread = bySlug.get(target.thread);
    return thread ? { kind: "thread", slug: thread.slug, place: thread.place, why: "named-thread" } : { kind: null, why: "thread-off-board" };
  }
  return firstFree === undefined ? { kind: null, why: "no-free" } : { kind: "free", place: firstFree, area: target.area ?? null, why: "first-free" };
}

export function buildBoardFacts(studio: StudioView, clock: BoardClock): StudioBoard {
  const placed = studio.active.filter((t): t is StudioThreadView & { place: number } => t.place !== undefined);
  const bySlug = new Map(placed.map((t) => [t.slug, t]));
  const freePlaces = Array.from({ length: studio.maxActive }, (_, i) => i + 1).filter((p) => !placed.some((t) => t.place === p));
  return {
    inbox: studio.inbox.map((capture) => ({ id: capture.id, target: resolveTarget(capture.target, bySlug, freePlaces[0]) })),
    proposals: studio.proposals.map((proposal) => ({ id: proposal.id, target: resolveTarget(proposal.target, bySlug, freePlaces[0]) })),
    shared: sharedPairs(placed),
    freePlaces,
    waiting: placed.filter(waitsOnYou).length,
    look: lookWindow(clock),
  };
}

function placesSentence(used: number, max: number, waiting: number): string {
  const inUse = used === 1 ? `1 of ${max} places is in use` : `${used} of ${max} places are in use`;
  if (waiting === 0) return `${inUse}.`;
  return `${inUse}, and I wait on you in ${waiting === 1 ? "one of them" : `${waiting} of them`}.`;
}

const viaName = (via: string): string => (via === "voice" ? "the voice note" : via === "mail" ? "the forwarded mail" : "a capture");

export function buildBoard(studio: StudioView, clock: BoardClock, name: string): Board {
  const area = areaLookup(studio.areas);
  const placed = studio.active.filter((t): t is StudioThreadView & { place: number } => t.place !== undefined);
  const facts = buildBoardFacts(studio, clock);
  const pairs = facts.shared;
  const bySlug = new Map(placed.map((t) => [t.slug, t]));

  const looseSentence = (target: StudioTarget | undefined, resolved: BoardTarget | null, proposal: boolean): string => {
    if (!target) return `${name} has no place for it yet.`;
    if (resolved?.kind === "thread") {
      const t = bySlug.get(resolved.slug);
      return `${name} would file it into “${clip(plainQuestion(t?.question ?? resolved.slug), 40)}”, place ${resolved.place}.`;
    }
    if (resolved?.kind === "free") {
      const under = target.area ? `, under ${area(target.area).label}` : "";
      return proposal ? `${name} would put it in place ${resolved.place}${under}.` : `${name} would make it a thread in place ${resolved.place}${under}.`;
    }
    if (target.thread !== undefined) return `${name} would file it into a thread that is not on the board.`;
    return "Every place is taken, so opening it would park a thread.";
  };

  const inbox: BoardCapture[] = studio.inbox.map((capture) => {
    const target = boardTarget(resolveTarget(capture.target, bySlug, facts.freePlaces[0]));
    return { id: capture.id, capture, target, reason: capture.target?.reason ?? null, sentence: looseSentence(capture.target, target, false) };
  });
  const proposals: BoardProposal[] = studio.proposals.map((proposal) => {
    const target = boardTarget(resolveTarget(proposal.target, bySlug, facts.freePlaces[0]));
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
    ...proposals.filter((p) => p.target?.kind === "free" && p.target.place === place).map(() => `${name}'s proposed thread`),
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

  const { since, kind } = facts.look;
  const lead = { day: "In the last day,", overnight: "Overnight", "since-look": "Since you last looked," }[kind];
  const thought = [...studio.active, ...studio.parked].filter((t) => t.notes.some((n) => {
    const at = time(n.at);
    return at > since && at <= clock.now;
  }));
  const thoughtAbout = thought.map((t) => `“${clip(plainQuestion(t.question), 48)}”`);
  const waiting = facts.waiting;
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

function boardTarget(target: StudioBoardTarget): BoardTarget | null {
  if (target.kind === null) return null;
  return target.kind === "thread" ? { kind: "thread", slug: target.slug, place: target.place } : { kind: "free", place: target.place };
}
