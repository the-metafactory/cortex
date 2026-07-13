/**
 * cortex#1797 (S12, ADR-0024 D5 extraction lane) — plugin-owned DUPLICATE of
 * the `PublishedEvent` shape (`src/taps/cc-events/hooks/lib/event-types.ts`'s
 * `PublishedEventSchema`/`PublishedEvent`), the CC-hook event shape the
 * legacy `#agent-log`/worklog outbound bridge (`outbound-log.ts`,
 * `worklog-manager.ts`, `event-formatter.ts`, `event-utils.ts`,
 * `worklog-formatter.ts`) reads off the JSONL published-events stream.
 *
 * A duplicate, not a relocation: `taps/cc-events/hooks/lib/event-types.ts`
 * also defines `RawEventSchema`/`createRawEvent` (the hook-emission side,
 * consumed by every CC hook script, not just Discord) and pulls in
 * `resolveSurfaceEnv` for that unrelated helper — genuinely cortex-internal
 * machinery this bundle has no reason to depend on. Discord's worklog family
 * only ever reads the FILTERED consumer-side shape (`PublishedEvent`), never
 * constructs one, so this file carries only that half — field-for-field,
 * byte-identical to the schema this mirrors.
 */

import { z } from "zod/v4";

export const PublishedEventSchema = z.object({
  event_id: z.uuid(),
  event_type: z.string().min(1),
  timestamp: z.iso.datetime(),
  session_id: z.string().min(1),
  // ST-P1 (cortex#964, refs #952) — session-tree linkage carried through to
  // consumers.
  parent_session_id: z.string().optional(),
  substrate: z.string().optional(),
  // GV-2 (cortex#1077) — dual-written channel label.
  cortex_channel: z.string().optional(),
  grove_channel: z.string().optional(),
  agent_id: z.string().optional(),
  agent_name: z.string().optional(),
  network_id: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export type PublishedEvent = z.infer<typeof PublishedEventSchema>;
