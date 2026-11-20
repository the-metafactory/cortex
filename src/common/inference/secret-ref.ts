// API-P0.2 (epic #2055, Phase 0, decision D6) — secret-reference primitive for
// the `inference` config block (providers' `apiKey` + header values). Design
// §"Secrets and egress": provider credentials are SECURITY-SENSITIVE — a
// leaked model-provider key is direct egress + billable abuse — so they never
// live as literals in the config and never touch the parsed/serialized config
// object.
//
// The convention is a REFERENCE, not a value: a config field holds the string
// `env:NAME`, which names an environment variable. Resolution to the real
// secret happens AT CALL TIME (in the harness / provider registry, → API-P0.4),
// via {@link resolveSecretRef} — never at parse time. Consequences:
//
//   1. The parsed `LoadedConfig` contains only `env:NAME` references. Dumping,
//      logging, or serializing it shows references, never secret values.
//   2. A resolved value exists only transiently in the harness call frame that
//      makes the provider request; it is never written back onto config.
//
// This differs deliberately from the surface-token `__ENV__` placeholder scheme
// (`resolve-env-placeholders.ts`), which resolves at config-LOAD and lands the
// value on the in-memory config so an adapter's `connect()` can read it. That
// is the wrong model for model-provider keys: a load-time-resolved value would
// sit on the config object and leak through any config dump/log. The `env:NAME`
// reference keeps the value OFF the object entirely (D6 / the redaction AC).

import { z } from "zod/v4";

/**
 * A secret reference is exactly `env:NAME`, where NAME is a conventional
 * environment-variable identifier (letter/underscore start, then
 * alphanumerics/underscores). Anchored end-to-end: a literal secret (e.g.
 * `sk-ant-…`) or a partial occurrence (`Bearer env:X`) does NOT match and is
 * rejected by {@link SecretRefSchema} — literals are never accepted (design
 * §Configuration: "SECRET REFERENCE — never a literal").
 */
export const SECRET_REF_PATTERN = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

const KEYCHAIN_REF_PATTERN = /^keychain:([A-Z0-9_]+)$/;

export const KEYCHAIN_MACOS_ONLY_MESSAGE =
  "`keychain:` secret references are macOS-only; use `env:NAME` on this host";

/**
 * Zod schema for a secret reference: `env:NAME` or `keychain:NAME`. Validates
 * the SHAPE only; it never reads the environment or the Keychain. A
 * `keychain:` reference is rejected on a non-macOS host.
 */
export const SecretRefSchema = z
  .string()
  .regex(
    new RegExp(`${SECRET_REF_PATTERN.source}|${KEYCHAIN_REF_PATTERN.source}`),
    "must be a secret reference of the form `env:NAME` (e.g. `env:ANTHROPIC_API_KEY`) or " +
      "`keychain:NAME` (macOS Keychain), never a literal secret — the value is resolved at " +
      "call time and never stored in config",
  )
  .refine((ref) => !KEYCHAIN_REF_PATTERN.test(ref) || process.platform === "darwin", {
    message: KEYCHAIN_MACOS_ONLY_MESSAGE,
  });

export function secretRefKeychainName(ref: string): string | undefined {
  return KEYCHAIN_REF_PATTERN.exec(ref)?.[1];
}

/**
 * Extract the environment-variable NAME from a secret reference, or `undefined`
 * if the string is not a well-formed `env:NAME` reference. Does not touch the
 * environment.
 */
export function secretRefEnvVar(ref: string): string | undefined {
  return SECRET_REF_PATTERN.exec(ref)?.[1];
}
