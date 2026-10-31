import { parseCaptureFile, parseProposalFile, parseThreadFile, type Parsed, type StudioCapture, type StudioProposal, type StudioTarget, type StudioThread } from "./format";

export const AREA_POLICIES = ["local", "cloud"] as const;
export type AreaPolicy = (typeof AREA_POLICIES)[number];

export interface StudioArea {
  id: string;
  label: string;
  color: string;
  policy?: AreaPolicy;
}

export interface StudioOptions {
  dir: string;
  maxActive: number;
}

export interface StudioFile {
  path: string;
  text: string;
}

export interface StudioFiles {
  threads: StudioFile[];
  inbox: StudioFile[];
  proposals: StudioFile[];
}

export interface StudioProblem {
  path: string;
  reason: string;
}

export interface StudioThreadView extends StudioThread {
  policy: AreaPolicy;
  place?: number;
  overCap: boolean;
}

export interface StudioProposalView extends StudioProposal {
  policy: AreaPolicy;
}

export interface StudioView {
  maxActive: number;
  areas: { id: string; label: string; color: string; policy: AreaPolicy }[];
  active: StudioThreadView[];
  parked: StudioThreadView[];
  closed: StudioThreadView[];
  inbox: StudioCapture[];
  proposals: StudioProposalView[];
  problems: StudioProblem[];
}

export function effectivePolicy(areaIds: readonly string[], areas: readonly StudioArea[]): { policy: AreaPolicy; unknown: string[] } {
  const byId = new Map(areas.map((a) => [a.id, a.policy ?? "cloud"]));
  const unknown = areaIds.filter((id) => !byId.has(id));
  const local = unknown.length > 0 || areaIds.some((id) => byId.get(id) === "local");
  return { policy: local ? "local" : "cloud", unknown };
}

const unknownAreas = (path: string, unknown: string[]): StudioProblem => ({
  path,
  reason: `names area${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} that the Desk config does not list; it is kept on the local model`,
});

const byOpened = (a: StudioThread, b: StudioThread): number => a.opened.localeCompare(b.opened) || a.slug.localeCompare(b.slug);
const byClosedDesc = (a: StudioThread, b: StudioThread): number => (b.closed ?? b.opened).localeCompare(a.closed ?? a.opened) || a.slug.localeCompare(b.slug);
const byTime = <T extends { id: string }>(time: (x: T) => string) => (a: T, b: T): number => Date.parse(time(a)) - Date.parse(time(b)) || a.id.localeCompare(b.id);

export function buildStudioView(files: StudioFiles, options: StudioOptions, areas: readonly StudioArea[], problems: StudioProblem[] = []): StudioView {
  const found = [...problems];
  const threads: StudioThreadView[] = [];
  for (const file of files.threads) {
    const parsed = parseThreadFile(file.path, file.text);
    if (!parsed.ok) {
      found.push({ path: file.path, reason: parsed.reason });
      continue;
    }
    const { policy, unknown } = effectivePolicy(parsed.value.areas, areas);
    if (unknown.length) found.push(unknownAreas(file.path, unknown));
    threads.push({ ...parsed.value, policy, overCap: false });
  }

  const active = threads
    .filter((t) => t.state === "active")
    .sort(byOpened)
    .map((t, i) => (i < options.maxActive ? { ...t, place: i + 1 } : { ...t, overCap: true }));
  const slugs = new Set(threads.map((t) => t.slug));

  const parseAll = <T extends { path: string; target?: StudioTarget }>(list: StudioFile[], parse: (path: string, text: string) => Parsed<T>): T[] =>
    list.flatMap((file) => {
      const parsed = parse(file.path, file.text);
      if (!parsed.ok) {
        found.push({ path: file.path, reason: parsed.reason });
        return [];
      }
      if (parsed.value.target?.thread && !slugs.has(parsed.value.target.thread)) found.push({ path: file.path, reason: `targets the thread ${parsed.value.target.thread}, which has no readable file` });
      return [parsed.value];
    });

  const inbox = parseAll(files.inbox, parseCaptureFile);
  const proposals: StudioProposalView[] = parseAll(files.proposals, parseProposalFile).map((p) => {
    const { policy, unknown } = effectivePolicy(p.areas, areas);
    if (unknown.length) found.push(unknownAreas(p.path, unknown));
    return { ...p, policy };
  });

  return {
    maxActive: options.maxActive,
    areas: areas.map(({ id, label, color, policy }) => ({ id, label, color, policy: policy ?? "cloud" })),
    active,
    parked: threads.filter((t) => t.state === "parked").sort(byOpened),
    closed: threads.filter((t) => t.state === "closed").sort(byClosedDesc),
    inbox: inbox.sort(byTime((c) => c.at)),
    proposals: proposals.sort(byTime((p) => p.proposed)),
    problems: found,
  };
}
