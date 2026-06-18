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
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stringify } from "yaml";
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

/**
 * #1006 — the work/halden shape: an agent in the canonical top-level
 * `agents[]` that does NOT declare its own `nkey_pub`. Its presence identity
 * must come from the STACK NKey fallback (declared as `stack.nkey_pub` or
 * derived from the seed) — independent of the signing posture. Mirrors the
 * live config-split stacks whose per-agent key lives only on
 * `policy.principals[].nkey_pub`, not on the `agents[]` entry.
 */
function makeAgentNoKey(id: string, capabilities: readonly string[]): Agent {
  const a = makeAgent(id, capabilities);
  // Strip the per-agent key so resolution must fall back to the stack key.
  // `nkey_pub` is optional on Agent, so the rest object is already an Agent.
  const { nkey_pub: _stripped, ...rest } = a;
  return rest;
}

/** A valid 56-char U-prefixed base32 NKey-shaped pubkey for tests. */
const STACK_NKEY_PUB = "UD" + "Q".padEnd(54, "A");

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

  // ===========================================================================
  // #1006 — the stack-NKey fallback must survive signing: off.
  //
  // The work/halden shape: agents in the canonical top-level `agents[]` carry
  // NO per-agent `nkey_pub` (it lives only on `policy.principals[].nkey_pub`),
  // the stack declares `stack.nkey_pub`, and `security.signing` is `off` (the
  // schema default). Pre-#1006 the stack pubkey was resolved ONLY inside the
  // signing-enabled boot branch, so with signing off the presence producer had
  // no fallback → every keyless agent was skipped → no `agent.online` → the
  // #989 multi-bus aggregator rendered nothing.
  //
  // Presence identity is a BUS concern, independent of the signing posture
  // (ADR-0007): a stack whose pubkey is declared in config must announce its
  // agents whether or not it is signing outbound envelopes.
  // ===========================================================================

  test("#1006 signing OFF + keyless agents + stack.nkey_pub: producer STILL announces (stack fallback survives signing posture)", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-presence-1006-stackfallback-"));
    const handle = await startCortex(
      // mc.enabled false is the work/halden shape; security.signing defaults to
      // `off` (no security block declared) — the exact live posture.
      minimalConfig({ mc: { enabled: false, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        // Agents WITHOUT per-agent nkey_pub — must fall back to the stack key.
        inlineAgents: [
          makeAgentNoKey("luna", ["code-review.typescript"]),
          makeAgentNoKey("echo", ["research"]),
        ],
        // The stack declares its pubkey (and a seed path), but signing is off.
        stack: {
          id: "andreas/work",
          nkey_pub: STACK_NKEY_PUB,
        },
        principal: { id: "andreas" },
      },
    );

    const onlines = runtime.published.filter((e) => e.type === "agent.online");
    // BOTH keyless agents must be announced via the stack fallback.
    expect(onlines.length).toBe(2);
    // Each carries the STACK pubkey as its presence identity (no per-agent key).
    for (const online of onlines) {
      const key = (online.payload as { identity: { nkey_public_key: string } })
        .identity.nkey_public_key;
      expect(key).toBe(STACK_NKEY_PUB);
    }

    await handle.stop();
  });

  test("#1006 meta-factory shape unchanged: per-agent nkey_pub still wins over the stack key", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-presence-1006-perAgentWins-"));
    const handle = await startCortex(
      minimalConfig({ mc: { enabled: true, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        // The meta-factory shape: agents DO declare per-agent nkey_pub.
        inlineAgents: [
          makeAgent("luna", ["code-review.typescript"]),
          makeAgent("echo", ["research"]),
        ],
        // A stack key is ALSO present, but per-agent keys must take precedence.
        stack: {
          id: "andreas/meta-factory",
          nkey_pub: STACK_NKEY_PUB,
        },
        principal: { id: "andreas" },
      },
    );

    const onlines = runtime.published.filter((e) => e.type === "agent.online");
    expect(onlines.length).toBe(2);
    const luna = onlines.find(
      (e) => (e.payload as { identity: { agent_id: string } }).identity.agent_id === "luna",
    );
    // Per-agent key wins — NOT the stack fallback.
    expect(
      (luna!.payload as { identity: { nkey_public_key: string } }).identity
        .nkey_public_key,
    ).toBe("UA" + "LUNA".padEnd(54, "X"));
    expect(
      (luna!.payload as { identity: { nkey_public_key: string } }).identity
        .nkey_public_key,
    ).not.toBe(STACK_NKEY_PUB);

    await handle.stop();
  });

  test("#1006 no stack key AND keyless agents: still skipped (the genuine no-key case)", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-presence-1006-genuinely-keyless-"));
    const handle = await startCortex(
      minimalConfig({ mc: { enabled: false, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        inlineAgents: [makeAgentNoKey("luna", ["code-review.typescript"])],
        // No `stack` option at all ⇒ no stack pubkey to fall back to.
        principal: { id: "andreas" },
      },
    );

    // Genuinely keyless: nothing to announce — the skip is correct here.
    expect(runtime.published.filter((e) => e.type === "agent.online")).toEqual([]);

    await handle.stop();
  });
});

// =============================================================================
// S1 (cortex#1159) — per-agent Discord/Mattermost adapters from agents.d
// fragments. Boot-path integration: an agent installed ONLY as an agents.d/
// fragment (not inline) must flow into the adapter-construction instance lists
// (`config.discord` carries inline presence only). Here we prove the fragment
// reaches the adapter loop and is governed by the loop's own `enabled` skip —
// a disabled fragment Discord presence constructs NO adapter and leaks no
// `system.adapter.*` envelope, exactly like the disabled-inline case
// (cortex.test.ts "ignores discord instances marked enabled: false"). The
// enabled-construction path does real network I/O on `.start()`, so the
// unit-level helper tests in loader.test.ts pin construction + fragment-identity
// binding; this boot test pins that the fragment ENTERS the iterated list.
// =============================================================================
describe("startCortex — S1 (cortex#1159) agents.d fragment → adapter wiring", () => {
  /** Write a fragment YAML + its persona file into `agentsDir`. */
  function writeDiscordFragment(
    agentsDir: string,
    id: string,
    presence: Record<string, unknown>,
  ): void {
    const personaPath = join(agentsDir, `${id}.md`);
    writeFileSync(personaPath, `# ${id} persona\n`, "utf-8");
    const fragment = {
      id,
      displayName: id.charAt(0).toUpperCase() + id.slice(1),
      persona: personaPath,
      trust: [],
      presence,
    };
    writeFileSync(join(agentsDir, `${id}.yaml`), stringify(fragment), { mode: 0o600 });
  }

  test("disabled fragment Discord presence enters the list but constructs NO adapter (loop's enabled-skip applies)", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-s1-disabled-frag-"));
    // A fragment-only agent (NOT in inlineAgents) with a DISABLED Discord presence.
    writeDiscordFragment(tmp, "pier", {
      discord: {
        enabled: false,
        token: "pier-disabled-token",
        guildId: "g-pier",
        agentChannelId: "c-pier",
        logChannelId: "c-pier-log",
      },
    });

    const handle = await startCortex(
      minimalConfig({ mc: { enabled: false, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableAgentsWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        inlineAgents: [],
        principal: { id: "andreas" },
      },
    );

    // The fragment reached the adapter loop and was skipped by its own
    // `if (!instance.enabled) continue` — so NO `system.adapter.*` envelope
    // leaked (a constructed+started adapter would publish system.adapter.connected).
    expect(
      runtime.published.filter((e) => e.type.startsWith("system.adapter.")),
    ).toEqual([]);

    await handle.stop();
  });

  test("inline-only stack with empty agents.d: no fragment adapters appended (regression)", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-s1-inline-only-"));
    // Empty agents.d (no fragment files) + one inline keyless agent. The append
    // of fragment-only presences is a no-op → boot behaves exactly as pre-S1.
    const handle = await startCortex(
      minimalConfig({ mc: { enabled: false, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableAgentsWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        inlineAgents: [makeAgent("luna", ["code-review.typescript"])],
        principal: { id: "andreas" },
      },
    );

    // No Discord/Mattermost presence anywhere → no adapter envelopes.
    expect(
      runtime.published.filter((e) => e.type.startsWith("system.adapter.")),
    ).toEqual([]);
    // The inline agent still announces presence (unchanged behavior).
    expect(runtime.published.filter((e) => e.type === "agent.online")).toHaveLength(1);

    await handle.stop();
  });
});
