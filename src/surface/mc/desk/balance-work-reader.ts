import type { Json } from "../../../conversations/domain-adapters/operations/types";
import type { HostContext } from "../../../conversations/authority";
import type { ReleaseSink } from "../../../conversations/authority-records";
import type { QueryRunner } from "../../../conversations/domain-adapters/reads/query";
import type { SchemaRef } from "../../../conversations/domain-adapters/types";
import { QUERY_LIMITS, type QueryResult } from "../../../conversations/domain-adapters/reads/query-types";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import type { WorkKind, WorkObject, WorkPage, WorkRead, WorkReader } from "../../../conversations/tools/work-context";
import type { Policy } from "../../../conversations/types";

export interface BalanceWorkArea {
  readonly id: string;
  readonly label: string;
  readonly policy?: Policy;
}
type BalanceCapability = "balance.task.query" | "balance.task.read" | "balance.project.query" | "balance.project.read";
type BalanceKind = Extract<WorkKind, "balance-task" | "balance-project">;
type BalanceObjectType = "task" | "project";
export interface BalanceQueryRequest {
  readonly capabilityId: BalanceCapability;
  readonly input: Json;
  readonly destinations: readonly ObjectReference[];
  readonly limit: number;
}
export interface BalanceQueryRun {
  readonly result: QueryResult;
  readonly released?: Json;
}
export interface BalanceWorkQuery {
  readonly connectionId: string;
  readonly areas: readonly BalanceWorkArea[];
  readonly run: (request: BalanceQueryRequest) => Promise<BalanceQueryRun>;
}
export interface BalanceWorkRunner {
  readonly connectionId: string;
  readonly areas: readonly BalanceWorkArea[];
  readonly runner: Pick<QueryRunner, "create" | "run">;
  readonly context: HostContext;
  readonly sink: ReleaseSink;
  readonly inputSchemaRef: (capabilityId: string) => SchemaRef;
}
export interface BalanceWorkSchemaRefs {
  readonly taskQuery: SchemaRef;
  readonly taskRead: SchemaRef;
  readonly projectQuery: SchemaRef;
  readonly projectRead: SchemaRef;
}
export const balanceWorkSchemaRef = (refs: BalanceWorkSchemaRefs): ((capabilityId: string) => SchemaRef) => capabilityId =>
  capabilityId === "balance.task.query" ? refs.taskQuery : capabilityId === "balance.task.read" ? refs.taskRead : capabilityId === "balance.project.query" ? refs.projectQuery : refs.projectRead;

interface ReleasedObject {
  readonly ref: ObjectReference;
  readonly destination: ObjectReference;
  readonly value: Record<string, unknown>;
  readonly evidence?: { readonly observedAt?: string };
}
type ObjectMapper = (query: BalanceWorkQuery, object: ReleasedObject, at: number) => WorkObject;
interface KindFacts {
  readonly search: BalanceCapability;
  readonly read: BalanceCapability;
  readonly objectType: BalanceObjectType;
  readonly toObject: ObjectMapper;
  readonly many: boolean;
}
const NO_AREA: WorkPage = { items: [], more: false, status: "unavailable", reason: "No Balance destination is available." };
const objectReference = (value: unknown): ObjectReference | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const held = value as Record<string, unknown>;
  return typeof held.adapterId === "string" && typeof held.connectionId === "string" && typeof held.objectType === "string" && typeof held.canonicalId === "string"
    ? { adapterId: held.adapterId, connectionId: held.connectionId, objectType: held.objectType, canonicalId: held.canonicalId }
    : null;
};
const releasedObjects = (released: Json): ReleasedObject[] => {
  if (typeof released !== "object" || released === null || Array.isArray(released)) return [];
  const held = (released as { objects?: unknown }).objects;
  if (!Array.isArray(held)) return [];
  const objects: ReleasedObject[] = [];
  for (const entry of held) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const ref = objectReference(raw.ref);
    const destination = objectReference(raw.destination);
    const value = raw.value;
    if (!ref || !destination || typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const evidence = typeof raw.evidence === "object" && raw.evidence !== null && !Array.isArray(raw.evidence) ? raw.evidence as { observedAt?: string } : undefined;
    objects.push({ ref, destination, value: value as Record<string, unknown>, ...(evidence ? { evidence } : {}) });
  }
  return objects;
};
const releasedOf = (run: BalanceQueryRun): ReleasedObject[] => run.released ? releasedObjects(run.released) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const areaOf = (query: BalanceWorkQuery, id: string): BalanceWorkArea | undefined => query.areas.find(area => area.id === id || area.id === `area:${id}`);
const observedAt = (object: ReleasedObject, at: number): number => {
  const time = object.evidence?.observedAt ? Date.parse(object.evidence.observedAt) : Number.NaN;
  return Number.isFinite(time) ? time : at;
};
const urlOf = (id: string): string => `?desk=balance&balance-item=${encodeURIComponent(id)}`;
const taskObject = (query: BalanceWorkQuery, object: ReleasedObject, at: number): WorkObject => {
  const areaRef = objectReference(object.value.area);
  const area = areaRef ? areaOf(query, areaRef.canonicalId) : undefined;
  const facts = [text(object.value.summary), text(object.value.note)].filter(Boolean);
  return { kind: "balance-task", id: object.ref.canonicalId, title: text(object.value.title), status: text(object.value.status), summary: facts.join("\n"), policy: area?.policy ?? "local", area: area?.label ?? null, url: urlOf(object.ref.canonicalId), observedAt: observedAt(object, at) };
};
const projectObject = (query: BalanceWorkQuery, object: ReleasedObject, at: number): WorkObject => {
  const area = areaOf(query, object.destination.canonicalId);
  const label = text(object.value.label);
  const title = area && label.startsWith(`${area.label} / `) ? label.slice(area.label.length + 3) : label;
  return { kind: "balance-project", id: object.ref.canonicalId, title, status: "open", summary: `Project in ${area?.label ?? title}`, policy: area?.policy ?? "local", area: area?.label ?? null, url: urlOf(object.ref.canonicalId), observedAt: observedAt(object, at) };
};
const pageOf = (result: QueryResult, items: WorkObject[], capability: BalanceCapability): WorkPage => {
  const groups = result.groups.filter(group => group.source.capabilityId === capability);
  const coverage = groups.find(group => group.coverage !== "exhausted")?.coverage ?? groups[0]?.coverage;
  return {
    items,
    more: result.status === "partial" || result.continuation !== undefined || coverage !== undefined && coverage !== "exhausted",
    ...(coverage ? { coverage } : {}),
    noMatch: result.noMatch,
    restricted: result.restricted || result.status === "denied",
    status: result.status,
    ...(result.reason ? { reason: result.reason.message } : {}),
    ...(result.continuation ? { continuation: result.continuation } : {}),
  };
};
const coverageOf = (pages: readonly WorkPage[]): NonNullable<WorkPage["coverage"]> =>
  pages.find(page => page.coverage !== undefined && page.coverage !== "exhausted")?.coverage ?? "exhausted";
const mergedStatus = (pages: readonly WorkPage[], items: readonly WorkObject[], restricted: boolean, more: boolean, coverage: string): NonNullable<WorkPage["status"]> => {
  if (pages.some(page => page.status === "cancelled")) return "cancelled";
  if (restricted) return items.length > 0 ? "partial" : "denied";
  if (pages.length > 0 && pages.every(page => page.status === "unsupported")) return "unsupported";
  if (pages.length > 0 && pages.every(page => page.status === "unavailable" || page.status === "unsupported")) return "unavailable";
  return more || coverage !== "exhausted" || pages.some(page => page.status === "partial") ? "partial" : "ok";
};
const mergePages = (pages: readonly WorkPage[], all: readonly WorkObject[], limit: number, offset: number, beyond: boolean): WorkPage => {
  const items = all.slice(offset, offset + limit);
  const restricted = pages.some(page => page.restricted === true || page.status === "denied");
  const coverage = coverageOf(pages);
  const more = beyond || all.length > offset + limit;
  const reason = pages.map(page => page.reason).find(value => value !== undefined);
  const continuation = pages.map(page => page.continuation).find(value => value !== undefined);
  return {
    items, more, coverage,
    noMatch: !restricted && pages.length > 0 && pages.every(page => page.noMatch === true),
    restricted,
    status: mergedStatus(pages, items, restricted, more, coverage),
    ...(reason ? { reason } : {}),
    ...(continuation ? { continuation } : {}),
  };
};
const queryPage = async (query: BalanceWorkQuery, request: BalanceQueryRequest, facts: KindFacts, at: number): Promise<WorkPage> => {
  const run = await query.run(request);
  const objects = releasedOf(run).filter(object => object.ref.objectType === facts.objectType);
  return pageOf(run.result, objects.map(object => facts.toObject(query, object, at)), facts.search);
};

export function balanceWorkQuery(config: BalanceWorkRunner): BalanceWorkQuery {
  return {
    connectionId: config.connectionId,
    areas: config.areas,
    run: async request => {
      const created = await config.runner.create(config.context, [{
        adapterId: "balance",
        connectionId: config.connectionId,
        capabilityId: request.capabilityId,
        inputSchemaRef: config.inputSchemaRef(request.capabilityId),
        destinations: [...request.destinations],
        input: request.input,
      }], config.sink);
      let released: Json | undefined;
      const result = await config.runner.run(config.context, created, config.sink, undefined, undefined, { released: value => { released = value; } });
      return { result, ...(released === undefined ? {} : { released }) };
    },
  };
}

const destinationOf = (query: BalanceWorkQuery, area: BalanceWorkArea): ObjectReference => ({ adapterId: "balance", connectionId: query.connectionId, objectType: "area", canonicalId: area.id });
interface AreaCollection {
  readonly pages: WorkPage[];
  readonly items: WorkObject[];
  readonly more: boolean;
}
const collectArea = async (query: BalanceWorkQuery, area: BalanceWorkArea, facts: KindFacts, needle: string, wanted: number, at: number): Promise<AreaCollection> => {
  const destination = destinationOf(query, area);
  const pages: WorkPage[] = [];
  const items: WorkObject[] = [];
  let more = false;
  for (;;) {
    const size = Math.min(QUERY_LIMITS.pageItems, wanted - items.length);
    if (size < 1) break;
    const page = await queryPage(query, { capabilityId: facts.search, input: { ...(facts.objectType === "task" ? { area: destination } : {}), query: needle, limit: size, offset: items.length }, destinations: [destination], limit: size }, facts, at);
    pages.push(page);
    items.push(...page.items);
    more = page.more;
    if (!page.more || page.items.length === 0) break;
  }
  return { pages, items, more };
};
const searchPage = async (query: BalanceWorkQuery, facts: KindFacts, needle: string, limit: number, offset: number, at: number): Promise<WorkPage> => {
  if (query.areas.length === 0) return NO_AREA;
  const collections = await Promise.all(query.areas.map(area => collectArea(query, area, facts, needle, offset + limit, at)));
  return mergePages(collections.flatMap(collection => collection.pages), collections.flatMap(collection => collection.items), limit, offset, collections.some(collection => collection.more));
};
const readObject = async (query: BalanceWorkQuery, facts: KindFacts, id: string, at: number): Promise<WorkRead> => {
  if (query.areas.length === 0) return { state: "unavailable", reason: "gone" };
  let denied = false;
  for (const area of query.areas) {
    const destination = destinationOf(query, area);
    const run = await query.run({ capabilityId: facts.read, input: { ref: { ...destination, objectType: facts.objectType, canonicalId: id } }, destinations: [destination], limit: 1 });
    if (run.result.status === "denied" || run.result.restricted) { denied = true; continue; }
    const object = releasedOf(run).find(entry => entry.ref.objectType === facts.objectType && entry.ref.canonicalId === id);
    if (run.result.status === "ok" && object) return { state: "available", object: facts.toObject(query, object, at) };
  }
  return { state: "unavailable", reason: denied ? "unauthorized" : "gone" };
};
const KINDS: Record<BalanceKind, KindFacts> = {
  "balance-task": { search: "balance.task.query", read: "balance.task.read", objectType: "task", toObject: taskObject, many: true },
  "balance-project": { search: "balance.project.query", read: "balance.project.read", objectType: "project", toObject: projectObject, many: false },
};
const readerFor = (query: BalanceWorkQuery, facts: KindFacts): WorkReader => {
  const read = (id: string): Promise<WorkRead> => readObject(query, facts, id, Date.now());
  return {
    search: (needle, limit, offset) => searchPage(query, facts, needle, limit, offset, Date.now()),
    read,
    ...(facts.many ? { readMany: (ids: readonly string[]) => Promise.all(ids.map(id => read(id))) } : {}),
  };
};

export function balanceWorkReaders(query: BalanceWorkQuery): Pick<Record<WorkKind, WorkReader>, "balance-task" | "balance-project"> {
  return { "balance-task": readerFor(query, KINDS["balance-task"]), "balance-project": readerFor(query, KINDS["balance-project"]) };
}
