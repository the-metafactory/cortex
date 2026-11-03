import { z } from "zod";

export const CAPABILITY_MARKER_LABEL = "desk-capability";
export const capabilityMarker = (capability: string): string => `${CAPABILITY_MARKER_LABEL}:${capability}`;
export const CapabilityNameSchema = z.string().min(1).max(200);
export const FILEABLE_CAPABILITY = /^[\w.-]{1,120}$/;

export const SovereigntySchema = z.object({
  model_class: z.enum(["local-only", "frontier", "any"]).optional(),
  frontier_ok: z.boolean().optional(),
  data_residency: z.string().optional(),
});
export type StepSovereignty = z.infer<typeof SovereigntySchema>;

export const CapabilityStepSchema = z.object({ label: z.string(), prompt: z.string(), sovereignty: SovereigntySchema });
export type CapabilityStep = z.infer<typeof CapabilityStepSchema>;

export const MissingCapabilitySchema = z.object({ capability: CapabilityNameSchema, steps: z.array(CapabilityStepSchema).min(1) });
export type MissingCapability = z.infer<typeof MissingCapabilitySchema>;

export const CapabilityNodeSchema = z.object({ ref: z.string().trim().min(1).max(200), url: z.string().regex(/^https?:/i), existing: z.boolean() });
export type CapabilityNode = z.infer<typeof CapabilityNodeSchema>;

export const CapabilityRefusalSchema = z.object({
  proposalId: z.uuid(),
  missing: z.array(MissingCapabilitySchema).min(1),
  offer: z.boolean(),
  nodes: z.record(z.string(), CapabilityNodeSchema).default({}),
});
export type CapabilityRefusal = z.infer<typeof CapabilityRefusalSchema>;

export const CapabilityBuildRequestSchema = z.object({
  requestId: z.string().regex(/^[\w-]{8,64}$/),
  proposalId: z.uuid(),
}).strict();
export type CapabilityBuildRequest = z.infer<typeof CapabilityBuildRequestSchema>;

export const CapabilityBuildResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  built: z.array(CapabilityNodeSchema.extend({ capability: z.string() })),
  failed: z.array(z.object({ capability: z.string(), error: z.string() })),
});
export type CapabilityBuildResult = z.infer<typeof CapabilityBuildResultSchema>;
