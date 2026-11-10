import type { Json } from "./operations/types";

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
export type SchemaDocument = Record<string, Json>;
export const schemaRef = (schemaId: string): { schemaId: string; version: "1.0.0" } => ({ schemaId, version: "1.0.0" });
export const objectSchema = (properties: Record<string, Json>, required: readonly string[]): SchemaDocument => ({ $schema: JSON_SCHEMA_DIALECT, type: "object", additionalProperties: false, required: [...required], properties });
export const objectReferenceSchema = (adapterId: string, objectType: string): SchemaDocument => objectSchema({
  adapterId: { type: "string", const: adapterId },
  connectionId: { type: "string", minLength: 1 },
  objectType: { type: "string", const: objectType },
  canonicalId: { type: "string", minLength: 1 },
}, ["adapterId", "connectionId", "objectType", "canonicalId"]);
