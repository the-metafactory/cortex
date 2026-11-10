import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { authorityHash, type RestrictionRecord } from "../../authority-records";
import type { Json } from "../operations/types";
import type { QueryFetchRequest, QueryPage } from "../reads/query-types";
import { ObjectReferenceSchema, type AdapterBindings, type ObjectReference } from "../types";
import { FLOW_ADAPTER_ID, flowReadBindings, flowReadDeclaration, flowSchemaRef } from "./schema";

const execute = promisify(execFile);
const name = z.string().regex(/^F_[A-Z0-9_]{1,64}$/);
const provenance = z.object({ origin: z.enum(["conversation", "cli"]), conversation: z.string().nullable(), exchange: z.string().nullable(), request_id: z.string(), saved_at: z.iso.datetime(), saved_by: z.string() }).strict().nullable();
const record = z.object({ name, source: z.literal("saved"), sha256: z.string().regex(/^[0-9a-f]{64}$/), provenance, path: z.string() });
const listing = z.object({ status: z.literal("ok"), flows: z.array(z.discriminatedUnion("source", [record.extend({ package: z.null() }).strict(), z.object({ source: z.literal("arc"), name: z.string(), path: z.string(), package: z.string().nullable(), sha256: z.string().nullable(), provenance: z.json() }).strict()])) }).strict();
const queryInput = z.object({ stack: ObjectReferenceSchema, limit: z.number().int().min(1).max(20).optional() }).strict();
const readInput = z.object({ ref: ObjectReferenceSchema }).strict();
const handlerContext = z.object({ destinations: z.array(ObjectReferenceSchema), cursor: z.string().optional(), limit: z.number().int().positive() });
const unavailable = (): never => { throw new Error("flow.source_unavailable"); };
const same = (left: ObjectReference, right: ObjectReference): boolean => authorityHash(left) === authorityHash(right);

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
  const query = async (request: QueryFetchRequest, signal?: AbortSignal): Promise<QueryPage> => {
    if (!request.destinations.some(ref => same(ref, destination))) return unavailable();
    if (!Number.isInteger(request.limit) || request.limit < 1) return unavailable();
    let target: ObjectReference | undefined;
    let limit = Math.min(request.limit, 20);
    if (request.capabilityId === "flow.saved.query") {
      const input = queryInput.parse(request.input);
      if (!same(input.stack, destination)) return unavailable();
      limit = Math.min(limit, input.limit ?? 20);
    } else if (request.capabilityId === "flow.saved.read") {
      target = readInput.parse(request.input).ref;
      if (target.adapterId !== FLOW_ADAPTER_ID || target.connectionId !== source.connectionId || target.objectType !== "saved" || !name.safeParse(target.canonicalId).success || request.cursor !== undefined) return unavailable();
    } else return unavailable();
    const parsed = listing.parse(await owner(["list", "--saved"], signal));
    const saved = parsed.flows.filter(item => item.source === "saved");
    if (new Set(saved.map(item => item.name)).size !== saved.length) return unavailable();
    let items: Json[];
    let cursor: string | undefined;
    const snapshot = authorityHash(saved);
    if (target) {
      const listed = saved.find(item => item.name === target.canonicalId);
      if (!listed) return unavailable();
      const shown = record.extend({ yaml: z.string() }).strict().parse(await owner(["show", target.canonicalId], signal));
      const { yaml: _yaml, ...metadata } = shown;
      const { package: _package, ...expected } = listed;
      if (authorityHash(metadata) !== authorityHash(expected)) return unavailable();
      items = [shown];
    } else {
      const offset = request.cursor === undefined ? 0 : Number(request.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || request.cursor !== undefined && String(offset) !== request.cursor) return unavailable();
      items = saved.slice(offset, offset + limit);
      if (offset + items.length < saved.length) cursor = String(offset + items.length);
    }
    const at = new Date().toISOString();
    return {
      readVersion: "1.0.0", payload: { items }, observedAt: at, ordering: "provider", snapshot: { kind: "stable", id: snapshot },
      annotations: items.map((value, position) => {
        const flow = record.parse(value);
        return { pointer: `/items/${position}`, ref: { adapterId: FLOW_ADAPTER_ID, connectionId: source.connectionId, objectType: "saved", canonicalId: flow.name }, schemaRef: flowSchemaRef("flow.saved"), destination, position, evidence: { evidenceId: `flow.saved:${flow.name}`, revision: authorityHash(value), observedAt: at } };
      }),
      ...(cursor === undefined ? {} : { cursor }),
    };
  };
  const handlers: AdapterBindings["handlers"] = Object.fromEntries(flowReadBindings.map(binding => [binding.capabilityId, (input: unknown, context: unknown) => {
    const checked = handlerContext.parse(context);
    return query({ readVersion: "1.0.0", queryId: "registered-handler", capabilityId: binding.capabilityId, input: input as Json, ...checked });
  }]));
  return {
    declaration: flowReadDeclaration(), bindings: { handlers, observations: {} }, readBindings: flowReadBindings, destination, dataPolicy, query,
    restriction: (metadata: Omit<RestrictionRecord, "source" | "egress">): RestrictionRecord => ({ ...metadata, source: destination, egress: dataPolicy }),
  };
}
