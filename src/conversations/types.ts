import { z } from "zod";

export const OWNER_TYPES = ["graph-node", "balance-task", "balance-project", "studio-thread", "studio-note", "routine", "flow"] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];
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
export const INPUT_KIND = "cortex.input";
export type Continuation =
  | { mode: "native-resume"; engine: string; at: string }
  | { mode: "reconstructed"; from: ModelRoute | null; to: ModelRoute; at: string };

export type OperationState = "proposed" | "confirmed" | "running" | "created" | "failed" | "uncertain";
export interface OperationRecord {
  operationId: string;
  conversationId: ConversationId;
  proposalId: string;
  revision: number;
  owner: OwnerType;
  state: OperationState;
  canonicalId?: string;
  history: { state: OperationState; at: string; detail?: string }[];
}

export type LinkResolver = (ref: ObjectRef) => Promise<Policy | null>;
export type LinkResolvers = Partial<Record<OwnerType, LinkResolver>>;
export type OwnerReadback = (operation: OperationRecord) => Promise<{ found: true; canonicalId: string } | { found: false } | null>;
export type OwnerReadbacks = Partial<Record<OwnerType, OwnerReadback>>;
