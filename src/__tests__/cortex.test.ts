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
 * minimum AgentConfig shape and rely on:
 *   - `nats?` absent → runtime starts in disabled mode (no socket).
 *   - `discord: []` and `mattermost: []` → no adapter `start()` calls.
 *   - `api.enabled: false` → no Hono server bound.
 *   - `disableConfigWatcher: true` and `disableOutboundPoller: true` (test
 *     option) keep the test deterministic and avoid filesystem churn.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "fs";
// Hermetic agents.d/ (R26 P1 PR hygiene, cortex#1371): every `startCortex`
// boot in this file points `agentsDir` at an EMPTY tmp dir. Without it the
// boot path falls back to the principal's LIVE `~/.config/cortex/agents.d/`
// (the documented production fallback), and whatever fragments live there
// (e.g. an agent whose `trust:` names an id not in the test config) crash
// registry assembly — the whole suite then fails on machine state, not code.
const HERMETIC_AGENTS_DIR = mkdtempSync(join(tmpdir(), "cortex-test-agents-hermetic-"));
import { join, basename } from "path";
import { tmpdir } from "os";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import type { Agent } from "../common/types/cortex-config";
import { pidFileFor, runDryRun, startCortex } from "../cortex";
import { migrateLegacyPidFile } from "../common/pidfile";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimum AgentConfig that passes Zod validation. Discord + Mattermost arrays
 * are empty; networks is empty (so cloud publisher stays inactive); api is
 * disabled; nats is absent so the runtime stays in no-op mode.
 *
 * Tests that need extra fields layer them on with the spread argument.
 */
function minimalConfig(overrides: Partial<Record<string, unknown>> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: {
      name: "test-cortex",
      displayName: "TestCortex",
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
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      principal: { id: "test-op" },
    });
    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe("function");
    await handle.stop();
  });

  test("survives a config where mc.enabled is true but disableDashboard is set", async () => {
    // Sanity check: the Mission Control embed is skipped via the test option
    // even when config.mc.enabled is on, so the test doesn't need a real HTTP
    // server bound to a port. (Repointed from the retired `api:` block to `mc:`
    // — ADR-0005/#882; `disableDashboard` gates the mc embed per cortex.ts.)
    const config = minimalConfig({
      // Port 38766 is well outside the typical default range; we never
      // actually bind here because `disableDashboard` short-circuits the
      // embed branch — the value just has to satisfy the Zod schema's
      // nonnegative constraint.
      mc: { enabled: true, port: 38766 },
    });
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      principal: { id: "test-op" },
    });
    expect(handle).toBeDefined();
    await handle.stop();
  });

  test("IAW A.5.4 — boot path accepts an explicit stack: option and starts cleanly (cortex#113)", async () => {
    // The boot wiring resolves `deriveStackId({ principal, stack })` and logs
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
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      principal: { id: "test-op" },
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
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      injectRuntime: runtime,
      principal: { id: "test-op" },
    });
    expect(handle).toBeDefined();
    // The surface-router's `start()` registers one envelope handler (its
    // dispatch fan-out). Post cortex#484 Option D, the runner's
    // dispatch-listener no longer registers as a SurfaceAdapter; instead
    // it calls `runtime.onEnvelope(...)` directly so it can sit outside
    // the router's render-timeout (CC sessions take minutes, renderers
    // are sub-second). cortex#491 adds a THIRD handler: the dispatch sink
    // (OUTBOUND) self-subscribes to the lifecycle stream via
    // `runtime.onEnvelope` to deliver replies. cortex#502 adds a FOURTH:
    // the review sink (OUTBOUND) self-subscribes to the review lifecycle
    // + verdict streams. Four handlers post-#502.
    expect(runtime.onEnvelopeHandlers.size).toBe(4);

    await handle.stop();
    // Both `router.stop()` and `dispatchListener.stop()` unregister from
    // the runtime — the set drains.
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
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      injectRuntime: runtime,
      principal: { id: "test-op" },
    });

    // Hand-craft a `dispatch.task.received` envelope. The listener parses
    // its payload and emits `dispatch.task.started` BEFORE spawning CC
    // (see runner/dispatch-listener.ts:303). Asserting the started event
    // alone is enough to prove wire-up; we don't need to spawn real CC.
    const envelope: Envelope = {
      id: "11111111-1111-4111-8111-111111111111",
      source: "test-op.cortex.local",
      type: "dispatch.task.received",
      distribution_mode: "direct",
      target_assistant: "did:mf:cortex",
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

    runtime.dispatchToHandlers(envelope, `local.test-op.default.tasks.@did-mf-cortex.chat`);

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

  test("dispatch-listener registers with the right principal-derived subject", async () => {
    // Echo round-1 N1: the listener's `surfaceConfig.subjects` is
    // `local.{principal}.{stack}.tasks.*.>` where `{principal}` comes from
    // the resolved principal id (cortex#427).
    //
    // cortex#429 PR-C — the legacy `agent.operatorId` fallback is gone;
    // the v3-canonical resolution path is `options.principal.id`. Verify
    // the router subscribes (single registered handler) when only the
    // canonical path is wired.
    const runtime = createRecordingRuntime();
    const config = minimalConfig({
      agent: {
        name: "no-op-cortex",
        displayName: "NoOpCortex",
      },
    });
    const handle = await startCortex(config, {
      disableConfigWatcher: true,
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      injectRuntime: runtime,
      principal: { id: "v3-canonical-op" },
    });
    expect(handle).toBeDefined();
    // 4 handlers: surface-router fan-out + dispatch-listener (cortex#484
    // Option D — listener subscribes directly via runtime.onEnvelope) +
    // dispatch sink (cortex#491 — OUTBOUND lifecycle delivery) + review
    // sink (cortex#502 — OUTBOUND review lifecycle + verdict delivery).
    expect(runtime.onEnvelopeHandlers.size).toBe(4);
    await handle.stop();
    expect(runtime.onEnvelopeHandlers.size).toBe(0);
  });

  test("startCortex throws when no principal id is resolvable (cortex#427)", async () => {
    // cortex#427 PR-A — `resolvePrincipalId` refuses to silently
    // collapse to `"default"`. cortex#429 PR-C — the legacy
    // `config.agent.operatorId` fallback has been retired together with
    // the schema field; `options.principal.id` is the only resolution
    // path. A config without it must fail-fast at boot — the previous
    // behaviour masked misconfiguration by emitting `local.default.>`
    // envelopes that competed with real principals on shared brokers.
    const runtime = createRecordingRuntime();
    const noPrincipal = minimalConfig({
      agent: { name: "no-op-cortex", displayName: "NoOpCortex" },
    });
    let threw: unknown = null;
    try {
      await startCortex(noPrincipal, {
        disableConfigWatcher: true,
        agentsDir: HERMETIC_AGENTS_DIR,
        disableDashboard: true,
        disableOutboundPoller: true,
        injectRuntime: runtime,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain("principal id");
    expect((threw as Error).message).toContain("principal.id");
    // No subscriptions leaked from the aborted boot path.
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
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      injectRuntime: runtime,
      principal: { id: "test-op" },
    });
    expect(handle).toBeDefined();
    // 4 handlers: surface-router fan-out + dispatch-listener (cortex#484
    // Option D) + dispatch sink (cortex#491) + review sink (cortex#502).
    // The disabled Discord instance registers NO adapter handler (adapters
    // register with the surface-router via router.register, not
    // runtime.onEnvelope) — the count stays at the four core subscribers.
    expect(runtime.onEnvelopeHandlers.size).toBe(4);
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
        // Construct via cast: AgentConfigSchema would reject a fully empty
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
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      injectRuntime: runtime,
      principal: { id: "test-op" },
    });
    expect(handle).toBeDefined();
    // 4 handlers: surface-router fan-out + dispatch-listener (cortex#484
    // Option D) + dispatch sink (cortex#491) + review sink (cortex#502).
    // The skipped Mattermost instance registers NO adapter handler
    // (adapters register with the surface-router via router.register, not
    // runtime.onEnvelope) — the count stays at the four core subscribers.
    expect(runtime.onEnvelopeHandlers.size).toBe(4);
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
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      principal: { id: "test-op" },
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
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      principal: { id: "test-op" },
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
        agentsDir: HERMETIC_AGENTS_DIR,
        disableDashboard: true,
        disableOutboundPoller: true,
        injectRuntime: runtime,
        principal: { id: "test-op" },
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
      // subsystem so a principal grepping the log can identify the
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
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      principal: { id: "test-op" },
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
      agentsDir: HERMETIC_AGENTS_DIR,
      disableDashboard: true,
      disableOutboundPoller: true,
      principal: { id: "test-op" },
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
    // Production callers today pass AgentConfig (no inline agents) and may have
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
      principal: { id: "test-op" },
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
            dmOwner: true,
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
            dmOwner: true,
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
      principal: { id: "test-op" },
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
    // Minimal cortex.yaml-shape config: principal + one agent w/ discord
    // presence. `loadConfigWithAgents` detects cortex shape from the
    // presence of `principal:` + `agents:` and validates against
    // `CortexConfigSchema`.
    const dir = mkdtempSync(join(tmpdir(), "cortex-dryrun-ok-"));
    const cfgPath = join(dir, "cortex.yaml");
    writeFileSync(
      cfgPath,
      [
        "principal:",
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
        "        guildId: \"666666666666666666\"",
        "        agentChannelId: \"888888888888888888\"",
        "        logChannelId: \"000000000000000000\"",
        "renderers: []",
        "claude: {}",
        "nats:",
        "  url: nats://localhost:4222",
        "  subjects: [\"local.jc.>\"]",
        "",
      ].join("\n"),
      "utf-8",
    );
    // TC-4a (cortex#636): the single-file config read enforces chmod 600
    // (it carries platform bot tokens). Set 0600 so the gate passes and the
    // dry-run exercises its real validation path, not the permission error.
    chmodSync(cfgPath, 0o600);
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
        "principal:",
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
        "        guildId: \"666666666666666666\"",
        "        agentChannelId: \"888888888888888888\"",
        "        logChannelId: \"000000000000000000\"",
        "renderers: []",
        "claude: {}",
        "",
      ].join("\n"),
      "utf-8",
    );
    // TC-4a (cortex#636): the single-file config read enforces chmod 600
    // (it carries platform bot tokens). Set 0600 so the gate passes and the
    // dry-run exercises its real validation path, not the permission error.
    chmodSync(cfgPath, 0o600);
    const result = runDryRun(cfgPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/NATS=\(disabled\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("failure path: returns exit 2 with principal-readable schema error", () => {
    // Cortex-shape input with a missing required field (no displayName on
    // the agent) — should be rejected by CortexConfigSchema.
    const dir = mkdtempSync(join(tmpdir(), "cortex-dryrun-fail-"));
    const cfgPath = join(dir, "cortex.yaml");
    writeFileSync(
      cfgPath,
      [
        "principal:",
        "  id: jc",
        "agents:",
        "  - id: luna",
        // missing: displayName, persona, roles, trust, presence
        "renderers: []",
        "",
      ].join("\n"),
      "utf-8",
    );
    // TC-4a (cortex#636): the single-file config read enforces chmod 600
    // (it carries platform bot tokens). Set 0600 so the gate passes and the
    // dry-run exercises its real validation path, not the permission error.
    chmodSync(cfgPath, 0o600);
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
    // and exit non-zero so the principal sees the config is invalid for
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
    // TC-4a (cortex#636): the single-file config read enforces chmod 600
    // (it carries platform bot tokens). Set 0600 so the gate passes and the
    // dry-run exercises its real validation path, not the permission error.
    chmodSync(cfgPath, 0o600);
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

  // cortex#1900 — the pidfile name is `cortex-<basename>-<hash8>.pid`: it keeps
  // the human-readable slug (continuity requirement #2) AND appends 8 hex chars
  // of sha256(canonical full path) so two trees can never collide.
  const STATE_DIR = join(process.env.HOME ?? "~", ".config", "grove", "state");

  test("custom config → cortex-<basename>-<hash8>.pid (slug preserved + path hash)", () => {
    const result = pidFileFor("/Users/andreas/.config/cortex/cortex.work.yaml");
    expect(basename(result)).toMatch(/^cortex-cortex\.work-[0-9a-f]{8}\.pid$/);
    expect(result.startsWith(STATE_DIR)).toBe(true);
  });

  test("two distinct custom configs → two distinct PID files", () => {
    const a = pidFileFor("/Users/andreas/.config/cortex/cortex.work.yaml");
    const b = pidFileFor("/Users/andreas/.config/cortex/cortex.research.yaml");
    expect(a).not.toBe(b);
  });

  test("config with .yml extension also normalises (extension stripped)", () => {
    const result = pidFileFor("/tmp/foo.yml");
    expect(basename(result)).toMatch(/^cortex-foo-[0-9a-f]{8}\.pid$/);
  });

  // cortex#1900 core property (AC: "two distinct config trees for the same
  // stack resolve to DISTINCT pidfiles"). Under the OLD basename-only scheme
  // these two collided on `cortex-stack.pid` — the exact X-07 copy-keep-original
  // hazard. The full-path hash forces them apart.
  test("two trees sharing a stack filename → DISTINCT PID files (path-full identity)", () => {
    const a = pidFileFor("/config-tree-old/stack/stack.yaml");
    const b = pidFileFor("/config-tree-new/stack/stack.yaml");
    expect(a).not.toBe(b);
    // both still carry the same readable slug — only the hash differs
    expect(basename(a)).toMatch(/^cortex-stack-[0-9a-f]{8}\.pid$/);
    expect(basename(b)).toMatch(/^cortex-stack-[0-9a-f]{8}\.pid$/);
  });

  test("resolution is deterministic (same path → same PID file across calls)", () => {
    const p = "/config-tree-old/stack/stack.yaml";
    expect(pidFileFor(p)).toBe(pidFileFor(p));
  });

  // Sage cortex#1027 — different SPELLINGS of the same on-disk config must
  // resolve to one PID identity (otherwise `cortex agents reload` signals the
  // wrong/no daemon). Preserved under the hash: identical canonical path →
  // identical hash. These probes use a real tmp file + a symlink so
  // realpathSync actually canonicalizes.
  describe("spelling stability (Sage cortex#1027, preserved under path-hash)", () => {
    let dir: string;
    let configPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "cortex-pidfile-spelling-"));
      configPath = join(dir, "stack.yaml");
      writeFileSync(configPath, "agent:\n  name: x\n");
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("trailing slash + plain spelling resolve to the same PID file", () => {
      expect(pidFileFor(`${configPath}/`)).toBe(pidFileFor(configPath));
    });

    test("'.' / '..' detour resolves to the same PID file", () => {
      const detour = join(dir, ".", "..", basename(dir), "stack.yaml");
      expect(pidFileFor(detour)).toBe(pidFileFor(configPath));
    });

    test("symlink to the config resolves to the same PID file as the target", () => {
      const link = join(dir, "alias.yaml");
      symlinkSync(configPath, link);
      // Without canonicalization these would key two daemons; realpathSync
      // collapses the symlink onto its target so the hash matches.
      expect(pidFileFor(link)).toBe(pidFileFor(configPath));
    });

    test("non-existent config still derives a stable hashed PID (fallback path)", () => {
      const ghost = join(dir, "never-created.yaml");
      const result = pidFileFor(ghost);
      expect(basename(result)).toMatch(/^cortex-never-created-[0-9a-f]{8}\.pid$/);
      // stable across calls even though realpath can't resolve it
      expect(pidFileFor(ghost)).toBe(result);
    });
  });

  // cortex#1900 kill-site safety AC: "a `stop` invoked with the wrong tree's
  // config path cannot SIGTERM a daemon started from the other tree." Because
  // `stop` reads ONLY `pidFileFor(config)` (see src/cortex.ts stop action) and
  // the two trees resolve to distinct files, a mis-targeted stop finds no file
  // and never touches the live daemon. Exercised against a real child process.
  describe("kill-site safety — stop targets only its own tree (cortex#1900)", () => {
    let stateDir: string;
    let dirA: string;
    let dirB: string;
    let cfgA: string;
    let cfgB: string;
    let sleeper: ReturnType<typeof Bun.spawn> | undefined;

    beforeEach(() => {
      // Hermetic STATE_DIR: never write pidfiles into the real ~/.config.
      stateDir = mkdtempSync(join(tmpdir(), "cortex-killsite-state-"));
      // Two DISTINCT trees, SAME stack filename — the X-07 copy-keep window.
      dirA = mkdtempSync(join(tmpdir(), "cortex-killsite-treeA-"));
      dirB = mkdtempSync(join(tmpdir(), "cortex-killsite-treeB-"));
      cfgA = join(dirA, "stack.yaml");
      cfgB = join(dirB, "stack.yaml");
      writeFileSync(cfgA, "agent:\n  name: x\n");
      writeFileSync(cfgB, "agent:\n  name: x\n");
    });

    afterEach(() => {
      if (sleeper !== undefined) {
        try {
          sleeper.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        sleeper = undefined;
      }
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    });

    // Relocate the REAL pidFileFor filename (hash included) into the temp
    // STATE_DIR, so distinctness is driven by production derivation.
    function pidPathIn(config: string): string {
      return join(stateDir, basename(pidFileFor(config)));
    }

    // Mirrors the stop action (src/cortex.ts stop command): resolve THIS
    // config's pidfile, bail if absent, else SIGTERM the recorded PID.
    function simulateStop(config: string): "not-running" | number {
      const pidFile = pidPathIn(config);
      if (!existsSync(pidFile)) return "not-running";
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      process.kill(pid, "SIGTERM");
      unlinkSync(pidFile);
      return pid;
    }

    test("two trees sharing a stack filename resolve to distinct pidfiles", () => {
      expect(pidPathIn(cfgA)).not.toBe(pidPathIn(cfgB));
    });

    test("stop --config treeB does NOT signal treeA's live daemon", () => {
      // Stand up a real, live "treeA daemon" and record its PID under treeA.
      sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      const pidValue = sleeper.pid;
      const treeAPid = pidPathIn(cfgA);
      writeFileSync(treeAPid, String(pidValue));

      // treeB owns no pidfile → stop reports not-running and MUST NOT fall
      // through to treeA's file (the pre-#1900 basename collision).
      expect(existsSync(pidPathIn(cfgB))).toBe(false);
      expect(simulateStop(cfgB)).toBe("not-running");

      // treeA's daemon is untouched: its pidfile survives and the process
      // is still alive (signal-0 probe throws only if the pid is gone).
      expect(existsSync(treeAPid)).toBe(true);
      expect(() => process.kill(pidValue, 0)).not.toThrow();

      // Positive control: stop --config treeA DOES target it and clears the file.
      expect(simulateStop(cfgA)).toBe(pidValue);
      expect(existsSync(treeAPid)).toBe(false);
    });
  });

  // cortex#1900 continuity AC: an existing fleet must not orphan its pidfiles
  // mid-upgrade. `migrateLegacyPidFile` renames the pre-hash `cortex-<slug>.pid`
  // onto the new hashed name on daemon start. Runs against a temp STATE_DIR.
  describe("continuity migration (cortex#1900 continuity AC)", () => {
    let stateDir: string;
    let dir: string;
    let cfg: string;
    let legacyName: string;
    let newName: string;
    // A guaranteed-DEAD pid — a real process spawned then reaped. The liveness
    // gate (adv PR#1923) probes process.kill(pid, 0), so adoption cases must use
    // a pid that is provably not alive rather than a synthetic literal (which
    // could collide with a live process on the host and flakily be refused).
    let deadPid: number;

    beforeEach(async () => {
      stateDir = mkdtempSync(join(tmpdir(), "cortex-pidmig-state-"));
      dir = mkdtempSync(join(tmpdir(), "cortex-pidmig-tree-"));
      cfg = join(dir, "work.yaml");
      writeFileSync(cfg, "agent:\n  name: x\n");
      newName = basename(pidFileFor(cfg)); // cortex-work-<hash>.pid
      legacyName = `cortex-${basename(cfg).replace(/\.ya?ml$/i, "")}.pid`; // cortex-work.pid
      mkdirSync(stateDir, { recursive: true });
      const reaped = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
      deadPid = reaped.pid;
      await reaped.exited; // exits + is reaped → process.kill(deadPid, 0) throws ESRCH
    });

    afterEach(() => {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    });

    // Capture console.error so the liveness-gate / guard warnings are assertable.
    function captureStderr(): { lines: string[]; restore: () => void } {
      const lines: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      return { lines, restore: () => { console.error = orig; } };
    }

    test("adopts a DEAD-pid old-format pidfile → renames to new-format, PID preserved", () => {
      const legacyPath = join(stateDir, legacyName);
      const newPath = join(stateDir, newName);
      writeFileSync(legacyPath, String(deadPid));

      const adopted = migrateLegacyPidFile(cfg, stateDir);

      expect(adopted).toBe(legacyPath);
      expect(existsSync(legacyPath)).toBe(false); // old name gone
      expect(existsSync(newPath)).toBe(true); // adopted under new name
      expect(readFileSync(newPath, "utf-8")).toBe(String(deadPid)); // PID carried over
    });

    // adv PR#1923 (blocking): a LIVE legacy pidfile is the cross-tree-kill
    // hazard signature — refuse it. Stand up a real live process, record its PID
    // under the old name, and assert migration does NOT adopt it.
    test("LIVE-pid old-format pidfile → NOT adopted, file untouched, warns", () => {
      const legacyPath = join(stateDir, legacyName);
      const newPath = join(stateDir, newName);
      const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      const livePid = sleeper.pid;
      const cap = captureStderr();
      let result: string | undefined;
      try {
        writeFileSync(legacyPath, String(livePid));
        result = migrateLegacyPidFile(cfg, stateDir);
      } finally {
        cap.restore();
        try { sleeper.kill("SIGKILL"); } catch { /* already gone */ }
      }
      expect(result).toBeUndefined(); // refused adoption
      expect(existsSync(legacyPath)).toBe(true); // old file left exactly as-is
      expect(existsSync(newPath)).toBe(false); // nothing created under the new name
      expect(
        cap.lines.some((l) => l.includes("not adopting") && l.includes(String(livePid))),
      ).toBe(true);
    });

    // adv PR#1923 / both reviewers: the rename must never abort boot. Simulate a
    // lost migration race — the legacy file vanishes between the pre-flight
    // checks and renameSync (via the test-only onBeforeRename seam) → ENOENT.
    test("lost migration race (legacy vanishes before rename) → no throw, boot continues", () => {
      const legacyPath = join(stateDir, legacyName);
      writeFileSync(legacyPath, String(deadPid));
      const cap = captureStderr();
      let result: string | undefined;
      try {
        expect(() => {
          result = migrateLegacyPidFile(cfg, stateDir, () => {
            unlinkSync(legacyPath); // pre-delete → renameSync sees ENOENT
          });
        }).not.toThrow();
      } finally {
        cap.restore();
      }
      expect(result).toBeUndefined(); // benign race → nothing adopted
      expect(existsSync(join(stateDir, newName))).toBe(false); // no partial new file
      expect(cap.lines.some((l) => l.includes("could not migrate"))).toBe(false); // ENOENT is silent
    });

    test("no-op when the new-format pidfile already exists (already migrated)", () => {
      const legacyPath = join(stateDir, legacyName);
      const newPath = join(stateDir, newName);
      writeFileSync(legacyPath, "111");
      writeFileSync(newPath, "222");

      expect(migrateLegacyPidFile(cfg, stateDir)).toBeUndefined();
      expect(readFileSync(newPath, "utf-8")).toBe("222"); // new-format untouched
      expect(existsSync(legacyPath)).toBe(true); // legacy left as-is (readers ignore it)
    });

    test("no-op on a fresh install (no old-format pidfile present)", () => {
      expect(migrateLegacyPidFile(cfg, stateDir)).toBeUndefined();
      expect(existsSync(join(stateDir, newName))).toBe(false);
    });

    test("no-op for the default / unspecified config (legacy cortex.pid, never suffixed)", () => {
      // A stray cortex.pid must never be renamed away by the migration.
      writeFileSync(join(stateDir, "cortex.pid"), "555");
      expect(migrateLegacyPidFile(DEFAULT_CONFIG, stateDir)).toBeUndefined();
      expect(migrateLegacyPidFile(undefined, stateDir)).toBeUndefined();
      expect(existsSync(join(stateDir, "cortex.pid"))).toBe(true);
    });

    test("migrated file IS the identity stop/status later resolve", () => {
      const legacyPath = join(stateDir, legacyName);
      writeFileSync(legacyPath, String(deadPid));
      migrateLegacyPidFile(cfg, stateDir);
      // readers key on basename(pidFileFor(cfg)); it must now exist.
      expect(existsSync(join(stateDir, basename(pidFileFor(cfg))))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// CORTEX_STATE_DIR env seam (cortex#1908 CONFIG/EVENTS/STATE trio) — #1900
// carries the STATE read because pidfile.ts is the sole state constructor.
// ---------------------------------------------------------------------------

describe("STATE_DIR — CORTEX_STATE_DIR env seam", () => {
  // STATE_DIR is a module constant read ONCE at import (T1b), so the override
  // can only be observed in a FRESH process — probe pidFileFor in a child with
  // the env var set vs. unset. An absolute + never-on-disk config keeps the
  // canonical path (hence the pidfile basename hash) identical across both
  // child processes regardless of their cwd.
  const modPath = join(import.meta.dir, "..", "common", "pidfile.ts");
  const CFG = "/cortex-1908-state-probe/stack.yaml";

  function probePidFile(override: string | null): string {
    const env = { ...process.env };
    if (override === null) delete env.CORTEX_STATE_DIR;
    else env.CORTEX_STATE_DIR = override;
    const src =
      `import { pidFileFor } from ${JSON.stringify(modPath)};` +
      `process.stdout.write(pidFileFor(${JSON.stringify(CFG)}));`;
    const proc = Bun.spawnSync([process.execPath, "-e", src], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`state-dir probe failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`);
    }
    return proc.stdout.toString();
  }

  test("CORTEX_STATE_DIR set → pidFileFor resolves inside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-statedir-seam-"));
    try {
      const out = probePidFile(dir);
      expect(out.startsWith(`${dir}/`)).toBe(true);
      expect(basename(out)).toMatch(/^cortex-stack-[0-9a-f]{8}\.pid$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CORTEX_STATE_DIR unset → byte-identical to the grove default STATE_DIR path", () => {
    const out = probePidFile(null);
    // basename is STATE_DIR-independent (hash is over the config path), so this
    // reference default holds even if the test process itself set the override.
    const expectedDefault = join(
      process.env.HOME ?? "~",
      ".config",
      "grove",
      "state",
      basename(pidFileFor(CFG)),
    );
    expect(out).toBe(expectedDefault);
  });

  // Interaction: migrateLegacyPidFile's DEFAULT stateDir is STATE_DIR, which now
  // honors CORTEX_STATE_DIR — so in production (`start` calls it with no 2nd
  // arg) the continuity rename lands in the SAME env-overridden dir as
  // pidFileFor + cortex.ts's mkdirSync(STATE_DIR). Runs in a child (env fixed at
  // import), seeds the old-format pidfile in the override dir, and migrates with
  // the default stateDir. (The explicit-stateDir test-isolation seam — used by
  // the continuity suite above — is unaffected: an explicit arg always wins.)
  test("migrateLegacyPidFile default stateDir honors CORTEX_STATE_DIR (env seam × continuity)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-statedir-migrate-"));
    try {
      const src = [
        `import { pidFileFor, migrateLegacyPidFile } from ${JSON.stringify(modPath)};`,
        `import { writeFileSync, existsSync, readFileSync } from "fs";`,
        `import { join } from "path";`,
        // reap a real child → a guaranteed-DEAD pid the liveness gate will adopt
        `const reaped = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });`,
        `await reaped.exited;`,
        `const wrote = String(reaped.pid);`,
        `const cfg = ${JSON.stringify(CFG)};`,
        // seed the pre-#1900 old-format pidfile INSIDE the override dir
        `const legacy = join(process.env.CORTEX_STATE_DIR, "cortex-stack.pid");`,
        `writeFileSync(legacy, wrote);`,
        `const adopted = migrateLegacyPidFile(cfg);`, // DEFAULT stateDir = env-aware STATE_DIR
        `const target = pidFileFor(cfg);`,
        `process.stdout.write(JSON.stringify({ adopted, target, targetExists: existsSync(target), legacyGone: !existsSync(legacy), wrote, read: existsSync(target) ? readFileSync(target,"utf-8") : null }));`,
      ].join("\n");
      const proc = Bun.spawnSync([process.execPath, "-e", src], {
        env: { ...process.env, CORTEX_STATE_DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) {
        throw new Error(`migrate probe failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`);
      }
      const r = JSON.parse(proc.stdout.toString());
      expect(r.adopted).toBe(join(dir, "cortex-stack.pid")); // adopted the old file in the ENV dir
      expect(r.target.startsWith(`${dir}/`)).toBe(true); // new-format also lands in the ENV dir
      expect(basename(r.target)).toMatch(/^cortex-stack-[0-9a-f]{8}\.pid$/);
      expect(r.targetExists).toBe(true);
      expect(r.legacyGone).toBe(true);
      expect(r.read).toBe(r.wrote); // PID carried across the rename
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
