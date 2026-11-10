import { z } from "zod";

export const OBSERVATION_LIMITS = { objects: 1000, contentMs: 86400000, evidence: 10000, evidenceMs: 604800000, staleMs: 600000, intervalMs: 60000, minimumIntervalMs: 1000, fetchMs: 10000, batchItems: 20, bytes: 1048576 } as const;
export const DEFAULT_OBSERVATION_RETENTION = { objects: OBSERVATION_LIMITS.objects, contentMs: OBSERVATION_LIMITS.contentMs, evidence: OBSERVATION_LIMITS.evidence, evidenceMs: OBSERVATION_LIMITS.evidenceMs };
export const ObservationPolicySchema = z.object({
  modes: z.array(z.enum(["poll", "subscription"])).min(1), objectsPointer: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)+$/),
  resumable: z.boolean(), ordering: z.string().min(1).optional(), watermark: z.boolean().default(false),
  staleMs: z.number().int().positive().max(OBSERVATION_LIMITS.staleMs).default(OBSERVATION_LIMITS.staleMs),
  retention: z.object({ objects: z.number().int().positive().max(OBSERVATION_LIMITS.objects).default(OBSERVATION_LIMITS.objects), contentMs: z.number().int().positive().max(OBSERVATION_LIMITS.contentMs).default(OBSERVATION_LIMITS.contentMs), evidence: z.number().int().positive().max(OBSERVATION_LIMITS.evidence).default(OBSERVATION_LIMITS.evidence), evidenceMs: z.number().int().positive().max(OBSERVATION_LIMITS.evidenceMs).default(OBSERVATION_LIMITS.evidenceMs) }).strict().default(DEFAULT_OBSERVATION_RETENTION),
}).strict();

export type ObservationRetention = z.infer<typeof ObservationPolicySchema>["retention"];
