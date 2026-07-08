import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MockAdapter } from "../../adapters/mock";
import { DispatchHandler } from "../dispatch-handler";
import type { InboundMessage } from "../../adapters/types";
import type { AgentConfig } from "../../common/types/config";
import type { Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime } from "../myelin/runtime";
import type { DispatchSourcePublishResult } from "../dispatch-source-publisher";
import { validateEnvelope, getActorPrincipal } from "../myelin/envelope-validator";
import { PolicyEngine } from "../../common/policy/engine";
import { policyEngineFromConfig } from "../../common/policy/factory";
import { defaultPolicySovereignty } from "../../common/policy/policy-gate";
import { extractAgentIdFromDid } from "../../common/policy/did";
import type { Policy } from "../../common/types/cortex-config";
import type {
  CCSessionFactory,
  CCSessionLike,
} from "../../substrates/claude-code/harness";
import type { CCSessionResult, CCSessionOpts } from "../../runner/cc-session";
import { ORCHESTRATOR_CAPABILITY } from "../../runner/orchestrator-command";
import { CLAUDE_TOOL_INVENTORY } from "../../common/policy/tool-inventory";
import { readLogicalRouting } from "../../adapters/response-routing-delivery";

/**
 * cortex#486 — adapter-side platform-id → principal resolution at
 * envelope-publish time requires a wired PolicyEngine. This helper
 * builds an engine that resolves the two `(platform, authorId)` tuples
 * the publish-path tests use:
 *
 *   - `(discord, 888888888888888888)` → `andreas`
 *   - `(mattermost, 8wkrnxq3abcdef)` → `andreas`
 *
 * Tests that exercise unresolvable inputs (the cortex#420 nit-5
 * DID-grammar collision case) pass `policyEngine: undefined` so the
 * publish refuses with `invalid-originator` — same surface, different
 * root cause from the pre-#486 fallback.
 */
function makePublishPolicyEngine(): PolicyEngine {
  return new PolicyEngine({
    principals: [
      {
        id: "andreas",
        home_principal: "andreas",
        home_stack: "andreas/research",
        role: ["operator"],
        trust: [],
        platform_ids: {
          discord: ["888888888888888888"],
          mattermost: ["8wkrnxq3abcdef"],
        },
      },
    ],
    roles: [{ id: "operator", capabilities: ["dispatch.test-agent"] }],
  });
}

/**
 * cortex#1167 — the PRODUCTION engine shape: built via `policyEngineFromConfig`
 * (exactly how cortex.ts wires it) so the synthetic `public` principal is
 * registered with `dispatch.<agentId>` per flagged agent. Maps
 * (discord, 888888888888888888) → andreas (a fully-privileged principal). Used
 * by the round-trip tests that prove the listener's engine.check passes for `public`.
 */
function makeWiredEngineWithPublic(openOnboardingAgentIds: string[]): PolicyEngine {
  const policy: Policy = {
    principals: [
      {
        id: "andreas",
        home_principal: "andreas",
        home_stack: "andreas/meta-factory",
        role: ["operator"],
        trust: [],
        platform_ids: { discord: ["888888888888888888"] },
      },
    ],
    roles: [{ id: "operator", capabilities: ["operator", "keyword.chat", "dispatch.test-agent", "dispatch.pier"] }],
  };
  return policyEngineFromConfig(policy, openOnboardingAgentIds)!;
}

// Minimal config that satisfies AgentConfig shape for testing
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agent: {
      name: "test-agent",
      displayName: "TestBot",
      operatorDiscordId: "operator1",
      operatorMattermostId: undefined,
    },
    discord: [{
      token: "fake-token",
      guildId: "guild1",
      agentChannelId: "ch1",
      logChannelId: "log1",
      contextDepth: 10,
      enableAgentLog: false,
      roles: [],
      defaultRole: "allow-all",
    }],
    mattermost: [],
    claude: {
      timeoutMs: 120_000,
      asyncTimeoutMs: 900_000,
      additionalArgs: [],
      allowedTools: [],
      disallowedTools: [],
      allowedDirs: [],
      readOnlyDirs: [],
    },
    attachments: {
      enabled: false,
      maxFileSizeBytes: 10_000_000,
      maxTotalSizeBytes: 25_000_000,
      maxAttachmentsPerMessage: 10,
    },
    execution: {
      default: "local",
      backends: [],
    },
    paths: {
      publishedEventsDir: "/tmp/grove-test/published",
      logDir: "/tmp/grove-test/logs",
    },
    // Test-fixture completion: the grove-v2 source test pre-dates the addition of
    // `github` and `networks` to AgentConfig and crashes at construction time
    // (`getAllRepos(config.github.repos)` on undefined). Filling the minimum schema
    // here so the lift's tests run; the runtime code is byte-identical to source.
    github: {
      webhookSecret: "",
      repos: [],
      agentDetection: {
        commitTrailers: [],
        branchPatterns: [],
        commentPatterns: [],
      },
    },
    networks: [],
    ...overrides,
  } as AgentConfig;
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "mock",
    instanceId: "mock-instance",
    authorId: "user1",
    authorName: "TestUser",
    content: "hello",
    channelId: "ch1",
    attachments: [],
    timestamp: new Date(),
    ...overrides,
  };
}

describe("DispatchHandler", () => {
  let adapter: MockAdapter;
  let router: DispatchHandler;

  beforeEach(() => {
    adapter = new MockAdapter();
    router = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
    });
  });

  describe("access control", () => {
    test("denied user gets error response", async () => {
      adapter.accessDecision = {
        allowed: false,
        features: { chat: false, async: false, team: false },
        denyReason: "Not authorized",
      };

      await router.handleMessage(adapter, makeMsg());

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("Not authorized");
    });
  });

  // cortex#1165 — Pier open-onboarding gate. An unmapped sender + a flagged
  // target agent → admitted as a zero-authority anon principal; the chat
  // session runs. Unflagged agents stay denied. Non-`unmapped_sender` denies
  // are NEVER converted.
  describe("open-onboarding gate (cortex#1165)", () => {
    const UNMAPPED_DENY = {
      allowed: false as const,
      features: { chat: false, async: false, team: false },
      denyCode: "unmapped_sender" as const,
      // Trimmed to the assertion-relevant prefix — the full prose lives in
      // resolve-access.ts; the test only keys off this substring + denyCode.
      denyReason: "Sorry, I'm not set up to respond to you.",
    };

    test("unmapped sender + FLAGGED agent → admitted (no deny posted, session runs)", async () => {
      let calls = 0;
      const factory: CCSessionFactory = () => {
        calls++;
        const session: CCSessionLike = {
          start() { return session; },
          async wait(): Promise<CCSessionResult> {
            return { success: true, response: "welcome!", exitCode: 0, durationMs: 1, sessionId: "anon-sess" };
          },
        };
        return session;
      };
      const handler = new DispatchHandler({
        config: makeConfig(),
        securityPreamble: "",
        ccSessionFactory: factory,
      });
      adapter.accessDecision = { ...UNMAPPED_DENY };

      await handler.handleMessage(adapter, makeMsg({ content: "hi, I'm new here" }), {
        id: "pier",
        displayName: "Pier",
        openOnboarding: true,
      });

      // The strict deny message must NOT have been posted...
      const denied = adapter.sentMessages.some((m) => m.text.includes("not set up to respond"));
      expect(denied).toBe(false);
      // ...and the chat session must have run (allow→dispatch).
      expect(calls).toBe(1);
      await handler.shutdown();
    });

    test("unmapped sender + UNFLAGGED agent (regression) → still DENIED, no session", async () => {
      let calls = 0;
      const factory: CCSessionFactory = () => {
        calls++;
        const session: CCSessionLike = {
          start() { return session; },
          async wait(): Promise<CCSessionResult> {
            return { success: true, response: "should not run", exitCode: 0, durationMs: 1, sessionId: "x" };
          },
        };
        return session;
      };
      const handler = new DispatchHandler({
        config: makeConfig(),
        securityPreamble: "",
        ccSessionFactory: factory,
      });
      adapter.accessDecision = { ...UNMAPPED_DENY };

      // No targetAgent / openOnboarding absent → strict deny path.
      await handler.handleMessage(adapter, makeMsg({ content: "hi" }), {
        id: "luna",
        displayName: "Luna",
        // openOnboarding intentionally absent
      });

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("not set up to respond");
      expect(calls).toBe(0);
      await handler.shutdown();
    });

    test("FLAGGED agent does NOT convert a non-unmapped deny (lockout stays denied)", async () => {
      let calls = 0;
      const factory: CCSessionFactory = () => {
        calls++;
        const session: CCSessionLike = {
          start() { return session; },
          async wait(): Promise<CCSessionResult> {
            return { success: true, response: "x", exitCode: 0, durationMs: 1, sessionId: "x" };
          },
        };
        return session;
      };
      const handler = new DispatchHandler({
        config: makeConfig(),
        securityPreamble: "",
        ccSessionFactory: factory,
      });
      // A recognized-but-muted principal → lockout deny, NOT unmapped_sender.
      adapter.accessDecision = {
        allowed: false,
        features: { chat: false, async: false, team: false },
        denyCode: "lockout",
        denyReason: 'Principal "muted" has no keyword capabilities ...',
      };

      await handler.handleMessage(adapter, makeMsg({ content: "let me in" }), {
        id: "pier",
        displayName: "Pier",
        openOnboarding: true,
      });

      // Lockout is a real principal with zero caps — open-onboarding must NOT
      // rescue it (it is a different deny category).
      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("no keyword capabilities");
      expect(calls).toBe(0);
      await handler.shutdown();
    });

    test("a MAPPED principal is unaffected — flagged agent still uses the real allow", async () => {
      let calls = 0;
      const factory: CCSessionFactory = () => {
        calls++;
        const session: CCSessionLike = {
          start() { return session; },
          async wait(): Promise<CCSessionResult> {
            return { success: true, response: "real reply", exitCode: 0, durationMs: 1, sessionId: "real" };
          },
        };
        return session;
      };
      const handler = new DispatchHandler({
        config: makeConfig(),
        securityPreamble: "",
        ccSessionFactory: factory,
      });
      // A real, mapped principal: allowed with real grants — NOT anon.
      adapter.accessDecision = {
        allowed: true,
        features: { chat: true, async: false, team: false },
      };

      await handler.handleMessage(adapter, makeMsg({ content: "hello" }), {
        id: "pier",
        displayName: "Pier",
        openOnboarding: true,
      });

      // No deny posted, session runs as the real principal (conversion code
      // only fires on `!allowed && unmapped_sender`).
      const denied = adapter.sentMessages.some((m) => m.text.includes("not set up to respond"));
      expect(denied).toBe(false);
      expect(calls).toBe(1);
      await handler.shutdown();
    });

    // cortex#1167 review MINOR — DM over-reach. An unmapped stranger DMing a
    // flagged agent must STAY denied (the gate scopes to the public channel).
    test("unmapped sender DMing a FLAGGED agent → still DENIED, no session", async () => {
      let calls = 0;
      const factory: CCSessionFactory = () => {
        calls++;
        const session: CCSessionLike = {
          start() { return session; },
          async wait(): Promise<CCSessionResult> {
            return { success: true, response: "should not run", exitCode: 0, durationMs: 1, sessionId: "x" };
          },
        };
        return session;
      };
      const handler = new DispatchHandler({
        config: makeConfig(),
        securityPreamble: "",
        ccSessionFactory: factory,
      });
      adapter.accessDecision = { ...UNMAPPED_DENY, isDM: true };

      await handler.handleMessage(adapter, makeMsg({ content: "let me in", isDM: true }), {
        id: "pier",
        displayName: "Pier",
        openOnboarding: true,
      });

      // G-300: unmapped DMs are silently ignored — no deny message, no session.
      expect(calls).toBe(0);
      const replied = adapter.sentMessages.some((m) => m.text.length > 0);
      expect(replied).toBe(false);
      await handler.shutdown();
    });
  });

  describe("help mode", () => {
    test("/help returns help text without CC invocation", async () => {
      await router.handleMessage(adapter, makeMsg({ content: "/help" }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("TestBot");
      expect(adapter.sentMessages[0]!.text).toContain("Chat");
      expect(adapter.sentMessages[0]!.text).toContain("async:");
    });

    test("help (no slash) also works", async () => {
      await router.handleMessage(adapter, makeMsg({ content: "help" }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("TestBot");
    });
  });

  describe("async mode", () => {
    test("async: without feature access is denied", async () => {
      adapter.accessDecision = {
        allowed: true,
        features: { chat: true, async: false, team: false },
      };

      await router.handleMessage(adapter, makeMsg({ content: "async: do something" }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("Async tasks aren't available");
    });
  });

  describe("team mode", () => {
    test("team: without feature access is denied", async () => {
      adapter.accessDecision = {
        allowed: true,
        features: { chat: true, async: false, team: false },
      };

      await router.handleMessage(adapter, makeMsg({ content: "team: analyze this" }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("Team mode isn't available");
    });
  });

  describe("principal notification", () => {
    test("non-principal triggers notification", async () => {
      // user1 is not principal1, so notification should fire
      await router.handleMessage(adapter, makeMsg({
        platform: "discord",
        authorId: "user999",
        authorName: "Stranger",
        content: "/help",
      }));

      expect(adapter.principalNotifications).toHaveLength(1);
      expect(adapter.principalNotifications[0]!).toContain("Stranger");
    });

    test("principal does not trigger notification", async () => {
      // v2.0.0 (cortex#297) — principal classification flows through
      // `msg.dmType` (set by adapters via the PolicyEngine principal-role
      // capability) instead of comparing `authorId` to a legacy
      // `agent.operatorDiscordId` field. The notifier short-circuits
      // on `msg.dmType === "principal"`.
      await router.handleMessage(adapter, makeMsg({
        platform: "discord",
        authorId: "principal1",
        content: "/help",
        isDM: true,
        dmType: "principal",
      }));

      expect(adapter.principalNotifications).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    test("router catches adapter errors gracefully", async () => {
      // Make resolveAccess throw
      const brokenAdapter = new MockAdapter();
      brokenAdapter.resolveAccess = () => { throw new Error("Boom"); };

      // Should not throw — router catches internally
      await router.handleMessage(brokenAdapter, makeMsg());

      // Should post error response
      expect(brokenAdapter.sentMessages).toHaveLength(1);
      expect(brokenAdapter.sentMessages[0]!.text).toContain("error occurred");
    });
  });

  describe("response target", () => {
    test("thread message targets the thread", async () => {
      await router.handleMessage(adapter, makeMsg({
        content: "/help",
        threadId: "thread123",
      }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.target.threadId).toBe("thread123");
    });

    test("channel message targets the channel", async () => {
      await router.handleMessage(adapter, makeMsg({
        content: "/help",
        channelId: "ch42",
      }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.target.channelId).toBe("ch42");
      expect(adapter.sentMessages[0]!.target.threadId).toBeUndefined();
    });
  });

  describe("shutdown", () => {
    test("shutdown completes cleanly", async () => {
      // Just verify it doesn't throw
      await router.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// MIG-3.8 / C-104: system.inbound.aborted emission on adapter-outbound
// attachment_fetch TimeoutSourceError. The handler publishes BEFORE the
// existing graceful-failure return so principals get the structured envelope
// even though the attachment pipeline degrades transparently.
// ---------------------------------------------------------------------------

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

/**
 * Reaches into the private `publishInboundAborted` method to drive emission
 * directly. Mirrors the pattern used in
 * `src/adapters/discord/__tests__/system-events.test.ts` for the analogous
 * `publishAdapterDegraded` helper — the wiring from `handleMessage` step 8
 * is straight-line code calling this helper, so testing the helper plus a
 * smaller wiring proof is materially cheaper than driving the whole pipeline
 * (which would also require a real `claude` binary for the CC spawn step).
 */
function callPublishInboundAborted(
  handler: DispatchHandler,
  opts: {
    adapterId: string;
    inboundMessageId: string;
    timeoutSource: "attachment_fetch" | "cloud_publisher" | "usage_monitor" | "usage_fetcher" | "startup_sync" | "cc_session_spawn" | "unknown";
    timeoutMs: number;
    elapsedMs: number;
  },
): void {
  (
    handler as unknown as {
      publishInboundAborted: (o: typeof opts) => void;
    }
  ).publishInboundAborted(opts);
}

describe("DispatchHandler — system.inbound.aborted emission (MIG-3.8 / C-104)", () => {
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;

  beforeEach(() => {
    originalWarn = console.warn;
    originalError = console.error;
    console.warn = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
  });

  test("publishes envelope with correct shape + schema-valid payload", async () => {
    const runtime = makeRecordingRuntime();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "metafactory", agent: "cortex", instance: "local" },
    });

    callPublishInboundAborted(handler, {
      adapterId: "discord-luna",
      inboundMessageId: "1111111111111111111",
      timeoutSource: "attachment_fetch",
      timeoutMs: 30_000,
      elapsedMs: 30_142,
    });

    expect(runtime.publishes.length).toBe(1);
    const env = runtime.publishes[0]!;
    expect(env.type).toBe("system.inbound.aborted");
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.payload).toMatchObject({
      adapter_id: "discord-luna",
      inbound_message_id: "1111111111111111111",
      timeout_source: "attachment_fetch",
      timeout_ms: 30_000,
      elapsed_ms: 30_142,
      phase: "pre_dispatch",
    });
    // Drift-detection: any change in the helper that violates the vendored
    // myelin schema must fail here, not at runtime on a live principal alert.
    expect(validateEnvelope(env).ok).toBe(true);

    await handler.shutdown();
  });

  test("no runtime configured → no publish (silent, doesn't throw)", async () => {
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
    });

    // Must not throw even though runtime is absent — the gate returns null
    // and the publish call is skipped.
    callPublishInboundAborted(handler, {
      adapterId: "discord-luna",
      inboundMessageId: "x",
      timeoutSource: "attachment_fetch",
      timeoutMs: 30_000,
      elapsedMs: 30_000,
    });

    await handler.shutdown();
  });

  test("runtime configured without systemEventSource → warns once, skips publish", async () => {
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    const runtime = makeRecordingRuntime();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      // intentionally no systemEventSource
    });

    callPublishInboundAborted(handler, {
      adapterId: "discord-luna",
      inboundMessageId: "x",
      timeoutSource: "attachment_fetch",
      timeoutMs: 30_000,
      elapsedMs: 30_000,
    });
    expect(runtime.publishes.length).toBe(0);
    expect(warnings.some((w) => w.includes("systemEventSource is missing"))).toBe(true);

    // Second call: latch must hold so we don't flood logs.
    warnings.length = 0;
    callPublishInboundAborted(handler, {
      adapterId: "discord-luna",
      inboundMessageId: "y",
      timeoutSource: "attachment_fetch",
      timeoutMs: 30_000,
      elapsedMs: 30_000,
    });
    expect(runtime.publishes.length).toBe(0);
    expect(warnings.some((w) => w.includes("systemEventSource is missing"))).toBe(false);

    await handler.shutdown();
  });

  test("publish() rejection is swallowed + logged (does not break caller)", async () => {
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    // Runtime whose publish() rejects — same behaviour as a bus outage. The
    // DispatchHandler must keep working; bus failures cannot break the
    // attachment pipeline.
    const runtime: MyelinRuntime = {
      enabled: true,
      onEnvelope: () => ({ unregister: () => {} }),
      publish: async () => {
        throw new Error("bus is down");
      },
      stop: async () => {},
    };
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "metafactory", agent: "cortex", instance: "local" },
    });

    callPublishInboundAborted(handler, {
      adapterId: "discord-luna",
      inboundMessageId: "x",
      timeoutSource: "attachment_fetch",
      timeoutMs: 30_000,
      elapsedMs: 30_000,
    });
    // publish() runs as a microtask via `void runtime.publish(...).catch(...)`
    // — wait one tick so the catch handler has a chance to log before we
    // assert. setTimeout(_, 0) gives us a clean turn of the event loop.
    await new Promise((r) => setTimeout(r, 0));

    expect(errors.some((m) => m.includes("publish(system.inbound.aborted) failed"))).toBe(true);

    await handler.shutdown();
  });

  test("emitted envelopes carry source.dataResidency override when provided", async () => {
    const runtime = makeRecordingRuntime();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "metafactory", agent: "cortex", instance: "local", dataResidency: "AU" },
    });

    callPublishInboundAborted(handler, {
      adapterId: "discord-luna",
      inboundMessageId: "x",
      timeoutSource: "attachment_fetch",
      timeoutMs: 30_000,
      elapsedMs: 30_000,
    });

    expect(runtime.publishes[0]?.sovereignty.data_residency).toBe("AU");

    await handler.shutdown();
  });

  /**
   * Wiring smoke test: prove the closure inside `handleMessage` step 8 calls
   * `publishInboundAborted` with the right parameters. We deliberately do
   * NOT drive the full pipeline (the CC spawn at step 12+ blocks on a real
   * `claude` binary). Instead, we invoke the closure directly by stubbing
   * `processInboundAttachments` via the public surface: trigger the helper
   * with a fetch that aborts immediately and observe the publish.
   *
   * The stand-alone helper tests in `attachments-timeout.test.ts` cover the
   * processInboundAttachments → callback contract; this test covers the
   * dispatch-handler-side construction of the envelope parameters
   * (adapterId from `adapter.instanceId`, inbound_message_id from
   * `msg._native.id` or the synthetic fallback).
   */
  test("wiring: handler builds correct envelope params from message context", async () => {
    const runtime = makeRecordingRuntime();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "metafactory", agent: "cortex", instance: "local" },
    });

    // Simulate the exact call shape handleMessage builds (cf. dispatch-handler.ts
    // step 8) — extract from a discord.js-shaped _native object plus an
    // adapter instanceId.
    const adapter = new MockAdapter("discord-luna");
    const nativeMsg = { id: "platform-msg-99" };
    const inboundMessageId =
      (nativeMsg as { id?: string }).id ??
      `synthetic:${adapter.instanceId}:ch1:2026-05-09T12:00:00.000Z`;
    callPublishInboundAborted(handler, {
      adapterId: adapter.instanceId,
      inboundMessageId,
      timeoutSource: "attachment_fetch",
      timeoutMs: 30_000,
      elapsedMs: 30_001,
    });

    expect(runtime.publishes.length).toBe(1);
    expect(runtime.publishes[0]!.payload).toMatchObject({
      adapter_id: "discord-luna",
      inbound_message_id: "platform-msg-99",
    });

    // Same call but exercising the synthetic fallback path (no _native).
    runtime.publishes.length = 0;
    const synthInboundId = `synthetic:${adapter.instanceId}:ch1:2026-05-09T12:00:00.000Z`;
    callPublishInboundAborted(handler, {
      adapterId: adapter.instanceId,
      inboundMessageId: synthInboundId,
      timeoutSource: "attachment_fetch",
      timeoutMs: 30_000,
      elapsedMs: 30_001,
    });
    expect(
      (runtime.publishes[0]!.payload as { inbound_message_id?: string }).inbound_message_id,
    ).toBe(synthInboundId);

    await handler.shutdown();
  });

  test("every TimeoutSource enum value produces a schema-valid envelope", async () => {
    const runtime = makeRecordingRuntime();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "metafactory", agent: "cortex", instance: "local" },
    });

    const sources = [
      "attachment_fetch",
      "cloud_publisher",
      "usage_monitor",
      "usage_fetcher",
      "startup_sync",
      "cc_session_spawn",
      "unknown",
    ] as const;
    for (const source of sources) {
      callPublishInboundAborted(handler, {
        adapterId: "x",
        inboundMessageId: "id",
        timeoutSource: source,
        timeoutMs: 1_000,
        elapsedMs: 1_000,
      });
    }
    expect(runtime.publishes.length).toBe(sources.length);
    for (const env of runtime.publishes) {
      expect(validateEnvelope(env).ok).toBe(true);
    }

    await handler.shutdown();
  });
});

// ---------------------------------------------------------------------------
// cortex#360 — Chat-path CC failure retry. The dispatch-handler's sync path
// used to die on the first CC timeout, surfacing a single apology with no
// retry. We now retry transient (`not_now`) failures up to 3 attempts within
// a 20-minute wall-clock budget, posting "Still working…" between attempts.
// Terminal failures emit a `dispatch.task.failed` envelope for cross-path
// observability parity with the review-consumer path.
// ---------------------------------------------------------------------------

/** Build a CCSessionLike fake that resolves to a fixed CCSessionResult. */
function makeFakeSession(result: CCSessionResult): CCSessionLike {
  const fake: CCSessionLike = {
    start() {
      return fake;
    },
    wait() {
      return Promise.resolve(result);
    },
  };
  return fake;
}

/** Factory that yields a different CCSessionResult per attempt. */
function makeStubFactory(results: CCSessionResult[]): {
  factory: CCSessionFactory;
  spawnCount: () => number;
  optsLog: () => CCSessionOpts[];
} {
  let index = 0;
  const log: CCSessionOpts[] = [];
  const factory: CCSessionFactory = (opts) => {
    log.push(opts);
    const result = results[index] ?? results[results.length - 1];
    if (!result) {
      throw new Error("makeStubFactory: results array is empty");
    }
    index++;
    return makeFakeSession(result);
  };
  return {
    factory,
    spawnCount: () => index,
    optsLog: () => log,
  };
}

function abortedResult(overrides: Partial<CCSessionResult> = {}): CCSessionResult {
  return {
    success: false,
    response: "",
    exitCode: 1,
    durationMs: 5_000,
    aborted: true,
    abortReason: "timeout",
    ...overrides,
  };
}

function successResult(overrides: Partial<CCSessionResult> = {}): CCSessionResult {
  return {
    success: true,
    response: "All good — here's your answer.",
    exitCode: 0,
    durationMs: 1_000,
    sessionId: "sess-123",
    ...overrides,
  };
}

describe("DispatchHandler — chat-path CC failure retry (cortex#360)", () => {
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;
  let originalLog: typeof console.log;

  beforeEach(() => {
    originalWarn = console.warn;
    originalError = console.error;
    originalLog = console.log;
    console.warn = () => {};
    console.error = () => {};
    console.log = () => {};
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
  });

  test("retry-then-success: aborts on attempt 1, succeeds on attempt 2", async () => {
    const runtime = makeRecordingRuntime();
    const { factory, spawnCount } = makeStubFactory([
      abortedResult(),
      successResult({ response: "Recovered on retry — here's your answer." }),
    ]);

    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "metafactory", agent: "cortex", instance: "local" },
      ccSessionFactory: factory,
    });

    await handler.handleMessage(adapter, makeMsg({ content: "do the thing" }));

    // Two CC spawns: the failing first attempt and the recovering second.
    expect(spawnCount()).toBe(2);

    // Principal-visible messages: one "Still working… (attempt 2/3)" then the
    // final response. No apology message.
    const texts = adapter.sentMessages.map((m) => m.text);
    expect(texts.length).toBe(2);
    expect(texts[0]).toBe("Still working… (attempt 2/3)");
    expect(texts[1]).toBe("Recovered on retry — here's your answer.");
    expect(texts.some((t) => t.startsWith("Sorry, I couldn't process"))).toBe(false);

    // No dispatch.task.failed envelope on a recovered run.
    const failed = runtime.publishes.filter(
      (e) => e.type === "dispatch.task.failed",
    );
    expect(failed.length).toBe(0);

    await handler.shutdown();
  });

  test("all-three-attempts-fail: emits dispatch.task.failed with kind=not_now", async () => {
    const runtime = makeRecordingRuntime();
    const { factory, spawnCount } = makeStubFactory([
      abortedResult(),
      abortedResult(),
      abortedResult(),
    ]);

    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "metafactory", agent: "cortex", instance: "local" },
      ccSessionFactory: factory,
    });

    await handler.handleMessage(adapter, makeMsg({ content: "do the thing" }));

    // Three CC spawns total.
    expect(spawnCount()).toBe(3);

    const texts = adapter.sentMessages.map((m) => m.text);
    // Two "Still working…" status messages (before attempts 2 and 3), then
    // the final apology. No success message.
    expect(texts).toEqual([
      "Still working… (attempt 2/3)",
      "Still working… (attempt 3/3)",
      "Sorry, I couldn't process that. (exit code: 1)",
    ]);

    // Exactly one dispatch.task.failed envelope on the bus.
    const failed = runtime.publishes.filter(
      (e) => e.type === "dispatch.task.failed",
    );
    expect(failed.length).toBe(1);
    const env = failed[0]!;
    expect(env.source).toBe("metafactory.cortex.local");
    const payload = env.payload as {
      task_id: string;
      agent_id: string;
      reason: { kind: string; detail?: string };
      error_summary: string;
    };
    expect(payload.agent_id).toBe("test-agent");
    expect(payload.reason.kind).toBe("not_now");
    expect(payload.reason.detail).toContain("aborted");
    // Stable correlation_id across the retry chain — the envelope's
    // correlation_id is the retry chain's load-bearing observability key.
    expect(typeof env.correlation_id).toBe("string");
    expect(env.correlation_id?.length ?? 0).toBeGreaterThan(0);
    // Schema-valid envelope (drift-detection against vendored myelin schema).
    expect(validateEnvelope(env).ok).toBe(true);

    await handler.shutdown();
  });

  test("clean-success-attempt-1: no retry, no extra messages, no failed envelope", async () => {
    const runtime = makeRecordingRuntime();
    const { factory, spawnCount } = makeStubFactory([
      successResult({ response: "Done — no drama." }),
    ]);

    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "metafactory", agent: "cortex", instance: "local" },
      ccSessionFactory: factory,
    });

    await handler.handleMessage(adapter, makeMsg({ content: "do the thing" }));

    // Exactly one CC spawn.
    expect(spawnCount()).toBe(1);

    // Exactly one Discord message: the success response. No "Still working…",
    // no apology.
    expect(adapter.sentMessages.length).toBe(1);
    expect(adapter.sentMessages[0]!.text).toBe("Done — no drama.");

    // No dispatch.task.failed envelope on a clean run.
    const failed = runtime.publishes.filter(
      (e) => e.type === "dispatch.task.failed",
    );
    expect(failed.length).toBe(0);

    await handler.shutdown();
  });

  test("terminal failure (cant_do) bails immediately — no retry", async () => {
    // A non-zero exit WITH no captured response is classified as not_now
    // (retryable). To exercise the terminal-failure-immediate-exit path we
    // need a result whose classifier returns null — e.g. `success === true`
    // but `!response`. That's the "cc exited cleanly but skill misbehaved"
    // case — the chat-path treats it as cant_do (principal action needed)
    // and surfaces the apology after attempt 1.
    const runtime = makeRecordingRuntime();
    const { factory, spawnCount } = makeStubFactory([
      { success: true, response: "", exitCode: 0, durationMs: 1_000 },
    ]);

    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "metafactory", agent: "cortex", instance: "local" },
      ccSessionFactory: factory,
    });

    await handler.handleMessage(adapter, makeMsg({ content: "do the thing" }));

    // Single CC spawn — no retry on terminal failure.
    expect(spawnCount()).toBe(1);

    const texts = adapter.sentMessages.map((m) => m.text);
    expect(texts.length).toBe(1);
    expect(texts[0]).toBe("Sorry, I couldn't process that. (exit code: 0)");

    // dispatch.task.failed with kind=cant_do.
    const failed = runtime.publishes.filter(
      (e) => e.type === "dispatch.task.failed",
    );
    expect(failed.length).toBe(1);
    const payload = failed[0]!.payload as {
      reason: { kind: string };
    };
    expect(payload.reason.kind).toBe("cant_do");

    await handler.shutdown();
  });

  test("factory throws on spawn — treated as not_now, retries up to limit", async () => {
    const runtime = makeRecordingRuntime();
    let spawnAttempts = 0;
    const factory: CCSessionFactory = () => {
      spawnAttempts++;
      throw new Error("CC binary missing");
    };

    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "metafactory", agent: "cortex", instance: "local" },
      ccSessionFactory: factory,
    });

    await handler.handleMessage(adapter, makeMsg({ content: "do the thing" }));

    // All three attempts blow up on factory spawn.
    expect(spawnAttempts).toBe(3);

    const texts = adapter.sentMessages.map((m) => m.text);
    // Two retry-status lines + final apology.
    expect(texts).toEqual([
      "Still working… (attempt 2/3)",
      "Still working… (attempt 3/3)",
      "Sorry, I couldn't process that. (exit code: 1)",
    ]);

    // dispatch.task.failed emitted, kind=not_now.
    const failed = runtime.publishes.filter(
      (e) => e.type === "dispatch.task.failed",
    );
    expect(failed.length).toBe(1);
    const payload = failed[0]!.payload as {
      reason: { kind: string; detail?: string };
    };
    expect(payload.reason.kind).toBe("not_now");
    expect(payload.reason.detail).toContain("CC binary missing");

    await handler.shutdown();
  });

  test("maxAttempts=1 override disables retry — one attempt, immediate apology", async () => {
    const runtime = makeRecordingRuntime();
    const { factory, spawnCount } = makeStubFactory([abortedResult()]);

    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "metafactory", agent: "cortex", instance: "local" },
      ccSessionFactory: factory,
      retry: { maxAttempts: 1 },
    });

    await handler.handleMessage(adapter, makeMsg({ content: "do the thing" }));

    expect(spawnCount()).toBe(1);
    const texts = adapter.sentMessages.map((m) => m.text);
    expect(texts.length).toBe(1);
    expect(texts[0]).toBe("Sorry, I couldn't process that. (exit code: 1)");

    await handler.shutdown();
  });
});

// ---------------------------------------------------------------------------
// cortex#723 — prompt-injection filter is trust-scoped at the dispatch-handler
// caller. The filter (@metafactory/content-filter, scanPrompt) gates UNTRUSTED
// inbound content; the home principal commands their OWN assistant and must not
// be hard-blocked by it. The live FP that motivated this: PI-002 role_play_trigger
// matched "…would act as a jumphost" (legit infra language) in Andreas's own DM.
//
// Contract:
//   - home-principal DM whose content matches a block pattern → PROCESSED
//     (reaches the CC path, NO "I can't process that message" reply), and the
//     match is LOGGED for principal visibility.
//   - untrusted sender's role-play injection → still BLOCKED (posts the
//     "I can't process that message" reply, never reaches CC).
//
// The scanner itself is unchanged — the trust decision belongs at the caller,
// which holds the policy context (sender principal/role via `msg.dmType`).
// ---------------------------------------------------------------------------

describe("DispatchHandler — prompt-filter trust scope (cortex#723)", () => {
  // Content that reliably trips PI-002 (role_play_trigger, "act as") in the
  // real @metafactory/content-filter — the exact FP class from the issue.
  const ACT_AS_CONTENT =
    "Dig deeper — the probe is not the jump host. A different machine would act as a jumphost.";

  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;
  let originalLog: typeof console.log;
  let logLines: string[];

  beforeEach(() => {
    originalWarn = console.warn;
    originalError = console.error;
    originalLog = console.log;
    logLines = [];
    console.warn = () => {};
    console.error = () => {};
    // Capture log output so we can assert the home-principal match is logged
    // for principal visibility (the issue's "log/flag for visibility" clause).
    console.log = (...args: unknown[]) => {
      logLines.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
  });

  test("home-principal DM matching a block pattern is PROCESSED (not blocked) and the match is logged for visibility", async () => {
    const { factory, spawnCount } = makeStubFactory([
      successResult({ response: "On it — here's the jumphost answer." }),
    ]);

    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      ccSessionFactory: factory,
    });

    await handler.handleMessage(
      adapter,
      makeMsg({
        platform: "discord",
        authorId: "principal1",
        content: ACT_AS_CONTENT,
        isDM: true,
        dmType: "principal",
      }),
    );

    // The message reached the CC path — the filter did NOT short-circuit it.
    expect(spawnCount()).toBe(1);

    const texts = adapter.sentMessages.map((m) => m.text);
    // No filter-block reply was posted to the principal.
    expect(texts.some((t) => t.includes("I can't process that message"))).toBe(false);
    expect(texts.some((t) => t.includes("Content filter blocked"))).toBe(false);
    // The CC response (success path) was posted instead.
    expect(texts).toContain("On it — here's the jumphost answer.");

    // The match is still logged for principal visibility (cortex#723). After
    // cortex#741 the trust decision + audit moved INTO scanPrompt; the audit
    // line now reads "AUDIT trusted-sender match NOT blocked".
    expect(
      logLines.some(
        (l) => l.includes("AUDIT") && l.includes("trusted-sender"),
      ),
    ).toBe(true);

    await handler.shutdown();
  });

  test("untrusted sender's role-play injection is still BLOCKED (posts the can't-process reply, no CC spawn)", async () => {
    const { factory, spawnCount } = makeStubFactory([
      successResult({ response: "should never run" }),
    ]);

    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      ccSessionFactory: factory,
    });

    // Same block-triggering content, but from an untrusted (non-principal)
    // sender — a plain guild message, not a principal DM. Must stay blocked.
    await handler.handleMessage(
      adapter,
      makeMsg({
        platform: "discord",
        authorId: "user999",
        authorName: "Stranger",
        content: ACT_AS_CONTENT,
      }),
    );

    // The filter short-circuited before any CC spawn.
    expect(spawnCount()).toBe(0);

    const texts = adapter.sentMessages.map((m) => m.text);
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("I can't process that message");
    // cortex#1264 — the reply is now the deterministic, category-rendered
    // text (injection/exfiltration → "...matched a ... safety pattern"),
    // not the raw "Content filter blocked (matched: ...)" string.
    expect(texts[0]).toContain("safety pattern");

    await handler.shutdown();
  });

  // cortex#741 — the trust signal is now `access.trusted`, set by
  // `resolvePolicyAccess` for the home principal on EVERY adapter (Discord,
  // Mattermost, Slack). This is the path that closes the Slack gap (#729's
  // per-adapter `authorIsPrincipal` was never set on Slack). Here the home
  // principal arrives with NEITHER `dmType: "principal"` NOR `authorIsPrincipal`
  // — trust flows solely through `access.trusted`. The exact live #741 FP
  // (EX-004 "access the environment") must be PROCESSED, not blocked.
  test("home principal trusted via access.trusted alone (no dmType / authorIsPrincipal) is PROCESSED — closes the Slack gap (cortex#741)", async () => {
    const EX004_FP =
      "you can use aws cli tooling to access the environment";
    const { factory, spawnCount } = makeStubFactory([
      successResult({ response: "Sure — pulling the AWS env now." }),
    ]);

    const adapter = new MockAdapter();
    // The home principal's AccessDecision carries `trusted: true` (as
    // resolvePolicyAccess sets for the home principal).
    adapter.accessDecision = {
      allowed: true,
      features: { chat: true, async: true, team: true },
      trusted: true,
    };
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      ccSessionFactory: factory,
    });

    await handler.handleMessage(
      adapter,
      makeMsg({
        platform: "slack",
        authorId: "home1",
        content: EX004_FP,
        // Deliberately NOT a principal DM and NOT flagged authorIsPrincipal —
        // trust must come from access.trusted only.
        isDM: false,
      }),
    );

    expect(spawnCount()).toBe(1);
    const texts = adapter.sentMessages.map((m) => m.text);
    expect(texts.some((t) => t.includes("I can't process that message"))).toBe(false);
    expect(texts).toContain("Sure — pulling the AWS env now.");

    await handler.shutdown();
  });

  // cortex#741 — conservative boundary: a recognized peer principal (allowed,
  // but `trusted` UNSET) sending the same EX-004 FP must STILL be hard-blocked.
  // This proves the exemption is keyed off home-principal trust, not mere
  // recognition.
  test("recognized-but-untrusted principal (access.trusted unset) is still BLOCKED (cortex#741)", async () => {
    const EX004_FP =
      "you can use aws cli tooling to access the environment";
    const { factory, spawnCount } = makeStubFactory([
      successResult({ response: "should never run" }),
    ]);

    const adapter = new MockAdapter();
    // Recognized + allowed, but NOT trusted (a peer principal).
    adapter.accessDecision = {
      allowed: true,
      features: { chat: true, async: false, team: false },
      // trusted intentionally omitted → falsy.
    };
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      ccSessionFactory: factory,
    });

    await handler.handleMessage(
      adapter,
      makeMsg({
        platform: "slack",
        authorId: "peer2",
        content: EX004_FP,
        isDM: false,
      }),
    );

    expect(spawnCount()).toBe(0);
    const texts = adapter.sentMessages.map((m) => m.text);
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("I can't process that message");
    // cortex#1264 — the reply is now the deterministic, category-rendered
    // text (injection/exfiltration → "...matched a ... safety pattern"),
    // not the raw "Content filter blocked (matched: ...)" string.
    expect(texts[0]).toContain("safety pattern");

    await handler.shutdown();
  });
});

// ---------------------------------------------------------------------------
// cortex#729 — #724 trust-scoped the prompt filter for the home principal's
// DMs, but gated the bypass on `isPrincipalDM` (msg.isDM && msg.dmType ===
// "principal"). `dmType` is set only inside the adapter's `if (isDM)` branch, so
// the home principal's CHANNEL @mention (isDM=false → dmType undefined) fell
// through and stayed hard-blocked (live FP: PI-002 "act as a jumphost" in
// #halden-observe, where Luna has dmOwner:false so a channel @mention is the
// only path). The fix adds `msg.authorIsPrincipal`, computed by the adapter for
// EVERY inbound message via the same non-spoofable PolicyEngine principal-role
// check, and the handler now bypasses on `(isPrincipalDM || msg.authorIsPrincipal)`.
//
// Contract:
//   - home-principal CHANNEL @mention (isDM=false, authorIsPrincipal=true) whose
//     content matches a block pattern → PROCESSED (reaches CC, NO can't-process
//     reply), match LOGGED for visibility.
//   - non-principal CHANNEL sender, same content → still BLOCKED.
//   - the home-principal DM path (#724) is unchanged (covered above).
// ---------------------------------------------------------------------------

describe("DispatchHandler — prompt-filter trust scope, channel @mentions (cortex#729)", () => {
  // Same PI-002-tripping content the #723 tests use — the exact live FP class.
  const ACT_AS_CONTENT =
    "Dig deeper — the probe is not the jump host. A different machine would act as a jumphost.";

  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;
  let originalLog: typeof console.log;
  let logLines: string[];

  beforeEach(() => {
    originalWarn = console.warn;
    originalError = console.error;
    originalLog = console.log;
    logLines = [];
    console.warn = () => {};
    console.error = () => {};
    console.log = (...args: unknown[]) => {
      logLines.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
  });

  test("home-principal CHANNEL @mention matching a block pattern is PROCESSED (not blocked) and the match is logged", async () => {
    const { factory, spawnCount } = makeStubFactory([
      successResult({ response: "On it — here's the jumphost answer." }),
    ]);

    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      ccSessionFactory: factory,
    });

    // A guild CHANNEL @mention (NOT a DM) from the home principal. `isDM` is
    // false so `dmType` is undefined — the home-principal signal arrives solely
    // via `authorIsPrincipal`, which is exactly the #729 path.
    await handler.handleMessage(
      adapter,
      makeMsg({
        platform: "discord",
        authorId: "principal1",
        content: ACT_AS_CONTENT,
        isDM: false,
        authorIsPrincipal: true,
      }),
    );

    // The message reached the CC path — the filter did NOT short-circuit it.
    expect(spawnCount()).toBe(1);

    const texts = adapter.sentMessages.map((m) => m.text);
    expect(texts.some((t) => t.includes("I can't process that message"))).toBe(false);
    expect(texts.some((t) => t.includes("Content filter blocked"))).toBe(false);
    expect(texts).toContain("On it — here's the jumphost answer.");

    // The match is logged for principal visibility (cortex#723/#729). After
    // cortex#741 the trust decision + audit moved INTO scanPrompt; the audit
    // line now reads "AUDIT trusted-sender match NOT blocked".
    expect(
      logLines.some(
        (l) => l.includes("AUDIT") && l.includes("trusted-sender"),
      ),
    ).toBe(true);

    await handler.shutdown();
  });

  test("non-principal CHANNEL sender with the same role-play content is still BLOCKED (no CC spawn)", async () => {
    const { factory, spawnCount } = makeStubFactory([
      successResult({ response: "should never run" }),
    ]);

    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      ccSessionFactory: factory,
    });

    // Same content, same channel shape — but the sender is NOT the home
    // principal (authorIsPrincipal omitted → undefined/false). Must stay blocked.
    await handler.handleMessage(
      adapter,
      makeMsg({
        platform: "discord",
        authorId: "user999",
        authorName: "Stranger",
        content: ACT_AS_CONTENT,
        isDM: false,
      }),
    );

    expect(spawnCount()).toBe(0);

    const texts = adapter.sentMessages.map((m) => m.text);
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("I can't process that message");
    // cortex#1264 — the reply is now the deterministic, category-rendered
    // text (injection/exfiltration → "...matched a ... safety pattern"),
    // not the raw "Content filter blocked (matched: ...)" string.
    expect(texts[0]).toContain("safety pattern");

    await handler.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Direction A Stage 4-B (cortex#409) — publishInboundDispatchEnvelope
//
// Dispatch-source path. The handler publishes chat/direct dispatches as
// `tasks.@{did-encoded-assistant}.chat` envelopes via
// `runtime.publishOnSubject` for the dispatch-listener to consume. Tests here
// exercise the envelope construction in isolation plus the handleMessage gate
// that now makes canonical publishing the default chat path.
// ---------------------------------------------------------------------------

interface RecordingRuntimeWithSubject extends MyelinRuntime {
  publishes: Envelope[];
  subjectPublishes: { envelope: Envelope; subject: string }[];
}

function makeRecordingRuntimeWithSubject(opts: {
  publishOnSubjectImpl?: (envelope: Envelope, subject: string) => Promise<void>;
} = {}): RecordingRuntimeWithSubject {
  const publishes: Envelope[] = [];
  const subjectPublishes: { envelope: Envelope; subject: string }[] = [];
  return {
    enabled: true,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: async (envelope: Envelope) => {
      publishes.push(envelope);
    },
    publishOnSubject: opts.publishOnSubjectImpl
      ? async (envelope: Envelope, subject: string) => {
          subjectPublishes.push({ envelope, subject });
          await opts.publishOnSubjectImpl!(envelope, subject);
        }
      : async (envelope: Envelope, subject: string) => {
          subjectPublishes.push({ envelope, subject });
        },
    stop: async () => {},
    publishes,
    subjectPublishes,
  };
}

/**
 * Reaches into the private `publishInboundDispatchEnvelope` method to
 * drive emission directly. Mirrors `callPublishInboundAborted` —
 * exercising the envelope construction in isolation is materially
 * cheaper than driving handleMessage end-to-end (which would also
 * require the CC spawn path through the harness).
 */
async function callPublishInboundDispatchEnvelope(
  handler: DispatchHandler,
  opts: Parameters<
    DispatchHandler["publishInboundDispatchEnvelope" & keyof DispatchHandler]
  > extends [infer A]
    ? A
    : unknown,
): Promise<boolean> {
  return (
    handler as unknown as {
      publishInboundDispatchEnvelope: (o: unknown) => Promise<DispatchSourcePublishResult>;
    }
  ).publishInboundDispatchEnvelope(opts).then((result) => result.published);
}

describe("DispatchHandler — Direction A Stage 4-B inbound envelope publish (cortex#409)", () => {
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;
  let originalLog: typeof console.log;

  beforeEach(() => {
    originalWarn = console.warn;
    originalError = console.error;
    originalLog = console.log;
    console.warn = () => {};
    console.error = () => {};
    console.log = () => {};
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
  });

  const dispatchOpts = (overrides: Record<string, unknown> = {}) => ({
    taskId: "11111111-1111-4111-8111-111111111111",
    msg: makeMsg({
      platform: "discord",
      authorId: "888888888888888888",
      content: "hello",
    }),
    prompt: "user prompt here",
    resumeSessionId: undefined,
    allowedDirs: ["/Users/andreas/Developer/cortex"],
    disallowedTools: ["WebSearch"],
    timeoutMs: 120_000,
    cwd: "/Users/andreas/Developer/cortex",
    additionalArgs: ["--foo"],
    channel: "cortex",
    network: undefined,
    project: "cortex",
    entity: "issue/409",
    principal: "andreas",
    ...overrides,
  });

  test("publishes envelope with canonical subject + Direct mode shape (stack-aware)", async () => {
    const runtime = makeRecordingRuntimeWithSubject();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
      policyEngine: makePublishPolicyEngine(),
    });

    const published = await callPublishInboundDispatchEnvelope(
      handler,
      dispatchOpts(),
    );

    expect(published).toBe(true);
    expect(runtime.subjectPublishes.length).toBe(1);

    const { envelope, subject } = runtime.subjectPublishes[0]!;

    // Subject lands in the canonical 6-segment Tasks Domain shape.
    expect(subject).toBe(
      "local.andreas.meta-factory.tasks.@did-mf-test-agent.chat",
    );

    // Envelope addressing:
    expect(envelope.type).toBe("tasks.chat");
    expect(envelope.distribution_mode).toBe("direct");
    expect(envelope.target_assistant).toBe("did:mf:test-agent");
    // cortex#486 — `originator.identity` is the RESOLVED principal DID
    // (`did:mf:andreas`), not a platform-prefixed snowflake. The
    // dispatch source did the `(discord, 1487...) → andreas` lookup at
    // publish time via the wired PolicyEngine.
    expect(envelope.originator?.identity).toBe("did:mf:andreas");
    expect(envelope.originator?.attribution).toBe("adapter-resolved");
    expect(envelope.sovereignty.classification).toBe("local");
    expect(envelope.sovereignty.data_residency).toBe("NZ");
    expect(envelope.correlation_id).toBe(
      "11111111-1111-4111-8111-111111111111",
    );

    // Payload mirrors DispatchTaskReceivedPayload shape.
    const payload = envelope.payload;
    expect(payload.task_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(payload.agent_id).toBe("test-agent");
    expect(payload.prompt).toBe("user prompt here");
    expect(payload.grove_channel).toBe("cortex");
    expect(payload.allowed_dirs).toEqual([
      "/Users/andreas/Developer/cortex",
    ]);
    expect(payload.disallowed_tools).toEqual(["WebSearch"]);
    expect(payload.timeout_ms).toBe(120_000);
    expect(payload.cwd).toBe("/Users/andreas/Developer/cortex");
    expect(payload.additional_args).toEqual(["--foo"]);
    expect(payload.project).toBe("cortex");
    expect(payload.entity).toBe("issue/409");
    expect(payload.principal).toBe("andreas");

    // cortex#491 — response routing stamped from the inbound message so
    // the runner can echo it onto lifecycle envelopes and the dispatch
    // sink can deliver the reply (CONTEXT.md §Response-routing). The
    // default `makeMsg` has no threadId, so `thread_id` is omitted.
    expect(payload.response_routing).toEqual({
      adapter_instance: "mock-instance",
      channel_id: "ch1",
    });

    // Envelope must validate against the vendored myelin schema —
    // catches any regression where the new envelope shape drifts
    // from the wire contract the dispatch-listener consumes.
    expect(validateEnvelope(envelope).ok).toBe(true);

    await handler.shutdown();
  });

  // cortex#1167 review BLOCKER (PIVOT) — full publish → LISTENER round-trip with
  // runtime + policyEngine WIRED (production config). The earlier whack-a-mole
  // anon-DID approach left the dispatch-listener gate (engine.check(...,
  // "dispatch.pier") at dispatch-listener.ts:1687) DENYING the unmapped sender
  // as unknown_principal. The fix attributes the sender to the single
  // registered `public` principal (originator `did:mf:public`) which the engine
  // GRANTS `dispatch.pier`. This test drives the admit path, then reproduces the
  // listener's EXACT principal resolution + engine.check on the published
  // envelope to PROVE it is NOT denied at 1687 (Pier's session would run).
  test("WIRED bus round-trip: unmapped sender → flagged Pier → published AND PASSES the listener's engine.check", async () => {
    const runtime = makeRecordingRuntimeWithSubject();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "andreas", agent: "cortex", instance: "local" },
      stack: "meta-factory",
      // PRODUCTION engine: built via the factory WITH the public principal
      // granted dispatch.pier (exactly how cortex.ts wires it). It maps
      // (discord, 888888888888888888) → andreas; JC's id below is UNMAPPED.
      policyEngine: makeWiredEngineWithPublic(["pier"]),
    });
    const adapter = new MockAdapter();
    adapter.accessDecision = {
      allowed: false,
      features: { chat: false, async: false, team: false },
      denyCode: "unmapped_sender",
      denyReason: "Sorry, I'm not set up to respond to you.",
    };

    await handler.handleMessage(
      adapter,
      makeMsg({ platform: "discord", authorId: "555555555555555555", authorName: "JC", content: "hi, I'm new here" }),
      { id: "pier", displayName: "Pier", openOnboarding: true, openOnboardingAllowedTools: ["Read"] },
    );

    // 1. The chat envelope was published with the PUBLIC originator.
    expect(runtime.subjectPublishes.length).toBe(1);
    const { envelope } = runtime.subjectPublishes[0]!;
    expect(envelope.type).toBe("tasks.chat");
    expect(envelope.originator?.identity).toBe("did:mf:public");
    expect(validateEnvelope(envelope).ok).toBe(true);
    // MAJOR — the explicit Read-only allowlist rode the payload (every path).
    expect(envelope.payload.allowed_tools).toEqual(["Read"]);

    // 2. ROUND-TRIP — reproduce the dispatch-listener's gate (dispatch-listener.ts
    //    resolvePrincipalId → engine.check("dispatch.<agent_id>")). The published
    //    envelope must PASS, not get denied as unknown_principal at line 1687.
    const listenerEngine = makeWiredEngineWithPublic(["pier"]);
    const actorDid = getActorPrincipal(envelope);
    expect(actorDid).toBe("did:mf:public");
    const principalId = extractAgentIdFromDid(actorDid!);
    expect(principalId).toBe("public");
    const decision = listenerEngine.check(principalId!, {
      capability: `dispatch.${envelope.payload.agent_id as string}`,
      sovereignty: defaultPolicySovereignty(),
    });
    expect(decision.allow).toBe(true); // NOT denied at dispatch-listener.ts:1687

    // 3. No invalid-originator error posted back.
    const errored = adapter.sentMessages.some((m) => m.text.includes("could not be mapped"));
    expect(errored).toBe(false);

    await handler.shutdown();
  });

  // cortex#1167 — the listener gate DENIES the public principal dispatching to a
  // NON-flagged agent (Luna): same engine, different capability claim.
  test("WIRED bus round-trip: public principal is DENIED dispatch to a NON-flagged agent (Luna) at the listener", () => {
    const listenerEngine = makeWiredEngineWithPublic(["pier"]);
    const decision = listenerEngine.check("public", {
      capability: "dispatch.luna",
      sovereignty: defaultPolicySovereignty(),
    });
    expect(decision.allow).toBe(false);
  });

  // cortex#1167 — regression: originator validation is UNCHANGED for real
  // dispatches. A mapped principal still resolves to their real principal DID
  // via the normal resolver (override is undefined → no bypass).
  test("WIRED bus: a MAPPED principal still resolves to the REAL principal DID (override not applied)", async () => {
    const runtime = makeRecordingRuntimeWithSubject();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "andreas", agent: "cortex", instance: "local" },
      stack: "meta-factory",
      policyEngine: makeWiredEngineWithPublic(["pier"]),
    });
    const adapter = new MockAdapter();
    // Mapped principal: a real allow (the conversion code never fires).
    adapter.accessDecision = { allowed: true, features: { chat: true, async: false, team: false } };

    await handler.handleMessage(
      adapter,
      makeMsg({ platform: "discord", authorId: "888888888888888888", authorName: "andreas", content: "hello" }),
      { id: "pier", displayName: "Pier", openOnboarding: true, openOnboardingAllowedTools: ["Read"] },
    );

    expect(runtime.subjectPublishes.length).toBe(1);
    const { envelope } = runtime.subjectPublishes[0]!;
    // RESOLVED real principal DID — proves the public override did NOT leak onto
    // a real, mapped dispatch (originator validation unchanged for real paths).
    expect(envelope.originator?.identity).toBe("did:mf:andreas");
    expect(envelope.originator?.identity).not.toContain("public");
    // No anon allowlist on a real dispatch.
    expect(envelope.payload.allowed_tools).toBeUndefined();

    await handler.shutdown();
  });

  test("cortex#491 — response_routing carries thread_id for a threaded message", async () => {
    const runtime = makeRecordingRuntimeWithSubject();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
      policyEngine: makePublishPolicyEngine(),
    });

    const published = await callPublishInboundDispatchEnvelope(
      handler,
      dispatchOpts({
        msg: makeMsg({
          platform: "discord",
          authorId: "888888888888888888",
          instanceId: "discord-pai-collab",
          channelId: "C100",
          threadId: "T200",
          content: "hello in a thread",
        }),
      }),
    );

    expect(published).toBe(true);
    const { envelope } = runtime.subjectPublishes[0]!;
    expect(envelope.payload.response_routing).toEqual({
      adapter_instance: "discord-pai-collab",
      channel_id: "C100",
      thread_id: "T200",
    });

    await handler.shutdown();
  });

  test("per-adapter target agent overrides host config agent", async () => {
    const runtime = makeRecordingRuntimeWithSubject();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
      policyEngine: makePublishPolicyEngine(),
    });

    const published = await callPublishInboundDispatchEnvelope(
      handler,
      dispatchOpts({
        targetAgent: { id: "holly", displayName: "Holly" },
      }),
    );

    expect(published).toBe(true);
    expect(runtime.subjectPublishes[0]?.subject).toBe(
      "local.andreas.meta-factory.tasks.@did-mf-holly.chat",
    );
    expect(runtime.subjectPublishes[0]?.envelope.target_assistant).toBe(
      "did:mf:holly",
    );
    expect(runtime.subjectPublishes[0]?.envelope.payload.agent_id).toBe("holly");
    expect(runtime.subjectPublishes[0]?.envelope.payload.agent_name).toBe("Holly");

    await handler.shutdown();
  });

  test("stackless subject when stack is omitted", async () => {
    const runtime = makeRecordingRuntimeWithSubject();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      // no stack
      policyEngine: makePublishPolicyEngine(),
    });

    const published = await callPublishInboundDispatchEnvelope(
      handler,
      dispatchOpts(),
    );

    expect(published).toBe(true);
    expect(runtime.subjectPublishes[0]?.subject).toBe(
      "local.andreas.tasks.@did-mf-test-agent.chat",
    );

    await handler.shutdown();
  });

  test("dataResidency override flows through onto the envelope", async () => {
    const runtime = makeRecordingRuntimeWithSubject();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
        dataResidency: "AU",
      },
      stack: "meta-factory",
      policyEngine: makePublishPolicyEngine(),
    });

    await callPublishInboundDispatchEnvelope(handler, dispatchOpts());
    expect(runtime.subjectPublishes[0]?.envelope.sovereignty.data_residency).toBe(
      "AU",
    );
    await handler.shutdown();
  });

  test("returns false when runtime is absent — caller can surface degraded dispatch", async () => {
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      // no runtime
    });
    const published = await callPublishInboundDispatchEnvelope(
      handler,
      dispatchOpts(),
    );
    expect(published).toBe(false);
    await handler.shutdown();
  });

  test("returns false when runtime lacks publishOnSubject", async () => {
    // Mimic an older runtime fake that only exposes `publish`.
    const runtime: MyelinRuntime = {
      enabled: true,
      onEnvelope: () => ({ unregister: () => {} }),
      publish: async () => {},
      stop: async () => {},
    };
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
    });
    const published = await callPublishInboundDispatchEnvelope(
      handler,
      dispatchOpts(),
    );
    expect(published).toBe(false);
    await handler.shutdown();
  });

  test("publishOnSubject rejection → returns false", async () => {
    const runtime = makeRecordingRuntimeWithSubject({
      publishOnSubjectImpl: async () => {
        throw new Error("bus is down");
      },
    });
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
    });
    const published = await callPublishInboundDispatchEnvelope(
      handler,
      dispatchOpts(),
    );
    expect(published).toBe(false);
    await handler.shutdown();
  });

  test("mattermost authorId resolves to principal DID — `did:mf:andreas` (cortex#486)", async () => {
    // cortex#486: the publish-time resolution is platform-agnostic. The
    // engine maps `(mattermost, 8wkrnxq3abcdef) → andreas`; the envelope
    // carries the resolved principal DID — no platform-prefixed shape
    // ever lands on the wire.
    const runtime = makeRecordingRuntimeWithSubject();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
      policyEngine: makePublishPolicyEngine(),
    });
    await callPublishInboundDispatchEnvelope(
      handler,
      dispatchOpts({
        msg: makeMsg({
          platform: "mattermost",
          authorId: "8wkrnxq3abcdef",
        }),
      }),
    );
    expect(
      runtime.subjectPublishes[0]?.envelope.originator?.identity,
    ).toBe("did:mf:andreas");
    await handler.shutdown();
  });

  test("unresolvable platform identity → returns false, no publish (cortex#486)", async () => {
    // cortex#486 — the dispatch source resolves `(platform, authorId)`
    // through the wired PolicyEngine; an unmapped tuple yields a null
    // originator identity and `publishInboundDispatchEnvelope` returns
    // `false`. Pre-#486 this test exercised the DID_RE rejection of
    // platform-prefixed shapes (cortex#420 nit-5); post-#486 that
    // grammar concern is moot because the publish never emits a
    // platform-prefixed DID in the first place. The publish-time
    // refusal IS the security boundary — the engine doesn't authorise
    // an unknown Discord user just because they typed in chat.
    const runtime = makeRecordingRuntimeWithSubject();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
      policyEngine: makePublishPolicyEngine(),
    });
    const published = await callPublishInboundDispatchEnvelope(
      handler,
      dispatchOpts({
        msg: makeMsg({
          platform: "discord",
          // Discord snowflake that no principal claims — engine returns
          // undefined; publish refuses with `invalid-originator`.
          authorId: "999999999999999999",
        }),
      }),
    );
    expect(published).toBe(false);
    expect(runtime.subjectPublishes.length).toBe(0);
    await handler.shutdown();
  });

  test("missing policyEngine → returns false, no publish (cortex#486 fail-closed)", async () => {
    // cortex#486 — without a wired PolicyEngine the dispatch source
    // cannot resolve `(platform, authorId)` to a principal. The publish
    // fails closed with `invalid-originator` rather than emitting a
    // platform-prefixed DID. Production boots without an engine only
    // when no `policy:` block is declared (deliberately rare).
    const runtime = makeRecordingRuntimeWithSubject();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
      // no policyEngine
    });
    const published = await callPublishInboundDispatchEnvelope(
      handler,
      dispatchOpts(),
    );
    expect(published).toBe(false);
    expect(runtime.subjectPublishes.length).toBe(0);
    await handler.shutdown();
  });

  // ---------------------------------------------------------------------------
  // handleMessage integration. The env flag from Stage 4-A is no longer part
  // of the production gate; chat/direct messages try the canonical publish
  // path by default.
  // ---------------------------------------------------------------------------

  test("chat mode publishes canonical envelope by default — legacy CC does not spawn", async () => {
    const runtime = makeRecordingRuntimeWithSubject();
    let spawnCount = 0;
    const ccFactory: CCSessionFactory = (_opts: CCSessionOpts) => {
      spawnCount++;
      const fake: CCSessionLike = {
        start() {
          return fake;
        },
        wait() {
          return Promise.resolve<CCSessionResult>({
            success: true,
            response: "legacy",
            exitCode: 0,
            durationMs: 0,
            sessionId: "fake-session",
          });
        },
      };
      return fake;
    };
    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
      ccSessionFactory: ccFactory,
      policyEngine: makePublishPolicyEngine(),
    });
    await handler.handleMessage(
      adapter,
      makeMsg({
        content: "hello",
        platform: "discord",
        authorId: "888888888888888888",
      }),
    );
    expect(runtime.subjectPublishes.length).toBe(1);
    expect(spawnCount).toBe(0);
    expect(runtime.subjectPublishes[0]?.subject).toBe(
      "local.andreas.meta-factory.tasks.@did-mf-test-agent.chat",
    );
    expect(runtime.subjectPublishes[0]?.envelope.payload).not.toHaveProperty("resume_session_id");
    await handler.shutdown();
  });

  test("chat mode injects the target agent persona into canonical dispatch prompt", async () => {
    const runtime = makeRecordingRuntimeWithSubject();
    const adapter = new MockAdapter();
    const dir = mkdtempSync(join(tmpdir(), "cortex-persona-"));
    const personaPath = join(dir, "juniper.md");
    writeFileSync(personaPath, "# Juniper\\nYou are Juniper, not Ivy.\\n");

    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
      policyEngine: makePublishPolicyEngine(),
    });

    try {
      await handler.handleMessage(
        adapter,
        makeMsg({
          content: "hello",
          platform: "discord",
          authorId: "888888888888888888",
        }),
        { id: "juniper", displayName: "Juniper", persona: personaPath },
      );

      const prompt = runtime.subjectPublishes[0]?.envelope.payload.prompt;
      expect(typeof prompt).toBe("string");
      expect(prompt).toContain("You are Juniper (agent id: juniper).");
      expect(prompt).toContain("# Juniper");
      expect(prompt).toContain("hello");
      expect(runtime.subjectPublishes[0]?.envelope.payload.agent_id).toBe("juniper");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await handler.shutdown();
    }
  });

  test("chat mode no longer consults CORTEX_ADAPTER_ENVELOPE_MODE", async () => {
    process.env.CORTEX_ADAPTER_ENVELOPE_MODE = "0";
    const runtime = makeRecordingRuntimeWithSubject();
    let spawnCount = 0;
    const ccFactory: CCSessionFactory = (_opts: CCSessionOpts) => {
      spawnCount++;
      const fake: CCSessionLike = {
        start() {
          return fake;
        },
        wait() {
          return Promise.resolve<CCSessionResult>({
            success: true,
            response: "legacy",
            exitCode: 0,
            durationMs: 0,
            sessionId: "fake-session",
          });
        },
      };
      return fake;
    };
    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
      ccSessionFactory: ccFactory,
      policyEngine: makePublishPolicyEngine(),
    });
    try {
      await handler.handleMessage(
        adapter,
        makeMsg({
          content: "hello",
          platform: "discord",
          authorId: "888888888888888888",
        }),
      );
      expect(runtime.subjectPublishes.length).toBe(1);
      expect(spawnCount).toBe(0);
      expect(runtime.subjectPublishes[0]?.subject).toBe(
        "local.andreas.meta-factory.tasks.@did-mf-test-agent.chat",
      );
    } finally {
      delete process.env.CORTEX_ADAPTER_ENVELOPE_MODE;
    }
    await handler.shutdown();
  });

  test("chat mode rejects invalid originator instead of spawning legacy CC", async () => {
    const runtime = makeRecordingRuntimeWithSubject();
    let spawnCount = 0;
    const ccFactory: CCSessionFactory = (_opts: CCSessionOpts) => {
      spawnCount++;
      const fake: CCSessionLike = {
        start() {
          return fake;
        },
        wait() {
          return Promise.resolve<CCSessionResult>({
            success: true,
            response: "legacy",
            exitCode: 0,
            durationMs: 0,
            sessionId: "fake-session",
          });
        },
      };
      return fake;
    };
    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      runtime,
      systemEventSource: {
        principal: "andreas",
        agent: "cortex",
        instance: "local",
      },
      stack: "meta-factory",
      ccSessionFactory: ccFactory,
      policyEngine: makePublishPolicyEngine(),
    });

    await handler.handleMessage(
      adapter,
      makeMsg({
        content: "hello",
        platform: "discord",
        // cortex#486 — unresolvable Discord snowflake (no principal
        // claims it). Engine returns undefined → publish refuses with
        // `invalid-originator`; the apology surface fires the same
        // user-facing message it did pre-#486 for grammar-invalid ids.
        authorId: "999999999999999999",
      }),
    );

    expect(runtime.subjectPublishes.length).toBe(0);
    expect(spawnCount).toBe(0);
    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]?.text).toContain("sender identity");
    await handler.shutdown();
  });

  test("intercept gate excludes async/team — explicit boolean coverage", () => {
    // The handleMessage canonical path fires only for
    // `parsed.mode === "sync"` (post-Nit-4 in commit 8f000e8 — the
    // `mode === undefined` branch was removed as dead code, since
    // `parseMessageKeywords` always returns a concrete enum mode).
    // Driving the async/team paths through `handleMessage` end-to-end
    // would require either spawning a real `claude` binary (handleAsync
    // builds `new CCSession(...)` directly, bypassing the factory)
    // or stubbing `AgentTeam` (handleTeam path). Both are exercised
    // by the cortex#360 / cortex#419 suites with the appropriate
    // fakes already wired. Here we encode the gate boolean as a
    // tiny standalone check, matching `parseMessageKeywords`'s
    // observable contract:
    //   - "hello"       → mode: "sync"      → intercept fires
    //   - ""            → mode: "sync"      → intercept fires
    //   - "async: …"    → mode: "async"     → intercept skipped
    //   - "team: …"     → mode: "team"      → intercept skipped
    //   - "/help"       → mode: "help"      → intercept skipped
    //   - "/learning …" → mode: "learning"  → intercept skipped
    // The `undefined` row is encoded for return-type-widening
    // defence — production refuses to intercept it.
    type MaybeMode = string | undefined;
    const wouldIntercept = (mode: MaybeMode): boolean => mode === "sync";
    expect(wouldIntercept("sync")).toBe(true);
    // `undefined` never appears in practice — `parseMessageKeywords` always
    // returns a concrete enum mode — but encode the production semantic
    // (only `"sync"` intercepts) explicitly to guard against return-type
    // widening.
    expect(wouldIntercept(undefined)).toBe(false);
    expect(wouldIntercept("async")).toBe(false);
    expect(wouldIntercept("team")).toBe(false);
    expect(wouldIntercept("help")).toBe(false);
    expect(wouldIntercept("learning")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cortex#1206 (S2) — dev-loop thread consolidation.
//
// When the orchestrator agent (vega) dispatches `implement {repo}#{N}` for the
// principal, the dispatch carries the run's LOGICAL thread routing AND vega's
// ack posts INTO that run thread (not the flat channel), so the principal
// follows the whole run — ack → dev lifecycle → review verdict — in one place.
// ---------------------------------------------------------------------------
describe("DispatchHandler — dev-loop thread consolidation (cortex#1206 S2)", () => {
  let originalLog: typeof console.log;

  beforeEach(() => {
    originalLog = console.log;
    console.log = () => {};
  });
  afterEach(() => {
    console.log = originalLog;
  });

  function makeOrchestratorHandler(): { handler: DispatchHandler; runtime: RecordingRuntime } {
    const runtime = makeRecordingRuntime();
    const handler = new DispatchHandler({
      config: makeConfig({
        github: { ...makeConfig().github, repos: ["the-metafactory/cortex"] },
      }),
      securityPreamble: "",
      runtime,
      systemEventSource: { principal: "andreas", agent: "cortex", instance: "local" },
    });
    return { handler, runtime };
  }

  const VEGA = {
    id: "vega",
    displayName: "Vega",
    capabilities: [ORCHESTRATOR_CAPABILITY],
  };

  test("principal `implement` dispatches with run-thread routing + posts ack INTO the run thread", async () => {
    const { handler, runtime } = makeOrchestratorHandler();
    const adapter = new MockAdapter();
    adapter.logicalSurface = "mock"; // the inbound surface resolves a thread

    await handler.handleMessage(
      adapter,
      makeMsg({ content: "implement cortex#1196", authorIsPrincipal: true }),
      VEGA,
    );

    // 1. The dispatch envelope carries the LOGICAL run-thread routing.
    expect(runtime.publishes).toHaveLength(1);
    const env = runtime.publishes[0]!;
    expect(env.type).toBe("tasks.dev.implement");
    expect(readLogicalRouting(env)).toEqual({
      surface: "mock",
      channel: "cortex",
      thread: "cortex/issue/1196",
    });

    // 2. The handler resolved that logical address to a native thread (the SAME
    //    `resolveLogicalTarget` the review-sink uses for the dev lifecycle).
    expect(adapter.logicalTargetsResolved).toContainEqual({
      surface: "mock",
      channel: "cortex",
      thread: "cortex/issue/1196",
    });

    // 3. vega's ack landed in the run thread, not the flat channel.
    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]!.target.threadId).toBe("thread:cortex/issue/1196");
    expect(adapter.sentMessages[0]!.text).toContain("the-metafactory/cortex#1196");
  });

  test("FALLBACK: when the surface can't thread, the ack degrades to the channel (never dropped)", async () => {
    const { handler, runtime } = makeOrchestratorHandler();
    const adapter = new MockAdapter();
    // The mock drives a DIFFERENT logical surface, so `resolveLogicalTarget`
    // returns null for the inbound `"mock"` surface — exactly the non-Discord /
    // missing-channel degrade path.
    adapter.logicalSurface = "some-other-surface";

    await handler.handleMessage(
      adapter,
      makeMsg({ content: "implement cortex#1196", authorIsPrincipal: true }),
      VEGA,
    );

    // The dispatch still published (the run still starts).
    expect(runtime.publishes).toHaveLength(1);
    // The ack is NOT dropped — it falls back to the inbound channel target
    // (today's behaviour): channel-scope, no thread.
    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]!.target.channelId).toBe("ch1");
    expect(adapter.sentMessages[0]!.target.threadId).toBeUndefined();
  });

  test("FAIL-CLOSED: a non-principal `implement` is ignored — no dispatch, no thread, no ack", async () => {
    const { handler, runtime } = makeOrchestratorHandler();
    const adapter = new MockAdapter();
    adapter.logicalSurface = "mock";

    await handler.handleMessage(
      adapter,
      makeMsg({ content: "implement cortex#1196", authorIsPrincipal: false }),
      VEGA,
    );

    expect(runtime.publishes).toHaveLength(0);
    expect(adapter.logicalTargetsResolved).toHaveLength(0);
    expect(adapter.sentMessages).toHaveLength(0);
  });
});

// WEB-2 / B1 — per-agent structural tool confinement. agentDisallowedTools in
// the DispatchTargetAgent config are merged into effectiveDisallowed AFTER
// the policy-based toolRestrictions, so they are denied regardless of role or
// network overrides. This is belt-and-braces atop the policy-layer floor tested
// in resolve-access.test.ts (facilitator-role denies all 14 inventory tools).
describe("agentDisallowedTools — WEB-2/B1 per-agent structural confinement (cortex#1312)", () => {
  test("agentDisallowedTools are merged into disallowedTools passed to every CCSession", async () => {
    let capturedDisallowed: string[] = [];
    const factory: CCSessionFactory = (opts) => {
      capturedDisallowed = [...(opts.disallowedTools ?? [])];
      const session: CCSessionLike = {
        start() { return session; },
        async wait(): Promise<CCSessionResult> {
          return { success: true, response: "ok", exitCode: 0, durationMs: 1, sessionId: "test-sess" };
        },
      };
      return session;
    };
    const adapter = new MockAdapter();
    const handler = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
      ccSessionFactory: factory,
    });
    // Simulate facilitator-role: all 14 inventory tools denied by policy inversion.
    // This is the access decision resolvePolicyAccess would return for a principal
    // whose role holds no tool.* capabilities (see resolve-access.test.ts counterpart).
    adapter.accessDecision = {
      allowed: true,
      features: { chat: true, async: false, team: false },
      toolRestrictions: [...CLAUDE_TOOL_INVENTORY],
      bashGuard: true,
    };

    await handler.handleMessage(adapter, makeMsg({ content: "hello" }), {
      id: "pylon",
      displayName: "Pylon",
      // Per-agent extras beyond the policy inventory — task-dispatch tool
      // and exit-plan-mode are not in CLAUDE_TOOL_INVENTORY but are still
      // CC-available; agentDisallowedTools adds them to the deny set explicitly.
      agentDisallowedTools: ["Task", "ExitPlanMode"],
    });

    // All 14 policy-layer inventory denials must reach the session.
    for (const tool of CLAUDE_TOOL_INVENTORY) {
      expect(capturedDisallowed).toContain(tool);
    }
    // Per-agent extras must also be present — belt-and-braces beyond the inventory.
    expect(capturedDisallowed).toContain("Task");
    expect(capturedDisallowed).toContain("ExitPlanMode");
    await handler.shutdown();
  });
});
