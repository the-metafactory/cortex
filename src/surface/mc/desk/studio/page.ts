import type { AreaPolicy } from "../types";
import { areaLookup, latestNote, sameSource, type BoardArea } from "./board";
import type { IvyNote, LogEntry, MaterialLink } from "./format";
import { dayMonth, outcomeLabel, safeHref, TYPE_LABEL } from "./labels";
import { NO_CONTEXT, relatesTo, type RelatesContext, type Relations } from "./relates";
import type { StudioThreadView, StudioView } from "./view";

export interface PageMaterial extends MaterialLink {
  also: { slug: string; question: string }[];
}

export type PageOutcome =
  | { open: true; text: string }
  | { open: false; label: string; closed: string | null; expect: string | null; reviewOn: string | null; text: string };

export interface ThreadPage {
  thread: StudioThreadView;
  typeLabel: string;
  where: string;
  areas: BoardArea[];
  policy: AreaPolicy;
  material: PageMaterial[];
  standProposal: IvyNote | null;
  ideas: IvyNote[];
  notes: IvyNote[];
  waitsOnYou: boolean;
  log: LogEntry[];
  outcome: PageOutcome;
  relations: Relations;
}

const newestFirst = (a: IvyNote, b: IvyNote): number => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);
const isGhost = (n: IvyNote): boolean => n.status === "open" && (n.kind === "stand" || n.kind === "idea");

function whereLine(t: StudioThreadView, maxActive: number): string {
  const opened = `opened ${dayMonth(t.opened)}`;
  if (t.state === "closed") return `closed${t.closed ? ` ${dayMonth(t.closed)}` : ""} · ${opened}`;
  if (t.state === "parked") return `parked · ${opened}`;
  if (t.place !== undefined) return `place ${t.place} of ${maxActive} · ${opened}`;
  return `over the cap · ${opened}`;
}

function outcomeOf(t: StudioThreadView): PageOutcome {
  if (t.state !== "closed") return { open: true, text: t.outcomeText };
  return {
    open: false,
    label: outcomeLabel(t),
    closed: t.closed ?? null,
    expect: t.expect ?? null,
    reviewOn: t.reviewOn ?? null,
    text: t.outcomeText,
  };
}

export function findThread(studio: StudioView, slug: string): StudioThreadView | undefined {
  return [...studio.active, ...studio.parked, ...studio.closed].find((t) => t.slug === slug);
}

export function buildThreadPage(studio: StudioView, slug: string, ctx: RelatesContext = NO_CONTEXT): ThreadPage | null {
  const thread = findThread(studio, slug);
  if (!thread) return null;
  const area = areaLookup(studio.areas);
  const others = [...studio.active, ...studio.parked, ...studio.closed].filter((o) => o.slug !== slug);
  const notes = [...thread.notes].sort(newestFirst);
  const stands = notes.filter((n) => isGhost(n) && n.kind === "stand");
  return {
    thread,
    typeLabel: TYPE_LABEL[thread.type],
    where: whereLine(thread, studio.maxActive),
    areas: thread.areas.map(area),
    policy: thread.policy,
    material: thread.material.map(({ href, ...m }) => ({
      ...m,
      ...(safeHref(href) ? { href } : {}),
      also: others.filter((o) => o.material.some((n) => sameSource(m, n))).map((o) => ({ slug: o.slug, question: o.question })),
    })),
    standProposal: stands[0] ?? null,
    ideas: notes.filter((n) => isGhost(n) && n.kind === "idea"),
    notes: notes.filter((n) => !isGhost(n)),
    waitsOnYou: latestNote(thread.notes)?.status === "open",
    log: thread.log,
    outcome: outcomeOf(thread),
    relations: relatesTo(thread, studio, ctx),
  };
}
