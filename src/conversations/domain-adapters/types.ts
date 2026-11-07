import { z } from "zod";
import { valid } from "semver";

const identifier = z.string().min(1).refine(value => value.trim().length > 0);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/).refine(value => valid(value) !== null);
export const SchemaRefSchema = z.object({ schemaId: identifier, version }).strict();
export const ObjectReferenceSchema = z.object({ adapterId: identifier, connectionId: identifier, objectType: identifier, canonicalId: identifier }).strict();
const relationship = z.object({ fieldPath: z.string().regex(/^(?:\/(?:[^~]|~[01])*)+$/), targetAdapterId: identifier, targetObjectType: identifier, cardinality: z.enum(["one", "many"]) }).strict();
const objectType = z.object({ objectType: identifier, label: identifier, schemaRef: SchemaRefSchema, relationships: z.array(relationship) }).strict();
const capability = z.object({ capabilityId: identifier, label: identifier, kind: z.enum(["observation", "query", "action"]), objectTypes: z.array(identifier), inputSchemaRef: SchemaRefSchema, outputSchemaRef: SchemaRefSchema, errorSchemaRef: SchemaRefSchema }).strict();
export const AdapterDeclarationSchema = z.object({
  adapterId: identifier,
  label: identifier,
  contractRange: identifier,
  schemas: z.array(z.object({ schemaId: identifier, version, schema: z.union([z.boolean(), z.record(z.string(), z.json())]) }).strict()),
  objectTypes: z.array(objectType),
  capabilities: z.array(capability),
  uiHints: z.record(z.string(), z.json()).optional(),
}).strict();
export const BoundaryErrorSchema = z.object({
  code: identifier,
  message: identifier,
  issues: z.array(z.object({ path: z.string().regex(/^(?:\/(?:[^~]|~[01])*)*$/), code: identifier, message: identifier }).strict()).optional(),
}).strict();
export const InputRequestSchema = z.object({ capabilityId: identifier, inputSchemaRef: SchemaRefSchema, input: z.json() }).strict();
export type SchemaRef = z.infer<typeof SchemaRefSchema>;
export type ObjectReference = z.infer<typeof ObjectReferenceSchema>;
export type AdapterDeclaration = z.infer<typeof AdapterDeclarationSchema>;
export type CapabilityDeclaration = AdapterDeclaration["capabilities"][number];
export type BoundaryError = z.infer<typeof BoundaryErrorSchema>;
export type Result<T> = { ok: true; value: T } | { ok: false; error: BoundaryError };
export type Handler = (input: unknown, context: unknown) => unknown;
export interface AdapterBindings { handlers: Record<string, Handler>; observations: Record<string, object> }
export type Availability = { state: "available" } | { state: "unavailable"; code: string; message: string };
export interface DeclaredCapability { support: "declared"; adapterId: string; capability: CapabilityDeclaration; availability: Availability }
export type CapabilityDiscovery = DeclaredCapability | { support: "unsupported"; capabilityId: string };
