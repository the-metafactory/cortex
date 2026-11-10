import { balanceDestinations, type AppState, type DestinationArea, type OutlineNode } from "../../../balance";
import { isRecord, parseObjectReference, parseReadHandlerContext, readObservedAt, readPage, readPageLimit, readSnapshotId, type Json, type QueryFetchRequest, type QueryPage, type QueryPageEntry, type ReadBinding } from "../reads/page-primitives";
import { objectSchema, schemaRef } from "../schema-primitives";
import { schemaKey } from "../schema-validation";
import type { AdapterBindings, AdapterDeclaration, ObjectReference } from "../types";
import { BALANCE_ADAPTER_ID as ADAPTER_ID, nullableReferenceSchema, referenceSchema } from "./schema";

const MAX_PAGE_ITEMS = 20;
const AREA_SCHEMA_REF = schemaRef("balance.area");
const PROJECT_SCHEMA_REF = schemaRef("balance.project");
const TASK_SCHEMA_REF = schemaRef("balance.task");
const DESTINATIONS_INPUT_REF = schemaRef("balance.destinations.input");
const DESTINATIONS_OUTPUT_REF = schemaRef("balance.destinations.output");
const TASK_QUERY_INPUT_REF = schemaRef("balance.task.query.input");
const TASK_QUERY_OUTPUT_REF = schemaRef("balance.task.query.output");
const TASK_READ_INPUT_REF = schemaRef("balance.task.read.input");
const TASK_READ_OUTPUT_REF = schemaRef("balance.task.read.output");
const ERROR_REF = schemaRef("balance.error");

const AREA_VALUE_SCHEMA = objectSchema({ label: { type: "string" } }, ["label"]);
const PROJECT_VALUE_SCHEMA = objectSchema({ label: { type: "string" } }, ["label"]);
const TASK_VALUE_SCHEMA = objectSchema({
  title: { type: "string" },
  status: { type: "string", enum: ["open", "done"] },
  dueDate: { type: ["string", "null"] },
  area: referenceSchema("area"),
  project: nullableReferenceSchema("project"),
  note: { type: "string" },
  effort: { type: "number" },
  summary: { type: "string" },
}, ["title", "status", "dueDate", "area", "project", "summary"]);
const DESTINATIONS_INPUT_SCHEMA = objectSchema({}, []);
const DESTINATIONS_OUTPUT_SCHEMA = objectSchema({ items: { type: "array", items: { anyOf: [AREA_VALUE_SCHEMA, PROJECT_VALUE_SCHEMA] } } }, ["items"]);
const TASK_QUERY_INPUT_SCHEMA = objectSchema({ area: referenceSchema("area"), query: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_ITEMS } }, ["area"]);
const TASK_QUERY_OUTPUT_SCHEMA = objectSchema({ items: { type: "array", items: { $ref: schemaKey(TASK_SCHEMA_REF) } } }, ["items"]);
const TASK_READ_INPUT_SCHEMA = objectSchema({ ref: referenceSchema("task") }, ["ref"]);
const TASK_READ_OUTPUT_SCHEMA = objectSchema({ items: { type: "array", items: { $ref: schemaKey(TASK_SCHEMA_REF) } } }, ["items"]);
const ERROR_SCHEMA = objectSchema({ code: { type: "string", pattern: "^balance\\..+$" }, message: { type: "string", minLength: 1 }, issues: { type: "array", items: objectSchema({ path: { type: "string" }, code: { type: "string" }, message: { type: "string" } }, ["path", "code", "message"]) } }, ["code", "message"]);

export function balanceReadDeclaration(): AdapterDeclaration {
  return {
    adapterId: ADAPTER_ID,
    label: "Balance",
    contractRange: "^1.0.0",
    schemas: [
      { ...AREA_SCHEMA_REF, schema: AREA_VALUE_SCHEMA },
      { ...PROJECT_SCHEMA_REF, schema: PROJECT_VALUE_SCHEMA },
      { ...TASK_SCHEMA_REF, schema: TASK_VALUE_SCHEMA },
      { ...DESTINATIONS_INPUT_REF, schema: DESTINATIONS_INPUT_SCHEMA },
      { ...DESTINATIONS_OUTPUT_REF, schema: DESTINATIONS_OUTPUT_SCHEMA },
      { ...TASK_QUERY_INPUT_REF, schema: TASK_QUERY_INPUT_SCHEMA },
      { ...TASK_QUERY_OUTPUT_REF, schema: TASK_QUERY_OUTPUT_SCHEMA },
      { ...TASK_READ_INPUT_REF, schema: TASK_READ_INPUT_SCHEMA },
      { ...TASK_READ_OUTPUT_REF, schema: TASK_READ_OUTPUT_SCHEMA },
      { ...ERROR_REF, schema: ERROR_SCHEMA },
    ],
    objectTypes: [
      { objectType: "area", label: "Area", schemaRef: AREA_SCHEMA_REF, relationships: [] },
      { objectType: "project", label: "Project", schemaRef: PROJECT_SCHEMA_REF, relationships: [] },
      { objectType: "task", label: "Task", schemaRef: TASK_SCHEMA_REF, relationships: [{ fieldPath: "/area", targetAdapterId: ADAPTER_ID, targetObjectType: "area", cardinality: "one" }] },
    ],
    capabilities: [
      { capabilityId: "balance.destinations", label: "List destinations", kind: "query", objectTypes: ["area", "project"], inputSchemaRef: DESTINATIONS_INPUT_REF, outputSchemaRef: DESTINATIONS_OUTPUT_REF, errorSchemaRef: ERROR_REF },
      { capabilityId: "balance.task.query", label: "Query tasks", kind: "query", objectTypes: ["task"], inputSchemaRef: TASK_QUERY_INPUT_REF, outputSchemaRef: TASK_QUERY_OUTPUT_REF, errorSchemaRef: ERROR_REF },
      { capabilityId: "balance.task.read", label: "Read task", kind: "query", objectTypes: ["task"], inputSchemaRef: TASK_READ_INPUT_REF, outputSchemaRef: TASK_READ_OUTPUT_REF, errorSchemaRef: ERROR_REF },
    ],
  };
}

export const balanceReadBindings: readonly ReadBinding[] = [
  { version: "1.0.0", adapterId: ADAPTER_ID, capabilityId: "balance.destinations", mode: "destinations", objectType: "area", inputSchemaRef: DESTINATIONS_INPUT_REF, outputSchemaRef: DESTINATIONS_OUTPUT_REF, display: { title: "/label" } },
  {
    version: "1.0.0", adapterId: ADAPTER_ID, capabilityId: "balance.task.query", mode: "query", objectType: "task", inputSchemaRef: TASK_QUERY_INPUT_REF, outputSchemaRef: TASK_QUERY_OUTPUT_REF, destinationType: "area",
    display: { title: "/title", summary: "/summary", status: "/status", due: "/dueDate", area: "/area" },
    query: { objectsPointer: "/items", ordering: "provider", stableSnapshot: true, limits: { items: MAX_PAGE_ITEMS } },
  },
  {
    version: "1.0.0", adapterId: ADAPTER_ID, capabilityId: "balance.task.read", mode: "query", objectType: "task", inputSchemaRef: TASK_READ_INPUT_REF, outputSchemaRef: TASK_READ_OUTPUT_REF, destinationType: "area",
    display: { title: "/title", summary: "/summary", status: "/status", due: "/dueDate", area: "/area" },
    query: { objectsPointer: "/items", ordering: "provider", stableSnapshot: true, limits: { items: 1 } },
  },
];

export interface BalanceReadSource {
  readonly connectionId: string;
  readonly state: () => AppState | null;
  readonly areas: () => readonly DestinationArea[];
  readonly now?: () => Date;
}

export interface BalanceReadAdapter {
  readonly declaration: AdapterDeclaration;
  readonly bindings: AdapterBindings;
  readonly readBindings: readonly ReadBinding[];
  readonly query: (request: QueryFetchRequest) => Promise<QueryPage>;
  readonly destinations: () => QueryPage;
}

interface LocatedTask { readonly node: OutlineNode; readonly area: DestinationArea; readonly project: string | null }
type BalanceReferenceType = "area" | "project" | "task";

const failure = (code: string): never => { throw new Error(`balance.${code}`); };
const reference = (connectionId: string, objectType: BalanceReferenceType, canonicalId: string): ObjectReference => ({ adapterId: ADAPTER_ID, connectionId, objectType, canonicalId });
const sameReference = (left: ObjectReference, right: ObjectReference): boolean => left.adapterId === right.adapterId && left.connectionId === right.connectionId && left.objectType === right.objectType && left.canonicalId === right.canonicalId;
const parseReference = (value: unknown): ObjectReference => parseObjectReference(value, failure);
const observedAt = readObservedAt;
const snapshotId = (scope: string, content: Json): string => readSnapshotId("balance", scope, content);
const parseLimit = (raw: unknown, code: string): number => readPageLimit(raw, MAX_PAGE_ITEMS, failure, code);
const parseHandlerContext = (raw: unknown) => parseReadHandlerContext(raw, MAX_PAGE_ITEMS, failure);

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0 || String(offset) !== cursor) return failure("cursor_invalid");
  return offset;
}

function parseTaskQuery(input: unknown): { area: ObjectReference; query: string; limit: number } {
  if (!isRecord(input)) return failure("invalid_input");
  const area = parseReference(input.area);
  if (input.query !== undefined && typeof input.query !== "string") return failure("invalid_input");
  return { area, query: typeof input.query === "string" ? input.query : "", limit: parseLimit(input.limit, "invalid_input") };
}

function parseTaskRead(input: unknown): ObjectReference {
  if (!isRecord(input)) return failure("invalid_input");
  return parseReference(input.ref);
}

function locateTasks(state: AppState, areas: readonly DestinationArea[]): LocatedTask[] {
  const found: LocatedTask[] = [];
  const visit = (node: OutlineNode, area: DestinationArea, project: string | null): void => {
    if (node.id.startsWith("studio-response:")) return;
    if (node.children.length === 0) {
      if (node.effort !== undefined) found.push({ node, area, project });
      return;
    }
    for (const child of node.children) visit(child, area, node.id);
  };
  for (const area of areas) {
    const root = state.outline.children.find(node => node.id === `area:${area.id}`);
    if (!root) continue;
    for (const child of root.children) visit(child, area, null);
  }
  return found;
}

function taskValue(task: LocatedTask, connectionId: string): Json {
  const status = task.node.done === true ? "done" : "open";
  const dueDate = task.node.dueDate ?? null;
  const summary = [status, typeof dueDate === "string" ? `due ${dueDate}` : "", task.area.label].filter(part => part.length > 0).join(" · ");
  return {
    title: task.node.title,
    status,
    dueDate,
    area: reference(connectionId, "area", task.area.id),
    project: task.project === null ? null : reference(connectionId, "project", task.project),
    summary,
    ...(task.node.note === undefined ? {} : { note: task.node.note }),
    ...(task.node.effort === undefined ? {} : { effort: task.node.effort }),
  };
}

function taskEntry(task: LocatedTask, connectionId: string, value: Json): QueryPageEntry {
  return {
    ref: reference(connectionId, "task", task.node.id),
    schemaRef: TASK_SCHEMA_REF,
    destination: reference(connectionId, "area", task.area.id),
    evidenceId: `balance.task.${task.node.id}`,
    value,
  };
}

function taskQueryPage(source: BalanceReadSource, input: unknown, destinations: readonly ObjectReference[], cursor: string | undefined, limit: number): QueryPage {
  const parsed = parseTaskQuery(input);
  if (parsed.area.adapterId !== ADAPTER_ID || parsed.area.objectType !== "area" || parsed.area.connectionId !== source.connectionId) return failure("invalid_input");
  const destination = reference(source.connectionId, "area", parsed.area.canonicalId);
  if (!destinations.some(item => sameReference(item, destination))) return failure("destination_denied");
  const area = source.areas().find(item => item.id === parsed.area.canonicalId);
  if (!area) return failure("destination_unavailable");
  const state = source.state();
  if (!state) return failure("source_unavailable");
  const found = locateTasks(state, [area]);
  const needle = parsed.query.trim().toLocaleLowerCase();
  const matching = needle.length === 0 ? found : found.filter(task => `${task.node.title}\n${task.node.note ?? ""}`.toLocaleLowerCase().includes(needle));
  const offset = parseCursor(cursor);
  const bounded = Math.min(limit, parsed.limit, MAX_PAGE_ITEMS);
  const slice = matching.slice(offset, offset + bounded);
  const next = offset + slice.length < matching.length ? String(offset + slice.length) : undefined;
  return readPage(
    slice.map(task => taskEntry(task, source.connectionId, taskValue(task, source.connectionId))),
    snapshotId("task.query", { connectionId: source.connectionId, area: area.id, tasks: matching.map(task => task.node.id) }),
    observedAt(source),
    next,
  );
}

function taskReadPage(source: BalanceReadSource, input: unknown, destinations: readonly ObjectReference[], limit: number): QueryPage {
  const parsed = parseTaskRead(input);
  if (parsed.adapterId !== ADAPTER_ID || parsed.objectType !== "task" || parsed.connectionId !== source.connectionId) return failure("invalid_input");
  if (limit < 1) return failure("invalid_input");
  const state = source.state();
  if (!state) return failure("source_unavailable");
  const task = locateTasks(state, source.areas()).find(item => item.node.id === parsed.canonicalId);
  if (!task || !destinations.some(item => sameReference(item, reference(source.connectionId, "area", task.area.id)))) return failure("task_unavailable");
  const value = taskValue(task, source.connectionId);
  return readPage([taskEntry(task, source.connectionId, value)], snapshotId("task.read", { connectionId: source.connectionId, task: task.node.id, value }), observedAt(source));
}

function destinationsPage(source: BalanceReadSource): QueryPage {
  const state = source.state();
  const entries: QueryPageEntry[] = state === null ? [] : balanceDestinations(state.outline, source.areas()).map(destination => destination.project
    ? { ref: reference(source.connectionId, "project", destination.id), schemaRef: PROJECT_SCHEMA_REF, destination: reference(source.connectionId, "project", destination.id), evidenceId: `balance.destination.project.${destination.id}`, value: { label: destination.label } }
    : { ref: reference(source.connectionId, "area", destination.area), schemaRef: AREA_SCHEMA_REF, destination: reference(source.connectionId, "area", destination.area), evidenceId: `balance.destination.area.${destination.area}`, value: { label: destination.label } });
  return readPage(entries, snapshotId("destinations", { connectionId: source.connectionId, destinations: entries.map(entry => entry.ref) }), observedAt(source));
}

export function createBalanceReadAdapter(source: BalanceReadSource): BalanceReadAdapter {
  const query = (request: QueryFetchRequest): Promise<QueryPage> => {
    if (request.capabilityId === "balance.destinations") return Promise.resolve(destinationsPage(source));
    if (request.capabilityId === "balance.task.query") return Promise.resolve(taskQueryPage(source, request.input, request.destinations, request.cursor, request.limit));
    if (request.capabilityId === "balance.task.read") return Promise.resolve(taskReadPage(source, request.input, request.destinations, request.limit));
    return Promise.reject(new Error("balance.unknown_capability"));
  };
  const handlers: AdapterBindings["handlers"] = {
    "balance.destinations": input => {
      if (!isRecord(input) || Object.keys(input).length > 0) return failure("invalid_input");
      return destinationsPage(source);
    },
    "balance.task.query": (input, context) => {
      const checked = parseHandlerContext(context);
      return taskQueryPage(source, input, checked.destinations, checked.cursor, checked.limit);
    },
    "balance.task.read": (input, context) => {
      const checked = parseHandlerContext(context);
      return taskReadPage(source, input, checked.destinations, checked.limit);
    },
  };
  return {
    declaration: balanceReadDeclaration(),
    bindings: { handlers, observations: {} },
    readBindings: balanceReadBindings,
    query,
    destinations: () => destinationsPage(source),
  };
}
