import { z } from "zod";
import type { AppState, OutlineNode } from "../../../balance";

const date = z.iso.date();
function historyRecord<T>(value: z.ZodType<T>): z.ZodType<Record<string, T>> {
  return z.preprocess(
    input => typeof input === "object" && input !== null && !Array.isArray(input)
      ? Object.entries(input) : undefined,
    z.array(z.tuple([z.string(), value])).transform(entries => Object.fromEntries(entries)),
  );
}
const recurrence = z.object({
  unit: z.enum(["day", "week", "month"]),
  interval: z.number(),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  count: z.number().int().nonnegative().optional(),
  until: date.optional(),
  timesDone: z.number().int().nonnegative().optional(),
});
const outline: z.ZodType<OutlineNode> = z.object({
  id: z.string().min(1),
  title: z.string(),
  weight: z.number().min(0).max(100),
  ordering: z.enum(["parallel", "sequential"]),
  children: z.array(z.lazy(() => outline)),
  note: z.string().optional(),
  done: z.boolean().optional(),
  completedAt: date.optional(),
  effort: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional(),
  dueDate: date.optional(),
  leadDays: z.number().optional(),
  startDate: date.optional(),
  deferredUntil: date.optional(),
  focusMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  repeat: recurrence.optional(),
  context: z.string().optional(),
  external: z.object({
    source: z.enum(["jira", "tana"]),
    url: z.string().optional(),
    syncedAt: z.string(),
  }).optional(),
});

export const BalanceStateSchema: z.ZodType<AppState> = z.object({
  outline,
  log: z.array(z.object({
    taskId: z.string().min(1),
    areaId: z.string().min(1),
    effort: z.number().nonnegative(),
    date,
    title: z.string(),
  })),
  settings: z.object({
    todayCap: z.number().int().positive(),
    balanceBeta: z.number().min(0).max(1),
    halfLifeDays: z.number().positive(),
    emergencyMode: z.boolean(),
    activeContext: z.string().nullable().optional(),
  }),
  dayState: z.object({
    date,
    confirmed: z.array(z.string().min(1)),
    closed: z.boolean(),
  }).nullable(),
  history: z.object({
    startDate: date.optional(),
    deficits: historyRecord(z.number()),
    lastSurfaced: historyRecord(date),
    lastAppliedDate: date.optional(),
  }),
  contexts: z.array(z.object({
    name: z.string(),
    windows: z.array(z.object({
      days: z.array(z.number().int().min(0).max(6)),
      from: z.iso.time({ precision: -1 }),
      to: z.iso.time({ precision: -1 }),
    })).optional(),
  })).optional(),
}).superRefine((state, ctx) => {
  const ids = new Set<string>();
  const walk = (node: OutlineNode) => {
    if (ids.has(node.id)) ctx.addIssue({ code: "custom", message: "Duplicate balance node id" });
    ids.add(node.id);
    for (const child of node.children) walk(child);
  };
  walk(state.outline);
});
