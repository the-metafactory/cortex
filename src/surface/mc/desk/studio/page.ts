import type { StudioThreadDerived } from "../../../../desk-api/wire/studio";
import { allThreads, buildThreadFacts, time } from "./thread-facts";
import { threadThinking, type ThreadThinking } from "./thinking-view";
import type { AreaPolicy } from "../types";
import { areaLookup, type BoardArea } from "./board";
import type { AssistantNote, LogEntry, MaterialLink } from "./format";
import { dayMonth, outcomeLabel, TYPE_LABEL, withHref } from "./labels";
import { NO_CONTEXT, relatesTo, type RelatesContext, type Relations, type SparPersona } from "./relates";
import type { StudioThreadView, StudioView } from "./view";

export interface PageMaterial extends MaterialLink {
  also: { slug: string; question: string }[];
}

export type PageOutcome =
  | { open: true; text: string }
  | { open: false; label: string; closed: string | null; expect: string | null; reviewOn: string | null; text: string };

export interface ThreadPage {
  thread: StudioThreadView;
  personas: SparPersona[];
  thinking: ThreadThinking;
  typeLabel: string;
  where: string;
  areas: BoardArea[];
  choices: BoardArea[];
  policy: AreaPolicy;
  material: PageMaterial[];
  standProposal: AssistantNote | null;
  ideas: AssistantNote[];
  notes: AssistantNote[];
  proposedRelations: AssistantNote[];
  latest: AssistantNote | null;
  waitsOnYou: boolean;
  needsResponse: boolean;
  log: LogEntry[];
  outcome: PageOutcome;
  relations: Relations;
}

const newestFirst = (a: AssistantNote, b: AssistantNote): number => time(b.at) - time(a.at);

function pageOutcome(outcome: StudioThreadDerived["outcome"], thread: StudioThreadView): PageOutcome {
  if (outcome.open) return outcome;
  const { outcome: _code, ...rest } = outcome;
  return { ...rest, label: outcomeLabel(thread) };
}

function whereLine(t: StudioThreadDerived["where"], closed: string | null): string {
  const opened = `opened ${dayMonth(t.opened)}`;
  if (t.state === "closed") return `closed${closed ? ` ${dayMonth(closed)}` : ""} · ${opened}`;
  if (t.state === "parked") return `parked · ${opened}`;
  if (t.place !== null) return `place ${t.place} of ${t.maxActive} · ${opened}`;
  return `over the cap · ${opened}`;
}

export function findThread(studio: StudioView, slug: string): StudioThreadView | undefined {
  return allThreads(studio).find((t) => t.slug === slug);
}

export const proposedRelations = (thread: StudioThreadView): AssistantNote[] => [...thread.notes].sort(newestFirst).filter((n) => n.kind === "relation" && n.status === "open");

export function buildThreadPage(studio: StudioView, slug: string, ctx: RelatesContext = NO_CONTEXT): ThreadPage | null {
  const thread = findThread(studio, slug);
  if (!thread) return null;
  const area = areaLookup(studio.areas);
  const { derived, material, notes, latest } = buildThreadFacts(studio, thread);
  return {
    thread,
    personas: thread.personas,
    thinking: threadThinking(studio, thread),
    typeLabel: TYPE_LABEL[thread.type],
    where: whereLine(derived.where, derived.outcome.open ? null : derived.outcome.closed),
    areas: thread.areas.map(area),
    choices: studio.areas,
    policy: thread.policy,
    material: material.map(({ href, ...link }) => ({ ...link, ...withHref(href) })),
    standProposal: derived.standProposal,
    ideas: derived.ideas,
    notes,
    proposedRelations: proposedRelations(thread),
    latest,
    waitsOnYou: derived.waitsOnYou,
    needsResponse: derived.needsResponse,
    log: thread.log,
    outcome: pageOutcome(derived.outcome, thread),
    relations: relatesTo(thread, studio, ctx),
  };
}
