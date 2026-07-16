/**
 * API-P0.4 (epic #2055, Phase 0) — inference provider registry: profile →
 * provider resolution, FAIL CLOSED.
 *
 * The registry is decoupled from the concrete provider classes (API-P1.1/P1.2,
 * not on main): construction is via an INJECTED `protocol → factory` map. These
 * tests inject a FAKE factory, so they exercise the registry's resolution +
 * fail-closed logic on the contract alone.
 *
 * Locked in:
 *   1. HAPPY — a known profile resolves to a bundle whose model / modelClass /
 *      dataResidency / capabilities all come from config (via the fake factory).
 *   2. UNKNOWN PROFILE — typed, catchable failure (not an uncaught throw).
 *   3. MISSING PROVIDER — profile → undefined provider key ⇒ typed failure.
 *   4. NO FACTORY — provider protocol with no registered factory ⇒ typed failure.
 *   5. SECRETS — the factory receives the secret REFERENCE untouched; the
 *      registry never resolves it.
 */

import { test, expect, describe } from "bun:test";
import {
  InferenceRegistry,
  ProfileResolutionError,
  type ProviderFactory,
  type ProviderFactoryMap,
} from "../registry";
import type {
  ProviderCapabilities,
  ModelProvider,
  ModelRequest,
  ModelEvent,
} from "../types";
import { InferenceConfigSchema } from "../../types/cortex-config";

// A capability matrix a fake provider advertises. Distinctive values so the
// happy-path test can prove the resolved `capabilities` come from the provider
// the factory built (which built them from config), not a hardcoded default.
const FAKE_CAPS: ProviderCapabilities = {
  streaming: true,
  tools: true,
  parallelTools: false,
  images: false,
  documents: false,
  structuredOutput: true,
  serverContinuation: false,
  promptCaching: true,
};

/** Records what the injected factory saw, so tests can assert the seam. */
interface FactorySpy {
  readonly factory: ProviderFactory;
  readonly calls: { name: string; apiKey: string; protocol: string }[];
  readonly instances: number;
}

function makeFactorySpy(): FactorySpy {
  const calls: FactorySpy["calls"] = [];
  const state = { instances: 0 };
  const factory: ProviderFactory = ({ name, config }) => {
    calls.push({ name, apiKey: config.apiKey, protocol: config.protocol });
    state.instances += 1;
    const provider: ModelProvider = {
      id: name,
      // Derive capabilities from config so "capabilities come from config"
      // holds through the factory seam; fall back to FAKE_CAPS.
      capabilities: { ...FAKE_CAPS, ...(config.capabilities ?? {}) },
      // eslint-disable-next-line require-yield
      async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
        throw new Error("fake provider does not stream in this test");
      },
    };
    return provider;
  };
  return {
    factory,
    calls,
    get instances() {
      return state.instances;
    },
  };
}

// A well-formed inference config parsed through the real schema, so the tests
// resolve exactly what config load would hand the registry. Secrets are
// `env:NAME` references (never literals), per the P0.2 schema.
function baseConfig() {
  return InferenceConfigSchema.parse({
    providers: {
      anthropic: {
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.example/v1",
        apiKey: "env:ANTHROPIC_API_KEY",
      },
      openai: {
        protocol: "openai-chat-completions",
        baseUrl: "https://api.openai.example/v1",
        apiKey: "env:OPENAI_API_KEY",
      },
    },
    profiles: {
      "frontier-eu": {
        provider: "anthropic",
        model: "claude-sonnet-4",
        modelClass: "frontier",
        dataResidency: "eu",
      },
    },
  });
}

describe("InferenceRegistry.resolveProfile — happy path", () => {
  test("resolves a known profile to a bundle sourced from config", () => {
    const spy = makeFactorySpy();
    const factories: ProviderFactoryMap = {
      "anthropic-messages": spy.factory,
    };
    const registry = new InferenceRegistry(baseConfig(), factories);

    const result = registry.resolveProfile("frontier-eu");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const { profile } = result;

    // model / modelClass / dataResidency come straight from the profile config.
    expect(profile.model).toBe("claude-sonnet-4");
    expect(profile.modelClass).toBe("frontier");
    expect(profile.dataResidency).toBe("eu");
    // capabilities come from the provider the factory built (config-derived).
    expect(profile.capabilities).toEqual(FAKE_CAPS);
    expect(profile.provider.id).toBe("anthropic");
  });

  test("caches the provider instance across resolves of the same provider", () => {
    const spy = makeFactorySpy();
    const config = InferenceConfigSchema.parse({
      providers: {
        anthropic: {
          protocol: "anthropic-messages",
          baseUrl: "https://api.anthropic.example/v1",
          apiKey: "env:ANTHROPIC_API_KEY",
        },
      },
      profiles: {
        a: { provider: "anthropic", model: "m1", modelClass: "frontier" },
        b: { provider: "anthropic", model: "m2", modelClass: "any" },
      },
    });
    const registry = new InferenceRegistry(config, {
      "anthropic-messages": spy.factory,
    });

    const a = registry.resolveProfile("a");
    const b = registry.resolveProfile("b");
    expect(a.ok && b.ok).toBe(true);
    // One instantiation, shared instance.
    expect(spy.instances).toBe(1);
    if (a.ok && b.ok) {
      expect(a.profile.provider).toBe(b.profile.provider);
    }
  });

  test("passes the secret REFERENCE to the factory, never a resolved value", () => {
    const spy = makeFactorySpy();
    const registry = new InferenceRegistry(baseConfig(), {
      "anthropic-messages": spy.factory,
    });

    registry.resolveProfile("frontier-eu");

    expect(spy.calls).toHaveLength(1);
    // The registry hands the `env:NAME` reference through untouched — it never
    // reads the environment or materializes the secret.
    expect(spy.calls[0]!.apiKey).toBe("env:ANTHROPIC_API_KEY");
  });
});

describe("InferenceRegistry.resolveProfile — fail closed", () => {
  test("unknown profile → typed failure, not an uncaught throw", () => {
    const spy = makeFactorySpy();
    const registry = new InferenceRegistry(baseConfig(), {
      "anthropic-messages": spy.factory,
    });

    let result!: ReturnType<InferenceRegistry["resolveProfile"]>;
    // Assert catchable: the call itself does NOT throw.
    expect(() => {
      result = registry.resolveProfile("does-not-exist");
    }).not.toThrow();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBeInstanceOf(ProfileResolutionError);
    expect(result.error.code).toBe("unknown-profile");
    expect(result.error.profileName).toBe("does-not-exist");
    expect(result.error.message).toContain("does-not-exist");
  });

  test("profile → missing provider key → typed failure", () => {
    const spy = makeFactorySpy();
    // Hand-build a config with a dangling provider reference. The document-level
    // schema refinement would reject this at load, so bypass it here to prove
    // the registry ALSO fails closed at resolve time (defense in depth).
    const config = {
      providers: {
        anthropic: InferenceConfigSchema.parse({
          providers: {
            anthropic: {
              protocol: "anthropic-messages" as const,
              baseUrl: "https://api.anthropic.example/v1",
              apiKey: "env:ANTHROPIC_API_KEY",
            },
          },
          profiles: {},
        }).providers.anthropic!,
      },
      profiles: {
        orphan: {
          provider: "ghost",
          model: "m",
          modelClass: "any" as const,
        },
      },
    };
    const registry = new InferenceRegistry(config, {
      "anthropic-messages": spy.factory,
    });

    const result = registry.resolveProfile("orphan");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBeInstanceOf(ProfileResolutionError);
    expect(result.error.code).toBe("missing-provider");
    expect(result.error.message).toContain("ghost");
    // The factory was never called — we failed before instantiation.
    expect(spy.instances).toBe(0);
  });

  test("provider protocol with no registered factory → typed failure", () => {
    // Config is valid, but the injected map has NO factory for the profile's
    // provider protocol (`openai-chat-completions`).
    const config = InferenceConfigSchema.parse({
      providers: {
        openai: {
          protocol: "openai-chat-completions",
          baseUrl: "https://api.openai.example/v1",
          apiKey: "env:OPENAI_API_KEY",
        },
      },
      profiles: {
        cheap: { provider: "openai", model: "gpt-x", modelClass: "any" },
      },
    });
    const spy = makeFactorySpy();
    const registry = new InferenceRegistry(config, {
      // Only anthropic registered; openai protocol has no factory.
      "anthropic-messages": spy.factory,
    });

    let result!: ReturnType<InferenceRegistry["resolveProfile"]>;
    expect(() => {
      result = registry.resolveProfile("cheap");
    }).not.toThrow();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBeInstanceOf(ProfileResolutionError);
    expect(result.error.code).toBe("no-factory-for-protocol");
    expect(result.error.message).toContain("openai-chat-completions");
    expect(spy.instances).toBe(0);
  });
});

describe("InferenceRegistry.validateAll", () => {
  test("returns no errors when every profile resolves", () => {
    const registry = new InferenceRegistry(baseConfig(), {
      "anthropic-messages": makeFactorySpy().factory,
    });
    expect(registry.validateAll()).toEqual([]);
  });

  test("surfaces the failing profiles for config-load pre-flight", () => {
    // Valid config, but no factory registered for the openai profile.
    const config = InferenceConfigSchema.parse({
      providers: {
        anthropic: {
          protocol: "anthropic-messages",
          baseUrl: "https://api.anthropic.example/v1",
          apiKey: "env:ANTHROPIC_API_KEY",
        },
        openai: {
          protocol: "openai-chat-completions",
          baseUrl: "https://api.openai.example/v1",
          apiKey: "env:OPENAI_API_KEY",
        },
      },
      profiles: {
        good: { provider: "anthropic", model: "m", modelClass: "frontier" },
        bad: { provider: "openai", model: "g", modelClass: "any" },
      },
    });
    const registry = new InferenceRegistry(config, {
      "anthropic-messages": makeFactorySpy().factory,
    });

    const errors = registry.validateAll();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("no-factory-for-protocol");
    expect(errors[0]!.profileName).toBe("bad");
  });
});
