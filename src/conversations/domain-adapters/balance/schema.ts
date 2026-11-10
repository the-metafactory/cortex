import { JSON_SCHEMA_DIALECT, nullableObjectReferenceSchema, objectReferenceSchema, type SchemaDocument } from "../schema-primitives";

export const BALANCE_DIALECT = JSON_SCHEMA_DIALECT;
export const BALANCE_ADAPTER_ID = "balance";
export type { SchemaDocument };
export const referenceSchema = (objectType: "area" | "project" | "task"): SchemaDocument => objectReferenceSchema(BALANCE_ADAPTER_ID, objectType);
export const nullableReferenceSchema = (objectType: "area" | "project" | "task"): SchemaDocument => nullableObjectReferenceSchema(BALANCE_ADAPTER_ID, objectType);
