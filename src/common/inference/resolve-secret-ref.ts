import { lookupKeychainItem, type SurfaceSecretStoreOptions } from "../config/surface-secret-store";
import { KEYCHAIN_MACOS_ONLY_MESSAGE, secretRefEnvVar, secretRefKeychainName } from "./secret-ref";

/**
 * Raised when a secret reference cannot be resolved at call time — the
 * referenced environment variable is unset or empty. Carries the env-var NAME
 * (never a value; there is none to carry) so the principal sees exactly which
 * variable to export.
 */
export class SecretRefResolutionError extends Error {
  public readonly envVar: string;

  constructor(envVar: string, message?: string) {
    super(
      message ?? `inference: secret reference env:${envVar} could not be resolved — ` +
        `environment variable ${envVar} is unset or empty. Export ${envVar} in the ` +
        `cortex daemon's environment before it issues a model request. The value is ` +
        `resolved at call time and never stored in config.`,
    );
    this.name = "SecretRefResolutionError";
    this.envVar = envVar;
  }
}

interface ResolveSecretRefOptions {
  platform?: string;
  security?: SurfaceSecretStoreOptions["security"];
  username?: string;
}

function resolveKeychainRef(name: string, options: ResolveSecretRefOptions): string {
  const ref = `keychain:${name}`;
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new SecretRefResolutionError(name, `inference: ${ref} — ${KEYCHAIN_MACOS_ONLY_MESSAGE}.`);
  }
  const lookup = lookupKeychainItem(name, "cortex", options);
  if (lookup.kind === "found" && lookup.value.trim() !== "") return lookup.value;
  const service = `ai.meta-factory.cortex.cortex.${name}`;
  const reason = lookup.kind === "failed" ? "the Keychain read failed" : "no such Keychain item exists";
  throw new SecretRefResolutionError(
    name,
    `inference: secret reference ${ref} could not be resolved — ${reason}. Create it with: ` +
      `security add-generic-password -s ${service} -a "$USER" -w`,
  );
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
  options: ResolveSecretRefOptions = {},
): string {
  const keychainName = secretRefKeychainName(ref);
  if (keychainName !== undefined) return resolveKeychainRef(keychainName, options);
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
