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
import type { ServicePlatform } from "../../../common/nats/nats-service-manager";

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
  /**
   * macOS — the nats-server launchd plist path (`stack.nats_infra.plist_path`
   * / `--plist`). Present on a darwin join; absent on a Linux join (where
   * {@link DerivedJoinInputs.unitPath} carries the systemd unit instead).
   */
  plistPath?: string;
  /**
   * #763 — Linux — the nats-server systemd unit path
   * (`stack.nats_infra.unit_path` / `--unit`). Present on a linux join.
   */
  unitPath?: string;
  /** #763 — the platform the descriptor was resolved for (launchd vs systemd). */
  platform: ServicePlatform;
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
  /** macOS launchd plist (absent on Linux). */
  plistPath?: string;
  /** #763 — Linux systemd unit (absent on macOS). */
  unitPath?: string;
  /** #763 — the resolved platform. */
  platform: ServicePlatform;
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
  /** #763 — `--unit` override for the systemd unit path on Linux. */
  unitPath?: string;
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

/** The default platform — mapped from `process.platform` (darwin vs linux). */
function defaultPlatform(): ServicePlatform {
  return process.platform === "darwin" ? "darwin" : "linux";
}

/**
 * #763 — resolve the nats-server service descriptor.
 *
 * An EXPLICIT descriptor flag wins AND is self-describing: `--plist` means "this
 * is a launchd plist", `--unit` means "this is a systemd unit", regardless of
 * the host platform. This keeps the fully-flagged legacy invocation (and its
 * cross-platform CLI tests) working: a `--plist`-flagged join resolves the
 * launchd descriptor even when `process.platform` is Linux. Flagging BOTH is a
 * conflict (you cannot manage two descriptor types for one nats-server).
 *
 * When NEITHER flag is given, the descriptor derives from config by the host
 * `platform`: macOS reads `stack.nats_infra.plist_path`, Linux reads
 * `stack.nats_infra.unit_path`. A descriptor for the OTHER platform in config is
 * ignored (a stack may carry a legacy `plist_path` it no longer uses on Linux).
 * A missing descriptor yields a clear, field-naming error.
 *
 * The returned `platform` is the descriptor's OWN platform (launchd→darwin,
 * systemd→linux), so the adapter selects the matching `NatsServiceManager`.
 */
function resolveDescriptor(
  platform: ServicePlatform,
  overrides: { plistPath?: string; unitPath?: string },
  natsInfra: { plist_path?: string; unit_path?: string } | undefined,
):
  | { ok: true; platform: ServicePlatform; plistPath?: string; unitPath?: string }
  | { ok: false; reason: string } {
  const flagPlist = overrides.plistPath;
  const flagUnit = overrides.unitPath;

  // Explicit-flag path — self-describing, platform-independent.
  if (flagPlist !== undefined && flagPlist !== "" && flagUnit !== undefined && flagUnit !== "") {
    return {
      ok: false,
      reason: "pass only one of --plist (launchd) or --unit (systemd), not both",
    };
  }
  if (flagPlist !== undefined && flagPlist !== "") {
    return { ok: true, platform: "darwin", plistPath: flagPlist };
  }
  if (flagUnit !== undefined && flagUnit !== "") {
    return { ok: true, platform: "linux", unitPath: flagUnit };
  }

  // Config path — derive by the host platform.
  if (platform === "darwin") {
    const plistPath = natsInfra?.plist_path;
    if (plistPath === undefined || plistPath === "") {
      return {
        ok: false,
        reason:
          "cannot resolve nats-server launchd plist — pass --plist or set `stack.nats_infra.plist_path` in cortex.yaml",
      };
    }
    return { ok: true, platform: "darwin", plistPath };
  }
  // Linux / systemd.
  const unitPath = natsInfra?.unit_path;
  if (unitPath === undefined || unitPath === "") {
    return {
      ok: false,
      reason:
        "cannot resolve nats-server systemd unit — pass --unit or set `stack.nats_infra.unit_path` in cortex.yaml",
    };
  }
  return { ok: true, platform: "linux", unitPath };
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
  platform: ServicePlatform = defaultPlatform(),
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

  // #763 — resolve the platform's service descriptor (plist on macOS, systemd
  // unit on Linux). Flag wins over config; a clear, field-naming error when the
  // platform's descriptor is neither flagged nor configured.
  const descriptor = resolveDescriptor(
    platform,
    { ...(overrides.plistPath !== undefined && { plistPath: overrides.plistPath }), ...(overrides.unitPath !== undefined && { unitPath: overrides.unitPath }) },
    natsInfra,
  );
  if (!descriptor.ok) return fail(descriptor.reason);

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
      ...(descriptor.plistPath !== undefined && { plistPath: descriptor.plistPath }),
      ...(descriptor.unitPath !== undefined && { unitPath: descriptor.unitPath }),
      platform: descriptor.platform,
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
  overrides: Pick<JoinOverrides, "principal" | "stack" | "natsConfigPath" | "plistPath" | "unitPath">,
  configPath: string,
  load: ConfigReader,
  platform: ServicePlatform = defaultPlatform(),
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

  // #763 — same platform-aware descriptor resolution as join.
  const descriptor = resolveDescriptor(
    platform,
    { ...(overrides.plistPath !== undefined && { plistPath: overrides.plistPath }), ...(overrides.unitPath !== undefined && { unitPath: overrides.unitPath }) },
    natsInfra,
  );
  if (!descriptor.ok) return fail(descriptor.reason);

  return {
    ok: true,
    inputs: {
      principal,
      stack,
      natsConfigPath,
      ...(descriptor.plistPath !== undefined && { plistPath: descriptor.plistPath }),
      ...(descriptor.unitPath !== undefined && { unitPath: descriptor.unitPath }),
      platform: descriptor.platform,
    },
  };
}
