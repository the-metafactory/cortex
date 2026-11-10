import { objectReferenceSchema, objectSchema, schemaRef, type SchemaDocument } from "../schema-primitives";
import type { SchemaRef } from "../types";

export const WORK_GRAPH_ADAPTER_ID = "work-graph";
export type GraphObjectType = "repository" | "map" | "node";

export const ref = (schemaId: string): SchemaRef => schemaRef(schemaId);
export { objectSchema };
export const referenceSchema = (objectType: GraphObjectType): SchemaDocument => objectReferenceSchema(WORK_GRAPH_ADAPTER_ID, objectType);
export const nullableReferenceSchema = (objectType: GraphObjectType): SchemaDocument => ({ ...referenceSchema(objectType), type: ["object", "null"] });
