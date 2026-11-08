import { z } from "zod";
import { AdapterDeclarationSchema, ObjectReferenceSchema, SchemaRefSchema, type AdapterBindings, type AdapterDeclaration, type ObjectReference } from "../types";
import type { DispatchRequest, ObjectReadback, OwnerResult, OwnerSupport } from "../operations/types";

export const DESK_ADAPTER_SDK_VERSION = "1.0.0";
const id = z.string().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const pointer = z.string().regex(/^\/.*/);
const relative = z.string().min(1).refine(value => !value.startsWith("/") && !value.split("/").includes(".."));

export const DraftingBindingSchema = z.object({
  version: z.literal("1.0.0"), adapterId: id, capabilityId: id, inputSchemaRef: SchemaRefSchema, guidanceId: id, guidanceVersion: id, instruction: z.string(),
  fieldHints: z.array(z.object({ pointer, role: z.enum(["title", "summary", "destination", "detail"]), resolveWith: id.optional(), widget: z.enum(["long"]).optional() }).strict()),
}).strict();
export const ReadBindingSchema = z.object({
  version: z.literal("1.0.0"), adapterId: id, capabilityId: id, mode: z.enum(["query", "poll", "destinations"]), objectType: id, inputSchemaRef: SchemaRefSchema, outputSchemaRef: SchemaRefSchema,
  textPointer: pointer.optional(), destinationPointer: pointer.optional(), destinationType: id.optional(), display: z.object({ title: pointer, summary: pointer.optional() }).strict(),
  attention: z.object({ title: pointer, why: pointer.optional(), due: pointer.optional(), area: pointer.optional(), link: pointer.optional() }).strict().optional(),
}).strict();
export const PackageManifestSchema = z.object({
  format: z.literal("desk-adapter-package/1"), packageId: id, packageVersion: id, deskSdkRange: id, domainContractVersion: z.literal("1.0.0"),
  backend: z.object({ entry: relative, sha256: sha }).strict(),
  declaration: AdapterDeclarationSchema, draftingBindings: z.array(DraftingBindingSchema), readBindings: z.array(ReadBindingSchema),
  setup: z.object({ version: z.literal("1.0.0"), schemas: z.array(z.object({ schemaId: id, version: id, schema: z.record(z.string(), z.json()) }).strict()), configurationSchemaRef: SchemaRefSchema, accountScopeSchemaRef: SchemaRefSchema, authMethods: z.array(z.union([z.object({ kind: z.literal("local") }).strict(), z.object({ kind: z.literal("token"), slots: z.array(z.object({ name: id, label: id, required: z.boolean() }).strict()) }).strict(), z.object({ kind: z.literal("broker"), brokerId: id }).strict()])).min(1) }).strict(),
  ui: z.object({ protocolVersion: z.literal("1.0.0"), entry: relative, files: z.array(z.object({ path: relative, sha256: sha, mediaType: z.enum(["text/html", "text/javascript", "text/css"]) }).strict()).min(1), views: z.array(z.object({ objectType: id, view: z.literal("result") }).strict()) }).strict().optional(),
}).strict();
export type PackageManifest = z.infer<typeof PackageManifestSchema>;
export type DraftingBinding = z.infer<typeof DraftingBindingSchema>;
export type ReadBinding = z.infer<typeof ReadBindingSchema>;

export const ReadResponseSchema = z.object({
  payload: z.json(),
  annotations: z.array(z.object({ pointer: z.string(), ref: ObjectReferenceSchema, objectSchemaRef: SchemaRefSchema, ownerRevision: id, destination: ObjectReferenceSchema.optional() }).strict()),
  continuation: id.optional(), observedAt: z.string(), consistency: z.enum(["snapshot", "best-effort"]),
}).strict();
export type ReadResponse = z.infer<typeof ReadResponseSchema>;
export interface ReadContext { connectionId: string; destinations: ObjectReference[]; continuation?: string; signal: AbortSignal }

export interface ConnectionForConnector { connectionId: string; adapterId: string; accountScope: Record<string, unknown>; configuration: Record<string, unknown> }
export interface PackagedConnector { support: OwnerSupport; readbackCapabilityId: string; dispatch(request: DispatchRequest, signal: AbortSignal): Promise<OwnerResult>; readback(request: { lifecycleVersion: "1.0.0"; ref: ObjectReference }, signal: AbortSignal): Promise<ObjectReadback> }
export interface DeskAdapterHost { sdkVersion: string; registerConnector(capabilityId: string, connect: (connection: ConnectionForConnector) => PackagedConnector): void }
export interface DeskAdapterModule { declaration: AdapterDeclaration; bindings: AdapterBindings }
export type CreateDeskAdapter = (host: DeskAdapterHost) => DeskAdapterModule;
