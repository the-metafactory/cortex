import { z } from "zod";

const id = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const current = z.object({ paused: z.boolean(), policy: z.enum(["auto", "approval", "disabled"]), schedule: z.string().min(1).max(1000), timezone: z.string().min(1).max(100).nullable() }).strict();
export const LifecycleDetailSchema = z.object({ id, revision, writable: z.boolean(), reason: z.string(), runtimeConfirmed: z.boolean(), current }).strict();
export type LifecycleDetail = z.infer<typeof LifecycleDetailSchema>;
export const LifecyclePreviewRequestSchema = z.object({ id, revision, paused: z.boolean() }).strict();
export type LifecyclePreviewRequest = z.infer<typeof LifecyclePreviewRequestSchema>;
export const LifecyclePreviewSchema = LifecycleDetailSchema.extend({ proposedRevision: revision, paused: z.boolean() }).strict();
export type LifecyclePreview = z.infer<typeof LifecyclePreviewSchema>;
export const LifecycleActionSchema = z.object({ requestId: z.string().regex(/^[\w-]{8,64}$/), action: z.enum(["pause", "resume"]), target: id, revision, proposedRevision: revision }).strict();
export type LifecycleAction = z.infer<typeof LifecycleActionSchema>;
