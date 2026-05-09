/**
 * T-1.3: Relay Policy Schema
 * Zod schema for the declarative relay-policy.yaml configuration.
 */

import { z } from "zod/v4";

// =============================================================================
// Policy Schema
// =============================================================================

/** Validate that a string is a compilable regex */
const regexString = z.string().check((ctx) => {
  try {
    new RegExp(ctx.value);
  } catch {
    ctx.issues.push({
      code: "custom",
      message: `Invalid regex pattern: ${ctx.value}`,
    } as any);
  }
});

export const RelayPolicySchema = z.object({
  /** Event types to allow through (all others dropped) */
  allow_events: z.array(z.string().min(1)),

  /** Per-event-type field inclusion lists */
  fields: z.record(
    z.string(),
    z.object({
      include: z.array(z.string().min(1)),
    })
  ).default({}),

  /** Redaction patterns applied to all string values */
  redact: z.array(
    z.object({
      pattern: regexString,
      replace: z.string(),
      flags: z.string().optional(),
    })
  ).default([]),

  /** Conditional drop rules — drop event if field contains any match */
  drop_if: z.array(
    z.object({
      field: z.string().min(1),
      contains: z.array(z.string().min(1)),
    })
  ).default([]),
});

export type RelayPolicy = z.infer<typeof RelayPolicySchema>;
