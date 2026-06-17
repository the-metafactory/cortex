/**
 * Cortex Mission Control v2 — Raw hook event type.
 *
 * Shape of events written to ~/.claude/events/raw/ by the EventLogger hook.
 * Defined locally — no v1 imports.
 */

export interface RawHookEvent {
  event_id: string;
  event_type: string;
  timestamp: string;
  session_id: string;
  // GV-2 (cortex#1077) — `cortex_channel` canonical, `grove_channel` legacy
  // back-compat alias (dual-written by producers; retires at v3.0.0).
  cortex_channel?: string;
  grove_channel?: string;
  agent_id?: string;
  agent_name?: string;
  network_id?: string;
  source: {
    hook: string;
    tool_name?: string;
  };
  payload: Record<string, unknown>;
}
