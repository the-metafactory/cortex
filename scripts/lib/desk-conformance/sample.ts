import type { ObjectReference } from "../../../src/conversations/domain-adapters/types";

export interface SampleContext {
  schemas: ReadonlyMap<string, unknown>;
  destinations: readonly ObjectReference[];
  adapterId: string;
  connectionId: string;
}

const MAX_DEPTH = 8;
const FILLER = "conformance";
const REFERENCE_KEYS = ["adapterId", "connectionId", "objectType", "canonicalId"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const schemaUrn = (schemaId: string, version: string): string => `urn:desk-schema:${schemaId}:${version}`;

function sampleString(schema: Record<string, unknown>): string {
  if (schema.format === "date") return "2026-11-01";
  if (schema.format === "date-time") return "2026-11-01T00:00:00.000Z";
  if (schema.format === "uri") return "https://example.invalid/conformance";
  const minimum = typeof schema.minLength === "number" ? schema.minLength : 1;
  const padded = FILLER.padEnd(minimum, "x");
  return typeof schema.maxLength === "number" ? padded.slice(0, Math.max(schema.maxLength, 0)) : padded;
}

function sampleNumber(schema: Record<string, unknown>): number {
  if (typeof schema.minimum === "number") return schema.minimum;
  return typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum + 1 : 1;
}

function isReference(schema: Record<string, unknown>): boolean {
  const properties = schema.properties;
  return isRecord(properties) && REFERENCE_KEYS.every(key => key in properties);
}

function sampleReference(schema: Record<string, unknown>, context: SampleContext): ObjectReference {
  const properties = schema.properties as Record<string, unknown>;
  const objectTypeSchema = properties.objectType;
  const objectType = isRecord(objectTypeSchema) && typeof objectTypeSchema.const === "string" ? objectTypeSchema.const : FILLER;
  const known = context.destinations.find(destination => destination.objectType === objectType);
  return known ?? { adapterId: context.adapterId, connectionId: context.connectionId, objectType, canonicalId: `${FILLER}-reference` };
}

function sampleObject(schema: Record<string, unknown>, context: SampleContext, depth: number): unknown {
  if (isReference(schema)) return sampleReference(schema, context);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  return Object.fromEntries(required.map(key => [key, sampleValue(properties[key], context, depth + 1)]));
}

/** Builds a minimal value that satisfies a declared JSON Schema, from the schema alone. */
export function sampleValue(schema: unknown, context: SampleContext, depth = 0): unknown {
  if (!isRecord(schema) || depth > MAX_DEPTH) return null;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (typeof schema.$ref === "string") return sampleValue(context.schemas.get(schema.$ref), context, depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find(candidate => candidate !== "null") : schema.type;
  if (type === "string") return sampleString(schema);
  if (type === "integer" || type === "number") return sampleNumber(schema);
  if (type === "boolean") return false;
  if (type === "array") return Array.from({ length: typeof schema.minItems === "number" ? schema.minItems : 0 }, () => sampleValue(schema.items, context, depth + 1));
  return type === "object" ? sampleObject(schema, context, depth) : null;
}
