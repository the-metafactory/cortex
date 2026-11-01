import { z } from "zod";

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const path = z.array(z.union([z.string(), z.number().int().nonnegative()])).min(1).max(40);
export const RoutinePatchSchema = z.object({ path, value: scalar }).strict();
export type RoutinePatch = z.infer<typeof RoutinePatchSchema>;
export const RoutineEditProposalSchema = z.object({ status: z.literal("edit"), patches: z.array(RoutinePatchSchema).max(100) }).strict();
export const RoutineStepSchema = z.object({
  path, action: z.string(), purpose: z.string(), reason: z.string(),
  parameters: z.array(z.object({ name: z.string(), kind: z.enum(["literal", "binding", "redacted"]), value: scalar.nullable() })),
  editable: z.array(z.object({ name: z.string(), type: z.enum(["string", "number", "boolean"]), minimum: z.number().optional(), maximum: z.number().optional(), enum: z.array(scalar).optional() })),
});
export type RoutineStep = z.infer<typeof RoutineStepSchema>;
export const RoutineDetailSchema = z.object({
  id: z.string(), revision: z.string(), writable: z.boolean(), reason: z.string(),
  flow: z.object({ name: z.string(), steps: z.array(RoutineStepSchema) }).nullable(),
});
export type RoutineDetail = z.infer<typeof RoutineDetailSchema>;
export const RoutineInventorySchema = z.array(z.object({
  id: z.string(), name: z.string().optional(), schedule: z.string(), timezone: z.string().nullable(), target: z.string(), policy: z.enum(["approval", "auto", "disabled"]),
  readOnly: z.boolean().default(true),
  capabilities: z.object({ editSchedule: z.boolean() }).default({ editSchedule: false }),
}));
export type RoutineInventory = z.infer<typeof RoutineInventorySchema>;
const mutation = z.object({ id: z.string().min(1).max(100), revision: z.string().regex(/^[a-f0-9]{64}$/) });
export const EditorRequestSchema = z.discriminatedUnion("action", [
  mutation.extend({ action: z.literal("update"), patches: z.array(RoutinePatchSchema).min(1).max(100) }).strict(),
  mutation.extend({ action: z.literal("propose"), text: z.string().trim().min(1).max(2000), area: z.string().optional() }).strict(),
]);

export function parameterError(field: RoutineStep["editable"][number], value: unknown): string | null {
  if (typeof value !== field.type) return `Enter a ${field.type} value.`;
  if (field.enum && !field.enum.includes(scalar.parse(value))) return "Choose one of the allowed values.";
  if (typeof value === "number" && (!Number.isSafeInteger(value) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) return `Enter a whole number${field.minimum !== undefined ? ` from ${field.minimum}` : ""}${field.maximum !== undefined ? ` to ${field.maximum}` : ""}.`;
  return null;
}

export function validateRoutinePatches(detail: RoutineDetail, patches: RoutinePatch[]): void {
  if (!detail.writable || !detail.flow) throw new Error(detail.reason || "This routine is read-only.");
  const seen = new Set<string>();
  for (const patch of patches) {
    const key = JSON.stringify(patch.path);
    if (seen.has(key)) throw new Error("A parameter may be edited only once per request.");
    seen.add(key);
    const step = detail.flow.steps.find((s) => JSON.stringify([...s.path, s.action]) === JSON.stringify(patch.path.slice(0, -1)));
    const field = step?.editable.find((f) => f.name === patch.path.at(-1));
    if (!field) throw new Error(`${key}: this parameter is not editable.`);
    const error = parameterError(field, patch.value);
    if (error) throw new Error(`${key}: ${error}`);
  }
}

