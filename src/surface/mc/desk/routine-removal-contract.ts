import { z } from "zod";
const id = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const RemovalDetailSchema = z.object({ id, revision, name: z.string(), target: z.string(), schedule: z.string(), timezone: z.string().nullable(), paused: z.boolean(), writable: z.boolean(), reason: z.string() }).strict();
export type RemovalDetail = z.infer<typeof RemovalDetailSchema>;
export const RemovalActionSchema = z.object({ requestId: z.string().regex(/^[\w-]{8,64}$/), action: z.literal("delete"), target: id, revision }).strict();
export type RemovalAction = z.infer<typeof RemovalActionSchema>;
export const RemovalStatusSchema = z.object({ id, revision, requestId: z.string(), status: z.enum(["unknown", "pending", "removed"]) }).strict();
