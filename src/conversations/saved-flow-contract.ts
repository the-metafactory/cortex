import { z } from "zod";

export const DESK_FLOWS_PATH = "/api/desk/flows";
export const SavedFlowNameSchema = z.string().regex(/^F_[A-Z0-9_]{1,64}$/);
export const FlowHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const SavedFlowSchema = z.object({
  name: SavedFlowNameSchema,
  sha256: FlowHashSchema,
  savedAt: z.iso.datetime({ offset: true }),
  origin: z.enum(["conversation", "cli"]),
  conversationId: z.string().min(1).nullable(),
});
export const FlowRoutineSchema = z.object({ target: z.string().min(1), timeZone: z.string().min(1) });
export const SavedFlowsSchema = z.object({ flows: z.array(SavedFlowSchema), routine: FlowRoutineSchema.optional() });
export const SavedFlowDefinitionSchema = z.object({ name: SavedFlowNameSchema, sha256: FlowHashSchema, yaml: z.string() });
export type FlowRoutine = z.infer<typeof FlowRoutineSchema>;
export type SavedFlow = z.infer<typeof SavedFlowSchema>;
export type SavedFlowDefinition = z.infer<typeof SavedFlowDefinitionSchema>;
