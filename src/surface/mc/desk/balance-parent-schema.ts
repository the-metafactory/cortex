import { z } from "zod";
import { ParserRoutingSchema } from "./parser-routing";

export const BalanceParentSchema = z.object({
  id: z.string().min(1),
  area: z.string().min(1),
  path: z.string().min(1),
});
export type BalanceParent = z.infer<typeof BalanceParentSchema>;
export const ParentProposalSchema = z.object({
  key: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  date: z.iso.date(),
  parents: z.array(BalanceParentSchema),
  parent: z.string().nullable(),
  reason: z.string().min(1).max(200),
  routing: ParserRoutingSchema,
});
export type ParentProposal = z.infer<typeof ParentProposalSchema>;
