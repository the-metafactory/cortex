import { z } from "zod";
import type { OutlineNode } from "../../../balance";

const id = z.string().min(1).max(300);
const revision = z.number().int().nonnegative();
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
});
export type BalanceDetails = z.infer<typeof BalanceDetailsSchema>;
export function balanceDetails(node: OutlineNode, date: string): BalanceDetails {
  return { title: node.title, weight: node.weight, note: node.note ?? "", ordering: node.ordering, focus: node.focusMonth === date.slice(0, 7), dueDate: node.dueDate ?? "", context: node.context ?? "", effort: node.effort ?? 1, estimateMinutes: node.estimateMinutes ?? null };
}
export const BalanceCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("outline-add"), revision, parent: id, title: z.string().trim().min(1).max(300) }),
  z.object({ op: z.literal("outline-edit"), revision, id, details: BalanceDetailsSchema, yes: z.boolean() }),
  z.object({ op: z.literal("outline-move"), revision, id, parent: id }),
  z.object({ op: z.literal("outline-file"), revision, id, parent: id }),
  z.object({ op: z.literal("outline-complete"), revision, id, confirm: z.literal(true) }),
  z.object({ op: z.literal("outline-reopen"), revision, id, confirm: z.literal(true) }),
  z.object({ op: z.literal("outline-remove"), revision, id, confirm: z.literal(true) }),
]);
export type BalanceCommand = z.infer<typeof BalanceCommandSchema>;
