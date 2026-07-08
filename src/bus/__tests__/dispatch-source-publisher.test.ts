/**
 * cortex#651 (F-1b) — dispatch-source publisher subject-derivation tests.
 *
 * F-1 (#629) wired the OUTBOUND (reply) leg per-principal; F-1b completes the
 * INBOUND (request) leg. The surface gateway serves MULTIPLE principals on one
 * shared bus, so a cross-principal binding's inbound request must be published
 * onto the BOUND stack's runner subscription
 * (`local.{bindingPrincipal}.{stack}.tasks.@{agent}.{cap}`), NOT the gateway
 * principal's subject.
 *
 * The publish SUBJECT principal is now derived from the OPT-IN
 * `subjectPrincipal` field, falling back to `source.principal` when absent.
 * These tests pin the four cases:
 *
 *   1. Gateway cross-principal — `subjectPrincipal` set, differs from source →
 *      subject uses the BINDING principal.
 *   2. Per-stack / same-principal — `subjectPrincipal` absent →
 *      subject uses `source.principal` (back-compat, byte-identical).
 *   3. Gap-4 — `subjectPrincipal` undefined → falls back to the gateway
 *      (source) principal.
 *   4. Same-principal gateway binding — `subjectPrincipal === source.principal`
 *      → subject unchanged.
 *
 * SECURITY-SENSITIVE: cross-principal routing. The publisher is SHARED with the
 * per-stack `dispatch-handler` path — the per-stack path NEVER sets
 * `subjectPrincipal`, so its subject derivation is unchanged. Anti-criterion:
 * the per-stack author metadata (`opts.principal = msg.authorName`) must NEVER
 * leak into the subject.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  publishInboundChatDispatchEnvelope,
  type InboundChatDispatchPublishOpts,
} from "../dispatch-source-publisher";
import type { InboundMessage } from "../../adapters/types";
import type { Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime } from "../myelin/runtime";
import type { SystemEventSource } from "../system-events";
import { PolicyEngine } from "../../common/policy/engine";

// =============================================================================
// Fixtures
// =============================================================================

/**
 * Policy engine that resolves the `(discord, <authorId>)` tuple used by these
 * tests to a registered principal DID, so the publish is not refused with
 * `invalid-originator`. Two principals are registered so the originator
 * resolution succeeds regardless of which one drives the subject.
 */
function makePolicyEngine(): PolicyEngine {
  return new PolicyEngine({
    principals: [
      {
        id: "andreas",
        home_principal: "andreas",
        home_stack: "andreas/research",
        role: ["operator"],
        trust: [],
        platform_ids: { discord: ["888888888888888888"] },
      },
      {
        id: "holly",
        home_principal: "holly",
        home_stack: "holly/research",
        role: ["operator"],
        trust: [],
        platform_ids: { discord: ["9999999999999999999"] },
      },
    ],
    roles: [{ id: "operator", capabilities: ["dispatch.luna"] }],
  });
}

interface RecordingRuntime extends MyelinRuntime {
  subjectPublishes: { envelope: Envelope; subject: string }[];
}

function makeRecordingRuntime(): RecordingRuntime {
  const subjectPublishes: { envelope: Envelope; subject: string }[] = [];
  return {
    enabled: true,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: async () => {},
    publishOnSubject: async (envelope: Envelope, subject: string) => {
      subjectPublishes.push({ envelope, subject });
    },
    stop: async () => {},
    subjectPublishes,
  };
}

/** Gateway dispatch-source identity — principal is the GATEWAY principal. */
const GATEWAY_SOURCE: SystemEventSource = {
  principal: "andreas",
  agent: "gateway",
  instance: "gateway-0",
  dataResidency: "NZ",
};

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "discord",
    instanceId: "discord:111222333",
    authorId: "888888888888888888",
    authorName: "TestUser",
    channelId: "channel-aaa",
    content: "Hello!",
    guildId: "111222333",
    attachments: [],
    timestamp: new Date("2026-06-03T00:00:00.000Z"),
    ...overrides,
  };
}

function baseOpts(
  runtime: MyelinRuntime,
  overrides: Partial<InboundChatDispatchPublishOpts> = {},
): InboundChatDispatchPublishOpts {
  return {
    runtime,
    source: GATEWAY_SOURCE,
    policyEngine: makePolicyEngine(),
    stack: "meta-factory",
    agentName: "luna",
    agentDisplayName: "luna",
    taskId: "11111111-1111-4111-8111-111111111111",
    msg: makeMsg(),
    prompt: "user prompt",
    resumeSessionId: undefined,
    allowedDirs: [],
    disallowedTools: [],
    allowedSkills: undefined,
    timeoutMs: undefined,
    cwd: undefined,
    additionalArgs: undefined,
    channel: undefined,
    network: undefined,
    project: undefined,
    entity: undefined,
    principal: undefined,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("dispatch-source-publisher — F-1b subject principal derivation (cortex#651)", () => {
  let originalError: typeof console.error;

  beforeEach(() => {
    originalError = console.error;
    console.error = () => {};
  });

  afterEach(() => {
    console.error = originalError;
  });

  // ── ISC-C1: gateway cross-principal → subject under BINDING principal ───────

  test("cross-principal: subjectPrincipal differing from source → subject uses BINDING principal", async () => {
    const runtime = makeRecordingRuntime();
    const result = await publishInboundChatDispatchEnvelope(
      baseOpts(runtime, {
        // gateway principal = andreas (source); binding principal = holly
        subjectPrincipal: "holly",
      }),
    );

    expect(result.published).toBe(true);
    expect(result.subject).toBe(
      "local.holly.meta-factory.tasks.@did-mf-luna.chat",
    );
    expect(runtime.subjectPublishes).toHaveLength(1);
    expect(runtime.subjectPublishes[0]?.subject).toBe(
      "local.holly.meta-factory.tasks.@did-mf-luna.chat",
    );
    // The subject must NOT be the gateway (source) principal.
    expect(result.subject).not.toContain("local.andreas.");
  });

  // ── ISC-C2 / ISC-A1: per-stack path (no subjectPrincipal) → source.principal

  test("per-stack: subjectPrincipal absent → subject uses source.principal (back-compat)", async () => {
    const runtime = makeRecordingRuntime();
    // Per-stack path passes `principal: msg.authorName` (payload metadata) and
    // NEVER sets subjectPrincipal. The author name must NOT leak into the subject.
    const result = await publishInboundChatDispatchEnvelope(
      baseOpts(runtime, {
        principal: "TestUser", // author metadata — payload only
        // subjectPrincipal intentionally omitted
      }),
    );

    expect(result.published).toBe(true);
    expect(result.subject).toBe(
      "local.andreas.meta-factory.tasks.@did-mf-luna.chat",
    );
    // ANTI: author metadata must not become the subject principal.
    expect(result.subject).not.toContain("local.TestUser.");
  });

  // ── ISC-C3: gap-4 → subjectPrincipal undefined → gateway-principal fallback ─

  test("gap-4: subjectPrincipal undefined → falls back to gateway (source) principal", async () => {
    const runtime = makeRecordingRuntime();
    const result = await publishInboundChatDispatchEnvelope(
      baseOpts(runtime, {
        subjectPrincipal: undefined, // gap-4 binding: no parsed principal
      }),
    );

    expect(result.published).toBe(true);
    expect(result.subject).toBe(
      "local.andreas.meta-factory.tasks.@did-mf-luna.chat",
    );
  });

  // ── ISC-C4: same-principal gateway binding → subject unchanged ──────────────

  test("same-principal: subjectPrincipal === source.principal → subject unchanged", async () => {
    const runtime = makeRecordingRuntime();
    const result = await publishInboundChatDispatchEnvelope(
      baseOpts(runtime, {
        subjectPrincipal: "andreas", // equals gateway principal
      }),
    );

    expect(result.published).toBe(true);
    expect(result.subject).toBe(
      "local.andreas.meta-factory.tasks.@did-mf-luna.chat",
    );
  });

  // ── Stackless cross-principal subject shape ────────────────────────────────

  test("cross-principal stackless: subject omits stack segment but uses binding principal", async () => {
    const runtime = makeRecordingRuntime();
    const result = await publishInboundChatDispatchEnvelope(
      baseOpts(runtime, {
        stack: undefined,
        subjectPrincipal: "holly",
      }),
    );

    expect(result.published).toBe(true);
    expect(result.subject).toBe("local.holly.tasks.@did-mf-luna.chat");
  });

  // ── cortex#710 — per-skill grant list rides the payload `allowed_skills` ────

  test("grants present → payload carries allowed_skills", async () => {
    const runtime = makeRecordingRuntime();
    await publishInboundChatDispatchEnvelope(
      baseOpts(runtime, { allowedSkills: ["code-review"] }),
    );
    const payload = runtime.subjectPublishes[0]!.envelope.payload;
    expect(payload.allowed_skills).toEqual(["code-review"]);
  });

  test("grants explicitly [] → payload carries the empty array (decided: no skills)", async () => {
    const runtime = makeRecordingRuntime();
    await publishInboundChatDispatchEnvelope(
      baseOpts(runtime, { allowedSkills: [] }),
    );
    const payload = runtime.subjectPublishes[0]!.envelope.payload;
    // Emitted even for [] so the runner distinguishes "no decision" (absent)
    // from "decided: no skills".
    expect(payload.allowed_skills).toEqual([]);
  });

  test("grants undefined → payload OMITS allowed_skills (no decision)", async () => {
    const runtime = makeRecordingRuntime();
    await publishInboundChatDispatchEnvelope(
      baseOpts(runtime, { allowedSkills: undefined }),
    );
    const payload = runtime.subjectPublishes[0]!.envelope.payload;
    expect("allowed_skills" in payload).toBe(false);
  });

  // ── GV-2 (cortex#1077) — channel/network label dual-write shim ──────────────

  test("GV-2: channel/network DUAL-WRITE both cortex_ (canonical) + grove_ (legacy)", async () => {
    const runtime = makeRecordingRuntime();
    await publishInboundChatDispatchEnvelope(
      baseOpts(runtime, { channel: "cortex", network: "metafactory" }),
    );
    const payload = runtime.subjectPublishes[0]!.envelope.payload;
    expect(payload.cortex_channel).toBe("cortex");
    expect(payload.grove_channel).toBe("cortex");
    expect(payload.cortex_network).toBe("metafactory");
    expect(payload.grove_network).toBe("metafactory");
  });

  test("GV-2: channel/network omitted → neither cortex_ nor grove_ field emitted", async () => {
    const runtime = makeRecordingRuntime();
    await publishInboundChatDispatchEnvelope(
      baseOpts(runtime, { channel: undefined, network: undefined }),
    );
    const payload = runtime.subjectPublishes[0]!.envelope.payload;
    expect("cortex_channel" in payload).toBe(false);
    expect("grove_channel" in payload).toBe(false);
    expect("cortex_network" in payload).toBe(false);
    expect("grove_network" in payload).toBe(false);
  });
});
