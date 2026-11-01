import { z } from "zod";

const id = z.string().min(1).max(300);
export const MyDayCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("start"), ids: z.array(id).max(7) }),
  z.object({ op: z.literal("draft"), ids: z.array(id).max(7) }),
  z.object({ op: z.literal("close") }),
  z.object({ op: z.literal("reset-caps") }),
  z.object({ op: z.literal("propose") }),
  z.object({ op: z.literal("done"), id }),
  z.object({ op: z.literal("defer"), id }),
  z.object({ op: z.literal("undo"), receipt: id }),
  z.object({ op: z.literal("todo"), key: id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ op: z.literal("cap"), cap: z.number().int().min(1).max(7) }),
  z.object({ op: z.literal("topN"), topN: z.number().int().min(1).max(10) }),
  z.object({ op: z.literal("file"), id, parent: id }),
  z.object({ op: z.literal("add"), parent: id, title: z.string().trim().min(1).max(300), kind: z.enum(["project", "task"]) }),
  z.object({ op: z.literal("edit"), id, title: z.string().trim().min(1).max(300), weight: z.number().min(0).max(100), dueDate: z.union([z.iso.date(), z.literal("")]), focus: z.boolean(), yes: z.boolean().default(false), before: z.object({ title: z.string(), weight: z.number(), dueDate: z.string(), focusMonth: z.string().optional() }) }),
]);
export const MyDayRequestSchema = z.object({ date: z.iso.date(), requestId: z.uuid(), command: MyDayCommandSchema });
export type MyDayCommand = z.infer<typeof MyDayCommandSchema>;
const source = z.object({ taskId: id, key: id, fingerprint: z.string(), kind: z.string(), url: z.string().optional() });
const undo = z.object({ receipt: id, taskId: id, date: z.iso.date(), before: z.string().optional(), after: z.string(), used: z.boolean() });
const studioThread = z.object({
  namespace: z.string(), source: z.string(), slug: z.string(), projectId: id,
  response: z.number().default(0),
  pending: z.object({ id, at: z.number() }).nullable().default(null),
});
export const MyDayMetaSchema = z.object({
  studio: z.array(studioThread).default([]),
  revision: z.number().int().nonnegative().default(0),
  inbox: z.array(z.object({ id, title: z.string(), weight: z.number(), ordering: z.literal("parallel"), children: z.tuple([]), effort: z.literal(1), note: z.string(), dueDate: z.iso.date().optional() })).default([]),
  draft: z.object({ date: z.iso.date(), ids: z.array(id), origin: z.enum(["engine", "person", "studio-unavailable"]).default("engine") }).nullable().default(null),
  sources: z.array(source).default([]),
  receipts: z.array(z.object({ id: id, payload: z.string(), undo: z.string().optional() })).default([]),
  undos: z.array(undo).default([]),
  caps: z.object({ cap: z.number().int().min(1).max(7), topN: z.number().int().min(1).max(10) }).nullable().default(null),
});
export type MyDayMeta = z.infer<typeof MyDayMetaSchema>;
