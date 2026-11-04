import type { DeskProposal } from "./ask";
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

export const BuiltNodeSchema = CapabilityNodeSchema.extend({ notStarted: z.string().optional() });
export type BuiltNode = z.infer<typeof BuiltNodeSchema>;

export const BUILD_STATES = ["filed", "building", "in-review", "merged", "failed"] as const;
export const BuildStatusSchema = z.object({
  state: z.enum(BUILD_STATES),
  reason: z.string().optional(),
  pr: z.union([z.string(), z.number()]).transform(String).optional(),
});
export type BuildState =
  | { state: (typeof BUILD_STATES)[number] | "live"; reason?: string; pr?: string }
  | { state: "unknown"; error: string };
export interface DraftNodeView { capability: string; ref: string; url: string; notStarted?: string; build: BuildState | null }
export interface RoutineDraftView { proposalId: string; title: string; nodes: DraftNodeView[]; missing: MissingCapability[]; proposal?: DeskProposal; error?: string }

export const CapabilityRefusalSchema = z.object({
  proposalId: z.uuid(),
  missing: z.array(MissingCapabilitySchema).min(1),
  offer: z.boolean(),
  nodes: z.record(z.string(), BuiltNodeSchema).default({}),
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
  built: z.array(BuiltNodeSchema.extend({ capability: z.string() })),
  failed: z.array(z.object({ capability: z.string(), error: z.string() })),
});
export type CapabilityBuildResult = z.infer<typeof CapabilityBuildResultSchema>;
