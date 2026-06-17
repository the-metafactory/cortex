/**
 * T-1.1: Raw Event Schema + T-1.2: Published Event Schema
 * Shared event type definitions for the Cortex event filtering pipeline.
 */

import { z } from "zod/v4";
import { resolveSurfaceEnv } from "./surface-env";

// =============================================================================
// Raw Event (PAI-internal, never exposed to consumers)
// =============================================================================

export const RawEventSchema = z.object({
  event_id: z.uuid(),
  event_type: z.string().min(1),
  timestamp: z.iso.datetime(),
  session_id: z.string().min(1),
  // ST-P1 (cortex#964, refs #952) — session-tree linkage. `parent_session_id`
  // names the session that spawned this one (a child session carries it; an
  // agent-rooted session has none — CONTEXT.md §Sessions). `substrate` is the
  // execution substrate the session runs on (`claude-code`, …). Both optional;
  // the ingestor (Phase 2) reads them off the envelope payload to parent the
  // session. Names PINNED for the ST-P2 consumer.
  parent_session_id: z.string().optional(),
  substrate: z.string().optional(),
  // GV-2 (cortex#1077) — channel-label vocabulary migration. `cortex_channel`
  // is the canonical field; `grove_channel` is the legacy alias kept for
  // back-compat. Producers DUAL-WRITE both; consumers read cortex-first with a
  // grove fallback. `grove_channel` retires only at the breaking v3.0.0 (in
  // lockstep with the GROVE_* env shim, cortex#774). Both optional.
  cortex_channel: z.string().optional(),
  grove_channel: z.string().optional(),
  agent_id: z.string().optional(),
  agent_name: z.string().optional(),
  network_id: z.string().optional(),
  source: z.object({
    hook: z.enum([
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "UserPromptSubmit",
      "SessionStart",
    ]),
    tool_name: z.string().optional(),
  }),
  payload: z.record(z.string(), z.unknown()),
});

export type RawEvent = z.infer<typeof RawEventSchema>;

// =============================================================================
// Published Event (filtered, safe for consumers like cortex)
// =============================================================================

export const PublishedEventSchema = z.object({
  event_id: z.uuid(),
  event_type: z.string().min(1),
  timestamp: z.iso.datetime(),
  session_id: z.string().min(1),
  // ST-P1 (cortex#964, refs #952) — session-tree linkage carried through to
  // consumers (the relay propagates these from the RawEvent). See RawEventSchema.
  parent_session_id: z.string().optional(),
  substrate: z.string().optional(),
  // GV-2 (cortex#1077) — dual-written channel label; see RawEventSchema.
  cortex_channel: z.string().optional(),
  grove_channel: z.string().optional(),
  agent_id: z.string().optional(),
  agent_name: z.string().optional(),
  network_id: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export type PublishedEvent = z.infer<typeof PublishedEventSchema>;

// =============================================================================
// Helpers
// =============================================================================

export function createRawEvent(
  eventType: string,
  hook: RawEvent["source"]["hook"],
  payload: Record<string, unknown>,
  options?: { sessionId?: string; parentSessionId?: string; substrate?: string; toolName?: string; channel?: string; agentId?: string; agentName?: string; networkId?: string }
): RawEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: eventType,
    timestamp: new Date().toISOString(),
    session_id: options?.sessionId ?? process.env.CLAUDE_SESSION_ID ?? "unknown",
    // ST-P1 — stamp the session-tree fields only when supplied (an
    // agent-rooted session has no parent; a non-CC tap may omit substrate).
    ...(options?.parentSessionId !== undefined && { parent_session_id: options.parentSessionId }),
    ...(options?.substrate !== undefined && { substrate: options.substrate }),
    // cortex#774: read CORTEX_* first, fall back to legacy GROVE_*.
    // GV-2 (cortex#1077): DUAL-WRITE the channel label — `cortex_channel`
    // (canonical) AND `grove_channel` (legacy back-compat alias). Both carry
    // the same resolved value; `grove_channel` retires at v3.0.0.
    cortex_channel: options?.channel ?? resolveSurfaceEnv("CHANNEL"),
    grove_channel: options?.channel ?? resolveSurfaceEnv("CHANNEL"),
    agent_id: options?.agentId ?? resolveSurfaceEnv("AGENT_ID"),
    agent_name: options?.agentName ?? resolveSurfaceEnv("AGENT_NAME"),
    network_id: options?.networkId ?? resolveSurfaceEnv("NETWORK"),
    source: {
      hook,
      tool_name: options?.toolName,
    },
    payload,
  };
}
