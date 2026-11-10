import type { Json } from "../operations/types";
import type { SchemaRef } from "../types";

export const BALANCE_DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const BALANCE_ADAPTER_ID = "balance";
export type SchemaDocument = Record<string, Json>;

export const ref = (schemaId: string): SchemaRef => ({ schemaId, version: "1.0.0" });
export const objectSchema = (properties: Record<string, Json>, required: readonly string[]): SchemaDocument => ({ $schema: BALANCE_DIALECT, type: "object", additionalProperties: false, required: [...required], properties });
export const referenceSchema = (objectType: "area" | "project" | "task"): SchemaDocument => objectSchema({
  adapterId: { type: "string", const: BALANCE_ADAPTER_ID },
  connectionId: { type: "string", minLength: 1 },
  objectType: { type: "string", const: objectType },
  canonicalId: { type: "string", minLength: 1 },
}, ["adapterId", "connectionId", "objectType", "canonicalId"]);
export const nullableReferenceSchema = (objectType: "area" | "project" | "task"): SchemaDocument => ({ anyOf: [referenceSchema(objectType), { type: "null" }] });
