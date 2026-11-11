import { z } from "zod";
import { ObservationPolicySchema } from "./observation-policy";
import { ObjectReferenceSchema, SchemaRefSchema } from "../types";

export const READ_BINDING_VERSION = "1.0.0";
const identifier = z.string().min(1).refine(value => value.trim().length > 0);
const pointer = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)+$/);
const label = z.string().trim().min(1).max(80);
export const READ_MODES = ["query", "poll", "destinations"] as const;
export const RowCapabilitySchema = z.object({ capabilityId: identifier, label }).strict();
export type RowCapability = z.infer<typeof RowCapabilitySchema>;
export const ReadBindingSchema = z.object({
  version: z.literal(READ_BINDING_VERSION),
  adapterId: identifier,
  capabilityId: identifier,
  mode: z.enum(READ_MODES),
  objectType: identifier,
  inputSchemaRef: SchemaRefSchema,
  outputSchemaRef: SchemaRefSchema,
  textPointer: pointer.optional(),
  destinationType: identifier.optional(),
  display: z.object({ title: pointer, summary: pointer.optional(), status: pointer.optional(), due: pointer.optional(), area: pointer.optional(), kind: pointer.optional(), parent: pointer.optional(), url: pointer.optional() }).strict(),
  attention: z.object({ pointer, badge: pointer.optional(), owner: pointer.optional() }).strict().optional(),
  capabilities: z.array(RowCapabilitySchema).min(1).max(8).optional(),
  observation: ObservationPolicySchema.optional(),
  query: z.object({
    objectsPointer: pointer,
    aggregatePointers: z.array(pointer).optional(),
    ordering: z.literal("provider"),
    stableSnapshot: z.boolean(),
    limits: z.object({ items: z.number().int().positive().max(20).optional(), bytes: z.number().int().positive().max(1048576).optional(), pageMs: z.number().int().positive().max(10000).optional() }).strict().optional(),
  }).strict().optional(),
}).strict();
export type ReadBinding = z.infer<typeof ReadBindingSchema>;
export type ReadMode = ReadBinding["mode"];

export interface ReadConnectorDeclaration { adapterId: string; connectionId: string; readCapabilityIds: readonly string[] }
export type ReadBindingLookup = { state: "available"; binding: ReadBinding } | { state: "unavailable"; code: "binding_missing" };

export const ReadRequestSchema = z.object({ lifecycleVersion: z.literal("1.0.0"), capabilityId: identifier, destinations: z.array(ObjectReferenceSchema).min(1), input: z.json() }).strict();
export type ReadRequest = z.infer<typeof ReadRequestSchema>;
export const ReadAdmissionRequestSchema = z.object({ connectionId: identifier, capabilityId: identifier, destinations: z.array(ObjectReferenceSchema).min(1), input: z.json() }).strict();
export type ReadAdmissionRequest = z.infer<typeof ReadAdmissionRequestSchema>;
export const ReadPageSchema = z.object({
  objects: z.array(z.object({ ref: ObjectReferenceSchema, schemaRef: SchemaRefSchema, destination: ObjectReferenceSchema.optional(), value: z.json() }).strict()),
}).strict();
export type ReadPage = z.infer<typeof ReadPageSchema>;
export type ReadPageObject = ReadPage["objects"][number];
