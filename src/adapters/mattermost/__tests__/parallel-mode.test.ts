/**
 * IAW Phase C.2b-242a (cortex#296) — MattermostAdapter parallel-mode tests.
 *
 * Mirror of `src/adapters/discord/__tests__/parallel-mode.test.ts` —
 * pins the intersection-wins semantic + disagreement-envelope shape
 * for the Mattermost adapter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../../bus/myelin/runtime";
import type { Agent, MattermostPresence, PolicyPrincipal } from "../../../common/types/cortex-config";
import {
  PolicyEngine,
  PlatformPrincipalIndex,
  type Principal,
  type RoleDefinition,
} from "../../../common/policy";
import type { InboundMessage } from "../../types";
import { MattermostAdapter, type MattermostAdapterInfra } from "../index";

function makePresence(overrides: Partial<MattermostPresence> = {}): MattermostPresence {
  return {
    enabled: true,
    callbackPort: 8080,
    apiUrl: "http://localhost:8065",
    apiToken: "fake-token",
    channels: [],
    pollIntervalMs: 3000,
    allowedUsers: [],
    roles: [
      {
        name: "user",
        users: ["U123"],
        features: ["chat"],
        disallowedTools: [],
      },
    ],
    defaultRole: "denied",
    ...overrides,
  };
}

function makeAgent(presence: MattermostPresence): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "(test)",
    roles: [],
    trust: [],
    presence: { mattermost: presence },
  };
}

interface RecordingRuntime extends MyelinRuntime {
  publishes: Envelope[];
}

function makeRecordingRuntime(): RecordingRuntime {
  const publishes: Envelope[] = [];
  return {
    enabled: true,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: async (envelope: Envelope) => {
      publishes.push(envelope);
    },
    stop: async () => {},
    publishes,
  };
}

interface PolicyFixture {
  engine: PolicyEngine;
  index: PlatformPrincipalIndex;
}

function makePolicy(opts: {
  principals: (Principal & { platform_ids: Record<string, string[]> })[];
  roles: RoleDefinition[];
}): PolicyFixture {
  const engine = new PolicyEngine({
    principals: opts.principals.map((p) => ({
      id: p.id,
      home_operator: p.home_operator,
      home_stack: p.home_stack,
      role: p.role,
      trust: p.trust,
    })),
    roles: opts.roles,
  });
  const index = new PlatformPrincipalIndex(
    opts.principals.map(
      (p): PolicyPrincipal => ({
        id: p.id,
        home_operator: p.home_operator,
        home_stack: p.home_stack,
        role: [...p.role],
        trust: [...p.trust],
        platform_ids: p.platform_ids,
      }),
    ),
  );
  return { engine, index };
}

function buildInboundMessage(authorId: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "mattermost",
    instanceId: "mattermost-luna",
    authorId,
    authorName: "test",
    content: "hi",
    channelId: "ch1",
    attachments: [],
    timestamp: new Date("2026-05-17T00:00:00.000Z"),
    ...overrides,
  };
}

function makeAdapter(opts: {
  presence?: MattermostPresence;
  parallelModeEnabled?: boolean;
  policy?: PolicyFixture;
  runtime?: MyelinRuntime;
  systemEventSource?: { org: string; agent: string; instance: string };
}): MattermostAdapter {
  const presence = opts.presence ?? makePresence();
  const agent = makeAgent(presence);
  const infra: MattermostAdapterInfra = {
    instanceId: "mattermost-luna",
    operator: { mattermostId: "U_OPERATOR" },
    ...(opts.runtime !== undefined && { runtime: opts.runtime }),
    ...(opts.systemEventSource !== undefined && { systemEventSource: opts.systemEventSource }),
    ...(opts.parallelModeEnabled !== undefined && { parallelModeEnabled: opts.parallelModeEnabled }),
    ...(opts.policy !== undefined && {
      policyEngine: opts.policy.engine,
      policyLookup: opts.policy.index,
    }),
  };
  return new MattermostAdapter(agent, presence, infra);
}

let originalError: typeof console.error;
let originalWarn: typeof console.warn;
beforeEach(() => {
  originalError = console.error;
  originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
});
afterEach(() => {
  console.error = originalError;
  console.warn = originalWarn;
});

describe("MattermostAdapter parallel-mode (§9.1 intersection-wins)", () => {
  test("parallel_mode_enabled=false: only legacy runs, no PolicyEngine call", () => {
    const policy = makePolicy({ principals: [], roles: [] });
    const runtime = makeRecordingRuntime();
    const adapter = makeAdapter({
      parallelModeEnabled: false,
      policy,
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    const decision = adapter.resolveAccess(buildInboundMessage("U123"));
    expect(decision.allowed).toBe(true);
    expect(runtime.publishes.length).toBe(0);
  });

  test("both gates allow: effective allow, no disagreement", () => {
    const policy = makePolicy({
      principals: [
        {
          id: "mike",
          home_operator: "andreas",
          home_stack: "andreas/meta-factory",
          role: ["user"],
          trust: [],
          platform_ids: { mattermost: ["U123"] },
        },
      ],
      roles: [{ id: "user", capabilities: ["keyword.chat"] }],
    });
    const runtime = makeRecordingRuntime();
    const adapter = makeAdapter({
      parallelModeEnabled: true,
      policy,
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    const decision = adapter.resolveAccess(buildInboundMessage("U123"));
    expect(decision.allowed).toBe(true);
    expect(decision.features.chat).toBe(true);
    expect(runtime.publishes.length).toBe(0);
  });

  test("legacy allow + new deny (unknown_principal): effective DENY + disagreement", () => {
    const policy = makePolicy({ principals: [], roles: [] });
    const runtime = makeRecordingRuntime();
    const adapter = makeAdapter({
      parallelModeEnabled: true,
      policy,
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    const decision = adapter.resolveAccess(buildInboundMessage("U123"));
    expect(decision.allowed).toBe(false);
    const env = runtime.publishes.find((e) => e.type === "system.access.disagreement");
    expect(env).toBeDefined();
    expect(env?.payload).toMatchObject({
      capability: "keyword.chat",
      legacy_decision: "allow",
      new_decision: "deny",
      new_reason: "unknown_principal",
      effective_decision: "deny",
    });
  });

  test("legacy deny + new allow: effective DENY + disagreement", () => {
    const policy = makePolicy({
      principals: [
        {
          id: "mike",
          home_operator: "andreas",
          home_stack: "andreas/meta-factory",
          role: ["user"],
          trust: [],
          platform_ids: { mattermost: ["U999"] },
        },
      ],
      roles: [{ id: "user", capabilities: ["keyword.chat"] }],
    });
    const runtime = makeRecordingRuntime();
    const adapter = makeAdapter({
      parallelModeEnabled: true,
      policy,
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    const decision = adapter.resolveAccess(buildInboundMessage("U999"));
    expect(decision.allowed).toBe(false);
    const env = runtime.publishes.find((e) => e.type === "system.access.disagreement");
    expect(env).toBeDefined();
    expect(env?.payload).toMatchObject({
      legacy_decision: "deny",
      new_decision: "allow",
      effective_decision: "deny",
    });
  });

  test("parallel_mode_enabled=true but no policy wired: ERROR + legacy fallback", () => {
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    const runtime = makeRecordingRuntime();
    const adapter = makeAdapter({
      parallelModeEnabled: true,
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    const decision = adapter.resolveAccess(buildInboundMessage("U123"));
    expect(decision.allowed).toBe(true);
    expect(runtime.publishes.length).toBe(0);
    expect(errors.some((e) => e.includes("parallel_mode_enabled=true but policyEngine/policyLookup not wired"))).toBe(true);
  });

  test("emitted disagreement envelope passes myelin schema validation", async () => {
    const policy = makePolicy({ principals: [], roles: [] });
    const runtime = makeRecordingRuntime();
    const adapter = makeAdapter({
      parallelModeEnabled: true,
      policy,
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    adapter.resolveAccess(buildInboundMessage("U123"));
    const env = runtime.publishes.find((e) => e.type === "system.access.disagreement");
    expect(env).toBeDefined();
    const { validateEnvelope } = await import("../../../bus/myelin/envelope-validator");
    const result = validateEnvelope(env);
    expect(result.ok).toBe(true);
  });
});
