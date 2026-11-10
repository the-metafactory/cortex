import { JSON_SCHEMA_DIALECT, objectReferenceSchema, objectSchema, schemaRef, type SchemaDocument } from "../schema-primitives";
import type { SchemaRef } from "../types";

export const BALANCE_DIALECT = JSON_SCHEMA_DIALECT;
export const BALANCE_ADAPTER_ID = "balance";
export type { SchemaDocument };
export const ref = (schemaId: string): SchemaRef => schemaRef(schemaId);
export { objectSchema };
export const referenceSchema = (objectType: "area" | "project" | "task"): SchemaDocument => objectReferenceSchema(BALANCE_ADAPTER_ID, objectType);
export const nullableReferenceSchema = (objectType: "area" | "project" | "task"): SchemaDocument => ({ anyOf: [referenceSchema(objectType), { type: "null" }] });
