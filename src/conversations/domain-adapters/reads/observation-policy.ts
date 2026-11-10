import { z } from "zod";

export const OBSERVATION_LIMITS = { objects: 1000, contentMs: 86400000, evidence: 10000, evidenceMs: 604800000, staleMs: 600000, intervalMs: 60000, minimumIntervalMs: 1000, fetchMs: 10000, batchItems: 20, bytes: 1048576 } as const;
export const ObservationPolicySchema = z.object({
  modes: z.array(z.enum(["poll", "subscription"])).min(1), objectsPointer: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)+$/),
  resumable: z.boolean(), ordering: z.string().min(1).optional(), watermark: z.boolean().default(false),
  staleMs: z.number().int().positive().max(600000).default(600000),
  retention: z.object({ objects: z.number().int().positive().max(1000).default(1000), contentMs: z.number().int().positive().max(86400000).default(86400000), evidence: z.number().int().positive().max(10000).default(10000), evidenceMs: z.number().int().positive().max(604800000).default(604800000) }).strict().default({ objects: 1000, contentMs: 86400000, evidence: 10000, evidenceMs: 604800000 }),
}).strict();

export type ObservationRetention = z.infer<typeof ObservationPolicySchema>["retention"];
