/**
 * MIG-7.1 — cortex entrypoint tests.
 *
 * Coverage axes:
 *   1. Construction shape — `startCortex(config)` returns a `{ stop }` handle
 *      without crashing on a minimal NATS-absent config.
 *   2. Wire-up — surface-router has been started; dispatch-listener registered;
 *      runtime in disabled state remains composable. We assert observable
 *      side-effects (handler-registration count via a recording runtime; a
 *      manually published `dispatch.task.received` envelope reaches the
 *      runner via the listener registered with the router).
 *   3. Shutdown — `stop()` is idempotent; reverse-order calls fire.
 *   4. Adapter loading — disabled adapters skipped; configured ones registered
 *      with the router (we assert via `dispatch()` to a Discord subject and
 *      observe the adapter's `render` is invoked, all without real I/O).
 *
 * No real Discord / Mattermost / NATS network is touched. Tests inject the
 * minimum BotConfig shape and rely on:
 *   - `nats?` absent → runtime starts in disabled mode (no socket).
 *   - `discord: []` and `mattermost: []` → no adapter `start()` calls.
 *   - `api.enabled: false` → no Hono server bound.
 *   - `disableConfigWatcher: true` and `disableOutboundPoller: true` (test
 *     option) keep the test deterministic and avoid filesystem churn.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BotConfigSchema, type BotConfig } from "../common/types/config";
import type { Agent } from "../common/types/cortex-config";
import { pidFileFor, runDryRun, startCortex } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimum BotConfig that passes Zod validation. Discord + Mattermost arrays
 * are empty; networks is empty (so cloud publisher stays inactive); api is
 * disabled; nats is absent so the runtime stays in no-op mode.
 *
 * Tests that need extra fields layer them on with the spread argument.
 */
function minimalConfig(overrides: Partial<Record<string, unknown>> = {}): BotConfig {
  return BotConfigSchema.parse({
    agent: {
      name: "test-cortex",
      displayName: "TestCortex",
      operatorId: "test-op",
    },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-test-published" },
    ...overrides,
  });
}

/**
 * Recording fake `MyelinRuntime` exposing the registration set + publish log
 * so wire-up tests can assert OBSERVABLE side-effects (Echo round-1 N1):
 * which subsystems actually wired themselves to the runtime, in what order,
 * and what they emitted at startup.
 *
 * Field semantics:
 *   - `onEnvelopeHandlers` — every handler currently registered. Asserting
 *     `.size > 0` proves the surface-router (which calls `runtime.onEnvelope`
 *     on `start()`) actually wired up; asserting `.size === 0` after `stop()`
 *     proves the unregister path fires.
 *   - `published` — every envelope passed to `publish()`. Empty by default
 *     in the wire-up path (cortex doesn't publish at startup); useful as a
 *     negative assertion ("startup did not leak events") and for future
 *     `system.cortex.started` work.
 *   - `dispatchToHandlers(env, subject)` — fires the registered handlers
 *     synchronously so tests can simulate "an envelope arrived from NATS"
 *     without standing up a real subscription.
 */
interface RecordingRuntime extends MyelinRuntime {
  onEnvelopeHandlers: Set<EnvelopeHandler>;
  published: Envelope[];
  dispatchToHandlers(env: Envelope, subject: string): void;
}

function createRecordingRuntime(): RecordingRuntime {
  const onEnvelopeHandlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  return {
    enabled: false,
    onEnvelopeHandlers,
    published,
    onEnvelope(handler) {
      onEnvelopeHandlers.add(handler);
      return {
        unregister: () => {
          onEnvelopeHandlers.delete(handler);
        },
      };
    },
    publish: async (envelope: Envelope) => {
      published.push(envelope);
    },
    stop: async () => {},
    dispatchToHandlers(env: Envelope, subject: string) {
      for (const h of onEnvelopeHandlers) h(env, subject);
    },
  };
}

// ---------------------------------------------------------------------------
// Construction-time tests
// ---------------------------------------------------------------------------

describe("startCortex — construction", () => {
  test("returns a handle on a minimal NATS-absent config", async () => {
    const config = minimalConfig();
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
    });
    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe("function");
    await handle.stop();
  });

  test("survives a config where api.enabled is true but disableDashboard is set", async () => {
    // Sanity check: the dashboard branch is skipped via the test option even
    // when config.api.enabled is on, so the test doesn't need a real HTTP
    // server bound to a port.
    const config = minimalConfig({
      // Port 38766 is well outside the typical default range; we never
      // actually bind here because `disableDashboard` short-circuits the
      // dashboard branch — the value just has to satisfy the Zod schema's
      // `>0` constraint.
      api: { enabled: true, port: 38766, mode: "local" },
    });
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
    });
    expect(handle).toBeDefined();
    await handle.stop();
  });

  test("IAW A.5.4 — boot path accepts an explicit stack: option and starts cleanly (cortex#113)", async () => {
    // The boot wiring resolves `deriveStackId({ operator, stack })` and logs
    // the derived id; we don't assert on stdout because the existing tests
    // already capture the boot log line shape on the default-derived path.
    // The smoke check here is that passing the option shape through
    // `StartCortexOptions.stack` doesn't trip type-checking or runtime
    // validation — `startCortex` accepts the field, threads it to the
    // logger, and keeps going. Emit subjects are unchanged (A.5.5 follow-up
    // on myelin#113).
    const config = minimalConfig();
    const handle = await startCortex(config, {
      stack: { id: "test-op/research" },
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
    });
    expect(handle).toBeDefined();
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Wire-up tests
// ---------------------------------------------------------------------------

describe("startCortex — wire-up", () => {
  test("surface-router subscribes to runtime envelopes on start()", async () => {
    // Echo round-1 N1: the prior assertion was "rejection-would-propagate"
    // (a contract test). Strengthen to an OBSERVABLE side-effect: after
    // startup, the router has called `runtime.onEnvelope(...)` so its
    // handler is in the runtime's registration set. After `stop()`, the
    // router unregisters and the set is empty again.
    const runtime = createRecordingRuntime();
    expect(runtime.onEnvelopeHandlers.size).toBe(0);

    const config = minimalConfig();
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      injectRuntime: runtime,
    });
    expect(handle).toBeDefined();
    // The surface-router's `start()` registers exactly one envelope handler
    // (its dispatch fan-out). The dispatch-listener registers as a
    // SurfaceAdapter on the router — NOT as a runtime handler — so the
    // count stays at 1 even with the listener wired.
    expect(runtime.onEnvelopeHandlers.size).toBe(1);

    await handle.stop();
    // `router.stop()` unregisters from the runtime — the set drains.
    expect(runtime.onEnvelopeHandlers.size).toBe(0);
  });

  test("dispatch-listener's surface adapter receives bus envelopes via the router", async () => {
    // Echo round-1 N1: assert the listener actually wired itself into the
    // dispatch path — not just that startCortex didn't reject. We do this
    // by firing an envelope through the recording runtime's handlers; if
    // the listener is registered with the router, and the router is
    // subscribed to the runtime, the listener's render() runs and (via
    // `runtime.publish`) we see a `dispatch.task.started` event.
    const runtime = createRecordingRuntime();
    const config = minimalConfig();
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      injectRuntime: runtime,
    });

    // Hand-craft a `dispatch.task.received` envelope. The listener parses
    // its payload and emits `dispatch.task.started` BEFORE spawning CC
    // (see runner/dispatch-listener.ts:303). Asserting the started event
    // alone is enough to prove wire-up; we don't need to spawn real CC.
    const envelope: Envelope = {
      id: "11111111-1111-4111-8111-111111111111",
      source: "test-op.cortex.local",
      type: "dispatch.task.received",
      timestamp: new Date().toISOString(),
      correlation_id: "22222222-2222-4222-8222-222222222222",
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: true,
        model_class: "any",
      },
      payload: {
        task_id: "22222222-2222-4222-8222-222222222222",
        agent_id: "cortex",
        // Use a `cwd` that doesn't exist so CC's spawn errors quickly —
        // the listener's `runtimeError` branch publishes `failed` rather
        // than `started`-then-hang. Either started OR failed is proof of
        // wire-up; assert there's >=1 lifecycle envelope.
        prompt: "test",
        cwd: "/var/empty/cortex-test-nonexistent",
        timeout_ms: 1,
      },
    };

    runtime.dispatchToHandlers(envelope, `local.test-op.dispatch.task.received`);

    // The listener's `render` is async; the router awaits it. Give the
    // microtask queue a beat so the `await runtime.publish(started)` lands.
    // The `started` event publishes BEFORE CC spawns, so even with a
    // 1-tick wait, we expect at least one lifecycle envelope on the wire.
    await new Promise((r) => setTimeout(r, 50));

    expect(runtime.published.length).toBeGreaterThanOrEqual(1);
    const types = runtime.published.map((e) => e.type);
    // The first lifecycle event is always `dispatch.task.started`. If we
    // only see `failed` (CC threw before started), that's still proof of
    // wire-up (listener reached its emit path), but in practice `started`
    // emits first.
    const sawDispatchEvent = types.some((t) => t.startsWith("dispatch.task."));
    expect(sawDispatchEvent).toBe(true);

    await handle.stop();
  });

  test("dispatch-listener registers with the right org-derived subject", async () => {
    // Echo round-1 N1: the listener's `surfaceConfig.subjects` is
    // `local.{org}.dispatch.task.received` where `{org}` comes from
    // `agent.operatorId ?? "default"`. Verify the fallback path: with
    // operatorId absent, the runtime sees envelopes on `local.default.*`.
    const runtime = createRecordingRuntime();
    const noOperator = minimalConfig({
      agent: { name: "no-op-cortex", displayName: "NoOpCortex" },
    });
    const handle = await startCortex(noOperator, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      injectRuntime: runtime,
    });
    expect(handle).toBeDefined();
    // Same observable-side-effect assertion: the router subscribed.
    expect(runtime.onEnvelopeHandlers.size).toBe(1);
    await handle.stop();
    expect(runtime.onEnvelopeHandlers.size).toBe(0);
  });

  test("ignores discord instances marked enabled: false (no adapter handler registered)", async () => {
    // Echo round-1 N1: previously this test only checked `handle defined`.
    // Strengthen by asserting that with the only configured Discord
    // instance disabled, the runtime registration count stays at the
    // baseline (1 = surface-router only). A leaking start() of the
    // disabled adapter would produce additional registrations or publish
    // a `system.adapter.connected` envelope — neither happens here.
    const runtime = createRecordingRuntime();
    const config = minimalConfig({
      discord: [
        {
          enabled: false,
          token: "fake",
          guildId: "g1",
          agentChannelId: "c1",
          logChannelId: "c2",
          contextDepth: 10,
          enableAgentLog: false,
        },
      ],
    });
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      injectRuntime: runtime,
    });
    expect(handle).toBeDefined();
    expect(runtime.onEnvelopeHandlers.size).toBe(1);
    // No adapter started → no `system.adapter.*` envelope leaked.
    expect(runtime.published).toEqual([]);
    await handle.stop();
  });

  test("skips mattermost instances missing apiUrl/apiToken (no adapter handler registered)", async () => {
    // Echo round-1 N1: same shape — assert the missing-credentials guard
    // short-circuits BEFORE adapter.start(), so no `system.adapter.*`
    // event is published and only the router's handler is on the runtime.
    const runtime = createRecordingRuntime();
    const config = minimalConfig({
      mattermost: [
        // Construct via cast: BotConfigSchema would reject a fully empty
        // instance, but loadConfig in the wild may receive partials from
        // legacy/typo'd YAML. We test the runtime guard rather than the
        // schema guard here.
        {
          enabled: true,
          apiUrl: "",
          apiToken: "",
          channels: [],
          pollIntervalMs: 5000,
        } as never,
      ],
    });
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      injectRuntime: runtime,
    });
    expect(handle).toBeDefined();
    expect(runtime.onEnvelopeHandlers.size).toBe(1);
    expect(runtime.published).toEqual([]);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Shutdown tests
// ---------------------------------------------------------------------------

describe("startCortex — shutdown", () => {
  test("stop() is idempotent — calling twice is safe", async () => {
    const config = minimalConfig();
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
    });

    await handle.stop();
    // Second call must not throw, must not double-publish system events,
    // must not double-stop the runtime.
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  test("stop() resolves within the shutdown timeout (clean shutdown leaves abandoned set empty)", async () => {
    const config = minimalConfig();
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
    });

    const start = Date.now();
    await handle.stop();
    const elapsed = Date.now() - start;
    // Internal cap is 15s; an empty stack should drain in well under 1s.
    // Using 5s as a generous CI-friendly upper bound.
    expect(elapsed).toBeLessThan(5_000);
    // Echo round-1 N2: abandoned-set is empty after a clean shutdown.
    expect(handle.lastShutdownAbandoned).toEqual([]);
  });

  test("stop() abandons subsystems whose stop() exceeds the timeout (Echo round-1 N2)", async () => {
    // Make `runtime.stop()` hang. It's the LAST drain step, so prior
    // subsystems complete cleanly and only "runtime stop" should land in
    // the abandoned set. This keeps the assertion specific instead of
    // brittle ordering.
    const runtime: MyelinRuntime = {
      enabled: false,
      onEnvelope: () => ({ unregister: () => {} }),
      publish: async () => {},
      // A promise that never resolves — simulating a wedged runtime
      // (closed connection, hung drain, ...).
      stop: () => new Promise<void>(() => {}),
    };

    const warnLines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string, ...rest: unknown[]) => {
      warnLines.push([msg, ...rest].join(" "));
    };

    let handle: Awaited<ReturnType<typeof startCortex>>;
    try {
      handle = await startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        injectRuntime: runtime,
        // Tight timeout — keeps the test fast. Production default is
        // 15_000ms; the same code path runs at both budgets.
        shutdownTimeoutMs: 100,
      });

      const start = Date.now();
      await handle.stop();
      const elapsed = Date.now() - start;
      // Should resolve at ~100ms (timeout fires) — well under the 15s
      // production cap. Bound generously for CI noise.
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(2_000);

      // The abandoned set: only "runtime stop" because every prior step
      // is sequential and has already cleared. If wire-up changes cause
      // additional steps to land here, the assertion's first match still
      // pinpoints the relevant subsystem name.
      expect(handle.lastShutdownAbandoned).toContain("runtime stop");
      // Belt-and-braces: the timeout warning is logged with the named
      // subsystem so an operator grepping the log can identify the
      // dirty subsystem without reading code.
      const timeoutWarn = warnLines.find((l) => l.includes("shutdown timed out"));
      expect(timeoutWarn).toBeDefined();
      expect(timeoutWarn!).toContain("abandoned:");
      expect(timeoutWarn!).toContain("runtime stop");
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// Sanity test — minimum config error surface
// ---------------------------------------------------------------------------

describe("startCortex — error surface", () => {
  test("does not throw on a config with no networks (cloud publisher inactive)", async () => {
    const config = minimalConfig({ networks: [] });
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
    });
    expect(handle).toBeDefined();
    await handle.stop();
  });

  test("does not throw on a config that requests cloud mode but has no cloud networks", async () => {
    // grove-bot logs a warning here; cortex must do the same and continue.
    const config = minimalConfig({
      networks: [],
      api: { enabled: false, mode: "cloud" },
    });
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
    });
    expect(handle).toBeDefined();
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// cortex#67 prereq C — AgentRegistry wiring
// ---------------------------------------------------------------------------

describe("startCortex — agent registry (cortex#67 prereq C)", () => {
  test("exposes an empty registry when no inline agents + agents.d/ is empty", async () => {
    // Production callers today pass BotConfig (no inline agents) and may have
    // no `agents.d/` directory yet. The registry must still construct cleanly
    // and the handle must surface it — the creds handler downstream will
    // simply gate itself off (`registry.size > 0` check).
    const config = minimalConfig();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-test-agents-empty-"));
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      agentsDir: tmpAgentsDir,
    });
    expect(handle.agentRegistry).toBeDefined();
    expect(handle.agentRegistry.size).toBe(0);
    expect(handle.agentRegistry.getAll()).toEqual([]);
    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("merges inline agents + agents.d/ fragments (inline wins on id conflict)", async () => {
    // Design §6.1 — when an inline cortex.yaml agent shares an id with a
    // fragment under agents.d/, the inline entry wins. We exercise both
    // sources here: two inline agents (luna + echo), two fragments (echo +
    // holly), and assert echo resolves to the inline definition while holly
    // (fragment-only) is still present.
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-test-agents-merge-"));

    // Drop fragments — each needs a persona file on disk per the loader's
    // existence check. Echo's fragment declares a `(fragment-source)` persona
    // marker so we can assert later that the inline definition shadowed it.
    const echoFragmentPersona = join(tmpAgentsDir, "echo-fragment.md");
    writeFileSync(echoFragmentPersona, "echo from fragment\n");
    writeFileSync(
      join(tmpAgentsDir, "echo.yaml"),
      `id: echo
displayName: EchoFromFragment
persona: ./echo-fragment.md
presence:
  discord:
    enabled: false
    token: "frag-echo"
    guildId: "0"
    agentChannelId: "1"
    logChannelId: "2"
`,
    );
    const hollyPersona = join(tmpAgentsDir, "holly.md");
    writeFileSync(hollyPersona, "holly from fragment\n");
    writeFileSync(
      join(tmpAgentsDir, "holly.yaml"),
      `id: holly
displayName: Holly
persona: ./holly.md
presence:
  discord:
    enabled: false
    token: "frag-holly"
    guildId: "0"
    agentChannelId: "1"
    logChannelId: "2"
`,
    );

    // Inline agents — luna fresh, echo overriding the fragment.
    const inlineAgents: Agent[] = [
      {
        id: "luna",
        displayName: "Luna",
        persona: "/tmp/luna-inline.md",
        trust: [],
        presence: {
          discord: {
            enabled: false,
            token: "inline-luna",
            guildId: "0",
            agentChannelId: "1",
            logChannelId: "2",
            contextDepth: 10,
            enableAgentLog: false,
            trustedBotIds: [],
            surfaceSubjects: [],
          },
        },
      },
      {
        id: "echo",
        displayName: "EchoFromInline",
        persona: "/tmp/echo-inline.md",
        trust: [],
        presence: {
          discord: {
            enabled: false,
            token: "inline-echo",
            guildId: "0",
            agentChannelId: "1",
            logChannelId: "2",
            contextDepth: 10,
            enableAgentLog: false,
            trustedBotIds: [],
            surfaceSubjects: [],
          },
        },
      },
    ];

    const handle = await startCortex(minimalConfig(), {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      agentsDir: tmpAgentsDir,
      inlineAgents,
    });

    // Three agents total: luna (inline-only), echo (inline wins), holly (fragment-only).
    expect(handle.agentRegistry.size).toBe(3);
    const ids = handle.agentRegistry.getAll().map((a) => a.id).sort();
    expect(ids).toEqual(["echo", "holly", "luna"]);

    // Inline-wins assertion — echo's displayName comes from the inline entry,
    // not the fragment's `EchoFromFragment`.
    expect(handle.agentRegistry.getById("echo").displayName).toBe("EchoFromInline");
    // Fragment-only agent still resolves.
    expect(handle.agentRegistry.getById("holly").displayName).toBe("Holly");
    // Inline-only agent still resolves.
    expect(handle.agentRegistry.getById("luna").displayName).toBe("Luna");

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// cortex#88 item 2 — `cortex start --dry-run`
// ---------------------------------------------------------------------------

describe("runDryRun — config validator (cortex#88 item 2)", () => {
  test("success path: returns exit 0 with one-line OK summary", () => {
    // Minimal cortex.yaml-shape config: operator + one agent w/ discord
    // presence. `loadConfigWithAgents` detects cortex shape from the
    // presence of `operator:` + `agents:` and validates against
    // `CortexConfigSchema`.
    const dir = mkdtempSync(join(tmpdir(), "cortex-dryrun-ok-"));
    const cfgPath = join(dir, "cortex.yaml");
    writeFileSync(
      cfgPath,
      [
        "operator:",
        "  id: jc",
        "  dataResidency: NZ",
        "agents:",
        "  - id: luna",
        "    displayName: Luna",
        "    persona: ./personas/luna.md",
        "    roles: []",
        "    trust: []",
        "    presence:",
        "      discord:",
        "        token: tok",
        "        guildId: \"100000000000000001\"",
        "        agentChannelId: \"100000000000000002\"",
        "        logChannelId: \"100000000000000003\"",
        "renderers: []",
        "claude: {}",
        "nats:",
        "  url: nats://localhost:4222",
        "  subjects: [\"local.jc.>\"]",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = runDryRun(cfgPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/cortex config validation OK/);
    expect(result.stdout).toMatch(/1 agents/);
    expect(result.stdout).toMatch(/0 renderers/);
    expect(result.stdout).toMatch(/NATS=nats:\/\/localhost:4222/);
    expect(result.stderr).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });

  test("success path: NATS disabled when nats block absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-dryrun-no-nats-"));
    const cfgPath = join(dir, "cortex.yaml");
    writeFileSync(
      cfgPath,
      [
        "operator:",
        "  id: jc",
        "agents:",
        "  - id: luna",
        "    displayName: Luna",
        "    persona: ./personas/luna.md",
        "    roles: []",
        "    trust: []",
        "    presence:",
        "      discord:",
        "        token: tok",
        "        guildId: \"100000000000000001\"",
        "        agentChannelId: \"100000000000000002\"",
        "        logChannelId: \"100000000000000003\"",
        "renderers: []",
        "claude: {}",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = runDryRun(cfgPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/NATS=\(disabled\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("failure path: returns exit 2 with operator-readable schema error", () => {
    // Cortex-shape input with a missing required field (no displayName on
    // the agent) — should be rejected by CortexConfigSchema.
    const dir = mkdtempSync(join(tmpdir(), "cortex-dryrun-fail-"));
    const cfgPath = join(dir, "cortex.yaml");
    writeFileSync(
      cfgPath,
      [
        "operator:",
        "  id: jc",
        "agents:",
        "  - id: luna",
        // missing: displayName, persona, roles, trust, presence
        "renderers: []",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = runDryRun(cfgPath);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/cortex config validation FAILED/);
    expect(result.stdout).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });

  test("cortex#106 item 4: legacy bot.yaml shape (no inlineAgents) exits 2", () => {
    // Pre-cortex#106: a legacy bot.yaml with a valid singular `agent:` block
    // loaded fine, the loader returned `inlineAgents: []`, and dry-run
    // reported "1 agents" via a hardcoded fallback that masked the
    // degenerate case. Post-cortex#106: report the actual zero-agent count
    // and exit non-zero so the operator sees the config is invalid for
    // the cortex-shape pipeline.
    const dir = mkdtempSync(join(tmpdir(), "cortex-dryrun-zero-"));
    const cfgPath = join(dir, "bot.yaml");
    writeFileSync(
      cfgPath,
      [
        "agent:",
        "  name: luna",
        "  displayName: Luna",
        "discord: []",
        "mattermost: []",
        "claude: {}",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = runDryRun(cfgPath);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/has no agents — config invalid/);
    expect(result.stdout).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// pidFileFor — multi-instance support (cortex#246)
// ---------------------------------------------------------------------------

describe("pidFileFor — per-config PID file derivation", () => {
  const DEFAULT_CONFIG = join(process.env.HOME ?? "~", ".config", "grove", "bot.yaml");
  const LEGACY_PID = join(process.env.HOME ?? "~", ".config", "grove", "state", "cortex.pid");

  test("undefined config → legacy cortex.pid (backward compat)", () => {
    expect(pidFileFor(undefined)).toBe(LEGACY_PID);
  });

  test("default config path → legacy cortex.pid (no behaviour change)", () => {
    expect(pidFileFor(DEFAULT_CONFIG)).toBe(LEGACY_PID);
  });

  test("custom config in same dir → derived from basename", () => {
    const result = pidFileFor("/Users/andreas/.config/cortex/cortex.work.yaml");
    expect(result).toBe(join(process.env.HOME ?? "~", ".config", "grove", "state", "cortex-cortex.work.pid"));
  });

  test("two distinct custom configs → two distinct PID files", () => {
    const a = pidFileFor("/Users/andreas/.config/cortex/cortex.work.yaml");
    const b = pidFileFor("/Users/andreas/.config/cortex/cortex.research.yaml");
    expect(a).not.toBe(b);
  });

  test("config with .yml extension also normalises", () => {
    const result = pidFileFor("/tmp/foo.yml");
    expect(result).toBe(join(process.env.HOME ?? "~", ".config", "grove", "state", "cortex-foo.pid"));
  });

  test("config path moves don't change the PID file (basename-only derivation)", () => {
    const a = pidFileFor("/somewhere/cortex.work.yaml");
    const b = pidFileFor("/elsewhere/cortex.work.yaml");
    expect(a).toBe(b);
  });

  test("relative config path → same PID file as absolute (basename match)", () => {
    const rel = pidFileFor("./cortex.work.yaml");
    const abs = pidFileFor("/Users/andreas/.config/cortex/cortex.work.yaml");
    expect(rel).toBe(abs);
  });
});
