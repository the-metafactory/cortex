import { z } from "zod";
import { ObjectReferenceSchema, SchemaRefSchema } from "../types";
import type { BoundaryError } from "../types";
import type { Json } from "../operations/types";
import { ReadAdmissionRequestSchema } from "./types";

export const READ_ENVELOPE_VERSION = "1.0.0";
export const QUERY_LIMITS = { items: 60, invocationMs: 30000, connections: 10, concurrent: 2, pageItems: 20, pageBytes: 1048576, pageMs: 10000, continuationMs: 600000 } as const;
export const QuerySourceSchema = ReadAdmissionRequestSchema.extend({ adapterId: z.string().min(1), inputSchemaRef: SchemaRefSchema }).strict();
export type QuerySource = z.infer<typeof QuerySourceSchema>;
export const QueryRequestSchema = z.object({ readVersion: z.literal(READ_ENVELOPE_VERSION), queryId: z.uuid(), sources: z.array(QuerySourceSchema).min(1).max(10), continuation: z.uuid().optional() }).strict();
export type QueryRequest = z.infer<typeof QueryRequestSchema>;
const annotation = z.object({
  pointer: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)+$/),
  ref: ObjectReferenceSchema, schemaRef: SchemaRefSchema, destination: ObjectReferenceSchema,
  position: z.number(),
  evidence: z.object({ evidenceId: z.string().min(1), revision: z.string().min(1), observedAt: z.iso.datetime() }).strict(),
}).strict();
export const QueryPageSchema = z.object({
  readVersion: z.literal(READ_ENVELOPE_VERSION), payload: z.json(), annotations: z.array(annotation).max(20),
  observedAt: z.iso.datetime(), ordering: z.literal("provider"),
  snapshot: z.discriminatedUnion("kind", [z.object({ kind: z.literal("stable"), id: z.string().min(1) }).strict(), z.object({ kind: z.literal("live") }).strict()]),
  cursor: z.string().min(1).optional(),
}).strict();
export type QueryPage = z.infer<typeof QueryPageSchema>;
export interface QueryFetchRequest { readVersion: "1.0.0"; queryId: string; capabilityId: string; input: Json; destinations: QuerySource["destinations"]; cursor?: string; limit: number }
export type QuerySeen = Record<string, string>;
export interface QueryDispatch { queryId: string; source: QuerySource; head: string; cursor?: string; snapshotId?: string; limit: number; seen: QuerySeen }
export type QueryStatus = "ok" | "partial" | "cancelled" | "denied" | "unsupported" | "unavailable";
export interface QueryGroup { source: Pick<QuerySource, "adapterId" | "connectionId" | "capabilityId">; status: QueryStatus | "not-attempted"; reason?: BoundaryError; coverage: "exhausted" | "more" | "incomplete" | "budget-exhausted" }
export interface QueryResult { readVersion: "1.0.0"; queryId: string; status: QueryStatus; groups: QueryGroup[]; restricted: boolean; noMatch: boolean; continuation?: string; restartRequired?: true; reason?: BoundaryError }
export interface QueryObserver { released(value: Json): void }
export const queryError = (code: string): BoundaryError => ({ code, message: code === "restart_required" ? "This query requires an explicit restart." : "The query could not complete within its current scope and bounds." });
