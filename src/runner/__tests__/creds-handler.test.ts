/**
 * cortex#67 prereq C — creds-handler stub tests.
 *
 * The stub's surface is intentionally minimal: a factory that accepts a
 * runtime + registry and returns a `{ start, stop }` handle whose methods
 * are idempotent no-ops. We assert the surface shape + idempotence so the
 * future replacement (cortex#67 full implementation) is constrained to keep
 * those guarantees.
 *
 * Scope:
 *   - createCredsHandler returns a CredsHandler with async start/stop
 *   - start() is idempotent (calling twice does not throw)
 *   - stop() is idempotent (calling twice does not throw)
 *   - stop() before start() is safe (no preconditions on lifecycle order)
 *   - start() resolves quickly (the stub does no real work)
 *
 * Out of scope (lands with cortex#67):
 *   - JWT minting per agent capability set
 *   - Account signing key handling
 *   - Refresh-timer behaviour
 *   - Publishing minted creds via the runtime
 */

import { describe, expect, test } from "bun:test";

import { createCredsHandler, type CredsHandlerOpts } from "../creds-handler";
import { AgentRegistry } from "../../common/agents/registry";
import type { Agent } from "../../common/types/cortex-config";
import type { MyelinRuntime } from "../../bus/myelin/runtime";

// =============================================================================
// Fixture builders
// =============================================================================

/**
 * Disabled MyelinRuntime — the stub doesn't touch the runtime, but the type
 * requires one. A `enabled: false` no-op runtime is the minimal shape that
 * compiles; once cortex#67 actually publishes creds via `runtime.publish`,
 * the test will swap this for a recording fake.
 */
function fakeRuntime(): MyelinRuntime {
  return {
    enabled: false,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: async () => {},
    stop: async () => {},
  };
}

/**
 * Single-agent registry — enough to satisfy the stub's `registry` opt without
 * needing to wire trust-closure validation against multiple peers. The agent's
 * `runtime.capabilities` field is what cortex#67 will read; we set a
 * non-empty value here so a future test that exercises the real handler can
 * assert the capability flowed into the minted JWT.
 */
function fakeRegistry(): AgentRegistry {
  const agent: Agent = {
    id: "scout",
    displayName: "Scout",
    persona: "/tmp/scout-persona.md",
    roles: [],
    trust: [],
    presence: {
      discord: {
        enabled: false,
        token: "fake",
        guildId: "0",
        agentChannelId: "1",
        logChannelId: "2",
        contextDepth: 10,
        enableAgentLog: false,
        roles: [],
        defaultRole: "allow-all",
        dm: {
          operatorRole: {
            features: ["chat", "async", "team"],
            disallowedTools: [],
            bashGuard: true,
          },
          defaultRole: "denied",
          userRoles: [],
        },
      },
    },
    runtime: {
      substrate: "claude-code",
      mode: "in-process",
      capabilities: ["research"],
    },
  } as Agent;
  return AgentRegistry.fromAgents([agent]);
}

function fakeOpts(): CredsHandlerOpts {
  return { runtime: fakeRuntime(), registry: fakeRegistry() };
}

// =============================================================================
// Surface shape
// =============================================================================

describe("createCredsHandler — surface", () => {
  test("returns a handle with async start and stop methods", () => {
    const handle = createCredsHandler(fakeOpts());
    expect(handle).toBeDefined();
    expect(typeof handle.start).toBe("function");
    expect(typeof handle.stop).toBe("function");
  });

  test("start() returns a Promise", () => {
    const handle = createCredsHandler(fakeOpts());
    const result = handle.start();
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  test("stop() returns a Promise", () => {
    const handle = createCredsHandler(fakeOpts());
    const result = handle.stop();
    expect(result).toBeInstanceOf(Promise);
    return result;
  });
});

// =============================================================================
// Idempotence — the stub MUST tolerate repeated lifecycle calls. The full
// cortex#67 handler will share this guarantee (the cortex.ts shutdown drain
// calls stop() once but a future signal-handler retry path could land here).
// =============================================================================

describe("createCredsHandler — idempotent lifecycle (stub)", () => {
  test("start() can be called twice without throwing", async () => {
    const handle = createCredsHandler(fakeOpts());
    await handle.start();
    await handle.start();
  });

  test("stop() can be called twice without throwing", async () => {
    const handle = createCredsHandler(fakeOpts());
    await handle.start();
    await handle.stop();
    await handle.stop();
  });

  test("stop() before start() is a safe no-op", async () => {
    // Defensive: a caller that constructs a handler and then bails before
    // start() (e.g. an upstream gate threw) must still be able to call
    // stop() during shutdown without exploding.
    const handle = createCredsHandler(fakeOpts());
    await handle.stop();
  });

  test("start() resolves promptly — stub does no real work", async () => {
    const handle = createCredsHandler(fakeOpts());
    const before = Date.now();
    await handle.start();
    const elapsed = Date.now() - before;
    // Generous upper bound — the stub should resolve in microseconds. We
    // assert <100ms so this test doesn't flake on a loaded CI runner while
    // still catching a regression where the future real handler accidentally
    // ships in stub-shape but with real work tacked on.
    expect(elapsed).toBeLessThan(100);
  });
});

// =============================================================================
// Opts handling — the stub captures opts in its closure (today the body is a
// no-op but cortex#67 will use them); ensure construction with valid opts
// succeeds for both empty and populated registries.
// =============================================================================

describe("createCredsHandler — opts", () => {
  test("accepts a registry with zero agents (caller responsible for gating)", () => {
    // cortex.ts gates `agentRegistry.size > 0` BEFORE calling
    // createCredsHandler — but the factory itself should not enforce a
    // non-empty registry. Keeps the contract symmetric with the future
    // real handler (which might still want to construct against an empty
    // registry to register a "no agents yet" sentinel).
    const opts: CredsHandlerOpts = {
      runtime: fakeRuntime(),
      registry: AgentRegistry.fromAgents([]),
    };
    expect(() => createCredsHandler(opts)).not.toThrow();
  });

  test("accepts a registry with agents declaring runtime.capabilities", () => {
    // The motivating use case for cortex#67: each agent's `runtime.capabilities`
    // bounds the NATS user permissions on its minted JWT. The stub doesn't
    // read it yet but the factory must accept the shape.
    expect(() => createCredsHandler(fakeOpts())).not.toThrow();
  });
});
