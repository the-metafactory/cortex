/**
 * #753 — derive `cortex network join`/`leave` inputs from the loaded cortex
 * config so the headline invocation is a true one-liner:
 *
 *     cortex network join <network> [--apply]
 *
 * Everything the join needs — principal, stack, signing seed, registry pin +
 * endpoint, and the per-stack nats-server infra paths (config / plist /
 * account / creds) — derives from the stack's loaded config + conventions.
 * Flags survive ONLY as optional per-invocation overrides: a flag, when
 * present, always wins; otherwise the value derives from config; a value that
 * is neither flagged nor derivable fails with a clear, field-naming error
 * (never a cryptic stack trace).
 *
 * Sources (in override precedence — flag beats config beats convention):
 *
 *   | join input        | flag              | config source                                  | convention default                |
 *   |-------------------|-------------------|------------------------------------------------|------------------------------------|
 *   | principal         | --principal       | principal.id                                   | —                                  |
 *   | stack             | --stack           | stack.id (single configured stack)             | {principal}/default                |
 *   | seed-path         | --seed-path       | stack.nkey_seed_path                            | —                                  |
 *   | registry-url      | --registry-url    | policy.federated.registry.url                  | —                                  |
 *   | registry-pubkey   | --registry-pubkey | policy.federated.registry.pubkey               | — (TOFU when absent)               |
 *   | nats-config       | --nats-config     | stack.nats_infra.config_path                   | —                                  |
 *   | plist             | --plist           | stack.nats_infra.plist_path                     | —                                  |
 *   | account           | --account         | stack.nats_infra.account                       | —                                  |
 *   | creds             | --creds           | stack.nats_infra.creds_path                     | ~/.config/nats/<network>.creds     |
 *
 * This module is PURE over an injected `loadConfig` reader (the loader is
 * threaded in by the caller) so it is unit-testable against a fixture config
 * without touching the principal's real `~/.config/cortex/`. The CLI passes
 * `loadConfigWithAgents`.
 *
 * arc-populating `stack.nats_infra` + `policy.federated.registry` at install
 * is a follow-up (see PR notes) — today the principal sets these once by hand
 * (or via `cortex provision-stack`), and the join derives from them.
 */

import type { LoadedConfig } from "../../../common/config/loader";

// =============================================================================
// Types
// =============================================================================

/** The five join inputs `cortex network join` previously demanded as flags. */
export interface DerivedJoinInputs {
  principal: string;
  /** `{principal}/{slug}` canonical stack id. */
  stack: string;
  seedPath: string;
  registryUrl: string;
  registryPubkey?: string;
  natsConfigPath: string;
  plistPath: string;
  account: string;
  credsPath: string;
  /**
   * #762 — the capability ids this stack announces INTO the network, read from
   * the matching `policy.federated.networks[].announce_capabilities[]` block in
   * config (empty when the network isn't yet declared locally or declares no
   * caps). The join announces these with `networks: [<network>]` so the
   * principal joins the network's roster.
   */
  announceCapabilities: string[];
}

/** The leave inputs — a strict subset (no registry / seed / account / creds). */
export interface DerivedLeaveInputs {
  principal: string;
  stack: string;
  natsConfigPath: string;
  plistPath: string;
}

/** Flag overrides — any field present on the CLI wins over config/convention. */
export interface JoinOverrides {
  principal?: string;
  stack?: string;
  seedPath?: string;
  registryUrl?: string;
  registryPubkey?: string;
  natsConfigPath?: string;
  plistPath?: string;
  account?: string;
  credsPath?: string;
}

/** A reader that loads + validates the cortex config from a path. */
export type ConfigReader = (path: string) => LoadedConfig;

export interface DeriveResult<T> {
  ok: boolean;
  inputs?: T;
  /** Actionable, field-naming error when a required value can't be resolved. */
  reason?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Default per-network creds path convention: `~/.config/nats/<network>.creds`.
 * Per-network so a stack joined to two networks keeps distinct creds files.
 */
export function defaultCredsPath(networkId: string): string {
  return `~/.config/nats/${networkId}.creds`;
}

/**
 * Resolve the stack identity from config. Precedence:
 *   1. `--stack` flag (validated by the caller's grammar).
 *   2. `stack.id` when the principal declared exactly one stack block.
 *   3. convention `{principal}/default`.
 *
 * The single-stack rule is deliberate: the loaded config carries at most one
 * `stack:` block (`LoadedConfig.stack`), so "the single configured stack" is
 * unambiguous. A future multi-stack layout (stacks/*.yaml) would surface a
 * default selection here — out of scope for #753.
 */
function resolveStack(
  principal: string,
  stackFlag: string | undefined,
  cfg: LoadedConfig,
): string {
  if (stackFlag !== undefined) return stackFlag;
  if (cfg.stack?.id !== undefined) return cfg.stack.id;
  return `${principal}/default`;
}

function fail<T>(reason: string): DeriveResult<T> {
  return { ok: false, reason };
}

/** An empty LoadedConfig — every derived field absent, so the deriver falls
 *  through to flags / convention. Returned by {@link tolerantReader} when no
 *  config file is present (fully-flagged back-compat path). */
export const EMPTY_CONFIG: LoadedConfig = {
  config: {} as LoadedConfig["config"],
  inlineAgents: [],
};

/**
 * Wrap a config reader so that a MISSING file is benign (returns
 * {@link EMPTY_CONFIG}, letting the deriver fall through to flags/convention)
 * while a file that EXISTS but fails to parse/validate still throws (so the
 * caller surfaces the loader's message rather than masking it behind a vaguer
 * "missing field" error). This is the CLI seam: the pure deriver always trusts
 * its reader, and the CLI feeds it this tolerant wrapper. `fileExists` is
 * injectable for unit tests; the CLI passes `fs.existsSync` over the expanded
 * path.
 */
export function tolerantReader(
  load: ConfigReader,
  fileExists: (path: string) => boolean,
): ConfigReader {
  return (path: string): LoadedConfig => {
    if (!fileExists(path)) return EMPTY_CONFIG;
    return load(path);
  };
}

// =============================================================================
// Join derivation
// =============================================================================

/**
 * Derive the full set of `cortex network join` inputs from the loaded config,
 * applying flag overrides. `configPath` is the `--config` path the CLI is
 * pointed at (the same default as `cortex start`).
 *
 * Returns `{ ok: false, reason }` with a clear, field-naming message when a
 * required value is neither flagged nor derivable — the caller turns this into
 * a usage error. Config-load errors (bad YAML, schema violations) propagate
 * from the injected reader; the caller wraps them.
 */
export function deriveJoinInputs(
  networkId: string,
  overrides: JoinOverrides,
  configPath: string,
  load: ConfigReader,
): DeriveResult<DerivedJoinInputs> {
  const cfg = load(configPath);

  // principal — flag wins, else principal.id.
  const principal = overrides.principal ?? cfg.principal?.id;
  if (principal === undefined || principal === "") {
    return fail(
      "cannot resolve principal — pass --principal or set `principal.id` in cortex.yaml",
    );
  }

  const stack = resolveStack(principal, overrides.stack, cfg);

  // seed-path — flag wins, else stack.nkey_seed_path.
  const seedPath = overrides.seedPath ?? cfg.stack?.nkey_seed_path;
  if (seedPath === undefined || seedPath === "") {
    return fail(
      "cannot resolve signing seed — pass --seed-path or set `stack.nkey_seed_path` in cortex.yaml",
    );
  }

  // registry — flag wins, else policy.federated.registry.{url,pubkey}.
  const registry = cfg.policy?.federated?.registry;
  const registryUrl = overrides.registryUrl ?? registry?.url;
  if (registryUrl === undefined || registryUrl === "") {
    return fail(
      "cannot resolve registry URL — pass --registry-url or set `policy.federated.registry.url` in cortex.yaml",
    );
  }
  // pubkey stays optional everywhere (TOFU when absent).
  const registryPubkey = overrides.registryPubkey ?? registry?.pubkey;

  // nats-infra — flag wins, else stack.nats_infra.{config_path,plist_path,account}.
  const natsInfra = cfg.stack?.nats_infra;

  const natsConfigPath = overrides.natsConfigPath ?? natsInfra?.config_path;
  if (natsConfigPath === undefined || natsConfigPath === "") {
    return fail(
      "cannot resolve nats config path — pass --nats-config or set `stack.nats_infra.config_path` in cortex.yaml",
    );
  }

  const plistPath = overrides.plistPath ?? natsInfra?.plist_path;
  if (plistPath === undefined || plistPath === "") {
    return fail(
      "cannot resolve plist path — pass --plist or set `stack.nats_infra.plist_path` in cortex.yaml",
    );
  }

  const account = overrides.account ?? natsInfra?.account;
  if (account === undefined || account === "") {
    return fail(
      "cannot resolve leaf account — pass --account or set `stack.nats_infra.account` in cortex.yaml",
    );
  }

  // creds — flag wins, else stack.nats_infra.creds_path, else convention.
  const credsPath =
    overrides.credsPath ?? natsInfra?.creds_path ?? defaultCredsPath(networkId);

  // #762 — announce_capabilities for THIS network, read from the matching
  // policy.federated.networks[] block. The join announces these to the registry
  // with networks:[networkId] so the principal joins the roster. Absent network
  // block (first join before the block exists) → empty; the join then warns +
  // preserves hand-pins rather than wiping them.
  const announceCapabilities =
    cfg.policy?.federated?.networks.find((n) => n.id === networkId)
      ?.announce_capabilities ?? [];

  return {
    ok: true,
    inputs: {
      principal,
      stack,
      seedPath,
      registryUrl,
      ...(registryPubkey !== undefined && { registryPubkey }),
      natsConfigPath,
      plistPath,
      account,
      credsPath,
      announceCapabilities,
    },
  };
}

// =============================================================================
// Leave derivation
// =============================================================================

/**
 * Derive the `cortex network leave` inputs — a subset of join (no registry,
 * seed, account, or creds; leave only needs to find + tear down the leaf
 * include + plist). Same override-then-config-then-convention precedence.
 */
export function deriveLeaveInputs(
  overrides: Pick<JoinOverrides, "principal" | "stack" | "natsConfigPath" | "plistPath">,
  configPath: string,
  load: ConfigReader,
): DeriveResult<DerivedLeaveInputs> {
  const cfg = load(configPath);

  const principal = overrides.principal ?? cfg.principal?.id;
  if (principal === undefined || principal === "") {
    return fail(
      "cannot resolve principal — pass --principal or set `principal.id` in cortex.yaml",
    );
  }

  const stack = resolveStack(principal, overrides.stack, cfg);
  const natsInfra = cfg.stack?.nats_infra;

  const natsConfigPath = overrides.natsConfigPath ?? natsInfra?.config_path;
  if (natsConfigPath === undefined || natsConfigPath === "") {
    return fail(
      "cannot resolve nats config path — pass --nats-config or set `stack.nats_infra.config_path` in cortex.yaml",
    );
  }

  const plistPath = overrides.plistPath ?? natsInfra?.plist_path;
  if (plistPath === undefined || plistPath === "") {
    return fail(
      "cannot resolve plist path — pass --plist or set `stack.nats_infra.plist_path` in cortex.yaml",
    );
  }

  return { ok: true, inputs: { principal, stack, natsConfigPath, plistPath } };
}
