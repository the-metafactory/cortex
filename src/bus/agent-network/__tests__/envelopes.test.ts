/**
 * G-1114.A — inert agent-presence protocol type tests.
 *
 * These assert the SHAPE of the four `agent`-domain presence payloads and that
 * an envelope carrying each payload:
 *   1. validates against the myelin envelope schema (payload is unconstrained —
 *      the same property cortex#361's heartbeat relies on), and
 *   2. derives the correct `agent`-domain subject
 *      (`{scope}.{principal}.{stack}.agent.{action}`) via `deriveNatsSubject`.
 *
 * NO producer/consumer/integration coverage — nothing is live yet (ADR-0007;
 * producers land in G-1114.B). This is the inert-shape gate only.
 */

import { describe, expect, test } from "bun:test";
import {
  AGENT_ONLINE_TYPE,
  AGENT_HEARTBEAT_TYPE,
  AGENT_OFFLINE_TYPE,
  AGENT_CAPABILITIES_CHANGED_TYPE,
  AGENT_PRESENCE_TYPES,
  AGENT_PRESENCE_PAYLOAD_SCHEMAS,
  AgentOnlinePayloadSchema,
  AgentHeartbeatPayloadSchema,
  AgentOfflinePayloadSchema,
  AgentCapabilitiesChangedPayloadSchema,
  AgentOfflineReasonSchema,
  type AgentPresenceType,
} from "../envelopes";
import {
  validateEnvelope,
  deriveNatsSubject,
} from "../../myelin/envelope-validator";

const IDENTITY = {
  nkey_public_key: "UABC1234567890",
  agent_id: "luna",
  assistant_name: "Luna",
};
const SCOPE = { principal: "andreas", stack: "meta-factory" };
const NOW = "2026-06-10T09:00:00Z";

/** Build a minimal valid myelin envelope wrapping a presence payload. */
function envelopeFor(type: AgentPresenceType, payload: unknown, stack = "meta-factory"): unknown {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    // source = {principal}.{agent}.{instance}; firstSegment → principal "andreas"
    source: `andreas.${stack}.cortex-01`,
    type,
    timestamp: NOW,
    sovereignty: {
      classification: "local",
      data_residency: "DE",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload,
  };
}

describe("agent-presence type constants", () => {
  test("the four action type literals are the agent domain", () => {
    expect(AGENT_ONLINE_TYPE).toBe("agent.online");
    expect(AGENT_HEARTBEAT_TYPE).toBe("agent.heartbeat");
    expect(AGENT_OFFLINE_TYPE).toBe("agent.offline");
    expect(AGENT_CAPABILITIES_CHANGED_TYPE).toBe("agent.capabilities-changed");
    // Every presence type rides the `agent` domain (leading subject segment),
    // distinct from the dispatch-scoped `system.agent.heartbeat` (cortex#361).
    for (const t of AGENT_PRESENCE_TYPES) {
      expect(t.startsWith("agent.")).toBe(true);
      expect(t).not.toBe("system.agent.heartbeat");
    }
  });

  test("presence heartbeat is NOT the dispatch heartbeat type", () => {
    // ADR-0007 §1 — two differently-scoped heartbeats by design.
    expect(AGENT_HEARTBEAT_TYPE).not.toBe("system.agent.heartbeat");
  });

  test("the schema map covers every presence type", () => {
    for (const t of AGENT_PRESENCE_TYPES) {
      expect(AGENT_PRESENCE_PAYLOAD_SCHEMAS[t]).toBeDefined();
    }
  });
});

describe("agent.online payload", () => {
  const valid = {
    identity: IDENTITY,
    scope: SCOPE,
    capabilities: ["code-review.typescript", "code-review.documentation"],
    started_at: NOW,
  };

  test("accepts a full descriptor", () => {
    const parsed = AgentOnlinePayloadSchema.parse(valid);
    expect(parsed.identity.agent_id).toBe("luna");
    expect(parsed.scope.principal).toBe("andreas");
    expect(parsed.capabilities).toHaveLength(2);
  });

  test("defaults capabilities to empty array when omitted", () => {
    const { capabilities: _omit, ...rest } = valid;
    const parsed = AgentOnlinePayloadSchema.parse(rest);
    expect(parsed.capabilities).toEqual([]);
  });

  test("null assistant_name is accepted (bus-only / unassigned agent)", () => {
    const parsed = AgentOnlinePayloadSchema.parse({
      ...valid,
      identity: { ...IDENTITY, assistant_name: null },
    });
    expect(parsed.identity.assistant_name).toBeNull();
  });

  test("rejects an uppercase / malformed capability id", () => {
    expect(() =>
      AgentOnlinePayloadSchema.parse({ ...valid, capabilities: ["CodeReview"] }),
    ).toThrow();
  });

  test("rejects a missing principal", () => {
    expect(() =>
      AgentOnlinePayloadSchema.parse({
        ...valid,
        scope: { stack: "meta-factory" },
      }),
    ).toThrow();
  });
});

describe("agent.heartbeat payload (presence, not dispatch)", () => {
  const valid = { identity: IDENTITY, scope: SCOPE, sent_at: NOW };

  test("accepts a minimal liveness ping", () => {
    const parsed = AgentHeartbeatPayloadSchema.parse(valid);
    expect(parsed.sent_at).toBe(NOW);
  });

  test("carries no dispatch fields (no correlation_id / phase)", () => {
    // Presence heartbeat is liveness-only; dispatch progress is the cortex#361
    // heartbeat's job. Zod strips unknowns, so an accidental dispatch field
    // does not survive parse.
    const parsed = AgentHeartbeatPayloadSchema.parse({
      ...valid,
      correlation_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      phase: "thinking",
    }) as Record<string, unknown>;
    expect(parsed.correlation_id).toBeUndefined();
    expect(parsed.phase).toBeUndefined();
  });
});

describe("agent.offline payload", () => {
  const valid = {
    identity: IDENTITY,
    scope: SCOPE,
    reason: "shutdown" as const,
    sent_at: NOW,
  };

  test("accepts each graceful + error reason", () => {
    for (const reason of ["shutdown", "restart", "error"] as const) {
      expect(AgentOfflinePayloadSchema.parse({ ...valid, reason }).reason).toBe(reason);
    }
  });

  test("accepts an optional detail", () => {
    const parsed = AgentOfflinePayloadSchema.parse({
      ...valid,
      reason: "error",
      detail: "uncaught exception in cc-session",
    });
    expect(parsed.detail).toBe("uncaught exception in cc-session");
  });

  test("rejects an unknown reason", () => {
    expect(() => AgentOfflineReasonSchema.parse("ttl-lapse")).toThrow();
  });
});

describe("agent.capabilities-changed payload", () => {
  const valid = {
    identity: IDENTITY,
    scope: SCOPE,
    capabilities: ["code-review.typescript"],
    sent_at: NOW,
  };

  test("carries the full new steady-state set (not a diff)", () => {
    const parsed = AgentCapabilitiesChangedPayloadSchema.parse(valid);
    expect(parsed.capabilities).toEqual(["code-review.typescript"]);
  });

  test("accepts an empty set (all capabilities revoked)", () => {
    const parsed = AgentCapabilitiesChangedPayloadSchema.parse({
      ...valid,
      capabilities: [],
    });
    expect(parsed.capabilities).toEqual([]);
  });
});

describe("envelope round-trip (myelin validator) + agent-domain subject derivation", () => {
  const cases: { type: AgentPresenceType; payload: unknown; action: string }[] = [
    {
      type: AGENT_ONLINE_TYPE,
      action: "online",
      payload: { identity: IDENTITY, scope: SCOPE, capabilities: [], started_at: NOW },
    },
    {
      type: AGENT_HEARTBEAT_TYPE,
      action: "heartbeat",
      payload: { identity: IDENTITY, scope: SCOPE, sent_at: NOW },
    },
    {
      type: AGENT_OFFLINE_TYPE,
      action: "offline",
      payload: { identity: IDENTITY, scope: SCOPE, reason: "shutdown", sent_at: NOW },
    },
    {
      type: AGENT_CAPABILITIES_CHANGED_TYPE,
      action: "capabilities-changed",
      payload: {
        identity: IDENTITY,
        scope: SCOPE,
        capabilities: ["code-review.typescript"],
        sent_at: NOW,
      },
    },
  ];

  for (const { type, action, payload } of cases) {
    test(`${type} validates against the envelope schema (payload unconstrained)`, () => {
      // Payload first passes its own cortex-side schema...
      AGENT_PRESENCE_PAYLOAD_SCHEMAS[type].parse(payload);
      // ...then the wrapping envelope validates (payload is domain-specific /
      // unconstrained — confirms it rides the standard envelope, like the
      // cortex#361 heartbeat work).
      const result = validateEnvelope(envelopeFor(type, payload));
      expect(result.ok).toBe(true);
    });

    test(`${type} derives local.{principal}.{stack}.agent.${action}`, () => {
      const env = validateEnvelope(envelopeFor(type, payload));
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      const subject = deriveNatsSubject(env.envelope, "meta-factory");
      expect(subject).toBe(`local.andreas.meta-factory.agent.${action}`);
    });

    test(`${type} derives the federated counterpart with the SAME identity segments`, () => {
      // ADR-0001/0007 — the federated subject carries {principal}.{stack},
      // never a network token; only the scope prefix differs.
      const fedEnvelope = {
        ...(envelopeFor(type, payload) as Record<string, unknown>),
        sovereignty: {
          classification: "federated",
          data_residency: "DE",
          max_hop: 1,
          frontier_ok: false,
          model_class: "local-only",
        },
      };
      const env = validateEnvelope(fedEnvelope);
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      const subject = deriveNatsSubject(env.envelope, "meta-factory");
      expect(subject).toBe(`federated.andreas.meta-factory.agent.${action}`);
    });
  }
});
