import { describe, it, expect } from "bun:test";
import type {
  Task,
  Agent,
  AgentTaskAssignment,
  Session,
  McEvent,
  AssignmentState,
  EndpointKind,
  TaskStatus,
  AgentType,
  Config,
  Action,
  TransitionResult,
} from "../types";

describe("mission-control types", () => {
  it("Task type accepts valid shape", () => {
    const task: Task = {
      id: "t-1",
      title: "Fix webhook",
      description: null,
      priority: 0,
      principal_id: "andreas",
      source_system: "github",
      source_url: "https://github.com/the-metafactory/grove/issues/190",
      source_external_id: "grove#190",
      related_refs_json: null,
      status: "open",
      created_at: 1744848000,
      updated_at: 1744848000,
    };
    expect(task.id).toBe("t-1");
    expect(task.status).toBe("open");
  });

  it("Agent type accepts valid shape", () => {
    const agent: Agent = {
      id: "a-1",
      name: "Luna",
      type: "head",
      persistent: true,
      created_at: "2026-04-17T00:00:00Z",
    };
    expect(agent.type).toBe("head");
    expect(agent.persistent).toBe(true);
  });

  it("AgentTaskAssignment type accepts valid shape with block_reason", () => {
    const assignment: AgentTaskAssignment = {
      id: "ata-1",
      agent_id: "a-1",
      task_id: "t-1",
      state: "blocked",
      block_reason: { kind: "permission.request", payload: { requested_action: "tool.bash" } },
      retry_after_ms: null,
      created_at: "2026-04-17T00:00:00Z",
      updated_at: "2026-04-17T00:00:00Z",
    };
    expect(assignment.state).toBe("blocked");
    expect(assignment.block_reason?.kind).toBe("permission.request");
  });

  it("Session type accepts both controlled and observed kinds", () => {
    // ST-P0 / ADR-0011 canonical session columns (denormalized fields nullable
    // this phase; substrate NOT NULL with a default; parent_session_id self-ref).
    const canonicalDefaults = {
      parent_session_id: null,
      substrate: "claude-code",
      agent_id: null,
      agent_name: null,
      principal_id: null,
      status: null,
      duration_ms: null,
      events_count: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cost_usd: null,
      classification: null,
      data_residency: null,
      home_principal: null,
      origin_stack_id: null,
    };
    const controlled: Session = {
      id: "s-1",
      assignment_id: "ata-1",
      cc_session_id: "cc-abc",
      endpoint_kind: "local.process.controlled",
      pid: 12345,
      started_at: "2026-04-17T00:00:00Z",
      ended_at: null,
      ...canonicalDefaults,
    };
    const observed: Session = {
      id: "s-2",
      assignment_id: "ata-1",
      cc_session_id: null,
      endpoint_kind: "local.observed",
      pid: null,
      started_at: "2026-04-17T00:00:00Z",
      ended_at: null,
      ...canonicalDefaults,
      // a child session on a non-default substrate exercises the new fields
      parent_session_id: "s-1",
      substrate: "codex",
    };
    expect(controlled.endpoint_kind).toBe("local.process.controlled");
    expect(observed.endpoint_kind).toBe("local.observed");
    expect(controlled.substrate).toBe("claude-code");
    expect(observed.parent_session_id).toBe("s-1");
    expect(observed.substrate).toBe("codex");
  });

  it("McEvent type accepts valid shape", () => {
    const event: McEvent = {
      id: "e-1",
      session_id: "s-1",
      type: "tool.bash",
      payload: { command: "ls" },
      timestamp: "2026-04-17T00:00:00Z",
    };
    expect(event.type).toBe("tool.bash");
    expect(event.payload.command).toBe("ls");
  });

  it("Config type accepts valid shape with defaults", () => {
    const config: Config = {
      port: 8767,
      hostname: "127.0.0.1",
      db: { path: "~/.local/share/grove/mission-control.db" },
      log: { level: "info" },
      hooks: {
        rawEventsDir: "/tmp/raw",
        cursorPath: "/tmp/cursor.json",
        pollInterval: 2000,
      },
      ws: {
        maxPayloadLength: 65536,
        idleTimeoutSec: 60,
        maxClients: 100,
      },
    };
    expect(config.port).toBe(8767);
    expect(config.hostname).toBe("127.0.0.1");
    expect(config.db.path).toContain("mission-control.db");
    expect(config.ws.maxPayloadLength).toBe(65536);
  });

  it("AssignmentState union covers all valid states", () => {
    const states: AssignmentState[] = [
      "queued", "dispatched", "running", "blocked", "completed", "failed", "cancelled",
    ];
    expect(states).toHaveLength(7);
  });

  it("Action tagged union covers all action types", () => {
    const actions: Action[] = [
      { type: "dispatch" },
      { type: "start" },
      { type: "block", reason: { kind: "permission.request", payload: { requested_action: "tool.bash" } } },
      { type: "complete" },
      { type: "fail", error: "something broke" },
      { type: "resume" },
      { type: "principal_requeue" },
      { type: "cancel" },
    ];
    expect(actions).toHaveLength(8);
  });

  it("TransitionResult discriminated union works for both ok and error", () => {
    const ok: TransitionResult = { ok: true, state: "running", blockReason: null };
    const err: TransitionResult = { ok: false, error: "invalid transition" };
    expect(ok.ok).toBe(true);
    expect(err.ok).toBe(false);
  });

  it("EndpointKind union covers all valid kinds", () => {
    const kinds: EndpointKind[] = [
      "local.process.controlled",
      "local.observed",
      "local.process.autonomous",
    ];
    expect(kinds).toHaveLength(3);
  });
});
