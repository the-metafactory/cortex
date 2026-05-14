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
    // Zod v4's $ZodIssueBase is a heavily-discriminated union; the
    // `custom` issue shape is the simplest manual literal we can push.
    // The union signature doesn't widen to accept `{ code: "custom", ... }`
    // without a cast, so suppress here at the boundary instead of widening
    // the project-wide types.
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
    ctx.issues.push({
      code: "custom",
      message: `Invalid regex pattern: ${ctx.value}`,
    } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
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
