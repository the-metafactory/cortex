import type { AppState, OutlineNode } from "../../../balance";
import { balanceDestinations } from "../../../surface/mc/desk/balance-destinations";
import type { DeskArea } from "../../../surface/mc/desk/types";
import type { Json } from "../operations/types";
import type { QueryFetchRequest, QueryPage } from "../reads/query-types";
import type { ReadBinding } from "../reads/types";
import { schemaKey } from "../schema-validation";
import { ObjectReferenceSchema, type AdapterBindings, type AdapterDeclaration, type ObjectReference, type SchemaRef } from "../types";

const ADAPTER_ID = "balance";
const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const MAX_PAGE_ITEMS = 20;
type SchemaDocument = Record<string, Json>;

const ref = (schemaId: string): SchemaRef => ({ schemaId, version: "1.0.0" });
const AREA_SCHEMA_REF = ref("balance.area");
const PROJECT_SCHEMA_REF = ref("balance.project");
const TASK_SCHEMA_REF = ref("balance.task");
const DESTINATIONS_INPUT_REF = ref("balance.destinations.input");
const DESTINATIONS_OUTPUT_REF = ref("balance.destinations.output");
const TASK_QUERY_INPUT_REF = ref("balance.task.query.input");
const TASK_QUERY_OUTPUT_REF = ref("balance.task.query.output");
const TASK_READ_INPUT_REF = ref("balance.task.read.input");
const TASK_READ_OUTPUT_REF = ref("balance.task.read.output");
const ERROR_REF = ref("balance.error");

const objectSchema = (properties: Record<string, Json>, required: readonly string[]): SchemaDocument => ({ $schema: DIALECT, type: "object", additionalProperties: false, required: [...required], properties });
const referenceSchema = (objectType: "area" | "project" | "task"): SchemaDocument => objectSchema({
  adapterId: { type: "string", const: ADAPTER_ID },
  connectionId: { type: "string", minLength: 1 },
  objectType: { type: "string", const: objectType },
  canonicalId: { type: "string", minLength: 1 },
}, ["adapterId", "connectionId", "objectType", "canonicalId"]);
const nullableReferenceSchema = (objectType: "area" | "project" | "task"): SchemaDocument => ({ anyOf: [referenceSchema(objectType), { type: "null" }] });

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
  readonly areas: () => readonly DeskArea[];
  readonly now?: () => Date;
}

export interface BalanceReadAdapter {
  readonly declaration: AdapterDeclaration;
  readonly bindings: AdapterBindings;
  readonly readBindings: readonly ReadBinding[];
  readonly query: (request: QueryFetchRequest) => Promise<QueryPage>;
  readonly destinations: () => QueryPage;
}

interface LocatedTask { readonly node: OutlineNode; readonly area: DeskArea; readonly project: string | null }
interface HandlerContext { readonly destinations: readonly ObjectReference[]; readonly cursor?: string; readonly limit: number }
type BalanceReferenceType = "area" | "project" | "task";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const failure = (code: string): never => { throw new Error(`balance.${code}`); };
const reference = (connectionId: string, objectType: BalanceReferenceType, canonicalId: string): ObjectReference => ({ adapterId: ADAPTER_ID, connectionId, objectType, canonicalId });
const sameReference = (left: ObjectReference, right: ObjectReference): boolean => left.adapterId === right.adapterId && left.connectionId === right.connectionId && left.objectType === right.objectType && left.canonicalId === right.canonicalId;
const parseReference = (value: unknown): ObjectReference => { const parsed = ObjectReferenceSchema.safeParse(value); return parsed.success ? parsed.data : failure("invalid_input"); };
const observedAt = (source: BalanceReadSource): string => (source.now?.() ?? new Date()).toISOString();

function parseHandlerContext(raw: unknown): HandlerContext {
  if (!isRecord(raw)) return failure("invalid_context");
  const destinations = Array.isArray(raw.destinations) ? raw.destinations.map(parseReference) : failure("invalid_context");
  if (raw.cursor !== undefined && typeof raw.cursor !== "string") return failure("invalid_context");
  if (raw.limit !== undefined && (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1)) return failure("invalid_context");
  return { destinations, ...(typeof raw.cursor === "string" ? { cursor: raw.cursor } : {}), limit: typeof raw.limit === "number" ? Math.min(raw.limit, MAX_PAGE_ITEMS) : MAX_PAGE_ITEMS };
}

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
  if (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1)) return failure("invalid_input");
  return { area, query: typeof input.query === "string" ? input.query : "", limit: typeof input.limit === "number" ? Math.min(input.limit, MAX_PAGE_ITEMS) : MAX_PAGE_ITEMS };
}

function parseTaskRead(input: unknown): ObjectReference {
  if (!isRecord(input)) return failure("invalid_input");
  return parseReference(input.ref);
}

function locateTasks(state: AppState, areas: readonly DeskArea[]): LocatedTask[] {
  const found: LocatedTask[] = [];
  const visit = (node: OutlineNode, area: DeskArea, project: string | null): void => {
    if (node.id.startsWith("studio-response:")) return;
    if (node.children.length === 0) { found.push({ node, area, project }); return; }
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

function taskPage(connectionId: string, tasks: readonly { task: LocatedTask; value: Json }[], cursor: string | undefined, snapshotId: string, at: string): QueryPage {
  return {
    readVersion: "1.0.0",
    payload: { items: tasks.map(entry => entry.value) },
    annotations: tasks.map((entry, position) => ({
      pointer: `/items/${position}`,
      ref: reference(connectionId, "task", entry.task.node.id),
      schemaRef: TASK_SCHEMA_REF,
      destination: reference(connectionId, "area", entry.task.area.id),
      position,
      evidence: { evidenceId: `balance.task.${entry.task.node.id}`, revision: "1", observedAt: at },
    })),
    observedAt: at,
    ordering: "provider",
    snapshot: { kind: "stable", id: snapshotId },
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function taskQueryPage(source: BalanceReadSource, input: unknown, destinations: readonly ObjectReference[], cursor: string | undefined, limit: number): QueryPage {
  const parsed = parseTaskQuery(input);
  if (parsed.area.adapterId !== ADAPTER_ID || parsed.area.objectType !== "area" || parsed.area.connectionId !== source.connectionId) return failure("invalid_input");
  const areas = source.areas();
  const area = areas.find(item => item.id === parsed.area.canonicalId);
  if (!area) return failure("destination_unavailable");
  const destination = reference(source.connectionId, "area", area.id);
  if (!destinations.some(item => sameReference(item, destination))) return failure("destination_denied");
  const state = source.state();
  if (!state) return failure("source_unavailable");
  const found = locateTasks(state, areas).filter(task => task.area.id === area.id);
  const needle = parsed.query.trim().toLocaleLowerCase();
  const matching = needle.length === 0 ? found : found.filter(task => `${task.node.title}\n${task.node.note ?? ""}`.toLocaleLowerCase().includes(needle));
  const offset = parseCursor(cursor);
  const bounded = Math.min(limit, parsed.limit, MAX_PAGE_ITEMS);
  const slice = matching.slice(offset, offset + bounded);
  const next = offset + slice.length < matching.length ? String(offset + slice.length) : undefined;
  return taskPage(source.connectionId, slice.map(task => ({ task, value: taskValue(task, source.connectionId) })), next, `balance.task.query:${source.connectionId}:${area.id}`, observedAt(source));
}

function taskReadPage(source: BalanceReadSource, input: unknown, destinations: readonly ObjectReference[], limit: number): QueryPage {
  const parsed = parseTaskRead(input);
  if (parsed.adapterId !== ADAPTER_ID || parsed.objectType !== "task" || parsed.connectionId !== source.connectionId) return failure("invalid_input");
  const areas = source.areas();
  const state = source.state();
  if (!state) return failure("source_unavailable");
  const task = locateTasks(state, areas).find(item => item.node.id === parsed.canonicalId);
  if (!task) return failure("task_unavailable");
  const destination = reference(source.connectionId, "area", task.area.id);
  if (!destinations.some(item => sameReference(item, destination))) return failure("destination_denied");
  if (limit < 1) return failure("invalid_input");
  return taskPage(source.connectionId, [{ task, value: taskValue(task, source.connectionId) }], undefined, `balance.task.read:${source.connectionId}:${task.node.id}`, observedAt(source));
}

function destinationsPage(source: BalanceReadSource): QueryPage {
  const state = source.state();
  const areas = source.areas();
  const at = observedAt(source);
  const entries = state === null ? [] : balanceDestinations(state.outline, [...areas]).map(destination => destination.project
    ? { ref: reference(source.connectionId, "project", destination.id), value: { label: destination.label }, schemaRef: PROJECT_SCHEMA_REF }
    : { ref: reference(source.connectionId, "area", destination.area), value: { label: destination.label }, schemaRef: AREA_SCHEMA_REF });
  return {
    readVersion: "1.0.0",
    payload: { items: entries.map(entry => entry.value) },
    annotations: entries.map((entry, position) => ({
      pointer: `/items/${position}`,
      ref: entry.ref,
      schemaRef: entry.schemaRef,
      destination: entry.ref,
      position,
      evidence: { evidenceId: `balance.destination.${entry.ref.objectType}.${entry.ref.canonicalId}`, revision: "1", observedAt: at },
    })),
    observedAt: at,
    ordering: "provider",
    snapshot: { kind: "stable", id: `balance.destinations:${source.connectionId}` },
  };
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
