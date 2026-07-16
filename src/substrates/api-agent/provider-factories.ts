// API-P1.3 (epic #2055, Phase 1) — the REAL provider-factory wiring: the
// dependency-injection point API-P0.4's `InferenceRegistry` documented. The
// registry takes a `protocol → factory` map and never imports the concrete
// provider classes; THIS module supplies them, mapping a schema-validated
// `InferenceProvider` config entry onto each provider's actual constructor.
//
// SECRETS: the registry hands the factory the provider config with its secret
// REFERENCES (`apiKey` / `headers.*` as `env:NAME`) intact. The shipped provider
// constructors (`AnthropicMessagesProvider` / `OpenAICompatibleProvider`) take a
// LITERAL key, so the factory resolves the reference via `resolveSecretRef` at
// PROVIDER-CONSTRUCTION time — inside `InferenceRegistry.resolveProfile`, the
// first time a given provider is built (instances are then cached).
//
// TIMING (API-P1.4): that construction happens at BOOT, not on first dispatch.
// The boot pre-flight (`inferenceRegistry.validateAll()` in `startCortex`)
// resolves EVERY configured profile at startup, so every configured provider's
// secret is resolved then — including providers no agent currently uses. The
// intended consequence: an unset/empty `env:NAME` surfaces as a boot stderr line
// (`resolveSecretRef` throws `SecretRefResolutionError`; the registry catches it
// and reports that profile as `provider-instantiation-failed`) instead of lying
// dormant until the first dispatch. Reported, not fatal — boot continues, and
// the api-agent harness still fails closed per-dispatch on the same condition.
//
// The resolved value lives on the provider instance only; it is never written
// back onto config and never logged (both providers keep it out of every error,
// event, and log line) — and the resolution error names the env VAR only, never
// a value.

import type {
  ProviderFactory,
  ProviderFactoryMap,
} from "../../common/inference/registry";
import { InferenceRegistry } from "../../common/inference/registry";
import type { InferenceConfig, InferenceProvider } from "../../common/types/cortex-config";
import { resolveSecretRef } from "../../common/inference/secret-ref";
import { AnthropicMessagesProvider } from "../../providers/anthropic/messages-provider";
import { OpenAICompatibleProvider } from "../../providers/openai-compatible/chat-completions-provider";

/** Options for the factory wiring — `env` is injectable for tests. */
export interface ProviderFactoryOptions {
  /** Environment used to resolve `env:NAME` secret references. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Resolve every `env:NAME` header reference to its literal value at call time. */
function resolveHeaders(
  headers: InferenceProvider["headers"],
  env: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [name, ref] of Object.entries(headers)) {
    out[name] = resolveSecretRef(ref, env ?? process.env);
  }
  return out;
}

/**
 * The default `protocol → factory` map wiring the two Phase-1 providers. Each
 * factory matches the provider's actual constructor signature and resolves
 * secret references from `opts.env` (default `process.env`).
 */
export function defaultProviderFactories(
  opts: ProviderFactoryOptions = {},
): ProviderFactoryMap {
  const env = opts.env;

  const anthropic: ProviderFactory = ({ config }) => {
    const extraHeaders = resolveHeaders(config.headers, env);
    return new AnthropicMessagesProvider({
      apiKey: resolveSecretRef(config.apiKey, env ?? process.env),
      baseUrl: config.baseUrl,
      ...(extraHeaders !== undefined ? { extraHeaders } : {}),
    });
  };

  const openai: ProviderFactory = ({ name, config }) => {
    const headers = resolveHeaders(config.headers, env);
    return new OpenAICompatibleProvider({
      id: name,
      baseUrl: config.baseUrl,
      apiKey: resolveSecretRef(config.apiKey, env ?? process.env),
      ...(config.capabilities !== undefined
        ? { capabilities: config.capabilities }
        : {}),
      ...(headers !== undefined ? { headers } : {}),
    });
  };

  return {
    "anthropic-messages": anthropic,
    "openai-chat-completions": openai,
  };
}

/**
 * Build an {@link InferenceRegistry} from a loaded `inference` config with the
 * real Phase-1 provider factories injected. This is the single boot-time
 * construction point the harness resolver consumes; pass the result to the
 * dispatch listener so `substrate: api-agent` agents resolve their profile.
 */
export function createInferenceRegistry(
  config: InferenceConfig,
  opts: ProviderFactoryOptions = {},
): InferenceRegistry {
  return new InferenceRegistry(config, defaultProviderFactories(opts));
}
