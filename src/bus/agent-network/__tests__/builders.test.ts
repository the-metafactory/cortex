/**
 * G-1114.B.1 — tests for the `agent.*` presence envelope builders.
 *
 * Mirrors the coverage axes of `dispatch-events.test.ts` + the inert-shape
 * `envelopes.test.ts`:
 *   1. Shape — each builder sets the right `type`, source triple, sovereignty
 *      posture; payload carries `identity`/`scope` + the action-specific
 *      fields; optional fields are OMITTED (not `undefined`-valued) when the
 *      caller doesn't pass them.
 *   2. Validation — every constructed envelope passes the vendored myelin
 *      schema (`validateEnvelope`) AND its payload passes the Phase A cortex
 *      payload schema (`AGENT_PRESENCE_PAYLOAD_SCHEMAS`).
 *   3. Subject — the derived subject is EXACTLY
 *      `local.{principal}.{stack}.agent.{action}` (and the `federated.`
 *      counterpart with the SAME identity segments — ADR-0001/0007).
 *   4. Signing path — the builder output is UNSIGNED (`signed_by` absent): the
 *      stack signs at publish via `runtime.publish`, never in the builder.
 *
 * NO producer/subscriber coverage — B.1 ships builders only; nothing wires
 * them yet (G-1114.B.2/B.3).
 */

import { describe, expect, test } from "bun:test";
import {
  validateEnvelope,
  deriveNatsSubject,
  type Classification,
} from "../../myelin/envelope-validator";
import {
  AGENT_ONLINE_TYPE,
  AGENT_HEARTBEAT_TYPE,
  AGENT_OFFLINE_TYPE,
  AGENT_CAPABILITIES_CHANGED_TYPE,
  AGENT_PRESENCE_PAYLOAD_SCHEMAS,
} from "../envelopes";
import {
  createAgentOnlineEvent,
  createAgentHeartbeatEvent,
  createAgentOfflineEvent,
  createAgentCapabilitiesChangedEvent,
  type AgentPresenceSource,
} from "../builders";

const SOURCE: AgentPresenceSource = {
  principal: "andreas",
  stack: "meta-factory",
  instance: "local",
};
const IDENTITY = {
  nkey_public_key: "UABC1234567890",
  agent_id: "luna",
  assistant_name: "Luna",
};
const SCOPE = { principal: "andreas", stack: "meta-factory" };
const STARTED_AT = new Date("2026-06-10T09:00:00.000Z");
const SENT_AT = new Date("2026-06-10T09:05:00.000Z");

/** Stack passed to the publish-side subject derivation (runtime supplies it). */
const STACK = "meta-factory";

describe("createAgentOnlineEvent", () => {
  test("required fields populated; envelope + payload pass validation", () => {
    const env = createAgentOnlineEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      capabilities: ["code-review.typescript"],
      startedAt: STARTED_AT,
    });
    expect(env.type).toBe("agent.online");
    expect(env.source).toBe("andreas.meta-factory.local");
    expect(env.payload).toMatchObject({
      identity: IDENTITY,
      scope: SCOPE,
      capabilities: ["code-review.typescript"],
      started_at: "2026-06-10T09:00:00.000Z",
    });
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    expect(validateEnvelope(env).ok).toBe(true);
    AGENT_PRESENCE_PAYLOAD_SCHEMAS[AGENT_ONLINE_TYPE].parse(env.payload);
  });

  test("capabilities default to empty array when omitted", () => {
    const env = createAgentOnlineEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      startedAt: STARTED_AT,
    });
    expect(env.payload.capabilities).toEqual([]);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("presence envelopes carry NO correlation_id", () => {
    const env = createAgentOnlineEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      startedAt: STARTED_AT,
    });
    // ADR-0007 §1 — presence is not correlated lifecycle; only the
    // dispatch heartbeat (cortex#361) carries a correlation_id.
    expect(env.correlation_id).toBeUndefined();
  });
});

describe("createAgentHeartbeatEvent (presence, not dispatch)", () => {
  test("liveness-only payload; passes validation", () => {
    const env = createAgentHeartbeatEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      sentAt: SENT_AT,
    });
    expect(env.type).toBe("agent.heartbeat");
    expect(env.payload).toMatchObject({
      identity: IDENTITY,
      scope: SCOPE,
      sent_at: "2026-06-10T09:05:00.000Z",
    });
    // Liveness-only — no capability list, no dispatch progress fields.
    expect("capabilities" in env.payload).toBe(false);
    expect("phase" in env.payload).toBe(false);
    expect("correlation_id" in env.payload).toBe(false);
    expect(env.correlation_id).toBeUndefined();
    expect(validateEnvelope(env).ok).toBe(true);
    AGENT_PRESENCE_PAYLOAD_SCHEMAS[AGENT_HEARTBEAT_TYPE].parse(env.payload);
  });
});

describe("createAgentOfflineEvent", () => {
  test("required fields populated; detail omitted when absent", () => {
    const env = createAgentOfflineEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      reason: "shutdown",
      sentAt: SENT_AT,
    });
    expect(env.type).toBe("agent.offline");
    expect(env.payload).toMatchObject({
      identity: IDENTITY,
      scope: SCOPE,
      reason: "shutdown",
      sent_at: "2026-06-10T09:05:00.000Z",
    });
    expect("detail" in env.payload).toBe(false);
    expect(validateEnvelope(env).ok).toBe(true);
    AGENT_PRESENCE_PAYLOAD_SCHEMAS[AGENT_OFFLINE_TYPE].parse(env.payload);
  });

  test("detail lands in payload when provided", () => {
    const env = createAgentOfflineEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      reason: "error",
      detail: "uncaught exception in cc-session",
      sentAt: SENT_AT,
    });
    expect(env.payload.detail).toBe("uncaught exception in cc-session");
    expect(env.payload.reason).toBe("error");
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

describe("createAgentCapabilitiesChangedEvent", () => {
  test("carries the full new set; passes validation", () => {
    const env = createAgentCapabilitiesChangedEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      capabilities: ["code-review.typescript", "code-review.documentation"],
      sentAt: SENT_AT,
    });
    expect(env.type).toBe("agent.capabilities-changed");
    expect(env.payload.capabilities).toEqual([
      "code-review.typescript",
      "code-review.documentation",
    ]);
    expect(env.payload.sent_at).toBe("2026-06-10T09:05:00.000Z");
    expect(validateEnvelope(env).ok).toBe(true);
    AGENT_PRESENCE_PAYLOAD_SCHEMAS[AGENT_CAPABILITIES_CHANGED_TYPE].parse(
      env.payload,
    );
  });

  test("capabilities default to empty (all revoked) when omitted", () => {
    const env = createAgentCapabilitiesChangedEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      sentAt: SENT_AT,
    });
    expect(env.payload.capabilities).toEqual([]);
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

describe("envelope hygiene shared across all four builders", () => {
  const make = () => [
    createAgentOnlineEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      startedAt: STARTED_AT,
    }),
    createAgentHeartbeatEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      sentAt: SENT_AT,
    }),
    createAgentOfflineEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      reason: "shutdown",
      sentAt: SENT_AT,
    }),
    createAgentCapabilitiesChangedEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      sentAt: SENT_AT,
    }),
  ];

  test("each call returns a fresh UUID id", () => {
    const a = createAgentOnlineEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      startedAt: STARTED_AT,
    });
    const b = createAgentOnlineEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      startedAt: STARTED_AT,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("builders emit UNSIGNED envelopes — the stack signs at publish, never the builder", () => {
    // The signing path is `runtime.publish` → `signEnvelope` (stack NKey),
    // mirroring dispatch-events. The builder must NOT pre-stamp `signed_by[]`.
    for (const env of make()) {
      expect(env.signed_by).toBeUndefined();
    }
  });
});

describe("agent-domain subject derivation (local + federated)", () => {
  const cases: { env: () => ReturnType<typeof createAgentOnlineEvent>; action: string }[] = [
    {
      action: "online",
      env: () =>
        createAgentOnlineEvent({
          source: SOURCE,
          identity: IDENTITY,
          scope: SCOPE,
          startedAt: STARTED_AT,
        }),
    },
    {
      action: "heartbeat",
      env: () =>
        createAgentHeartbeatEvent({
          source: SOURCE,
          identity: IDENTITY,
          scope: SCOPE,
          sentAt: SENT_AT,
        }),
    },
    {
      action: "offline",
      env: () =>
        createAgentOfflineEvent({
          source: SOURCE,
          identity: IDENTITY,
          scope: SCOPE,
          reason: "shutdown",
          sentAt: SENT_AT,
        }),
    },
    {
      action: "capabilities-changed",
      env: () =>
        createAgentCapabilitiesChangedEvent({
          source: SOURCE,
          identity: IDENTITY,
          scope: SCOPE,
          sentAt: SENT_AT,
        }),
    },
  ];

  for (const { action, env } of cases) {
    test(`local builder derives local.andreas.meta-factory.agent.${action}`, () => {
      const e = env();
      expect(deriveNatsSubject(e, STACK)).toBe(
        `local.andreas.meta-factory.agent.${action}`,
      );
    });
  }

  test("federated classification derives the federated counterpart with the SAME identity segments", () => {
    // ADR-0001/0007 — the federated subject carries {principal}.{stack},
    // never a network token; only the scope prefix differs.
    const classification: Classification = "federated";
    const env = createAgentOnlineEvent({
      source: SOURCE,
      identity: IDENTITY,
      scope: SCOPE,
      startedAt: STARTED_AT,
      classification,
    });
    expect(env.sovereignty.classification).toBe("federated");
    expect(validateEnvelope(env).ok).toBe(true);
    expect(deriveNatsSubject(env, STACK)).toBe(
      "federated.andreas.meta-factory.agent.online",
    );
  });
});
