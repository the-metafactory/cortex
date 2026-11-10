import { authorityHash } from "../../authority-records";
import { schemaKey } from "../schema-validation";
import { OBSERVATION_LIMITS, type ObservationBatch, type ObservationConnector, type ObservationEvent, type ObservationRequest } from "../reads/observation-types";
import { isRecord, readObservedAt } from "../reads/page-primitives";
import { ReadBindingSchema, type ReadBinding } from "../reads/types";
import type { AdapterBindings, AdapterDeclaration } from "../types";
import type { Json } from "../operations/types";
import { BALANCE_ADAPTER_ID as ADAPTER_ID, objectSchema, ref } from "./schema";
import { balanceReadDeclaration, balanceReadBindings, createBalanceReadAdapter, balanceTaskObjects, type BalanceReadSource } from "./read";

export const BALANCE_TASK_OBSERVATION_CAPABILITY_ID = "balance.task.observation";
export const BALANCE_TASK_ORDERING = "balance.current-task";

const TASK_SCHEMA_REF = ref("balance.task");
const OBSERVATION_INPUT_REF = ref("balance.task.observation.input");
const OBSERVATION_OUTPUT_REF = ref("balance.task.observation.output");
const ERROR_REF = ref("balance.error");

const failure = (code: string): never => { throw new Error(`balance.${code}`); };
const authoritativeCurrentTask: NonNullable<ObservationConnector["ordering"]> = {
  id: BALANCE_TASK_ORDERING,
  compare: (left, right) => left === right ? "same" : "newer",
};


export function balanceTaskObservationDeclaration(): AdapterDeclaration {
  const read = balanceReadDeclaration();
  return {
    ...read,
    schemas: [
      ...read.schemas,
      { ...OBSERVATION_INPUT_REF, schema: objectSchema({}, []) },
      { ...OBSERVATION_OUTPUT_REF, schema: objectSchema({ items: { type: "array", items: { $ref: schemaKey(TASK_SCHEMA_REF) } } }, ["items"]) },
    ],
    capabilities: [
      ...read.capabilities,
      { capabilityId: BALANCE_TASK_OBSERVATION_CAPABILITY_ID, label: "Observe tasks", kind: "observation", objectTypes: ["task"], inputSchemaRef: OBSERVATION_INPUT_REF, outputSchemaRef: OBSERVATION_OUTPUT_REF, errorSchemaRef: ERROR_REF },
    ],
  };
}

export function balanceTaskObservationBinding(): ReadBinding {
  return ReadBindingSchema.parse({
    version: "1.0.0", adapterId: ADAPTER_ID, capabilityId: BALANCE_TASK_OBSERVATION_CAPABILITY_ID, mode: "poll", objectType: "task",
    inputSchemaRef: OBSERVATION_INPUT_REF, outputSchemaRef: OBSERVATION_OUTPUT_REF, destinationType: "area",
    display: { title: "/title", summary: "/summary", status: "/status", due: "/dueDate", area: "/area" },
    observation: { modes: ["poll"], objectsPointer: "/items", resumable: false, ordering: BALANCE_TASK_ORDERING },
  });
}

export function createBalanceTaskObservationConnector(source: BalanceReadSource): ObservationConnector {
  return { modes: ["poll"], ordering: authoritativeCurrentTask, fetch: (request, signal) => Promise.resolve().then(() => observe(source, request, signal)) };
}

export interface BalanceObservationAdapter {
  readonly declaration: AdapterDeclaration;
  readonly bindings: AdapterBindings;
  readonly readBindings: readonly ReadBinding[];
  readonly connector: ObservationConnector;
}

export function createBalanceObservationAdapter(source: BalanceReadSource): BalanceObservationAdapter {
  const read = createBalanceReadAdapter(source);
  return {
    declaration: balanceTaskObservationDeclaration(),
    bindings: { handlers: read.bindings.handlers, observations: { [BALANCE_TASK_OBSERVATION_CAPABILITY_ID]: { modes: ["poll"], ordering: BALANCE_TASK_ORDERING } } },
    readBindings: [...balanceReadBindings, balanceTaskObservationBinding()],
    connector: createBalanceTaskObservationConnector(source),
  };
}

function observationAreas(source: BalanceReadSource, request: ObservationRequest): string[] {
  if (!isRecord(request.source.input) || Object.keys(request.source.input).length > 0) return failure("invalid_input");
  const owned = source.areas();
  const chosen: string[] = [];
  for (const destination of request.source.destinations) {
    if (destination.adapterId !== ADAPTER_ID || destination.connectionId !== source.connectionId || destination.objectType !== "area") return failure("invalid_input");
    if (!owned.some(area => area.id === destination.canonicalId)) continue;
    chosen.push(destination.canonicalId);
  }
  return [...new Set(chosen)];
}

function observe(source: BalanceReadSource, request: ObservationRequest, signal: AbortSignal): ObservationBatch {
  signal.throwIfAborted();
  const chosen = observationAreas(source, request);
  const state = source.state();
  if (!state) return failure("source_unavailable");
  const areas = source.areas().filter(area => chosen.includes(area.id));
  const objects = balanceTaskObjects(state, areas, source.connectionId);
  const observedAt = readObservedAt(source);
  const limit = Math.max(1, Math.min(request.limit, OBSERVATION_LIMITS.batchItems));
  const events: ObservationEvent[] = [];
  const items: Json[] = [];
  for (const object of objects.slice(0, limit)) {
    const revision = authorityHash(object.value);
    items.push(object.value);
    events.push({
      kind: "present", pointer: `/items/${items.length - 1}`, ref: object.ref, schemaRef: TASK_SCHEMA_REF, destination: object.destination,
      observedAt, revision, evidenceId: `balance.task.${object.ref.canonicalId}.${revision}`,
    });
  }
  return { version: "1.0.0", payload: { items }, events, coverage: "objects", gap: false };
}
