import { z } from "zod";
import { STUDIO_SLUG } from "./format";

const words = (max: number) => z.string().trim().min(1).max(max);
export const SessionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread") }),
  z.object({ kind: z.literal("ghost"), note: words(64) }),
]);
export type SessionScope = z.infer<typeof SessionScopeSchema>;
export const SessionEndSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("leave") }),
  z.object({ kind: z.literal("keep") }),
  z.object({ kind: z.literal("reword"), text: words(4000) }),
  z.object({ kind: z.literal("dismiss") }),
  z.object({ kind: z.literal("propose"), text: words(4000) }),
]);
export type SessionEnd = z.infer<typeof SessionEndSchema>;
export const SessionRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), id: z.uuid(), thread: z.string().regex(STUDIO_SLUG), scope: SessionScopeSchema }),
  z.object({ action: z.literal("read"), id: z.uuid() }),
  z.object({ action: z.literal("recover"), id: z.uuid() }),
  z.object({ action: z.literal("save-message"), id: z.uuid(), text: words(4000) }),
  z.object({ action: z.literal("say"), id: z.uuid(), turn: z.uuid(), text: words(4000), draft: z.string().trim().max(4000).optional() }),
  z.object({ action: z.literal("end"), id: z.uuid(), outcome: SessionEndSchema, draft: z.string().trim().max(4000).optional() }),
]);
export const SessionAnswerSchema = z.object({ reply: words(3000), summary: words(3000), proposal: words(4000).nullable() });
const TurnSchema = z.object({ id: z.uuid(), text: words(4000), answer: SessionAnswerSchema.nullable(), model: z.string(), policy: z.enum(["local", "cloud"]) });
export const StudioSessionSchema = z.object({
  id: z.uuid(), thread: z.string().regex(STUDIO_SLUG), scope: SessionScopeSchema, original: z.string(), stand: z.string(), policy: z.enum(["local", "cloud"]),
  turns: z.array(TurnSchema).max(30),
  draft: z.string().max(4000).optional(),
  phase: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("open") }),
    z.object({ kind: z.literal("ending"), outcome: SessionEndSchema }),
    z.object({ kind: z.literal("ended"), outcome: SessionEndSchema, commit: z.string() }),
  ]),
});
export type StudioSession = z.infer<typeof StudioSessionSchema>;
