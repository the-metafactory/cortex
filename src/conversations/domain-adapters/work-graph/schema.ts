import { nullableObjectReferenceSchema, objectReferenceSchema, type SchemaDocument } from "../schema-primitives";

export const WORK_GRAPH_ADAPTER_ID = "work-graph";
export type GraphObjectType = "repository" | "map" | "node";

export const referenceSchema = (objectType: GraphObjectType): SchemaDocument => objectReferenceSchema(WORK_GRAPH_ADAPTER_ID, objectType);
export const nullableReferenceSchema = (objectType: GraphObjectType): SchemaDocument => nullableObjectReferenceSchema(WORK_GRAPH_ADAPTER_ID, objectType);
