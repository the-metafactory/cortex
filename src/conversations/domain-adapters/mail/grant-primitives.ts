import { z } from "zod";

export const MailStandingGrantBaseSchema = z.object({
  grantId: z.string().min(1),
  adapterId: z.string().min(1),
  connectionId: z.string().min(1),
  authorityGrantId: z.string().min(1).nullable(),
  status: z.enum(["active", "revoked"]),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
}).strict();
