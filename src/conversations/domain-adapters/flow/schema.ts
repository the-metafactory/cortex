import { z } from "zod";
import type { Json } from "../operations/types";
import { schemaKey } from "../schema-validation";
import type { AdapterDeclaration, SchemaRef } from "../types";
import type { ReadBinding } from "../reads/types";

export const FLOW_ADAPTER_ID = "flow";
export const flowSchemaRef = (schemaId: string): SchemaRef => ({ schemaId, version: "1.0.0" });
const object = (properties: Record<string, Json>, required = Object.keys(properties)): Record<string, Json> => ({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, properties, required });
const string = { type: "string" };
export const flowName = z.string().regex(/^F_[A-Z0-9_]{1,64}$/);
const provenance = z.object({ origin: z.enum(["conversation", "cli"]), conversation: z.string().nullable(), exchange: z.string().nullable(), request_id: z.string(), saved_at: z.iso.datetime(), saved_by: z.string() }).strict().nullable();
export const flowSavedRecord = z.object({ name: flowName, source: z.literal("saved"), sha256: z.string().regex(/^[0-9a-f]{64}$/), provenance, path: z.string() });
export const flowReferenceSchema = (objectType: "stack" | "saved"): Record<string, Json> => object({ adapterId: { const: FLOW_ADAPTER_ID, type: "string" }, connectionId: { type: "string", minLength: 1 }, objectType: { type: "string", const: objectType }, canonicalId: { type: "string", minLength: 1 } });
const saved = JSON.parse(JSON.stringify(z.toJSONSchema(flowSavedRecord.extend({ package: z.null().optional(), yaml: z.string().optional() }).strict()))) as Record<string, Json>;
const output = object({ items: { type: "array", items: { $ref: schemaKey(flowSchemaRef("flow.saved")) } } });
const queryInput = object({ stack: flowReferenceSchema("stack"), limit: { type: "integer", minimum: 1, maximum: 20 } }, ["stack"]);
const readInput = object({ ref: flowReferenceSchema("saved") });
const error = object({ code: string, message: string });
const capabilityIds = ["flow.saved.query", "flow.saved.read"] as const;

export function flowReadDeclaration(): AdapterDeclaration {
  return {
    adapterId: FLOW_ADAPTER_ID, label: "Saved Flows", contractRange: "^1.0.0",
    schemas: [
      { ...flowSchemaRef("flow.stack"), schema: object({ label: string }) },
      { ...flowSchemaRef("flow.saved"), schema: saved },
      { ...flowSchemaRef("flow.saved.query.input"), schema: queryInput },
      { ...flowSchemaRef("flow.saved.read.input"), schema: readInput },
      { ...flowSchemaRef("flow.saved.output"), schema: output },
      { ...flowSchemaRef("flow.error"), schema: error },
    ],
    objectTypes: [
      { objectType: "stack", label: "Stack", schemaRef: flowSchemaRef("flow.stack"), relationships: [] },
      { objectType: "saved", label: "Saved Flow", schemaRef: flowSchemaRef("flow.saved"), relationships: [] },
    ],
    capabilities: capabilityIds.map(capabilityId => ({ capabilityId, label: capabilityId === "flow.saved.query" ? "List saved Flows" : "Read saved Flow", kind: "query", objectTypes: ["saved"], inputSchemaRef: flowSchemaRef(`${capabilityId}.input`), outputSchemaRef: flowSchemaRef("flow.saved.output"), errorSchemaRef: flowSchemaRef("flow.error") })),
  };
}

export const flowReadBindings: readonly ReadBinding[] = capabilityIds.map(capabilityId => ({
  version: "1.0.0", adapterId: FLOW_ADAPTER_ID, capabilityId, mode: "query", objectType: "saved", destinationType: "stack",
  inputSchemaRef: flowSchemaRef(`${capabilityId}.input`), outputSchemaRef: flowSchemaRef("flow.saved.output"), display: { title: "/name" },
  query: { objectsPointer: "/items", ordering: "provider", stableSnapshot: true, limits: { items: capabilityId === "flow.saved.read" ? 1 : 20 } },
}));
