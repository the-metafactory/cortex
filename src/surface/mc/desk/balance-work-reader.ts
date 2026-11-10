import type { Json } from "../../../conversations/domain-adapters/operations/types";
import type { HostContext } from "../../../conversations/authority";
import type { ReleaseSink } from "../../../conversations/authority-records";
import type { QueryRunner } from "../../../conversations/domain-adapters/reads/query";
import type { SchemaRef } from "../../../conversations/domain-adapters/types";
import type { QueryResult } from "../../../conversations/domain-adapters/reads/query-types";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import type { WorkKind, WorkObject, WorkPage, WorkRead, WorkReader } from "../../../conversations/tools/work-context";
import type { Policy } from "../../../conversations/types";

export interface BalanceWorkArea {
  readonly id: string;
  readonly label: string;
  readonly policy?: Policy;
}
export interface BalanceQueryRequest {
  readonly capabilityId: "balance.task.query" | "balance.task.read" | "balance.project.query" | "balance.project.read";
  readonly input: Json;
  readonly destinations: readonly ObjectReference[];
  readonly limit: number;
}
export interface BalanceQueryResult {
  readonly result: QueryResult;
  readonly released?: Json;
}
export interface BalanceWorkQuery {
  readonly connectionId: string;
  readonly areas: readonly BalanceWorkArea[];
  readonly run: (request: BalanceQueryRequest) => Promise<BalanceQueryResult>;
}
export interface BalanceWorkRunner {
  readonly connectionId: string;
  readonly areas: readonly BalanceWorkArea[];
  readonly runner: Pick<QueryRunner, "create" | "run">;
  readonly context: HostContext;
  readonly sink: ReleaseSink;
  readonly inputSchemaRef: (capabilityId: string) => SchemaRef;
  readonly sends: readonly Json[];
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
const objectReference = (value: unknown): ObjectReference | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const held = value as Record<string, unknown>;
  return typeof held.adapterId === "string" && typeof held.connectionId === "string" && typeof held.objectType === "string" && typeof held.canonicalId === "string"
    ? { adapterId: held.adapterId, connectionId: held.connectionId, objectType: held.objectType, canonicalId: held.canonicalId }
    : null;
};
const releasedObjects = (released: Json | undefined): ReleasedObject[] => {
  if (!released || typeof released !== "object" || Array.isArray(released)) return [];
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
const text = (value: unknown): string => typeof value === "string" ? value : "";
const areaOf = (query: BalanceWorkQuery, id: string): BalanceWorkArea | undefined => query.areas.find(area => area.id === id || area.id === `area:${id}`);
const observedAt = (object: ReleasedObject, at: number): number => {
  const time = object.evidence?.observedAt ? Date.parse(object.evidence.observedAt) : Number.NaN;
  return Number.isFinite(time) ? time : at;
};
const taskObject = (query: BalanceWorkQuery, object: ReleasedObject, at: number): WorkObject => {
  const areaRef = objectReference(object.value.area);
  const area = areaRef ? areaOf(query, areaRef.canonicalId) : undefined;
  const facts = [text(object.value.summary), text(object.value.note)].filter(Boolean);
  return { kind: "balance-task", id: object.ref.canonicalId, title: text(object.value.title), status: text(object.value.status), summary: facts.join("\n"), policy: area?.policy ?? "cloud", area: area?.label ?? null, url: `?desk=balance&balance-item=${encodeURIComponent(object.ref.canonicalId)}`, observedAt: observedAt(object, at) };
};
const projectObject = (query: BalanceWorkQuery, object: ReleasedObject, at: number): WorkObject => {
  const label = text(object.value.label);
  const [areaLabel, title] = label.includes(" / ") ? [label.slice(0, label.indexOf(" / ")), label.slice(label.lastIndexOf(" / ") + 3)] : [label, label];
  const area = query.areas.find(candidate => candidate.label === areaLabel);
  return { kind: "balance-project", id: object.ref.canonicalId, title, status: "open", summary: `Project in ${areaLabel}`, policy: area?.policy ?? "cloud", area: areaLabel || null, url: `?desk=balance&balance-item=${encodeURIComponent(object.ref.canonicalId)}`, observedAt: observedAt(object, at) };
};
const pageOf = (result: QueryResult, items: WorkObject[], kind: WorkKind, limit: number): WorkPage => {
  const groups = result.groups.filter(group => group.source.capabilityId === (kind === "balance-task" ? "balance.task.query" : "balance.project.query"));
  const coverage = groups[0]?.coverage;
  return {
    items,
    more: result.status === "partial" || result.continuation !== undefined || coverage === "more" || coverage === "incomplete" || coverage === "budget-exhausted" || items.length > limit,
    ...(coverage ? { coverage } : {}),
    noMatch: result.noMatch,
    restricted: result.restricted || result.status === "denied",
    status: result.status,
    ...(result.reason ? { reason: result.reason.message } : {}),
    ...(result.continuation ? { continuation: result.continuation } : {}),
  };
};
const queryPage = async (query: BalanceWorkQuery, request: BalanceQueryRequest, kind: WorkKind, at: number): Promise<WorkPage> => {
  const { result, released } = await query.run(request);
  const objects = releasedObjects(released);
  const items = kind === "balance-task" ? objects.map(object => taskObject(query, object, at)) : objects.filter(object => object.ref.objectType === "project").map(object => projectObject(query, object, at));
  return pageOf(result, items, kind, request.limit);
};

export function balanceWorkQuery(config: BalanceWorkRunner): BalanceWorkQuery {
  return {
    connectionId: config.connectionId,
    areas: config.areas,
    run: async request => {
      const before = config.sends.length;
      const created = await config.runner.create(config.context, [{
        adapterId: "balance",
        connectionId: config.connectionId,
        capabilityId: request.capabilityId,
        inputSchemaRef: config.inputSchemaRef(request.capabilityId),
        destinations: [...request.destinations],
        input: request.input,
      }], config.sink);
      const result = await config.runner.run(config.context, created, config.sink);
      return { result, ...(config.sends.length > before ? { released: config.sends[config.sends.length - 1] } : {}) };
    },
  };
}

const destinationOf = (query: BalanceWorkQuery, area: BalanceWorkArea): ObjectReference => ({ adapterId: "balance", connectionId: query.connectionId, objectType: "area", canonicalId: area.id });
const searchPage = async (query: BalanceWorkQuery, capabilityId: "balance.task.query" | "balance.project.query", kind: "balance-task" | "balance-project", needle: string, area: BalanceWorkArea, limit: number, offset: number, at: number): Promise<WorkPage> => {
  const destination = destinationOf(query, area);
  const page = await queryPage(query, { capabilityId, input: { ...(kind === "balance-task" ? { area: destination } : {}), query: needle, limit, offset }, destinations: [destination], limit }, kind, at);
  return { ...page, items: page.items.slice(0, limit), more: page.more || page.items.length > limit };
};
const readObject = async (query: BalanceWorkQuery, capabilityId: "balance.task.read" | "balance.project.read", objectType: "task" | "project", id: string, projectObjectOf: (query: BalanceWorkQuery, object: ReleasedObject, at: number) => WorkObject, at: number): Promise<WorkRead> => {
  const area = query.areas[0];
  if (!area) return { state: "unavailable", reason: "gone" };
  const destination = destinationOf(query, area);
  const { result, released } = await query.run({ capabilityId, input: { ref: { ...destination, objectType, canonicalId: id } }, destinations: [destination], limit: 1 });
  if (result.status === "denied" || result.restricted) return { state: "unavailable", reason: "unauthorized" };
  const object = releasedObjects(released).find(entry => entry.ref.objectType === objectType && entry.ref.canonicalId === id);
  if (result.status !== "ok" || !object) return { state: "unavailable", reason: "gone" };
  return { state: "available", object: projectObjectOf(query, object, at) };
};

export function balanceWorkReaders(query: BalanceWorkQuery): Pick<Record<WorkKind, WorkReader>, "balance-task" | "balance-project"> {
  const now = (): number => Date.now();
  const task: WorkReader = {
    search: async (needle, limit, offset) => {
      const area = query.areas[0];
      if (!area) return { items: [], more: false, status: "unavailable", reason: "No Balance destination is available." };
      return searchPage(query, "balance.task.query", "balance-task", needle, area, limit, offset, now());
    },
    read: async id => readObject(query, "balance.task.read", "task", id, taskObject, now()),
    readMany: async ids => Promise.all(ids.map(id => readObject(query, "balance.task.read", "task", id, taskObject, now()))),
  };
  const project: WorkReader = {
    search: async (needle, limit, offset) => {
      const area = query.areas[0];
      if (!area) return { items: [], more: false, status: "unavailable", reason: "No Balance destination is available." };
      return searchPage(query, "balance.project.query", "balance-project", needle, area, limit, offset, now());
    },
    read: async id => readObject(query, "balance.project.read", "project", id, projectObject, now()),
  };
  return { "balance-task": task, "balance-project": project };
}
