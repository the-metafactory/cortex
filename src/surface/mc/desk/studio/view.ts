import { DEFAULT_YES_FILTER } from "../yes-filter";
import { sparPersonas } from "./relates";
import type { AreaPolicy, DeskArea, StudioOptions } from "../types";
import { parseCaptureFile, parseProposalFile, parseThreadFile, type Parsed, type StudioTarget, type StudioThread } from "./format";

export type StudioArea = DeskArea & { policy?: AreaPolicy };

export interface StudioFile {
  path: string;
  text: string;
}

export interface StudioFiles {
  threads: StudioFile[];
  inbox: StudioFile[];
  proposals: StudioFile[];
}

export { DEFAULT_YES_FILTER } from "../yes-filter";
import type { StudioThreadView, StudioView, StudioProblem, StudioProposalView } from "../../../../desk-api/wire/studio";
export type { StudioThreadView, StudioView, StudioProblem, StudioProposalView } from "../../../../desk-api/wire/studio";

export type TrackedAreas<T extends StudioArea = StudioArea> = T[] & { readonly policyTracked: true };

const policyRevisions = new WeakMap<object, { n: number }>();

const policyFingerprint = (areas: readonly StudioArea[]): string => JSON.stringify(areas.map((a) => [a.id, a.policy ?? "cloud"]));

const ownedCopy = (value: unknown): unknown => (typeof value === "object" && value !== null ? structuredClone(value) : value);

export function trackAreaPolicies<T extends StudioArea>(areas: readonly T[]): TrackedAreas<T> {
  const own = structuredClone([...areas]);
  const counter = { n: 0 };
  let last = policyFingerprint(own);
  const noteWrite = (): void => {
    const now = policyFingerprint(own);
    if (now !== last) { counter.n++; last = now; }
  };
  const watch = <O extends object>(target: O): O => new Proxy(target, {
    get: (t, k, r) => { const v = Reflect.get(t, k, r); return typeof v === "object" && v !== null ? watch(v) : v; },
    set: (t, k, v, r) => { const ok = Reflect.set(t, k, ownedCopy(v), r); noteWrite(); return ok; },
    deleteProperty: (t, k) => { const ok = Reflect.deleteProperty(t, k); noteWrite(); return ok; },
  });
  const tracked = watch(own) as TrackedAreas<T>;
  policyRevisions.set(tracked, counter);
  return tracked;
}

export const asTrackedAreas = <T extends StudioArea>(areas: readonly T[]): TrackedAreas<T> | null => (policyRevisions.has(areas) ? (areas as TrackedAreas<T>) : null);

export function areaPolicyRevision(areas: TrackedAreas): number {
  return policyRevisions.get(areas)?.n ?? 0;
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

export function buildStudioView(files: StudioFiles, options: StudioOptions, areas: readonly StudioArea[], problems: StudioProblem[] = [], assistantName?: string): StudioView {
  const found = [...problems];

  const parseAll = <T extends { path: string }>(list: StudioFile[], parse: (path: string, text: string) => Parsed<T>): T[] =>
    list.flatMap((file) => {
      const parsed = parse(file.path, file.text);
      if (parsed.ok) return [parsed.value];
      found.push({ path: file.path, reason: parsed.reason });
      return [];
    });

  const withPolicy = <T extends { path: string; areas: string[] }>(item: T, extra: readonly string[] = []): T & { policy: AreaPolicy } => {
    const { policy, unknown } = effectivePolicy([...item.areas, ...extra], areas);
    if (unknown.length) found.push(unknownAreas(item.path, unknown));
    return { ...item, policy };
  };

  const threads: StudioThreadView[] = parseAll(files.threads, (path, text) => parseThreadFile(path, text, assistantName)).map((t) => ({ ...withPolicy(t), overCap: false, personas: sparPersonas(options, t) }));
  const active = threads
    .filter((t) => t.state === "active")
    .sort(byOpened)
    .map((t, i) => (i < options.maxActive ? { ...t, place: i + 1 } : { ...t, overCap: true }));
  const slugs = new Set(threads.map((t) => t.slug));

  const checkTarget = <T extends { path: string; target?: StudioTarget }>(item: T): T => {
    const thread = item.target?.thread;
    if (thread && !slugs.has(thread)) found.push({ path: item.path, reason: `targets the thread ${thread}, which has no readable file` });
    return item;
  };

  const inbox = parseAll(files.inbox, parseCaptureFile).map(checkTarget);
  const proposals: StudioProposalView[] = parseAll(files.proposals, parseProposalFile)
    .map(checkTarget)
    .map((p) => withPolicy(p, p.target.area ? [p.target.area] : []));

  return {
    personas: options.personas ?? [],
    maxActive: options.maxActive,
    yesFilter: options.yesFilter?.length ? { questions: [...options.yesFilter], fromConfig: true } : { questions: [...DEFAULT_YES_FILTER], fromConfig: false },
    areas: areas.map(({ id, label, color, policy }) => ({ id, label, color, policy: policy ?? "cloud" })),
    active,
    parked: threads.filter((t) => t.state === "parked").sort(byOpened),
    closed: threads.filter((t) => t.state === "closed").sort(byClosedDesc),
    inbox: inbox.sort(byTime((c) => c.at)),
    proposals: proposals.sort(byTime((p) => p.proposed)),
    problems: found,
  };
}
