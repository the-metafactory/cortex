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

/**
 * Zod schema for a secret reference. Validates the `env:NAME` SHAPE only — it
 * does NOT read the environment, so parsing a config never resolves (and never
 * captures) a secret value. A non-`env:` literal is REJECTED with a descriptive
 * message pointing the principal at the reference convention.
 */
export const SecretRefSchema = z
  .string()
  .regex(
    SECRET_REF_PATTERN,
    "must be a secret reference of the form `env:NAME` (e.g. `env:ANTHROPIC_API_KEY`), " +
      "never a literal secret — the value is resolved from that environment variable at " +
      "call time and never stored in config",
  );

/** A validated `env:NAME` secret reference. */
export type SecretRef = z.infer<typeof SecretRefSchema>;

/**
 * Extract the environment-variable NAME from a secret reference, or `undefined`
 * if the string is not a well-formed `env:NAME` reference. Does not touch the
 * environment.
 */
export function secretRefEnvVar(ref: string): string | undefined {
  return SECRET_REF_PATTERN.exec(ref)?.[1];
}

/**
 * Raised when a secret reference cannot be resolved at call time — the
 * referenced environment variable is unset or empty. Carries the env-var NAME
 * (never a value; there is none to carry) so the principal sees exactly which
 * variable to export.
 */
export class SecretRefResolutionError extends Error {
  public readonly envVar: string;

  constructor(envVar: string) {
    super(
      `inference: secret reference env:${envVar} could not be resolved — ` +
        `environment variable ${envVar} is unset or empty. Export ${envVar} in the ` +
        `cortex daemon's environment before it issues a model request. The value is ` +
        `resolved at call time and never stored in config.`,
    );
    this.name = "SecretRefResolutionError";
    this.envVar = envVar;
  }
}

/**
 * Resolve a secret reference to its value AT CALL TIME. Reads
 * `env[NAME]` for a `env:NAME` reference; throws {@link SecretRefResolutionError}
 * if the reference is malformed or the variable is unset / empty / whitespace.
 *
 * This is the ONLY function that materializes a secret value. Callers (the
 * harness / provider registry) invoke it at the moment of a provider request
 * and hold the result in the local call frame ONLY — never assign it back onto
 * any config object, and never log it.
 *
 * `env` is injectable for testing; defaults to `process.env`.
 */
export function resolveSecretRef(
  ref: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const envVar = secretRefEnvVar(ref);
  if (envVar === undefined) {
    throw new SecretRefResolutionError(ref);
  }
  const value = env[envVar];
  if (value === undefined || value.trim() === "") {
    throw new SecretRefResolutionError(envVar);
  }
  return value;
}
