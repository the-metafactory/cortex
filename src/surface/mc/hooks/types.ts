/**
 * Grove Mission Control v2 — Raw hook event type.
 *
 * Shape of events written to ~/.claude/events/raw/ by the EventLogger hook.
 * Defined locally — no v1 imports.
 */

export interface RawHookEvent {
  event_id: string;
  event_type: string;
  timestamp: string;
  session_id: string;
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
