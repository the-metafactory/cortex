/**
 * IAW Phase C.2b-242a (cortex#296) — DiscordAdapter parallel-mode tests.
 *
 * Pins the intersection-wins semantic from `docs/design-policy-cutover.md`
 * §9.1: effective decision = legacy AND new. Verifies the
 * `system.access.disagreement` envelope shape + graceful degradation
 * when the parallel-mode wiring is incomplete.
 *
 * Tests exercise `DiscordAdapter.resolveAccess` directly — no Discord
 * connection involved. The DM-context branch is exercised separately
 * from the channel-context branch because each flows through a
 * different legacy code path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../../bus/myelin/runtime";
import { DMConfigSchema } from "../../../common/types/config";
import type { Agent, DiscordPresence, PolicyPrincipal } from "../../../common/types/cortex-config";
import { PolicyEngine, PlatformPrincipalIndex, type Principal, type RoleDefinition } from "../../../common/policy";
import type { InboundMessage } from "../../types";
import { DiscordAdapter, type DiscordAdapterInfra } from "../index";

function makePresence(overrides: Partial<DiscordPresence> = {}): DiscordPresence {
  return {
    enabled: true,
    token: "fake-token",
    guildId: "g1",
    agentChannelId: "ch1",
    logChannelId: "ch2",
    contextDepth: 5,
    enableAgentLog: false,
    // Legacy gate: grants `chat` to user `U123` via role `user`.
    roles: [
      {
        name: "user",
        users: ["U123"],
        features: ["chat"],
        disallowedTools: [],
      },
    ],
    defaultRole: "denied",
    dm: DMConfigSchema.parse({}),
    trustedBotIds: [],
    surfaceSubjects: [],
    ...overrides,
  };
}

function makeAgent(presence: DiscordPresence): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "(test)",
    roles: [],
    trust: [],
    presence: { discord: presence },
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

/**
 * Build a PolicyEngine + PlatformPrincipalIndex pair from a slim
 * principal/role description. The full `PolicyPrincipal` shape from
 * cortex-config.ts has extra fields (nkey_pub, session_config,
 * platform_ids) the engine doesn't read; the index reads only
 * platform_ids, so we feed each side what it needs.
 */
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
  // PlatformPrincipalIndex reads from `PolicyPrincipal`-shape; pass
  // the full record (it ignores the engine-only fields).
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
    platform: "discord",
    instanceId: "discord-luna",
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
  presence?: DiscordPresence;
  parallelModeEnabled?: boolean;
  policy?: PolicyFixture;
  runtime?: MyelinRuntime;
  systemEventSource?: { org: string; agent: string; instance: string };
}): DiscordAdapter {
  const presence = opts.presence ?? makePresence();
  const agent = makeAgent(presence);
  const infra: DiscordAdapterInfra = {
    instanceId: "discord-luna",
    operator: { discordId: "U_OPERATOR" },
    ...(opts.runtime !== undefined && { runtime: opts.runtime }),
    ...(opts.systemEventSource !== undefined && { systemEventSource: opts.systemEventSource }),
    ...(opts.parallelModeEnabled !== undefined && { parallelModeEnabled: opts.parallelModeEnabled }),
    ...(opts.policy !== undefined && {
      policyEngine: opts.policy.engine,
      policyLookup: opts.policy.index,
    }),
  };
  return new DiscordAdapter(agent, presence, infra);
}

let originalError: typeof console.error;
beforeEach(() => {
  originalError = console.error;
  console.error = () => {};
});
afterEach(() => {
  console.error = originalError;
});

describe("DiscordAdapter parallel-mode (§9.1 intersection-wins)", () => {
  test("parallel_mode_enabled=false: only legacy runs, no PolicyEngine call", () => {
    // Build a policy fixture that would DENY user U123 if consulted —
    // proves the engine is NOT being consulted when the flag is off.
    const policy = makePolicy({
      principals: [],
      roles: [],
    });
    const runtime = makeRecordingRuntime();
    const adapter = makeAdapter({
      parallelModeEnabled: false,
      policy,
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    const decision = adapter.resolveAccess(buildInboundMessage("U123"));
    expect(decision.allowed).toBe(true);
    expect(decision.features.chat).toBe(true);
    // No disagreement envelopes — engine not consulted.
    expect(runtime.publishes.length).toBe(0);
  });

  test("both gates allow: effective allow, no disagreement envelope", () => {
    const policy = makePolicy({
      principals: [
        {
          id: "mike",
          home_operator: "andreas",
          home_stack: "andreas/meta-factory",
          role: ["user"],
          trust: [],
          platform_ids: { discord: ["U123"] },
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
    expect(decision.features.async).toBe(false); // legacy denied async; new gate has no role grant for it either
    // Legacy grants chat (allowed), denies async/team; new gate grants
    // chat (allowed), denies async/team. Both AGREE on all three →
    // no disagreement envelope.
    expect(runtime.publishes.length).toBe(0);
  });

  test("both gates deny: effective deny, no disagreement envelope", () => {
    // Legacy denies (user not in any role + defaultRole=denied).
    // New gate denies (no principal claims platform_ids.discord=U999).
    const policy = makePolicy({
      principals: [],
      roles: [],
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
    // Both gates agree on the denial — no disagreement envelope.
    expect(runtime.publishes.length).toBe(0);
  });

  test("legacy allow + new deny: effective DENY + disagreement envelope (dangerous direction)", () => {
    // Legacy: U123 has role "user" with feature "chat" → allowed.
    // New: no principal claims U123 → unknown_principal → deny.
    // Effective: deny (intersection-wins). Disagreement envelope fires.
    const policy = makePolicy({
      principals: [],
      roles: [],
    });
    const runtime = makeRecordingRuntime();
    const adapter = makeAdapter({
      parallelModeEnabled: true,
      policy,
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    const decision = adapter.resolveAccess(buildInboundMessage("U123"));
    expect(decision.allowed).toBe(false);
    expect(decision.features.chat).toBe(false);
    expect(decision.denyReason).toBeDefined();
    // Disagreement envelope on the keyword.chat capability (the one
    // where legacy and new differ). Other capabilities (async, team)
    // both denied → no envelope.
    expect(runtime.publishes.length).toBeGreaterThanOrEqual(1);
    const env = runtime.publishes.find(
      (e) => e.type === "system.access.disagreement",
    );
    expect(env).toBeDefined();
    expect(env?.type).toBe("system.access.disagreement");
    expect(env?.payload).toMatchObject({
      capability: "keyword.chat",
      legacy_decision: "allow",
      new_decision: "deny",
      new_reason: "unknown_principal",
      effective_decision: "deny",
    });
  });

  test("legacy deny + new allow: effective DENY + disagreement envelope (breakage direction)", () => {
    // Legacy denies (U999 is not in any role + defaultRole=denied).
    // New gate would grant chat (principal mike claims U999, role user
    // has keyword.chat). Effective: deny. Disagreement fires.
    const policy = makePolicy({
      principals: [
        {
          id: "mike",
          home_operator: "andreas",
          home_stack: "andreas/meta-factory",
          role: ["user"],
          trust: [],
          platform_ids: { discord: ["U999"] },
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
    const env = runtime.publishes.find(
      (e) => e.type === "system.access.disagreement",
    );
    expect(env).toBeDefined();
    expect(env?.payload).toMatchObject({
      capability: "keyword.chat",
      legacy_decision: "deny",
      new_decision: "allow",
      effective_decision: "deny",
    });
  });

  test("parallel_mode_enabled=true but no policyEngine wired: ERROR log + fall back to legacy-only", () => {
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    const runtime = makeRecordingRuntime();
    const adapter = makeAdapter({
      parallelModeEnabled: true,
      // policy: omitted — engine/lookup are undefined
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    const decision = adapter.resolveAccess(buildInboundMessage("U123"));
    // Legacy allowed → effective allow (graceful degradation).
    expect(decision.allowed).toBe(true);
    expect(decision.features.chat).toBe(true);
    // No disagreement envelope (engine never consulted).
    expect(runtime.publishes.length).toBe(0);
    // ERROR log fired (at most once across multiple calls).
    expect(errors.some((e) => e.includes("parallel_mode_enabled=true but policyEngine/policyLookup not wired"))).toBe(true);
    // Second call: same fallback, no second error.
    const errorsBefore = errors.length;
    adapter.resolveAccess(buildInboundMessage("U999"));
    expect(errors.length).toBe(errorsBefore);
  });

  test("disagreement envelope carries the §9.1 schema fields", () => {
    const policy = makePolicy({
      principals: [],
      roles: [],
    });
    const runtime = makeRecordingRuntime();
    const adapter = makeAdapter({
      parallelModeEnabled: true,
      policy,
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    adapter.resolveAccess(buildInboundMessage("U123"));
    const env = runtime.publishes.find(
      (e) => e.type === "system.access.disagreement",
    );
    expect(env).toBeDefined();
    // §9.1 mandated wire fields.
    expect(env?.payload).toMatchObject({
      principal_id: expect.any(String),
      capability: expect.any(String),
      legacy_decision: expect.stringMatching(/^(allow|deny)$/),
      legacy_reason: expect.any(String),
      new_decision: expect.stringMatching(/^(allow|deny)$/),
      new_reason: expect.any(String),
      effective_decision: expect.stringMatching(/^(allow|deny)$/),
    });
    // Sovereignty + envelope-correlation fields mirror sibling
    // `system.access.*` envelopes so dashboard renderers slot it in.
    expect(env?.payload).toHaveProperty("intent_sovereignty");
    expect(env?.payload).toHaveProperty("envelope_id");
    expect(env?.payload).toHaveProperty("envelope_subject");
    expect(env?.payload).toHaveProperty("signed_by");
  });

  test("unknown_principal envelope reason fires when no platform_ids match", () => {
    const policy = makePolicy({
      principals: [
        {
          id: "alice",
          home_operator: "andreas",
          home_stack: "andreas/meta-factory",
          role: ["user"],
          trust: [],
          platform_ids: { discord: ["U_ALICE"] }, // different from U123
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
    adapter.resolveAccess(buildInboundMessage("U123"));
    const env = runtime.publishes.find(
      (e) => e.type === "system.access.disagreement",
    );
    expect(env).toBeDefined();
    expect((env?.payload as { new_reason?: string }).new_reason).toBe("unknown_principal");
  });

  test("emitted disagreement envelope passes myelin schema validation", async () => {
    const policy = makePolicy({
      principals: [],
      roles: [],
    });
    const runtime = makeRecordingRuntime();
    const adapter = makeAdapter({
      parallelModeEnabled: true,
      policy,
      runtime,
      systemEventSource: { org: "metafactory", agent: "cortex", instance: "local" },
    });
    adapter.resolveAccess(buildInboundMessage("U123"));
    const env = runtime.publishes.find(
      (e) => e.type === "system.access.disagreement",
    );
    expect(env).toBeDefined();
    const { validateEnvelope } = await import("../../../bus/myelin/envelope-validator");
    const result = validateEnvelope(env);
    expect(result.ok).toBe(true);
  });
});
