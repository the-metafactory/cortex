/**
 * T-1.1: Raw Event Schema + T-1.2: Published Event Schema
 * Shared event type definitions for Grove event filtering pipeline.
 */

import { z } from "zod/v4";

// =============================================================================
// Raw Event (PAI-internal, never exposed to consumers)
// =============================================================================

export const RawEventSchema = z.object({
  event_id: z.uuid(),
  event_type: z.string().min(1),
  timestamp: z.iso.datetime(),
  session_id: z.string().min(1),
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
// Published Event (filtered, safe for consumers like grove-bot)
// =============================================================================

export const PublishedEventSchema = z.object({
  event_id: z.uuid(),
  event_type: z.string().min(1),
  timestamp: z.iso.datetime(),
  session_id: z.string().min(1),
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
  options?: { sessionId?: string; toolName?: string; groveChannel?: string; agentId?: string; agentName?: string; networkId?: string }
): RawEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: eventType,
    timestamp: new Date().toISOString(),
    session_id: options?.sessionId ?? process.env.CLAUDE_SESSION_ID ?? "unknown",
    grove_channel: options?.groveChannel ?? process.env.GROVE_CHANNEL,
    agent_id: options?.agentId ?? process.env.GROVE_AGENT_ID,
    agent_name: options?.agentName ?? process.env.GROVE_AGENT_NAME,
    network_id: options?.networkId ?? process.env.GROVE_NETWORK,
    source: {
      hook,
      tool_name: options?.toolName,
    },
    payload,
  };
}
