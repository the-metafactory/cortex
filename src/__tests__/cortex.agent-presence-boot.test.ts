/**
 * G-1114.B.2 + B.3 — agent-presence producer + registry boot/shutdown wiring.
 *
 * Asserts the boot lifecycle integration in `startCortex`:
 *
 *   1. MC ON (`config.mc.enabled: true`) → one `agent.online` per hosted
 *      agent goes out on boot, carrying that agent's capabilities; the registry
 *      subscriber self-subscribes to the stack-local `agent.>` pattern.
 *   2. (#1003) MC OFF (`config.mc.enabled: false`) WITH agents → the presence
 *      PRODUCER still announces (`agent.online` per agent + `agent.offline` on
 *      shutdown), because presence is a BUS concern independent of the MC
 *      dashboard (ADR-0007). But the consuming REGISTRY stays MC-gated: a
 *      non-dashboard stack only PUBLISHES its own presence, it does not CONSUME
 *      others' — so it does NOT subscribe to `agent.>`.
 *   3. No agents (empty roster) → NO producer, NO `agent.*` envelopes, even with
 *      a bus — nothing to announce.
 *   4. Shutdown → `agent.offline` (reason: shutdown) publishes for every agent
 *      BEFORE the runtime closes (ordering: offline lands while the recording
 *      runtime is still accepting publishes, i.e. before `runtime.stop`) — and
 *      this holds whether or not MC is enabled.
 *
 * Mirrors the `cortex.capability-boot.test.ts` harness (NATS-absent recording
 * runtime, inline agents, headless presence). The recording runtime records the
 * order of `publish` vs `stop` so we can assert offline-before-close.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import type { Agent, AgentRuntime } from "../common/types/cortex-config";
import { startCortex } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";
import type { MyelinSubscriber } from "../bus/myelin/subscriber";

function minimalConfig(overrides: Record<string, unknown> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-presence-test-published" },
    ...overrides,
  });
}

interface RecordingRuntime extends MyelinRuntime {
  published: Envelope[];
  subscribedPatterns: string[];
  /** True once `stop()` has been called — lets tests assert publish-before-close. */
  stopped: boolean;
  /** Envelope types published AFTER `stop()` was called (should be empty). */
  publishedAfterStop: string[];
}

function createRecordingRuntime(): RecordingRuntime {
  const handlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  const subscribedPatterns: string[] = [];
  const publishedAfterStop: string[] = [];
  const fakeSubscriber: MyelinSubscriber = {
    stop: () => Promise.resolve(),
  } as unknown as MyelinSubscriber;
  const rt: RecordingRuntime = {
    enabled: true,
    published,
    subscribedPatterns,
    stopped: false,
    publishedAfterStop,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    publish: (envelope: Envelope) => {
      if (rt.stopped) publishedAfterStop.push(envelope.type);
      published.push(envelope);
      return Promise.resolve();
    },
    subscribe: (pattern: string) => {
      subscribedPatterns.push(pattern);
      return Promise.resolve(fakeSubscriber);
    },
    stop: () => {
      rt.stopped = true;
      return Promise.resolve();
    },
  };
  return rt;
}

function makeAgent(id: string, capabilities: readonly string[]): Agent {
  const runtime: AgentRuntime = {
    substrate: "claude-code",
    mode: "in-process",
    capabilities: [...capabilities],
  };
  return {
    id,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    persona: `/tmp/${id}-persona.md`,
    trust: [],
    presence: {},
    // A per-agent NKey so the presence identity resolves without a stack key.
    nkey_pub: "UA" + id.toUpperCase().padEnd(54, "X"),
    runtime,
  };
}

const presenceTypes = (envs: Envelope[]): string[] =>
  envs.map((e) => e.type).filter((t) => t.startsWith("agent."));

describe("startCortex — agent-presence boot/shutdown (G-1114.B.2+B.3)", () => {
  test("gated ON: agent.online per agent on boot + registry self-subscribes", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-presence-on-"));
    const handle = await startCortex(
      minimalConfig({ mc: { enabled: true, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableDashboard: true, // skip the HTTP embed; presence still runs
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        inlineAgents: [
          makeAgent("luna", ["code-review.typescript"]),
          makeAgent("echo", ["research"]),
        ],
        principal: { id: "andreas" },
      },
    );

    const onlines = runtime.published.filter((e) => e.type === "agent.online");
    expect(onlines.length).toBe(2);
    // Each carries its agent's capabilities.
    const luna = onlines.find(
      (e) => (e.payload as { identity: { agent_id: string } }).identity.agent_id === "luna",
    );
    expect((luna!.payload as { capabilities: string[] }).capabilities).toEqual([
      "code-review.typescript",
    ]);
    // Stack-local subject (default-derived stack = "default").
    expect(luna!.sovereignty.classification).toBe("local");
    // Registry self-subscribed to the stack-local agent.> pattern.
    expect(runtime.subscribedPatterns).toContain("local.andreas.default.agent.>");

    await handle.stop();
  });

  test("#1003 MC OFF with agents: producer STILL announces agent.online per agent (presence is a bus concern)", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-presence-off-"));
    const handle = await startCortex(
      minimalConfig({ mc: { enabled: false, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        inlineAgents: [
          makeAgent("luna", ["code-review.typescript"]),
          makeAgent("echo", ["research"]),
        ],
        principal: { id: "andreas" },
      },
    );

    // The PRODUCER runs regardless of mc.enabled — the core #1003 fix. Each
    // hosted agent announces presence on the stack-local bus so #989's
    // multi-bus aggregator has something to render.
    const onlines = runtime.published.filter((e) => e.type === "agent.online");
    expect(onlines.length).toBe(2);
    const luna = onlines.find(
      (e) => (e.payload as { identity: { agent_id: string } }).identity.agent_id === "luna",
    );
    expect((luna!.payload as { capabilities: string[] }).capabilities).toEqual([
      "code-review.typescript",
    ]);
    expect(luna!.sovereignty.classification).toBe("local");

    // The CONSUMING registry stays MC-gated: a non-dashboard stack publishes its
    // own presence but does not consume others' — so NO `agent.>` subscription.
    expect(runtime.subscribedPatterns).not.toContain(
      "local.andreas.default.agent.>",
    );

    await handle.stop();
  });

  test("#1003 MC OFF: agent.offline still publishes on shutdown for every agent", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-presence-off-shutdown-"));
    const handle = await startCortex(
      minimalConfig({ mc: { enabled: false, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        inlineAgents: [
          makeAgent("luna", ["code-review.typescript"]),
          makeAgent("echo", ["research"]),
        ],
        principal: { id: "andreas" },
      },
    );

    await handle.stop();

    const offlines = runtime.published.filter((e) => e.type === "agent.offline");
    expect(offlines.length).toBe(2);
    for (const off of offlines) {
      expect((off.payload as { reason: string }).reason).toBe("shutdown");
    }
    // Still ordered before the runtime close even on the MC-off path.
    expect(runtime.publishedAfterStop).not.toContain("agent.offline");
  });

  test("#1003 no agents: no producer, no agent.* envelopes (even with a bus)", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-presence-no-agents-"));
    const handle = await startCortex(
      // mc.enabled true to prove the gate is "has agents", not "mc off": even
      // with MC on, an empty roster announces nothing.
      minimalConfig({ mc: { enabled: true, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        inlineAgents: [],
        principal: { id: "andreas" },
      },
    );
    // No hosted agents ⇒ no presence producer ⇒ no agent.online/heartbeat.
    expect(runtime.published.filter((e) => e.type === "agent.online")).toEqual(
      [],
    );
    await handle.stop();
    // …and none on shutdown either.
    expect(runtime.published.filter((e) => e.type === "agent.offline")).toEqual(
      [],
    );
  });

  test("shutdown: agent.offline publishes for every agent BEFORE runtime close", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-presence-shutdown-"));
    const handle = await startCortex(
      minimalConfig({ mc: { enabled: true, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        inlineAgents: [
          makeAgent("luna", ["code-review.typescript"]),
          makeAgent("echo", ["research"]),
        ],
        principal: { id: "andreas" },
      },
    );

    await handle.stop();

    const offlines = runtime.published.filter((e) => e.type === "agent.offline");
    expect(offlines.length).toBe(2);
    for (const off of offlines) {
      expect((off.payload as { reason: string }).reason).toBe("shutdown");
    }
    // Ordering: every agent.offline landed BEFORE runtime.stop() ran. The
    // recording runtime flags any publish that arrives after `stopped` — no
    // agent.offline may appear there.
    expect(runtime.publishedAfterStop).not.toContain("agent.offline");
  });
});
