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
 *   | registry-url      | --registry-url    | policy.federated.registry.url                  | DEFAULT_REGISTRY.url (#1228)        |
 *   | registry-pubkey   | --registry-pubkey | policy.federated.registry.pubkey               | DEFAULT_REGISTRY.pubkey on the      |
 *   |                   |                   |                                                | default URL; else TOFU (#1228)      |
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
import type { OperatorModeLeafPackage } from "../../../common/nats/leaf-remote-renderer";
import { deriveStackId } from "../../../common/types/stack";
import { resolveRegistryAnchor } from "./default-registry";
// network-leaf-package import removed — ADR-0015 retired O-4b / Model-A.

// =============================================================================
// Types
// =============================================================================

/** The five join inputs `cortex network join` previously demanded as flags. */
export interface DerivedJoinInputs {
  principal: string;
  /**
   * `{principal}/{slug}` canonical stack id — flag-honouring. `--stack` wins,
   * else `stack.id`, else `{principal}/default` (see {@link resolveStack}). This
   * feeds the LOCATOR / write-path (`portsConfigFromInputs` → `stackId`), which
   * per ADR-0004 DA-5 follows the file the daemon composes policy from — NOT the
   * federation-identity authority.
   */
  stack: string;
  /**
   * C-1364 — the boot-authoritative own-scope stack slug: `deriveStackId(cfg).stack`,
   * the trailing segment of `stack.id` ALONE (ADR-0004: `stack.id` is the single
   * stack-slug authority). This is the SAME derivation the daemon boot validator
   * runs (`CortexConfigSchema` federated subject-scope superRefine →
   * `deriveStackId(config).stack`), so the join own-scope guard and boot can never
   * split on a drifted stack (locator/`--stack` slug ≠ `stack.id` trailing segment).
   * Unlike {@link stack} it is flag-INDEPENDENT — a `--stack` override changes the
   * write-path locator but must NOT move the federation identity boot enforces.
   * The join own-scope guard (`ownAcceptSubjects` / `ownFederatedSubjectScopePrefix`
   * / `isFederatedSubjectInOwnScope` in `network-lib.ts`) MUST build its
   * `federated.{me}.{stack}.` scope from THIS, never from {@link stack}'s slug.
   */
  bootStackSlug: string;
  seedPath: string;
  registryUrl: string;
  registryPubkey?: string;
  /**
   * cortex#1228 — `true` ⇒ the resolved registry is a CUSTOM (non-default)
   * registry with no pinned pubkey, so the join will trust-on-first-use. The
   * CLI surfaces an explicit warning when this is set (TOFU is never silent).
   * Absent ⇒ the registry is pinned (default-anchor / config / flag), no TOFU.
   */
  registryTofu?: boolean;
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
  /**
   * The leaf account (nkey-U) the leaf binds to — OPTIONAL (#799). Present for
   * an operator-mode bus (`--account` / `stack.nats_infra.account`); ABSENT for
   * a `$G`/default-account bus, where the account binding rides in the creds
   * JWT and rendering an `account:` line would crash nats-server. No longer a
   * hard requirement: a `$G` peer (e.g. jc/default) joins with creds only.
   */
  account?: string;
  credsPath: string;
  /**
   * C-1224 (ADR-0013 Model B) — the **leaf shared secret** for a secret-
   * authenticated transport-pipe leaf (`--leaf-secret` /
   * `stack.nats_infra.leaf_secret`). Present ⇒ the join renders a secret-auth
   * leaf (URL userinfo) binding the principal's OWN local account, instead of a
   * `.creds`-file leaf. Absent ⇒ the legacy creds path.
   */
  leafSecret?: string;
  /**
   * C-1224 — the userinfo USER paired with {@link DerivedJoinInputs.leafSecret}
   * (`--leaf-user` / `stack.nats_infra.leaf_user`). Resolved ONLY when a leaf
   * secret is present; defaults to the principal id when neither flag nor config
   * supplies one.
   */
  leafUser?: string;
  /**
   * O-3 (cortex#1053) — the operator-mode leaf package, assembled from
   * `--operator-jwt` / `--account-jwt` / `--account` (+ optional
   * `--system-account` / `--system-account-jwt`) flags or the matching
   * `stack.nats_infra.*` fields. Present ONLY when at least the operator JWT +
   * account + account JWT all resolve — the minimum to convert an anonymous bus.
   * Absent ⇒ join falls back to the #794 fail-fast on an anonymous bus.
   */
  operatorModePackage?: OperatorModeLeafPackage;
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
  /**
   * C-820 — registry coordinates for the leave-side cap retag (the inverse of
   * join's union). All OPTIONAL: leave's PRIMARY effect is the LOCAL teardown,
   * which must succeed even when the registry can't be resolved (offline / no
   * registry configured). When all three resolve, `leave` also retags the
   * principal's registry capabilities to drop this network; when any is missing,
   * the registry deregister is skipped (the local leave still completes, with a
   * warning) rather than failing the whole command.
   */
  registryUrl?: string;
  registryPubkey?: string;
  seedPath?: string;
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
  /** C-1224 (ADR-0013 Model B) — `--leaf-secret` (the secret-auth pipe secret). */
  leafSecret?: string;
  /** C-1224 — `--leaf-user` (userinfo user; defaults to the principal id). */
  leafUser?: string;
  /** O-3 (#1053) — `--operator-jwt`. */
  operatorJwt?: string;
  /** O-3 (#1053) — `--account-jwt`. */
  accountJwt?: string;
  /** O-3 (#1053) — `--system-account`. */
  systemAccount?: string;
  /** O-3 (#1053) — `--system-account-jwt`. */
  systemAccountJwt?: string;
  /**
   * O-4b (#1063) — the leaf package SOURCED from `--from-package <file>` (parsed
   * + validated by the CLI before it reaches here). Sits in the precedence chain
   * BELOW the explicit per-field flags above and ABOVE config: an explicit flag
   * (`operatorJwt`/`account`/`accountJwt`/`systemAccount*`/`credsPath`) wins, then
   * config, then convention.
   */
  // leafPackage removed — ADR-0015 retired O-4b / --from-package / Model-A.
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

  // C-1364 — the boot-authoritative own-scope stack slug. Derived from the SAME
  // loaded config the daemon boots from, via the SAME resolver the boot
  // validator uses (`deriveStackId(cfg).stack`, ADR-0004 / ADR-0001 superRefine).
  // This is flag-INDEPENDENT on purpose: a `--stack` override retargets the
  // write-path locator (DA-5) but must never move the federation identity boot
  // enforces, or the join own-scope guard and boot would split on a drifted stack.
  const bootStackSlug = deriveStackId(cfg).stack;

  // seed-path — flag wins, else stack.nkey_seed_path.
  const seedPath = overrides.seedPath ?? cfg.stack?.nkey_seed_path;
  if (seedPath === undefined || seedPath === "") {
    return fail(
      "cannot resolve signing seed — pass --seed-path or set `stack.nkey_seed_path` in cortex.yaml",
    );
  }

  // registry — cortex#1228: resolved through the shared anchor chokepoint.
  // Precedence flag → config → the compiled-in DEFAULT_REGISTRY anchor, so the
  // URL ALWAYS resolves (closes the old hard-error gap: a fresh install with no
  // `policy.federated.registry` now defaults to the metafactory registry,
  // PINNED, with NO TOFU window). pubkey: explicit pin wins; else the default
  // anchor's baked pubkey when the URL is the default; else absent (TOFU on a
  // custom registry, flagged via `registryTofu`).
  const registry = cfg.policy?.federated?.registry;
  const resolvedRegistry = resolveRegistryAnchor({
    ...(overrides.registryUrl !== undefined && { flagUrl: overrides.registryUrl }),
    ...(overrides.registryPubkey !== undefined && { flagPubkey: overrides.registryPubkey }),
    ...(registry?.url !== undefined && { configUrl: registry.url }),
    ...(registry?.pubkey !== undefined && { configPubkey: registry.pubkey }),
  });
  const registryUrl = resolvedRegistry.url;
  const registryPubkey = resolvedRegistry.pubkey;

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

  // #799 — the leaf account is OPTIONAL. An operator-mode bus supplies it (via
  // `--account` / `stack.nats_infra.account`) → the leaf renders an `account:`
  // line. A `$G`/default-account bus has none → the join renders a no-account
  // leaf (binding rides in the creds JWT). So an absent account is NOT an
  // error here; the bind-mode decision (resolveLeafBindMode) refuses only the
  // genuinely-unjoinable case (no creds, or operator-mode missing the account).
  const accountRaw = overrides.account ?? natsInfra?.account;
  const account =
    accountRaw === undefined || accountRaw === "" ? undefined : accountRaw;

  // creds — flag wins, else stack.nats_infra.creds_path, else convention.
  // (--from-package / pkg?.credsPath removed — ADR-0015 retired O-4b / Model-A)
  const credsPath =
    overrides.credsPath ?? natsInfra?.creds_path ?? defaultCredsPath(networkId);

  // C-1224 (ADR-0013 Model B) — the leaf shared secret (secret-auth pipe). Flag
  // wins, else `stack.nats_infra.leaf_secret`. When present, the join renders a
  // secret-auth leaf binding the principal's OWN local `account` instead of a
  // `.creds`-file leaf. The userinfo USER defaults to the principal id (the hub's
  // `authorization { user, password }` user) unless flagged/configured. The user
  // is resolved ONLY alongside a secret — it is meaningless without one.
  const leafSecretRaw = overrides.leafSecret ?? natsInfra?.leaf_secret;
  const leafSecret =
    leafSecretRaw === undefined || leafSecretRaw === "" ? undefined : leafSecretRaw;
  const leafUser =
    leafSecret === undefined
      ? undefined
      : (overrides.leafUser ?? natsInfra?.leaf_user ?? principal);

  // O-3 (cortex#1053) — assemble the operator-mode leaf package. Precedence per
  // field: explicit flag > config (`stack.nats_infra.{operator_jwt,account_jwt,…}`).
  // The package materialises ONLY when its minimum (operator JWT + account + account
  // JWT) all resolve; a partial set is treated as "no package" so join falls back
  // to the #794 fail-fast rather than handing a half-formed package to the renderer.
  const operatorJwt = overrides.operatorJwt ?? natsInfra?.operator_jwt;
  const accountJwt = overrides.accountJwt ?? natsInfra?.account_jwt;
  const systemAccount = overrides.systemAccount ?? natsInfra?.system_account;
  const systemAccountJwt = overrides.systemAccountJwt ?? natsInfra?.system_account_jwt;
  const operatorModePackage: OperatorModeLeafPackage | undefined =
    operatorJwt !== undefined &&
    operatorJwt !== "" &&
    account !== undefined &&
    accountJwt !== undefined &&
    accountJwt !== ""
      ? {
          operatorJwt,
          account,
          accountJwt,
          ...(systemAccount !== undefined &&
            systemAccount !== "" && { systemAccount }),
          ...(systemAccountJwt !== undefined &&
            systemAccountJwt !== "" && { systemAccountJwt }),
        }
      : undefined;

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
      bootStackSlug,
      seedPath,
      registryUrl,
      ...(registryPubkey !== undefined && { registryPubkey }),
      ...(resolvedRegistry.tofu && { registryTofu: true }),
      natsConfigPath,
      ...(descriptor.plistPath !== undefined && { plistPath: descriptor.plistPath }),
      ...(descriptor.unitPath !== undefined && { unitPath: descriptor.unitPath }),
      platform: descriptor.platform,
      ...(account !== undefined && { account }),
      credsPath,
      ...(leafSecret !== undefined && { leafSecret }),
      ...(leafUser !== undefined && { leafUser }),
      ...(operatorModePackage !== undefined && { operatorModePackage }),
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
  overrides: Pick<
    JoinOverrides,
    | "principal"
    | "stack"
    | "natsConfigPath"
    | "plistPath"
    | "unitPath"
    | "registryUrl"
    | "registryPubkey"
    | "seedPath"
  >,
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

  // C-820 — registry coordinates for the leave-side cap retag, resolved the
  // SAME way join does (flag wins, else policy.federated.registry / stack seed).
  // All OPTIONAL: an unresolved registry/seed does NOT fail leave — the local
  // teardown still runs and the registry retag is skipped with a warning.
  const registry = cfg.policy?.federated?.registry;
  const registryUrl = overrides.registryUrl ?? registry?.url;
  const registryPubkey = overrides.registryPubkey ?? registry?.pubkey;
  const seedPath = overrides.seedPath ?? cfg.stack?.nkey_seed_path;

  return {
    ok: true,
    inputs: {
      principal,
      stack,
      natsConfigPath,
      ...(descriptor.plistPath !== undefined && { plistPath: descriptor.plistPath }),
      ...(descriptor.unitPath !== undefined && { unitPath: descriptor.unitPath }),
      platform: descriptor.platform,
      ...(registryUrl !== undefined && registryUrl !== "" && { registryUrl }),
      ...(registryPubkey !== undefined && registryPubkey !== "" && { registryPubkey }),
      ...(seedPath !== undefined && seedPath !== "" && { seedPath }),
    },
  };
}
