import { z } from "zod";
import { CREATABLE_TYPES, type CreatableType } from "./catalog";

export const OWNER_TYPES = CREATABLE_TYPES;
export type OwnerType = CreatableType;
export type ConversationId = string;
export type Policy = "local" | "cloud";
export type ModelRoute = Policy;

export const ObjectRefSchema = z.object({
  owner: z.enum(OWNER_TYPES),
  id: z.string().trim().min(1).max(512),
  url: z.url().max(2048).optional(),
}).strict();
export type ObjectRef = z.infer<typeof ObjectRefSchema>;

export const ORIGIN_KINDS = ["studio", "balance", "graph", "discord-dm", "web", "imported-studio-session"] as const;
export const OriginSchema = z.object({ kind: z.enum(ORIGIN_KINDS), ref: z.string().trim().min(1).max(512).optional() }).strict();
export type Origin = z.infer<typeof OriginSchema>;

export interface ConversationMeta {
  id: ConversationId;
  stack: string;
  title: string;
  links: ObjectRef[];
  policy: Policy;
  state: "current" | "archived";
  pinned: boolean;
  activity: { lastAt: string; status: "working" | "waiting" | "idle" };
  origin: Origin;
  discord?: { threadId: string; usedAt: string };
}

export const AttachmentRefSchema = z.object({
  uri: z.string().regex(/^attachment:\/\/sha256\/[0-9a-f]{64}$/),
  name: z.string().trim().min(1).max(256),
  mediaType: z.string().trim().min(1).max(128),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

export const InputRequestSchema = z.object({
  inputId: z.string().trim().min(1).max(256),
  transport: z.enum(["web", "discord"]),
  text: z.string().trim().min(1).max(20_000),
  attachments: z.array(AttachmentRefSchema).max(20).optional(),
  mode: z.enum(["queue", "steer"]).default("queue"),
}).strict();
export type InputRequest = z.infer<typeof InputRequestSchema>;

export const CreateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200),
  links: z.array(ObjectRefSchema).max(50).default([]),
  origin: OriginSchema,
  policy: z.enum(["local", "cloud"]).default("cloud"),
}).strict();
export type CreateConversation = z.infer<typeof CreateConversationSchema>;

export const AttachmentUploadSchema = z.object({
  name: z.string().trim().min(1).max(256),
  mediaType: z.string().trim().min(1).max(128),
  base64: z.string().min(1).max(14_000_000),
}).strict();
export type AttachmentUpload = z.infer<typeof AttachmentUploadSchema>;

export const DraftSchema = z.object({ text: z.string().max(20_000) }).strict();

export const CONVERSATION_STATES = ["current", "archived"] as const;
export const OrganizeSchema = z.object({ pinned: z.boolean().optional(), state: z.enum(CONVERSATION_STATES).optional() }).strict()
  .refine(change => change.pinned !== undefined || change.state !== undefined);
export type Organize = z.infer<typeof OrganizeSchema>;
export const OverviewQuerySchema = z.object({
  state: z.enum(CONVERSATION_STATES).default("current"),
  q: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(1024).optional(),
}).strict();
export type OverviewQuery = z.infer<typeof OverviewQuerySchema>;

export interface ExchangeLine { who: "principal" | "assistant"; text: string }
export interface LinkedView { owner: OwnerType; title: string | null }
export interface OverviewRow {
  conversation: ConversationMeta;
  linked: LinkedView[];
  latest: ExchangeLine | null;
  match: ExchangeLine | null;
}
export interface OverviewPage { rows: OverviewRow[]; next?: string }

export interface ConversationDetail {
  conversation: ConversationMeta;
  sources: SourceView[];
  draft: string;
  pending: SubmissionView[];
  studio: { scope: "thread" | "note"; subject: string; outcome: OperationRecord | null } | null;
}

export interface SubmissionView {
  inputId: string;
  submission: string;
  status: "queued" | "placed" | "done" | "unanswered";
  reason?: string;
  answer?: string;
}

export interface ConversationEntry {
  id: string;
  kind: string;
  role?: "user" | "assistant" | "tool" | "system";
  text?: string;
  data?: unknown;
  at?: number;
}

export const CONTINUATION_KIND = "cortex.continuation";
export const IMPORTED_TURN_KIND = "cortex.imported-turn";
export const DECISION_KIND = "cortex.decision";
export const INPUT_KIND = "cortex.input";
export const PROPOSAL_KIND = "cortex.proposal";
export const CREATION_KIND = "cortex.creation";
export const GRANT_KIND = "cortex.grant";
export type Continuation =
  | { mode: "native-resume"; engine: string; at: string }
  | { mode: "reconstructed"; from: ModelRoute | null; to: ModelRoute; at: string };

export const GRANT_SCOPES = ["conversation", "global"] as const;
export const TRANSPORTS = ["web", "discord"] as const;
export const OPERATION_STATES = ["proposed", "confirmed", "running", "created", "failed", "uncertain"] as const;
export type OperationState = (typeof OPERATION_STATES)[number];
export const OperationRecordSchema = z.object({
  operationId: z.string(),
  conversationId: z.string(),
  proposalId: z.string(),
  revision: z.number().int(),
  owner: z.enum(OWNER_TYPES),
  state: z.enum(OPERATION_STATES),
  canonicalId: z.string().optional(),
  url: z.string().optional(),
  digest: z.string().optional(),
  authority: z.union([
    z.object({ kind: z.literal("confirmation"), transport: z.enum(TRANSPORTS) }).strict(),
    z.object({ kind: z.literal("grant"), grantId: z.string(), scope: z.enum(GRANT_SCOPES) }).strict(),
  ]).optional(),
  history: z.array(z.object({ state: z.enum(OPERATION_STATES), at: z.string(), detail: z.string().optional() })),
});
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

export type SourceState =
  | { state: "available"; policy: Policy; title: string; context?: string; url?: string }
  | { state: "unavailable"; reason: "gone" | "unauthorized" };
export type SourceView = { ref: ObjectRef } & SourceState;
export type LinkResolver = (ref: ObjectRef) => Promise<SourceState>;
export type LinkResolvers = Partial<Record<OwnerType, LinkResolver>>;
export type ReadbackResult = { found: true; canonicalId: string; url?: string } | { found: false } | null;
export type OwnerReadback = (operation: OperationRecord) => Promise<ReadbackResult>;
export type OwnerReadbacks = Partial<Record<OwnerType, OwnerReadback>>;

export interface Provenance { conversationId: string; proposalId: string; revision: number; operationId: string; entryId: string | null; link: string }
export interface CreateRequest { operationId: string; type: OwnerType; fields: Record<string, string>; activation: "none"; provenance: Provenance; signal: AbortSignal }
export type CreateResult =
  | { state: "created"; canonicalId: string; url?: string }
  | { state: "accepted"; receipt?: string }
  | { state: "failed"; error: string };
export interface OwnerWriter { create: (request: CreateRequest) => Promise<CreateResult>; readback: OwnerReadback }
export type OwnerWriters = Partial<Record<OwnerType, OwnerWriter>>;
