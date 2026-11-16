import { z } from "zod";
import type { OutlineNode } from "../../../balance";

const id = z.string().min(1).max(300);
const revision = z.number().int().nonnegative();
export const OUTLINE_REPEAT_MODES = ["calendar", "completion"] as const;
export const OUTLINE_REPEAT_UNITS = ["day", "week", "month"] as const;
export const OUTLINE_REPEAT_FIELDS = ["mode", "unit", "interval", "weekdays", "count", "until"] as const;
export const OUTLINE_TIME_FIELDS = ["startDate", "deferredUntil", "repeat"] as const;
export const OutlineRepeatInputSchema = z.strictObject({
  mode: z.enum(OUTLINE_REPEAT_MODES).optional(),
  unit: z.enum(OUTLINE_REPEAT_UNITS),
  interval: z.number().int().min(1).max(366),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  count: z.number().int().min(1).optional(),
  until: z.iso.date().optional(),
}).refine(repeat => !repeat.weekdays?.length || repeat.unit === "week", { message: "Repeat weekdays belong to a weekly repeat.", path: ["weekdays"] });
export type OutlineRepeatInput = z.infer<typeof OutlineRepeatInputSchema>;
const clearableDate = z.union([z.iso.date(), z.literal("")]);
export const BalanceDetailsSchema = z.object({
  title: z.string().trim().min(1).max(300),
  weight: z.number().min(0).max(100),
  note: z.string().max(10_000),
  ordering: z.enum(["parallel", "sequential"]),
  focus: z.boolean(),
  dueDate: z.union([z.iso.date(), z.literal("")]),
  context: z.string().trim().max(120),
  effort: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  estimateMinutes: z.number().int().positive().nullable(),
  startDate: clearableDate.optional(),
  deferredUntil: clearableDate.optional(),
  repeat: OutlineRepeatInputSchema.nullable().optional(),
});
export type BalanceDetails = z.infer<typeof BalanceDetailsSchema>;
export function balanceDetails(node: OutlineNode, date: string): BalanceDetails {
  return { title: node.title, weight: node.weight, note: node.note ?? "", ordering: node.ordering, focus: node.focusMonth === date.slice(0, 7), dueDate: node.dueDate ?? "", context: node.context ?? "", effort: node.effort ?? 1, estimateMinutes: node.estimateMinutes ?? null };
}
export const BalanceCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("outline-add"), revision, parent: id, title: z.string().trim().min(1).max(300), kind: z.enum(["task", "project"]).optional(), note: z.string().max(10_000).optional(), dueDate: z.iso.date().optional(), weight: BalanceDetailsSchema.shape.weight.optional(), context: BalanceDetailsSchema.shape.context.optional(), effort: BalanceDetailsSchema.shape.effort.optional(), estimateMinutes: BalanceDetailsSchema.shape.estimateMinutes.optional(), startDate: z.iso.date().optional(), deferredUntil: z.iso.date().optional(), repeat: OutlineRepeatInputSchema.optional() }),
  z.object({ op: z.literal("outline-edit"), revision, id, details: BalanceDetailsSchema, yes: z.boolean() }),
  z.object({ op: z.literal("outline-move"), revision, id, parent: id, index: z.number().int().nonnegative().optional() }),
  z.object({ op: z.literal("outline-file"), revision, id, parent: id }),
  z.object({ op: z.literal("outline-complete"), revision, id, confirm: z.literal(true) }),
  z.object({ op: z.literal("outline-skip"), revision, id, confirm: z.literal(true) }),
  z.object({ op: z.literal("outline-reopen"), revision, id, confirm: z.literal(true) }),
  z.object({ op: z.literal("outline-remove"), revision, id, confirm: z.literal(true) }),
]);
export type BalanceCommand = z.infer<typeof BalanceCommandSchema>;
