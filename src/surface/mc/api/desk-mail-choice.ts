import { z } from "zod";
import { SNOOZE_TIMES } from "../desk/mail-snooze-schema";

export const MeetingChoiceSchema = z.object({ kind: z.literal("meeting"), event: z.string().min(1).max(1000) }).strict();

export const SnoozeChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(SNOOZE_TIMES) }).strict(),
  z.object({ kind: z.literal("date"), date: z.string().max(10) }).strict(),
  MeetingChoiceSchema,
  z.object({ kind: z.literal("person"), address: z.string().min(3).max(320) }).strict(),
]);
