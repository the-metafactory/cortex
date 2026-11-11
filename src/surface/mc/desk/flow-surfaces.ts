import { flowQuerySource } from "../../../conversations/domain-adapters/flow/queries";
import { flowName } from "../../../conversations/domain-adapters/flow/schema";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import type { SavedFlow } from "./saved-flow-contract";
import type { FlowCardFacts, FlowReceipt, FlowSavedCard, FlowSavedDefinition, FlowSavedList } from "./flow-surface-schema";
import { runCreatedHostQuery, runHostQuery, type HostQueryRun, type HostQueryRunner } from "./query-run";
import { releasedObjects, type ReleasedObject } from "./work-released";

const FLOW = "flow";
const FLOW_FAILED = "flow.surface_unreadable";
const MAX_PAGES = 50;

export interface FlowSurfaceSource {
  readonly connectionId: string;
  readonly destination: ObjectReference;
  readonly enabled: () => boolean;
  readonly query: (continuation?: string) => Promise<HostQueryRun>;
  readonly read: (name: string) => Promise<HostQueryRun>;
  readonly receipt?: (operationId: string) => Promise<FlowReceipt | null>;
}

export type FlowSurfaceAccess = () => FlowSurfaceReader | null;

export interface FlowSurfaceReader {
  list(): Promise<FlowSavedList>;
  definition(name: string): Promise<FlowSavedDefinition>;
  card(name: string, operationId: string): Promise<FlowSavedCard>;
}

export interface FlowSurfaceRunner extends HostQueryRunner {
  readonly connectionId: string;
  readonly destination: ObjectReference;
}

export function flowSurfaceQueries(config: FlowSurfaceRunner): Pick<FlowSurfaceSource, "query" | "read"> {
  return {
    async query(continuation) {
      const request = await config.runner.create(config.context, [flowQuerySource(config.connectionId, config.destination, "flow.saved.query")], config.sink);
      return runCreatedHostQuery(config, continuation === undefined ? request : { ...request, continuation });
    },
    read(name) {
      return runHostQuery(config, flowQuerySource(config.connectionId, config.destination, "flow.saved.read", name));
    },
  };
}

type CurrentFlow = { enabled: true; state: "withheld" | "unavailable" } | ({ enabled: true; state: "available" } & FlowCardFacts & { yaml: string });

const unreadable = (): never => { throw new Error(FLOW_FAILED); };
const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const newestFirst = (left: SavedFlow, right: SavedFlow): number => Date.parse(right.savedAt) - Date.parse(left.savedAt);
const savedObjects = (run: HostQueryRun): ReleasedObject[] => releasedObjects(run.released ?? {}).filter(object => object.ref.adapterId === FLOW && object.ref.objectType === "saved");

function provenanceOf(object: ReleasedObject): Pick<FlowCardFacts, "savedAt" | "origin" | "conversationId"> | null {
  const provenance = record(object.value.provenance);
  const savedAt = provenance === null ? null : text(provenance.saved_at);
  const origin = provenance === null ? null : provenance.origin;
  if (savedAt === null || origin !== "conversation" && origin !== "cli") return null;
  return { savedAt, origin, conversationId: text(provenance?.conversation) };
}

function savedFlowOf(object: ReleasedObject): SavedFlow | null {
  const sha256 = text(object.value.sha256);
  const provenance = provenanceOf(object);
  return sha256 === null || provenance === null ? null : { name: object.ref.canonicalId, sha256, ...provenance };
}

function factsOf(object: ReleasedObject): (FlowCardFacts & { yaml: string }) | null {
  const flow = savedFlowOf(object);
  const yaml = text(object.value.yaml);
  return flow === null || yaml === null ? null : { ...flow, yaml };
}

export function createFlowSurfaceReader(source: FlowSurfaceSource): FlowSurfaceReader {
  const permitted = (run: HostQueryRun): boolean => !run.result.restricted && run.result.status !== "denied";
  const collect = async (): Promise<SavedFlow[]> => {
    const flows: SavedFlow[] = [];
    const seen = new Set<string>();
    let continuation: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const run = await source.query(continuation);
      if (!permitted(run) || run.result.status !== "ok" && run.result.status !== "partial") return unreadable();
      const objects = savedObjects(run);
      for (const object of objects) {
        const flow = savedFlowOf(object);
        if (flow === null) return unreadable();
        if (!seen.has(flow.name)) { seen.add(flow.name); flows.push(flow); }
      }
      const next: string | undefined = run.result.continuation;
      if (next === undefined) return flows.sort(newestFirst);
      if (next === continuation) return unreadable();
      continuation = next;
    }
    return unreadable();
  };
  const current = async (name: string): Promise<CurrentFlow> => {
    const run = await source.read(name);
    if (!permitted(run)) return { enabled: true, state: "withheld" };
    if (run.result.status !== "ok") return unreadable();
    const object = savedObjects(run).find(candidate => candidate.ref.canonicalId === name);
    if (run.result.noMatch || object === undefined) return { enabled: true, state: "unavailable" };
    const facts = factsOf(object);
    return facts === null ? unreadable() : { enabled: true, state: "available", ...facts };
  };
  return {
    async list() {
      if (!source.enabled()) return { enabled: false };
      return { enabled: true, flows: await collect() };
    },
    async definition(name) {
      if (!source.enabled()) return { enabled: false };
      if (!flowName.safeParse(name).success) return unreadable();
      const read = await current(name);
      return read.state === "available" ? { enabled: true, state: "available", name: read.name, sha256: read.sha256, yaml: read.yaml } : read;
    },
    async card(name, operationId) {
      if (!source.enabled()) return { enabled: false };
      if (!flowName.safeParse(name).success || operationId.trim().length === 0) return unreadable();
      const receipt = source.receipt === undefined ? null : await source.receipt(operationId);
      if (receipt?.name !== name) return { enabled: true, state: "unrecorded" };
      const read = await current(name);
      if (read.state !== "available") return { enabled: true, state: read.state, receipt };
      const { enabled: _enabled, state: _state, yaml: _yaml, ...facts } = read;
      return { enabled: true, state: "available", receipt, changed: facts.sha256 !== receipt.sha256, ...facts };
    },
  };
}
