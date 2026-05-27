/**
 * Grove Mission Control v2 — shared TypeScript types.
 */

// --- Enum-like unions ---

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export type AgentType = "head" | "hands";

export type AssignmentState =
  | "queued"
  | "dispatched"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type EndpointKind =
  | "local.process.controlled"
  | "local.observed"
  | "local.process.autonomous";

export type LogLevel = "debug" | "info" | "warn" | "error";

// --- Block reason tagged union ---

export interface BlockReasonPermission {
  kind: "permission.request";
  payload: {
    requested_action: string;
    target?: string;
    context?: string;
    risk_hint?: string;
  };
}

export interface BlockReasonToolError {
  kind: "tool.error";
  payload: {
    tool_name: string;
    error_message: string;
  };
}

export interface BlockReasonReviewCheckpoint {
  kind: "review.checkpoint";
  payload: {
    description: string;
  };
}

export type BlockReason =
  | BlockReasonPermission
  | BlockReasonToolError
  | BlockReasonReviewCheckpoint;

// --- Entity types ---

export type TaskSourceSystem = "github" | "internal";

export interface Task {
  id: string;
  title: string;
  description: string | null;
  priority: number;
  principal_id: string;
  source_system: TaskSourceSystem;
  source_url: string | null;
  source_external_id: string | null;
  related_refs_json: string | null;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
}

export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  persistent: boolean;
  created_at: string;
}

export interface AgentTaskAssignment {
  id: string;
  agent_id: string;
  task_id: string;
  state: AssignmentState;
  block_reason: BlockReason | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  assignment_id: string;
  cc_session_id: string | null;
  endpoint_kind: EndpointKind;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
}

export interface McEvent {
  id: string;
  session_id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// --- State machine ---

export type Action =
  | { type: "dispatch" }
  | { type: "start" }
  | { type: "block"; reason: BlockReason }
  | { type: "complete" }
  | { type: "fail"; error?: string }
  | { type: "resume" }
  | { type: "operator_requeue" }
  | { type: "cancel" };

export type ActionType = Action["type"];

export type TransitionResult =
  | { ok: true; state: AssignmentState; blockReason: BlockReason | null }
  | { ok: false; error: string };

// --- Config ---

export interface HooksConfig {
  rawEventsDir: string;
  cursorPath: string;
  pollInterval: number;
}

export interface Config {
  port: number;
  /** Bind address. Defaults to "127.0.0.1" — loopback only.
   *  NEVER set to "0.0.0.0" without auth; see CLAUDE.md security rule. */
  hostname: string;
  db: { path: string };
  log: { level: LogLevel };
  hooks: HooksConfig;
  ws: WsConfig;
}

export interface WsConfig {
  /** Max inbound WebSocket payload in bytes. Default 64 KB. */
  maxPayloadLength: number;
  /** Idle timeout in seconds — server closes connections with no activity. */
  idleTimeoutSec: number;
  /** Max concurrent WebSocket clients. 0 = unlimited. */
  maxClients: number;
}
