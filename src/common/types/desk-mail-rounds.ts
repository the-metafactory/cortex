import { z } from "zod/v4";

export const DEFAULT_MAIL_ROUND_SLOTS = ["08:30", "13:30", "16:30"] as const;

const MAIL_ROUND_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const slot = z.string().regex(MAIL_ROUND_TIME_RE, "mc.desk.mailRounds.slots holds local times as HH:MM, such as 08:30");

export const MailRoundsSchema = z
  .object({
    slots: z
      .array(slot)
      .min(1, "mc.desk.mailRounds.slots needs at least one local time")
      .max(24, "mc.desk.mailRounds.slots holds at most 24 local times")
      .default([...DEFAULT_MAIL_ROUND_SLOTS])
      .refine((slots) => new Set(slots).size === slots.length, "mc.desk.mailRounds.slots names a time twice"),
  })
  .default({ slots: [...DEFAULT_MAIL_ROUND_SLOTS] });

export type MailRoundsConfig = z.infer<typeof MailRoundsSchema>;
