/**
 * MIG-4.6: tests for `dispatch.task.*` envelope constructors.
 *
 * Mirrors the coverage axes of `system-events.test.ts`:
 *   1. Shape — fields match G-1111 §3.4 verbatim, lifecycle moments land
 *      in payload (not envelope top-level), optional fields are omitted
 *      (not `undefined`-valued) when callers don't pass them.
 *   2. Validation — every constructed envelope passes the vendored myelin
 *      schema. Catches regressions where someone adds a field but forgets
 *      to keep the envelope shape (sovereignty, source pattern, correlation
 *      UUID format).
 *   3. Correlation — `task_id` doubles as `correlation_id` by default; an
 *      explicit `correlationId` opt overrides. This is the load-bearing
 *      contract that lets surfaces stitch started → completed/failed/aborted.
 */

import { describe, expect, test } from "bun:test";
import { validateEnvelope } from "../myelin/envelope-validator";
import { readResponseRouting } from "../../adapters/response-routing-delivery";
import {
  createDispatchTaskAbortedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskStartedEvent,
  createDispatchTaskPostEvent,
  type DispatchEventSource,
} from "../dispatch-events";

const SOURCE: DispatchEventSource = {
  principal: "metafactory",
  agent: "cortex",
  instance: "local",
};

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const STARTED_AT = new Date("2026-05-09T12:00:00.000Z");
const COMPLETED_AT = new Date("2026-05-09T12:01:30.000Z");

describe("createDispatchTaskStartedEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    });
    expect(env.type).toBe("dispatch.task.started");
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.payload).toMatchObject({
      task_id: TASK_ID,
      agent_id: "cortex",
      started_at: "2026-05-09T12:00:00.000Z",
    });
    expect(env.correlation_id).toBe(TASK_ID);
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("explicit correlationId overrides task_id default", () => {
    const customCorr = "22222222-2222-4222-8222-222222222222";
    const env = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      correlationId: customCorr,
    });
    expect(env.correlation_id).toBe(customCorr);
    // task_id stays in payload either way
    expect(env.payload.task_id).toBe(TASK_ID);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("each invocation returns a fresh UUID id", () => {
    const a = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    });
    const b = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("createDispatchTaskCompletedEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createDispatchTaskCompletedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
    });
    expect(env.type).toBe("dispatch.task.completed");
    expect(env.payload).toMatchObject({
      task_id: TASK_ID,
      agent_id: "cortex",
      started_at: "2026-05-09T12:00:00.000Z",
      completed_at: "2026-05-09T12:01:30.000Z",
    });
    // result_summary omitted when not provided
    expect("result_summary" in env.payload).toBe(false);
    expect(env.correlation_id).toBe(TASK_ID);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("result_summary lands in payload when provided", () => {
    const env = createDispatchTaskCompletedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      resultSummary: "Refactored two files; tests green.",
    });
    expect(env.payload).toMatchObject({
      result_summary: "Refactored two files; tests green.",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

describe("createDispatchTaskFailedEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createDispatchTaskFailedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      failedAt: COMPLETED_AT,
      errorSummary: "claude exited 1: stderr noise",
    });
    expect(env.type).toBe("dispatch.task.failed");
    expect(env.payload).toMatchObject({
      task_id: TASK_ID,
      agent_id: "cortex",
      started_at: "2026-05-09T12:00:00.000Z",
      failed_at: "2026-05-09T12:01:30.000Z",
      error_summary: "claude exited 1: stderr noise",
    });
    expect(env.correlation_id).toBe(TASK_ID);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  // -----------------------------------------------------------------------
  // IAW Wave 0 PR-A.0a (refs cortex#232, cortex#238) — nak taxonomy
  // extension. Mirrors `docs/architecture.md` §7.3 and is the producer-side
  // contract consumed by pilot per `docs/design-pilot-restructure.md` §4.4.
  // -----------------------------------------------------------------------

  test("reason kind=policy_denied round-trips (back-compat — unchanged C.3.1 path)", () => {
    const env = createDispatchTaskFailedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      failedAt: COMPLETED_AT,
      errorSummary: "policy gate refused",
      reason: {
        kind: "policy_denied",
        deny: { code: "unknown_principal", principal: "ghost" },
      },
    });
    const payload = env.payload as { reason?: { kind: string; deny?: unknown } };
    expect(payload.reason?.kind).toBe("policy_denied");
    expect(payload.reason?.deny).toEqual({
      code: "unknown_principal",
      principal: "ghost",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("reason kind=cant_do round-trips with detail", () => {
    const env = createDispatchTaskFailedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      failedAt: COMPLETED_AT,
      errorSummary: "no consumer for capability",
      reason: {
        kind: "cant_do",
        detail: "no agent registered for code-review.rust",
      },
    });
    const payload = env.payload as {
      reason?: { kind: string; detail?: string };
    };
    expect(payload.reason?.kind).toBe("cant_do");
    expect(payload.reason?.detail).toBe(
      "no agent registered for code-review.rust",
    );
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("reason kind=wont_do round-trips with detail", () => {
    const env = createDispatchTaskFailedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      failedAt: COMPLETED_AT,
      errorSummary: "sovereignty refused",
      reason: {
        kind: "wont_do",
        detail: "agent sovereignty: strict mode rejects external requesters",
      },
    });
    const payload = env.payload as {
      reason?: { kind: string; detail?: string };
    };
    expect(payload.reason?.kind).toBe("wont_do");
    expect(payload.reason?.detail).toBe(
      "agent sovereignty: strict mode rejects external requesters",
    );
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("reason kind=not_now round-trips without retry_after_ms", () => {
    const env = createDispatchTaskFailedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      failedAt: COMPLETED_AT,
      errorSummary: "backpressure",
      reason: {
        kind: "not_now",
        detail: "queue full; try again shortly",
      },
    });
    const payload = env.payload as {
      reason?: { kind: string; detail?: string; retry_after_ms?: number };
    };
    expect(payload.reason?.kind).toBe("not_now");
    expect(payload.reason?.detail).toBe("queue full; try again shortly");
    expect(payload.reason?.retry_after_ms).toBeUndefined();
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("reason kind=not_now round-trips with retry_after_ms hint", () => {
    const env = createDispatchTaskFailedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      failedAt: COMPLETED_AT,
      errorSummary: "backpressure with hint",
      reason: {
        kind: "not_now",
        detail: "queue at capacity",
        retry_after_ms: 30000,
      },
    });
    const payload = env.payload as {
      reason?: { kind: string; detail?: string; retry_after_ms?: number };
    };
    expect(payload.reason?.kind).toBe("not_now");
    expect(payload.reason?.detail).toBe("queue at capacity");
    expect(payload.reason?.retry_after_ms).toBe(30000);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("reason kind=compliance_block round-trips with detail", () => {
    const env = createDispatchTaskFailedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      failedAt: COMPLETED_AT,
      errorSummary: "compliance attestation forbids",
      reason: {
        kind: "compliance_block",
        detail: "STD-EXAMPLE-AI-001 gate: external review not attested",
      },
    });
    const payload = env.payload as {
      reason?: { kind: string; detail?: string };
    };
    expect(payload.reason?.kind).toBe("compliance_block");
    expect(payload.reason?.detail).toBe(
      "STD-EXAMPLE-AI-001 gate: external review not attested",
    );
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

describe("createDispatchTaskAbortedEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createDispatchTaskAbortedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      abortedAt: COMPLETED_AT,
      reason: "timeout",
    });
    expect(env.type).toBe("dispatch.task.aborted");
    expect(env.payload).toMatchObject({
      task_id: TASK_ID,
      agent_id: "cortex",
      started_at: "2026-05-09T12:00:00.000Z",
      aborted_at: "2026-05-09T12:01:30.000Z",
      reason: "timeout",
    });
    expect(env.correlation_id).toBe(TASK_ID);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("reason is preserved verbatim (free-form)", () => {
    const env = createDispatchTaskAbortedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      abortedAt: COMPLETED_AT,
      reason: "principal-cancel: SIGINT received during shutdown drain",
    });
    expect(env.payload.reason).toBe(
      "principal-cancel: SIGINT received during shutdown drain",
    );
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

describe("createDispatchTaskPostEvent", () => {
  test(
    "cortex#1033 §Architecture — post rides the dispatch domain as " +
      "dispatch.task.post (NOT a brain.* top-level domain); passes schema",
    () => {
      const env = createDispatchTaskPostEvent({
        source: SOURCE,
        taskId: TASK_ID,
        agentId: "yarrow",
        text: "Composed the flow.",
        taskSource: {
          surface: "mattermost",
          channel: "c1",
          thread: "t1",
          user: "u1",
        },
      });
      expect(env.type).toBe("dispatch.task.post");
      expect(env.type.startsWith("dispatch.")).toBe(true);
      expect(env.payload).toMatchObject({
        task_id: TASK_ID,
        agent_id: "yarrow",
        text: "Composed the flow.",
        response_routing: { surface: "mattermost", channel: "c1", thread: "t1" },
        triggered_by: "u1",
      });
      expect(env.correlation_id).toBe(TASK_ID);
      expect(validateEnvelope(env).ok).toBe(true);
    },
  );

  test("cortex#1038 — adapter_instance source ⇒ WIRE routing the chat sink delivers; absent ⇒ logical shape", () => {
    // The bug: a brain post's logical {surface,channel,thread} routing is
    // null to `readResponseRouting` (the chat dispatch-sink's gate), so every
    // post was dropped. With adapter_instance the post must carry the wire
    // shape the sink accepts.
    const live = createDispatchTaskPostEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "yarrow",
      text: "Composed the flow.",
      taskSource: {
        surface: "discord",
        channel: "chan-snowflake",
        thread: "thread-snowflake",
        user: "u1",
        adapter_instance: "discord-yarrow",
      },
    });
    expect(live.payload).toMatchObject({
      response_routing: {
        adapter_instance: "discord-yarrow",
        channel_id: "chan-snowflake",
        thread_id: "thread-snowflake",
      },
    });
    // The sink's gate now ACCEPTS it (was null before this fix).
    expect(readResponseRouting(live)).toEqual({
      adapter_instance: "discord-yarrow",
      channel_id: "chan-snowflake",
      thread_id: "thread-snowflake",
    });
    expect(validateEnvelope(live).ok).toBe(true);

    // Bus-originated (no adapter_instance) keeps the logical shape — the
    // review-sink path — back-compat unchanged.
    const bus = createDispatchTaskPostEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "yarrow",
      text: "x",
      taskSource: { surface: "bus", channel: "c1", thread: "t1", user: "u1" },
    });
    expect(bus.payload).toMatchObject({
      response_routing: { surface: "bus", channel: "c1", thread: "t1" },
    });
    expect(readResponseRouting(bus)).toBeNull();
  });

  test("attachment reference is carried when present, omitted otherwise", () => {
    const withAtt = createDispatchTaskPostEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "yarrow",
      text: "see attached",
      taskSource: { surface: "bus", channel: "", thread: "", user: "" },
      attachment: { filename: "report.md", path: "/scratch/report.md" },
    });
    expect((withAtt.payload as { attachment?: unknown }).attachment).toEqual({
      filename: "report.md",
      path: "/scratch/report.md",
    });
    expect(validateEnvelope(withAtt).ok).toBe(true);

    const noAtt = createDispatchTaskPostEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "yarrow",
      text: "no attachment",
      taskSource: { surface: "bus", channel: "", thread: "", user: "" },
    });
    expect("attachment" in (noAtt.payload as object)).toBe(false);
  });
});

describe("dispatch.task.* — correlation_id contract", () => {
  test("all four lifecycle events for one task share one correlation_id by default", () => {
    const common = {
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    };
    const started = createDispatchTaskStartedEvent(common);
    const completed = createDispatchTaskCompletedEvent({
      ...common,
      completedAt: COMPLETED_AT,
    });
    const failed = createDispatchTaskFailedEvent({
      ...common,
      failedAt: COMPLETED_AT,
      errorSummary: "x",
    });
    const aborted = createDispatchTaskAbortedEvent({
      ...common,
      abortedAt: COMPLETED_AT,
      reason: "timeout",
    });

    expect(started.correlation_id).toBe(TASK_ID);
    expect(completed.correlation_id).toBe(TASK_ID);
    expect(failed.correlation_id).toBe(TASK_ID);
    expect(aborted.correlation_id).toBe(TASK_ID);
  });
});

describe("dispatch.task.* — cc_session_id parameterisation (MC-I1.S3)", () => {
  const common = {
    source: SOURCE,
    taskId: TASK_ID,
    agentId: "cortex",
    startedAt: STARTED_AT,
  };
  const CC_SESSION_ID = "b3a1c2d4-0000-4000-8000-aaaaaaaaaaaa";

  test("omitting ccSessionId leaves the field ABSENT (not empty) on every helper", () => {
    const envs = [
      createDispatchTaskStartedEvent(common),
      createDispatchTaskCompletedEvent({ ...common, completedAt: COMPLETED_AT }),
      createDispatchTaskFailedEvent({ ...common, failedAt: COMPLETED_AT, errorSummary: "x" }),
      createDispatchTaskAbortedEvent({ ...common, abortedAt: COMPLETED_AT, reason: "timeout" }),
    ];
    for (const env of envs) {
      // Absent, not undefined-valued — same omission contract as response_routing.
      expect("cc_session_id" in env.payload).toBe(false);
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });

  test("ccSessionId lands in payload.cc_session_id on started and round-trips through schema", () => {
    const env = createDispatchTaskStartedEvent({ ...common, ccSessionId: CC_SESSION_ID });
    expect(env.payload.cc_session_id).toBe(CC_SESSION_ID);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("ccSessionId lands in payload.cc_session_id on every terminal helper", () => {
    const envs = [
      createDispatchTaskCompletedEvent({ ...common, completedAt: COMPLETED_AT, ccSessionId: CC_SESSION_ID }),
      createDispatchTaskFailedEvent({ ...common, failedAt: COMPLETED_AT, errorSummary: "x", ccSessionId: CC_SESSION_ID }),
      createDispatchTaskAbortedEvent({ ...common, abortedAt: COMPLETED_AT, reason: "timeout", ccSessionId: CC_SESSION_ID }),
    ];
    for (const env of envs) {
      expect(env.payload.cc_session_id).toBe(CC_SESSION_ID);
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });
});

describe("dispatch.task.* — data_residency parameterisation", () => {
  test("source without dataResidency defaults to NZ", () => {
    const env = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    });
    expect(env.sovereignty.data_residency).toBe("NZ");
  });

  test("source.dataResidency overrides the default for every lifecycle helper", () => {
    const sourceAU: DispatchEventSource = { ...SOURCE, dataResidency: "AU" };
    const common = {
      source: sourceAU,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    };
    const envs = [
      createDispatchTaskStartedEvent(common),
      createDispatchTaskCompletedEvent({ ...common, completedAt: COMPLETED_AT }),
      createDispatchTaskFailedEvent({ ...common, failedAt: COMPLETED_AT, errorSummary: "x" }),
      createDispatchTaskAbortedEvent({ ...common, abortedAt: COMPLETED_AT, reason: "timeout" }),
    ];
    for (const env of envs) {
      expect(env.sovereignty.data_residency).toBe("AU");
    }
  });
});

describe("dispatch.task.* — classification parameterisation (IAW A.3)", () => {
  const common = {
    source: SOURCE,
    taskId: TASK_ID,
    agentId: "cortex",
    startedAt: STARTED_AT,
  };

  test("omitting classification defaults to local for every lifecycle helper", () => {
    const envs = [
      createDispatchTaskStartedEvent(common),
      createDispatchTaskCompletedEvent({ ...common, completedAt: COMPLETED_AT }),
      createDispatchTaskFailedEvent({ ...common, failedAt: COMPLETED_AT, errorSummary: "x" }),
      createDispatchTaskAbortedEvent({ ...common, abortedAt: COMPLETED_AT, reason: "timeout" }),
    ];
    for (const env of envs) {
      expect(env.sovereignty.classification).toBe("local");
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });

  test("classification: 'federated' flows into envelope.sovereignty for every helper", () => {
    const fed = { ...common, classification: "federated" as const };
    const envs = [
      createDispatchTaskStartedEvent(fed),
      createDispatchTaskCompletedEvent({ ...fed, completedAt: COMPLETED_AT }),
      createDispatchTaskFailedEvent({ ...fed, failedAt: COMPLETED_AT, errorSummary: "x" }),
      createDispatchTaskAbortedEvent({ ...fed, abortedAt: COMPLETED_AT, reason: "timeout" }),
    ];
    for (const env of envs) {
      expect(env.sovereignty.classification).toBe("federated");
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });

  test("classification: 'public' flows into envelope.sovereignty for every helper", () => {
    const pub = { ...common, classification: "public" as const };
    const envs = [
      createDispatchTaskStartedEvent(pub),
      createDispatchTaskCompletedEvent({ ...pub, completedAt: COMPLETED_AT }),
      createDispatchTaskFailedEvent({ ...pub, failedAt: COMPLETED_AT, errorSummary: "x" }),
      createDispatchTaskAbortedEvent({ ...pub, abortedAt: COMPLETED_AT, reason: "timeout" }),
    ];
    for (const env of envs) {
      expect(env.sovereignty.classification).toBe("public");
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });
});
