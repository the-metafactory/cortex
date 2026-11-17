import { needsResponse, responseCoverage } from "./response";
import type { AssistantNote, MaterialLink } from "./format";
import type { StudioThreadView, StudioView } from "./view";
import type { StudioThreadDerived, StudioThreadOutcome } from "../../../../desk-api/wire/studio";

export const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

export function latestNote(notes: readonly AssistantNote[]): AssistantNote | null {
  let best: AssistantNote | null = null;
  for (const n of notes) if (best === null || time(n.at) >= time(best.at)) best = n;
  return best;
}

export function waitsOnYou(thread: Pick<StudioThreadView, "notes" | "responses">): boolean {
  const latest = latestNote(thread.notes);
  if (latest?.status !== "open") return false;
  const at = time(latest.at);
  return !thread.responses.some((r) => responseCoverage(thread, r) >= at);
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

const newestFirst = (a: AssistantNote, b: AssistantNote): number => time(b.at) - time(a.at);
const isGhost = (note: AssistantNote): boolean => note.status === "open" && (note.kind === "stand" || note.kind === "idea");

function outcomeOf(thread: StudioThreadView): StudioThreadOutcome {
  if (thread.state !== "closed") return { open: true, text: thread.outcomeText };
  if (!thread.outcome) throw new Error("A closed Studio thread needs an outcome.");
  return {
    open: false,
    outcome: thread.outcome,
    closed: thread.closed ?? null,
    expect: thread.expect ?? null,
    reviewOn: thread.reviewOn ?? null,
    text: thread.outcomeText,
  };
}

export const allThreads = (studio: StudioView): StudioThreadView[] => [...studio.active, ...studio.parked, ...studio.closed];

const sourceKeys = (link: MaterialLink): string[] => {
  const href = link.href?.trim();
  const label = normaliseLabel(link.label);
  return [...(href ? [`href:${href}`] : []), ...(label ? [`label:${label}`] : [])];
};

export function buildMaterialSourceIndex(studio: StudioView) {
  const threads = allThreads(studio);
  const keys = new Map<MaterialLink, string[]>();
  const sources = new Map<string, Set<number>>();
  threads.forEach((thread, position) => {
    for (const link of thread.material) {
      const linkKeys = keys.get(link) ?? sourceKeys(link);
      keys.set(link, linkKeys);
      for (const key of linkKeys) {
        const positions = sources.get(key) ?? new Set<number>();
        positions.add(position);
        sources.set(key, positions);
      }
    }
  });
  return (link: MaterialLink, slug: string): { slug: string; question: string }[] => {
    const positions = new Set<number>();
    for (const key of keys.get(link) ?? sourceKeys(link)) {
      for (const position of sources.get(key) ?? []) positions.add(position);
    }
    return [...positions].sort((a, b) => a - b).flatMap(position => {
      const other = threads[position];
      return other && other.slug !== slug ? [{ slug: other.slug, question: other.question }] : [];
    });
  };
}

export function buildThreadFacts(studio: StudioView, thread: StudioThreadView, alsoFor = buildMaterialSourceIndex(studio)) {
  const sorted = [...thread.notes].sort(newestFirst);
  const notes = sorted.filter(note => !isGhost(note) && note.kind !== "relation");
  const derived: StudioThreadDerived = {
    waitsOnYou: waitsOnYou(thread),
    needsResponse: needsResponse(thread),
    notes: { open: notes.filter(note => note.status === "open"), kept: notes.filter(note => note.status === "kept") },
    standProposal: sorted.find(note => isGhost(note) && note.kind === "stand") ?? null,
    ideas: sorted.filter(note => isGhost(note) && note.kind === "idea"),
    outcome: outcomeOf(thread),
    where: { state: thread.state, place: thread.place ?? null, maxActive: studio.maxActive, opened: thread.opened },
  };
  const material = thread.material.map(link => ({
    ...link,
    also: alsoFor(link, thread.slug),
  }));
  return { derived, material, notes, latest: latestNote(thread.notes) };
}
