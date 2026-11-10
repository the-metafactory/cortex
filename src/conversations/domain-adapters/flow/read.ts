import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { authorityHash, type RestrictionRecord } from "../../authority-records";
import type { Json } from "../operations/types";
import type { QueryFetchRequest, QueryPage } from "../reads/query-types";
import { ObjectReferenceSchema, type AdapterBindings, type ObjectReference } from "../types";
import { FLOW_ADAPTER_ID, flowName, flowReadBindings, flowReadDeclaration, flowSavedRecord, flowSchemaRef } from "./schema";

const execute = promisify(execFile);
const savedListingRecord = flowSavedRecord.extend({ package: z.null() }).strict();
const shownRecord = flowSavedRecord.extend({ yaml: z.string() }).strict();
const listing = z.object({ status: z.literal("ok"), flows: z.array(z.discriminatedUnion("source", [savedListingRecord, z.object({ source: z.literal("arc"), name: z.string(), path: z.string(), package: z.string().nullable(), sha256: z.string().nullable(), provenance: z.json() }).strict()])) }).strict();
const queryInput = z.object({ stack: ObjectReferenceSchema, limit: z.number().int().min(1).max(20).optional() }).strict();
const readInput = z.object({ ref: ObjectReferenceSchema }).strict();
const handlerContext = z.object({ destinations: z.array(ObjectReferenceSchema), cursor: z.string().optional(), limit: z.number().int().positive() });
const unavailable = (): never => { throw new Error("flow.source_unavailable"); };
const same = (left: ObjectReference, right: ObjectReference): boolean => authorityHash(left) === authorityHash(right);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const checked = schema.safeParse(value);
  return checked.success ? checked.data : unavailable();
}
type SavedListing = z.infer<typeof savedListingRecord>[];
function pageSaved(saved: SavedListing, cursor: string | undefined, limit: number) {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || cursor !== undefined && String(offset) !== cursor) return unavailable();
  const items = saved.slice(offset, offset + limit);
  return { items, ...(offset + items.length < saved.length ? { cursor: String(offset + items.length) } : {}) };
}

export interface FlowReadSource {
  readonly connectionId: string;
  readonly stack: string;
  readonly flowsDir?: string;
  readonly dataPolicy?: "local" | "cloud";
  readonly binary?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function createFlowReadAdapter(source: FlowReadSource) {
  const destination: ObjectReference = { adapterId: FLOW_ADAPTER_ID, connectionId: source.connectionId, objectType: "stack", canonicalId: source.stack };
  const dataPolicy = source.dataPolicy ?? "local";
  const owner = async (args: string[], signal?: AbortSignal): Promise<unknown> => {
    if (!source.flowsDir || !isAbsolute(source.flowsDir)) return unavailable();
    try {
      const result = await execute(source.binary ?? "pulse", ["flow", ...args, "--flows-dir", source.flowsDir, "--json"], { env: source.env ?? process.env, timeout: 8000, maxBuffer: 1048576, signal });
      return JSON.parse(result.stdout) as unknown;
    } catch (_err) { return unavailable(); }
  };
  const readSaved = async (saved: SavedListing, target: ObjectReference, signal?: AbortSignal) => {
    const listed = saved.find(item => item.name === target.canonicalId);
    if (!listed) return unavailable();
    const shown = parse(shownRecord, await owner(["show", target.canonicalId], signal));
    const { yaml: _yaml, ...metadata } = shown;
    const { package: _package, ...expected } = listed;
    if (authorityHash(metadata) !== authorityHash(expected)) return unavailable();
    return { items: [shown] };
  };
  const selection = (request: QueryFetchRequest) => {
    if (request.capabilityId === "flow.saved.query") {
      const input = parse(queryInput, request.input);
      if (!same(input.stack, destination)) return unavailable();
      return { kind: "query" as const, limit: Math.min(request.limit, input.limit ?? 20, 20) };
    }
    if (request.capabilityId === "flow.saved.read") {
      const target = parse(readInput, request.input).ref;
      if (target.adapterId !== FLOW_ADAPTER_ID || target.connectionId !== source.connectionId || target.objectType !== "saved" || !flowName.safeParse(target.canonicalId).success || request.cursor !== undefined) return unavailable();
      return { kind: "read" as const, target };
    }
    return unavailable();
  };
  const query = async (request: QueryFetchRequest, signal?: AbortSignal): Promise<QueryPage> => {
    if (!request.destinations.some(ref => same(ref, destination))) return unavailable();
    if (!Number.isInteger(request.limit) || request.limit < 1) return unavailable();
    const selected = selection(request);
    const parsed = parse(listing, await owner(["list", "--saved"], signal));
    const saved = parsed.flows.filter(item => item.source === "saved");
    if (new Set(saved.map(item => item.name)).size !== saved.length) return unavailable();
    const snapshot = authorityHash(saved);
    const page: { items: z.infer<typeof flowSavedRecord>[]; cursor?: string } = selected.kind === "read" ? await readSaved(saved, selected.target, signal) : pageSaved(saved, request.cursor, selected.limit);
    const { items, cursor } = page;
    const at = new Date().toISOString();
    return {
      readVersion: "1.0.0", payload: { items }, observedAt: at, ordering: "provider", snapshot: { kind: "stable", id: snapshot },
      annotations: items.map((value, position) => {
        return { pointer: `/items/${position}`, ref: { adapterId: FLOW_ADAPTER_ID, connectionId: source.connectionId, objectType: "saved", canonicalId: value.name }, schemaRef: flowSchemaRef("flow.saved"), destination, position, evidence: { evidenceId: `flow.saved:${value.name}`, revision: authorityHash(value), observedAt: at } };
      }),
      ...(cursor === undefined ? {} : { cursor }),
    };
  };
  const handlers: AdapterBindings["handlers"] = Object.fromEntries(flowReadBindings.map(binding => [binding.capabilityId, (input: unknown, context: unknown) => {
    const checked = parse(handlerContext, context);
    return query({ readVersion: "1.0.0", queryId: "registered-handler", capabilityId: binding.capabilityId, input: input as Json, ...checked });
  }]));
  return {
    declaration: flowReadDeclaration(), bindings: { handlers, observations: {} }, readBindings: flowReadBindings, destination, dataPolicy, query,
    restriction: (metadata: Omit<RestrictionRecord, "source" | "egress">): RestrictionRecord => ({ ...metadata, source: destination, egress: dataPolicy }),
  };
}
