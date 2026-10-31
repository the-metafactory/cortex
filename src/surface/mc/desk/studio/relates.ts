import type { DeskEvent, DeskGoal } from "../types";
import { clip, normaliseLabel, sameSource } from "./board";
import type { MaterialLink } from "./format";
import { outcomeLabel, withHref } from "./labels";
import type { StudioThreadView, StudioView } from "./view";

const PERSON_KINDS = ["person", "people", "contact"] as const;

const GOAL_ID = /^(G[1-9]\d*)\b[\s:.-]*/i;
const MIN_EVENT_TITLE = 4;
const MAX_EVENTS = 5;
const CALENDAR_KINDS: readonly DeskEvent["kind"][] = ["meeting", "all-day", "reminder"];
const GOAL_STATE: Record<DeskGoal["state"], string> = {
  "on-track": "on track",
  "at-risk": "at risk",
  "off-track": "off track",
  stale: "without a fresh reading",
  unknown: "without a reading",
};

export type RelationKind = "thread" | "goal" | "event" | "person" | "decision" | "link";

export interface Relation {
  kind: RelationKind;
  key: string;
  title: string;
  why: string;
  open?: string;
  href?: string;
  at?: number;
}

export interface Relations {
  threads: Relation[];
  goals: Relation[];
  events: Relation[];
  people: Relation[];
  decisions: Relation[];
  links: Relation[];
}

export interface RelatesContext {
  now: number;
  events: readonly DeskEvent[];
  goals: readonly DeskGoal[];
}

export const NO_CONTEXT: RelatesContext = { now: 0, events: [], goals: [] };

export const relationCount = (r: Relations): number => r.threads.length + r.goals.length + r.events.length + r.people.length + r.decisions.length + r.links.length;

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const sharedLink = (a: StudioThreadView, b: StudioThreadView): MaterialLink | undefined => a.material.find((m) => b.material.some((n) => sameSource(m, n)));

const containsWords = (hay: string, needle: string): boolean => ` ${hay} `.includes(` ${needle} `);

function uniqueBy<T>(list: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function threadRelations(thread: StudioThreadView, studio: StudioView): Relation[] {
  return [...studio.active, ...studio.parked]
    .filter((o) => o.slug !== thread.slug)
    .flatMap((o) => {
      const hit = sharedLink(thread, o);
      return hit ? [{ kind: "thread" as const, key: `thread:${o.slug}`, title: o.question, why: `Shares a source: ${hit.label}.`, open: o.slug }] : [];
    });
}

function goalRelations(thread: StudioThreadView, goals: readonly DeskGoal[]): Relation[] {
  const byId = new Map(goals.map((g) => [g.id.toUpperCase(), g]));
  const found = thread.material
    .filter((m) => m.kind.toLowerCase() === "goal")
    .map((m): Relation => {
      const id = GOAL_ID.exec(m.label)?.[1]?.toUpperCase();
      const goal = id ? byId.get(id) : undefined;
      const rest = m.label.replace(GOAL_ID, "").trim() || m.label;
      const why = goal ? `The goal this thread serves, ${GOAL_STATE[goal.state]}.` : "The goal this thread serves, named in its material.";
      return { kind: "goal", key: `goal:${id ?? normaliseLabel(m.label)}`, title: goal ? goal.text : capitalise(rest), why, ...withHref(m.href) };
    });
  return uniqueBy(found, (r) => r.key);
}

function eventRelations(thread: StudioThreadView, ctx: RelatesContext): Relation[] {
  const question = normaliseLabel(thread.question);
  const labels = thread.material.map((m) => ({ label: m.label, norm: normaliseLabel(m.label) }));
  const found = ctx.events
    .filter((e) => CALENDAR_KINDS.includes(e.kind) && (e.end ?? e.at) >= ctx.now)
    .flatMap((e): Relation[] => {
      const title = normaliseLabel(e.title);
      if (title.length < MIN_EVENT_TITLE) return [];
      const named = labels.find((l) => containsWords(l.norm, title));
      const why = named ? `Named in the material: ${clip(named.label, 60)}.` : containsWords(question, title) ? "Matches the thread's question." : null;
      return why ? [{ kind: "event", key: `event:${e.key}`, title: e.title, why, at: e.at, ...withHref(e.url) }] : [];
    })
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return uniqueBy(found, (r) => r.key).slice(0, MAX_EVENTS);
}

function peopleRelations(thread: StudioThreadView): Relation[] {
  const found = thread.material
    .filter((m) => (PERSON_KINDS as readonly string[]).includes(m.kind.toLowerCase()))
    .map((m): Relation => ({ kind: "person", key: `person:${normaliseLabel(m.label)}`, title: m.label, why: "Named in the thread's material.", ...withHref(m.href) }));
  return uniqueBy(found, (r) => r.key);
}

function decisionRelations(thread: StudioThreadView, studio: StudioView): Relation[] {
  const areaLabel = new Map(studio.areas.map((a) => [a.id, a.label]));
  return studio.closed
    .filter((c) => c.slug !== thread.slug)
    .flatMap((c): Relation[] => {
      const hit = sharedLink(thread, c);
      const area = hit ? undefined : c.areas.find((a) => thread.areas.includes(a));
      if (!hit && area === undefined) return [];
      const via = hit ? `Shares a source: ${hit.label}.` : `Same area: ${areaLabel.get(area ?? "") ?? area}.`;
      const head = `${outcomeLabel(c)}${c.closed ? ` ${c.closed}` : ""}.`;
      const said = c.expect ? ` Expected: ${clip(c.expect, 80)}` : c.outcomeText ? ` ${clip(c.outcomeText, 80)}` : "";
      return [{ kind: "decision", key: `decision:${c.slug}`, title: c.question, why: `${head}${said} ${via}`.replace(/\s+/g, " "), open: c.slug }];
    });
}

export const KEPT_WHY = "Ivy proposed it and you kept it.";

function keptRelations(thread: StudioThreadView, studio: StudioView): Relation[] {
  const known = new Map([...studio.active, ...studio.parked, ...studio.closed].map((t) => [t.slug, t]));
  return thread.notes.flatMap((n): Relation[] => {
    const r = n.relates;
    if (n.kind !== "relation" || n.status !== "kept" || !r) return [];
    const why = n.text ? `${clip(n.text, 100)} ${KEPT_WHY}` : KEPT_WHY;
    const kind = r.kind.toLowerCase();
    if (kind === "thread") {
      const slug = r.label.trim();
      const other = known.get(slug);
      return [{ kind: "thread", key: `kept:${n.at}`, title: other?.question ?? slug, why, ...(other ? { open: slug } : {}) }];
    }
    const as: RelationKind = kind === "goal" ? "goal" : (PERSON_KINDS as readonly string[]).includes(kind) ? "person" : "link";
    return [{ kind: as, key: `kept:${n.at}`, title: r.label, why, ...withHref(r.href) }];
  });
}

export function relatesTo(thread: StudioThreadView, studio: StudioView, ctx: RelatesContext = NO_CONTEXT): Relations {
  const kept = keptRelations(thread, studio);
  const keptThreads = kept.filter((k) => k.kind === "thread");
  const derived = threadRelations(thread, studio).map((d) => (keptThreads.some((k) => k.open === d.open) ? { ...d, why: `${d.why} ${KEPT_WHY}` } : d));
  return {
    threads: [...derived, ...keptThreads.filter((k) => k.open === undefined || !derived.some((d) => d.open === k.open))],
    goals: [...goalRelations(thread, ctx.goals), ...kept.filter((k) => k.kind === "goal")],
    events: eventRelations(thread, ctx),
    people: [...peopleRelations(thread), ...kept.filter((k) => k.kind === "person")],
    decisions: decisionRelations(thread, studio),
    links: kept.filter((k) => k.kind === "link"),
  };
}
