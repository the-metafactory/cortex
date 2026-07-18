/**
 * cortex#2215 — `create_private_thread` (cortex#2206) boot-wiring integration
 * test.
 *
 * cortex#2206/PR #2214 built `DaemonBrainHost`'s `create_private_thread`
 * capability and unit-tested it directly against the class (constructor
 * options: `agentChannelId` / `createPrivateThread` / `anonReachable`).
 * Nothing wired those options for a real agent — this file proves the REAL
 * `cortex.ts` boot path (`startCortex`) now does, for an agent declaring
 * `openOnboarding: true` with a Discord presence binding.
 *
 * Scope of "real boot path" here: `startCortex` runs the actual
 * `wireBrainConsumers` + `wireSurfaceAdapters` boot-wiring modules, in the
 * actual order (brain consumers, THEN surface adapters) — the exact
 * construction-ordering problem cortex#2215 names. Two test seams keep this
 * hermetic (no real subprocess, no real Discord bundle):
 *
 *   - `injectDaemonBrainTransport` swaps the daemon host's real
 *     spawn-a-subprocess transport for an in-memory fake brain
 *     (`FakeDaemonBrain` — the SAME double `daemon-brain-host.test.ts` and
 *     `bus/__tests__/brain-consumer.test.ts` already drive).
 *   - `injectSurfacePluginRegistry` swaps the real (out-of-tree, arc-bundle-
 *     loaded) Discord adapter for a construct-only fake implementing
 *     `createPrivateThread` — mirrors `surface-adapter-boot.test.ts`'s own
 *     `registryFromRecordingFactory` fake-plugin pattern.
 *
 * What's deliberately OUT of scope: driving a task to the daemon host over
 * the real bus/JetStream pull-consumer path. That plumbing is its own,
 * already-covered surface (`brain-consumer-boot.test.ts`'s `subscribePull`
 * assertions; `bus/__tests__/brain-consumer.test.ts`'s consumer↔host
 * integration). This test instead reads the REAL, boot-constructed
 * `DaemonBrainHost` off `handle.daemonBrainHosts` (cortex#2215's new
 * `@internal` handle field) and calls `runTask` on it directly — the
 * assertion under test is "the wiring cortex.ts did is correct", not
 * "the bus can deliver a task" (a different, already-tested claim).
 *
 * All test ids are obviously-fake, non-numeric placeholders (confidentiality
 * gate — never a realistic-looking digit snowflake).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { z } from "zod/v4";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import { AgentSchema, type Agent } from "../common/types/cortex-config";
import { startCortex } from "../cortex";
import { SurfacePluginRegistry, type AdapterPlugin } from "../adapters/registry";
import type { PlatformAdapter, CreatePrivateThreadResult } from "../adapters/types";
import {
  FakeDaemonBrain,
  singleFakeDaemonTransport,
} from "../brain/__tests__/fake-daemon-brain";
import type { TaskEvent } from "../brain/protocol";
import type { BrainTaskHooks } from "../brain/exec-brain-runner";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Non-numeric, obviously-fake — never a realistic 17-20 digit platform
// snowflake (confidentiality-gate self-check, per CLAUDE.md).
const FAKE_DISCORD_TOKEN = "discord-token-fake-for-test";
const FAKE_GUILD_ID = "guild-fake-for-test";
const FAKE_AGENT_CHANNEL_ID = "agent-channel-fake-for-test";
const FAKE_LOG_CHANNEL_ID = "log-channel-fake-for-test";
const FAKE_THREAD_ID = "thread-fake-for-test";
const FAKE_SOURCE_USER_ID = "newcomer-fake-for-test";

function minimalConfig(overrides: Partial<Record<string, unknown>> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/cortex-brain-daemon-thread-boot-test-published" },
    ...overrides,
  });
}

/** A construct-only fake Discord `PlatformAdapter` implementing `createPrivateThread`. */
interface RecordedThreadCall {
  channelId: string;
  name: string;
  memberIds: string[];
}

function makeFakeDiscordAdapter(
  recordedCalls: RecordedThreadCall[],
): PlatformAdapter & Record<string, unknown> {
  return {
    platform: "discord",
    instanceId: "pier-discord",
    start: async () => {},
    stop: async () => {},
    getPlatformUserId: async () => "bot-fake-for-test",
    fetchContext: async () => [],
    resolveAccess: () => ({ allowed: true, features: { chat: true, async: false, team: false } }),
    postResponse: async () => {},
    sendTyping: async () => {},
    sendProgress: async () => {},
    clearProgress: async () => {},
    createThread: async () => ({ instanceId: "pier-discord", channelId: FAKE_AGENT_CHANNEL_ID }),
    resolveLogicalTarget: async () => null,
    notifyPrincipal: async () => {},
    createPrivateThread: async (opts: {
      channelId: string;
      name: string;
      memberIds: string[];
    }): Promise<CreatePrivateThreadResult> => {
      recordedCalls.push({ ...opts });
      return { ok: true, threadId: FAKE_THREAD_ID };
    },
    // `surface-adapter-boot.ts`'s discord descriptor unconditionally casts to
    // `DiscordLikeAdapter` (`PlatformAdapter & RouterRegistrable &
    // TrustMergeable`) and runs its Pass-2 trust merge for EVERY discord
    // instance — these members are required even though this test never
    // exercises trust.
    surfaceConfig: { id: "discord-pier-discord", subjects: [], render: async () => {} },
    setTrustedBotIds: () => {},
    attachInboundDispatch: () => {},
    trustedBotIdCount: 0,
  };
}

/** A `SurfacePluginRegistry` with exactly one registered "discord" plugin, delegating to `factory`. */
function registryWithFakeDiscord(
  factory: () => PlatformAdapter & Record<string, unknown>,
): SurfacePluginRegistry {
  const registry = new SurfacePluginRegistry();
  const plugin: AdapterPlugin = {
    kind: "adapter",
    id: "discord",
    platform: "discord",
    bindingSchema: z.unknown(),
    foldsIntoPresence: true,
    secretFields: [],
    demuxKey: () => "",
    buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
    createAdapter: () => factory(),
  };
  registry.registerAdapter(plugin);
  return registry;
}

/** A minimal, valid, open-onboarding, `lifecycle: daemon` agent bound to Discord. */
function makePierAgent(overrides: Partial<Record<string, unknown>> = {}): Agent {
  return AgentSchema.parse({
    id: "pier",
    displayName: "Pier",
    persona: writePersonaFile(),
    trust: [],
    openOnboarding: true,
    presence: {
      discord: {
        enabled: true,
        token: FAKE_DISCORD_TOKEN,
        guildId: FAKE_GUILD_ID,
        agentChannelId: FAKE_AGENT_CHANNEL_ID,
        logChannelId: FAKE_LOG_CHANNEL_ID,
      },
    },
    runtime: {
      mode: "in-process",
      capabilities: ["concierge.welcome"],
      brain: {
        kind: "exec",
        run: "bun {pack}/brain/main.ts",
        lifecycle: "daemon",
        maxRestarts: 0,
      },
    },
    ...overrides,
  });
}

let personaDirs: string[] = [];
function writePersonaFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cortex-brain-daemon-thread-boot-"));
  personaDirs.push(dir);
  const p = join(dir, "pier.md");
  writeFileSync(p, "# Pier persona\n", "utf-8");
  return p;
}

function makeTask(over: Partial<TaskEvent> = {}): TaskEvent {
  return {
    v: 1,
    type: "task",
    task_id: "welcome-1",
    capability: "concierge.welcome",
    payload: {},
    source: { surface: "discord", channel: "arrivals", thread: "", user: FAKE_SOURCE_USER_ID },
    ...over,
  };
}

function noopHooks(): BrainTaskHooks {
  return {
    onPost: () => {},
    onAskPrincipal: async () => ({ verdict: "pass", principal: "andreas" }),
    onDispatch: () => undefined,
    onLog: () => {},
  };
}

/** Wait until `cond()` is true (poll), or throw after `timeoutMs`. */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startCortex — create_private_thread boot wiring (cortex#2215)", () => {
  test("an openOnboarding agent's REAL boot-constructed DaemonBrainHost has a working create_private_thread capability end-to-end against a fake adapter", async () => {
    const recordedCalls: RecordedThreadCall[] = [];
    const brain = new FakeDaemonBrain();
    const config = minimalConfig({
      discord: [
        {
          enabled: true,
          token: FAKE_DISCORD_TOKEN,
          guildId: FAKE_GUILD_ID,
          agentChannelId: FAKE_AGENT_CHANNEL_ID,
          logChannelId: FAKE_LOG_CHANNEL_ID,
        },
      ],
    });
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-brain-daemon-thread-boot-agents-"));

    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableAgentsWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      agentsDir: tmpAgentsDir,
      inlineAgents: [makePierAgent()],
      principal: { id: "andreas" },
      injectSurfacePluginRegistry: registryWithFakeDiscord(() =>
        makeFakeDiscordAdapter(recordedCalls),
      ),
      injectDaemonBrainTransport: singleFakeDaemonTransport(brain),
    });

    try {
      // The real boot path constructed exactly one lifecycle:daemon host, for
      // "pier" — proof `wireBrainConsumers` ran and pushed onto the shared
      // array cortex.ts owns.
      expect(handle.daemonBrainHosts).toHaveLength(1);
      const host = handle.daemonBrainHosts[0]!;
      expect(host.agentId).toBe("pier");

      // Drive a task directly against the REAL, boot-constructed host (see
      // file header for why this bypasses the bus pull-consumer path).
      const runP = host.runTask(makeTask(), noopHooks());
      await until(() => brain.lastTask()?.task_id === "welcome-1");

      // The brain requests a private thread with `members: "source"` — the
      // only form an anon-reachable (openOnboarding) agent's brain may ever
      // request (cortex#2206 policy).
      brain.emit(
        JSON.stringify({
          v: 1,
          type: "create_private_thread",
          task_id: "welcome-1",
          name: "welcome newcomer",
          members: "source",
        }),
      );
      await until(() => brain.hasEvent("thread_created"));

      // The load-bearing assertion: the call reached the FAKE ADAPTER the
      // real `wireSurfaceAdapters` boot lane constructed for "pier" —
      // proving the agentPlatformAdapters holder-indirection actually
      // resolves at call time, and that the channel is "pier"'s OWN bound
      // agentChannelId (never brain-supplied).
      expect(recordedCalls).toEqual([
        {
          channelId: FAKE_AGENT_CHANNEL_ID,
          name: "welcome newcomer",
          memberIds: [FAKE_SOURCE_USER_ID],
        },
      ]);

      const created = brain.received.find((e) => e.type === "thread_created");
      expect(created).toMatchObject({
        type: "thread_created",
        task_id: "welcome-1",
        thread_id: FAKE_THREAD_ID,
      });

      brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "welcome-1", status: "complete" }));
      await runP;
    } finally {
      await handle.stop();
      rmSync(tmpAgentsDir, { recursive: true, force: true });
    }
  });

  test("an agent WITHOUT openOnboarding: true gets NO create_private_thread capability — fail-safe, not fail-open", async () => {
    const recordedCalls: RecordedThreadCall[] = [];
    const brain = new FakeDaemonBrain();
    const config = minimalConfig({
      discord: [
        {
          enabled: true,
          token: FAKE_DISCORD_TOKEN,
          guildId: FAKE_GUILD_ID,
          agentChannelId: FAKE_AGENT_CHANNEL_ID,
          logChannelId: FAKE_LOG_CHANNEL_ID,
        },
      ],
    });
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-brain-daemon-thread-boot-noopen-"));

    // Same Discord binding, same daemon lifecycle — the ONLY difference is
    // `openOnboarding` is absent (default false).
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableAgentsWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      agentsDir: tmpAgentsDir,
      inlineAgents: [makePierAgent({ openOnboarding: undefined })],
      principal: { id: "andreas" },
      injectSurfacePluginRegistry: registryWithFakeDiscord(() =>
        makeFakeDiscordAdapter(recordedCalls),
      ),
      injectDaemonBrainTransport: singleFakeDaemonTransport(brain),
    });

    try {
      expect(handle.daemonBrainHosts).toHaveLength(1);
      const host = handle.daemonBrainHosts[0]!;

      const runP = host.runTask(makeTask({ task_id: "no-open-1" }), noopHooks());
      await until(() => brain.lastTask()?.task_id === "no-open-1");

      brain.emit(
        JSON.stringify({
          v: 1,
          type: "create_private_thread",
          task_id: "no-open-1",
          name: "should never open",
          members: "source",
        }),
      );
      await until(() => brain.hasEvent("effect_rejected"));

      // No capability configured at all ⇒ `effect_rejected`/`cant_do`
      // (DaemonBrainHost's "missing agentChannelId/createPrivateThread"
      // structural path) — and, load-bearing, the fake adapter is NEVER
      // called.
      const rejected = brain.received.find((e) => e.type === "effect_rejected");
      expect(rejected).toMatchObject({ type: "effect_rejected", effect: "create_private_thread" });
      if (rejected?.type === "effect_rejected") {
        expect(rejected.reason.kind).toBe("cant_do");
      }
      expect(recordedCalls).toEqual([]);
      expect(brain.hasEvent("thread_created")).toBe(false);

      brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "no-open-1", status: "complete" }));
      await runP;
    } finally {
      await handle.stop();
      rmSync(tmpAgentsDir, { recursive: true, force: true });
    }
  });

  test("an openOnboarding agent with NO Discord presence binding boots without crashing and gets no create_private_thread capability", async () => {
    const brain = new FakeDaemonBrain();
    const config = minimalConfig();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-brain-daemon-thread-boot-headless-"));

    // openOnboarding: true, but headless — no `presence.discord` at all.
    // Must not crash boot (a bare `.agentChannelId` read must be `?.`-safe).
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableAgentsWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      agentsDir: tmpAgentsDir,
      inlineAgents: [makePierAgent({ presence: {} })],
      principal: { id: "andreas" },
      injectDaemonBrainTransport: singleFakeDaemonTransport(brain),
    });

    try {
      expect(handle.daemonBrainHosts).toHaveLength(1);
      const host = handle.daemonBrainHosts[0]!;

      const runP = host.runTask(makeTask({ task_id: "headless-1" }), noopHooks());
      await until(() => brain.lastTask()?.task_id === "headless-1");

      brain.emit(
        JSON.stringify({
          v: 1,
          type: "create_private_thread",
          task_id: "headless-1",
          name: "should never open",
          members: "source",
        }),
      );
      await until(() => brain.hasEvent("effect_rejected"));

      const rejected = brain.received.find((e) => e.type === "effect_rejected");
      expect(rejected).toMatchObject({ type: "effect_rejected", effect: "create_private_thread" });

      brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "headless-1", status: "complete" }));
      await runP;
    } finally {
      await handle.stop();
      rmSync(tmpAgentsDir, { recursive: true, force: true });
    }
  });
});

afterAll(() => {
  for (const d of personaDirs) rmSync(d, { recursive: true, force: true });
  personaDirs = [];
});
