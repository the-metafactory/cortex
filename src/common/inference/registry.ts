// API-P0.4 (epic #2055, Phase 0) — the inference provider registry: resolve an
// `inferenceProfile` NAME into a concrete, ready-to-use `ModelProvider` plus the
// operational facts the harness needs (model, capabilities, model class, data
// residency). Design §"Harness selection" (fail-closed resolution), §Configuration.
//
// FAIL CLOSED is the whole point. An unknown profile, a profile whose provider
// key is absent, or a provider whose `protocol` has no registered factory must
// surface a clear, typed, catchable failure at config load / admission — NEVER a
// throw deep in the token stream. `resolveProfile` therefore RETURNS a typed
// result (`ProfileResolution`) rather than throwing for the expected failure
// modes; `validateAll` lets the harness pre-flight every profile at load.
//
// DEPENDENCY-INJECTED provider construction. The registry does NOT import the
// concrete provider classes (`AnthropicMessagesProvider` → API-P1.1,
// `OpenAICompatibleProvider` → API-P1.2 — neither on main yet). Instead it takes
// a factory map keyed by `protocol`. The harness slice (API-P1.3) injects the
// real factories; tests inject fakes. Adding a protocol is a new map entry — no
// call site in this file changes. This is the extension point (AC: "provider
// instantiation is keyed by protocol, extensible without touching call sites").
//
// SECRETS NEVER MATERIALIZE HERE (P0.2 adversarial review nit). The registry
// passes the schema-validated secret REFERENCE (`apiKey` / `headers.*`, each an
// `env:NAME` ref) straight through to the factory on the untouched provider
// config. It does NOT import or call `resolveSecretRef`, and places NO resolved
// secret value on any object. Resolution stays at REQUEST time inside the
// provider (the only correct place — see secret-ref.ts). Credentials belong in
// the `apiKey` / `headers` reference fields ONLY; the profile `options` bag is an
// opaque provider-knob escape hatch that cortex never inspects and never resolves
// secrets from — never route a credential through `options`.

import type { ProviderCapabilities, ModelProvider } from "./types";
import type {
  InferenceConfig,
  InferenceProvider,
  InferenceProfile,
} from "../types/cortex-config";

/** The wire protocols a provider can speak (mirrors the config enum). */
export type InferenceProtocol = InferenceProvider["protocol"];

/** The policy class a profile is permitted (mirrors the config enum). */
export type ModelClass = InferenceProfile["modelClass"];

/**
 * Builds a {@link ModelProvider} from a single, schema-validated provider-config
 * entry. Injected per `protocol` (dependency injection): API-P1.3 wires the real
 * `AnthropicMessagesProvider` / `OpenAICompatibleProvider` constructors; tests
 * wire fakes. The `config` passed in still carries the secret REFERENCES
 * (`apiKey` / `headers.*` as `env:NAME`) untouched — the factory hands them to
 * the provider, which resolves them at REQUEST time. The factory MUST NOT
 * resolve or persist a secret value.
 */
export type ProviderFactory = (input: {
  /** The provider's key in `inference.providers` — becomes the provider id. */
  readonly name: string;
  /** The schema-validated provider config, secret references intact. */
  readonly config: InferenceProvider;
}) => ModelProvider;

/** A `protocol → factory` map. Partial: a protocol with no entry fails closed. */
export type ProviderFactoryMap = Partial<
  Record<InferenceProtocol, ProviderFactory>
>;

/** The concrete, ready-to-use bundle a resolved profile yields. */
export interface ResolvedProfile {
  /** The instantiated provider — the harness streams against this. */
  readonly provider: ModelProvider;
  /** Provider-neutral model id from the profile config. */
  readonly model: string;
  /**
   * The provider's advertised capability matrix. Configured-only (issue #2057
   * Q2) — the provider derives it from config; cortex never probes at startup.
   */
  readonly capabilities: ProviderCapabilities;
  /** Policy: the egress class the profile is permitted (from config). */
  readonly modelClass: ModelClass;
  /** Policy: declared data-residency label (from config), when set. */
  readonly dataResidency?: string;
}

/** The reasons a profile can fail to resolve. All fail closed. */
export type ProfileResolutionErrorCode =
  | "unknown-profile"
  | "missing-provider"
  | "no-factory-for-protocol"
  | "provider-instantiation-failed";

/**
 * A typed, catchable resolution failure. Returned (not thrown) by
 * {@link InferenceRegistry.resolveProfile} for the expected failure modes so a
 * caller surfaces it at config load / admission instead of discovering it mid-
 * stream. It extends `Error` so it carries a descriptive message + stack and is
 * `instanceof`-checkable; callers may re-throw it if they prefer.
 */
export class ProfileResolutionError extends Error {
  readonly code: ProfileResolutionErrorCode;
  /** The profile name that failed to resolve. */
  readonly profileName: string;

  constructor(
    code: ProfileResolutionErrorCode,
    profileName: string,
    message: string,
  ) {
    super(message);
    this.name = "ProfileResolutionError";
    this.code = code;
    this.profileName = profileName;
  }
}

/** The discriminated result of a profile resolution — never throws for the expected failures. */
export type ProfileResolution =
  | { readonly ok: true; readonly profile: ResolvedProfile }
  | { readonly ok: false; readonly error: ProfileResolutionError };

/**
 * The inference provider registry. Built from a loaded `inference` config and an
 * injected `protocol → factory` map; resolves profile names to ready-to-use
 * provider bundles, failing closed on every unresolvable case.
 *
 * Provider instances are created LAZILY on first resolve and cached by provider
 * key, so profiles sharing a provider reuse one instance.
 */
export class InferenceRegistry {
  private readonly config: InferenceConfig;
  private readonly factories: ProviderFactoryMap;
  private readonly providerCache = new Map<string, ModelProvider>();

  constructor(config: InferenceConfig, factories: ProviderFactoryMap) {
    this.config = config;
    this.factories = factories;
  }

  /** The profile names this registry knows about. */
  profileNames(): string[] {
    return Object.keys(this.config.profiles);
  }

  /**
   * Resolve a profile NAME to its ready-to-use bundle, or a typed failure.
   * Fail closed: unknown profile, missing provider, or a provider protocol with
   * no registered factory each yield `{ ok: false, error }` — never a throw.
   */
  resolveProfile(name: string): ProfileResolution {
    const profile = this.config.profiles[name];
    if (profile === undefined) {
      const known = this.profileNames();
      return this.fail(
        "unknown-profile",
        name,
        `inference profile "${name}" is not defined ` +
          `(known profiles: ${known.length > 0 ? known.join(", ") : "<none>"}).`,
      );
    }

    const providerConfig = this.config.providers[profile.provider];
    if (providerConfig === undefined) {
      const known = Object.keys(this.config.providers);
      return this.fail(
        "missing-provider",
        name,
        `inference profile "${name}" references provider "${profile.provider}" ` +
          `which is not defined in inference.providers ` +
          `(known providers: ${known.length > 0 ? known.join(", ") : "<none>"}).`,
      );
    }

    const factory = this.factories[providerConfig.protocol];
    if (factory === undefined) {
      const registered = Object.keys(this.factories);
      return this.fail(
        "no-factory-for-protocol",
        name,
        `inference profile "${name}" needs a provider factory for protocol ` +
          `"${providerConfig.protocol}" (provider "${profile.provider}"), but none ` +
          `is registered (registered protocols: ` +
          `${registered.length > 0 ? registered.join(", ") : "<none>"}).`,
      );
    }

    let provider: ModelProvider;
    try {
      provider = this.instantiate(profile.provider, providerConfig, factory);
    } catch (err) {
      // Fail closed rather than letting a factory throw escape uncaught. The
      // provider config is validated by schema, so this is unexpected — surface
      // it as a typed, catchable failure at resolve time.
      const detail = err instanceof Error ? err.message : String(err);
      return this.fail(
        "provider-instantiation-failed",
        name,
        `inference profile "${name}" could not instantiate provider ` +
          `"${profile.provider}" (protocol "${providerConfig.protocol}"): ${detail}`,
      );
    }

    return {
      ok: true,
      profile: {
        provider,
        model: profile.model,
        capabilities: provider.capabilities,
        modelClass: profile.modelClass,
        ...(profile.dataResidency !== undefined
          ? { dataResidency: profile.dataResidency }
          : {}),
      },
    };
  }

  /**
   * Resolve EVERY profile and return the failures. Empty array ⇒ every profile
   * resolves. Call this at config load / admission to fail closed up front,
   * before any request reaches a provider.
   */
  validateAll(): ProfileResolutionError[] {
    const errors: ProfileResolutionError[] = [];
    for (const name of this.profileNames()) {
      const result = this.resolveProfile(name);
      if (!result.ok) {
        errors.push(result.error);
      }
    }
    return errors;
  }

  private instantiate(
    name: string,
    config: InferenceProvider,
    factory: ProviderFactory,
  ): ModelProvider {
    const cached = this.providerCache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    // The factory receives the provider config with its secret REFERENCES
    // (`apiKey` / `headers.*`) intact — the registry never resolves them.
    const provider = factory({ name, config });
    this.providerCache.set(name, provider);
    return provider;
  }

  private fail(
    code: ProfileResolutionErrorCode,
    profileName: string,
    message: string,
  ): { ok: false; error: ProfileResolutionError } {
    return { ok: false, error: new ProfileResolutionError(code, profileName, message) };
  }
}
