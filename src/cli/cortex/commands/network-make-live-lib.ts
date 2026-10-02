/**
 * C-1257 (PR7/#1225, ADR-0013 sovereign model) — the pure orchestration behind
 * `cortex network make-live <stack>`: the daemon-switch step that LANDS a
 * provisioned stack onto its own sovereign agents account.
 *
 * `cortex network provision` is non-disruptive — it mints the account tree
 * (`ANDREAS_<STACK>_FED` + `ANDREAS_<STACK>_AGENTS`) and writes `stack.nats_infra`
 * but NEVER switches the running daemon. make-live closes that gap:
 *
 *   1. mint the daemon's bus creds UNDER the agents account, at `nats.credsPath`
 *      (the very file the daemon authenticates with — `connection.ts`).
 *   2. teach the local NATS server the new account — append its JWT to
 *      `resolver_preload` (MEMORY resolver) in the nats config (default
 *      `~/.config/nats/local.conf`). Keyed on the account pubkey: pure addition,
 *      never disturbs the other stacks' accounts already there (multi-stack safe).
 *      cortex#1265 — when the bus has NO `resolver_preload` yet (a fresh local-only
 *      stack that never federates), BOOTSTRAP the operator-mode skeleton first from
 *      the JWTs provision wrote into `stack.nats_infra` (instead of refusing). PR8:
 *      when the target `<slug>.conf` does not exist AT ALL (truly from-scratch), the
 *      stack's OWN derived base identity (`baseIdentity` — listen from `nats.url`,
 *      names `<slug>-<principal>`) lets make-live SYNTHESISE the hard-isolated base
 *      first and render the operator-mode blocks onto it, in one shot, zero raw nsc.
 *   3. restart the NATS server so the MEMORY resolver loads the new account
 *      (a SIGHUP reload does NOT pick up resolver_preload — a hard restart is
 *      required; verified empirically, see docs/design-make-live-daemon-switch.md).
 *   4. restart the cortex daemon so it reconnects with the new creds under the
 *      agents account.
 *
 * make-live is NETWORK-AGNOSTIC: it lands the daemon on its agents account for
 * BOTH a local stack (no network) and a federated one (where `cortex network
 * join` then renders the leaf on the FED account). It NEVER touches
 * `policy.federated` / `payload_key` / any encryption block, so a federated
 * stack's confidentiality setup survives the account swap by construction.
 *
 * This module is PURE over injected ports — zero fs / arc / nsc / launchctl. The
 * live adapters live in `network-make-live-adapters.ts`. cortex NEVER runs nsc
 * (ADR-0013 invariant): the account JWT comes from `arc nats export-account` and
 * the creds from `arc nats add-bot`.
 *
 * ## Idempotency
 *
 * Every step is ensure-shaped, gated on cheap filesystem reads:
 *   - resolver: append iff the agents pubkey is ABSENT (idempotent, keyed on key).
 *   - creds: (re-)mint iff this is a first migration (resolver did not yet carry
 *     the account) OR the creds file is missing OR `--force`. A converged re-run
 *     (resolver already carries the account AND the creds file exists) mints
 *     nothing and restarts nothing.
 *   - restarts: the nats-server restarts only when the resolver changed; the
 *     daemon restarts only when the creds changed (or the nats-server did).
 *
 * ## Dry-run vs apply
 *
 * Dry-run (the DEFAULT-safe posture) computes the plan from config + filesystem
 * and mutates NOTHING. `--apply` executes mint → resolver → nats restart →
 * daemon restart, fail-fast (any port failure aborts and surfaces how far it got).
 *
 * ## Restart safety (cortex#1483 join-4)
 *
 * When a {@link NatsCanaryPort} is wired, the nats-server restart is GUARDED —
 * validate-before-reload (`-t`), snapshot-before-mutate, settle-window
 * health-verify, and auto-rollback on a genuinely-unhealthy bus. This makes the
 * common ways a live public bus goes down RECOVERABLE and LOUD; it is NOT an
 * absolute "crash-proof" guarantee (cortex#1495): on a host without
 * `nats-server` on PATH the `-t` gate cannot run — it is SKIPPED with a loud
 * warning, not a silent pass — and the hub-side SIGHUP reload path is out of
 * this slice's scope.
 */

import type { OperatorModeLeafPackage, NatsBaseIdentity } from "../../../common/nats/leaf-remote-renderer";
import {
  probeHealthWithSettle,
  realClock,
  settleFailureReason,
  INCONCLUSIVE_HEALTH_NOTICE,
  type ClockPort,
  type ConfigValidationOutcome,
  type HealthProbeResult,
  type SettleWindowOptions,
} from "../../../common/nats/restart-with-settle";
import { describeGStoreStreams, gStoreMoveTarget, type GStoreStream } from "./network-make-live-preflight";

// =============================================================================
// Ports
// =============================================================================

/** Mint the daemon's bus creds under the agents account (composes `arc nats add-bot`). */
export interface CredsMintPort {
  /**
   * Mint a `.creds` for `botName` under `account`, written to `credsPath`
   * (`chmod 600`), backing up any existing creds to `<credsPath>.bak-makelive`
   * first. `force` overwrites an existing user. Returns the user's pubkey.
   */
  mint(opts: { botName: string; account: string; credsPath: string; force: boolean }): Promise<
    | { ok: true; credsPath: string; userPubkey: string }
    | { ok: false; reason: string }
  >;
}

/** Export an account's JWT (composes `arc nats export-account`). */
export interface AccountExportPort {
  exportAccount(account: string): Promise<
    | { ok: true; pubKey: string; jwt: string; seedPath: string | null }
    | { ok: false; reason: string }
  >;
}

/** Append an account to the nats-server `resolver_preload` (MEMORY resolver). */
export interface ResolverPreloadPort {
  /** Is `accountPubkey` already present in the resolver_preload of `natsConfigPath`? */
  hasAccount(natsConfigPath: string, accountPubkey: string): boolean;
  /**
   * M3 — does `natsConfigPath` carry a `resolver_preload { … }` block at all?
   * A bus with none (the anonymous / hard-isolated `halden` pattern) is NOT
   * operator-mode and cannot host a make-live; the orchestrator refuses early.
   */
  hasResolverPreload(natsConfigPath: string): boolean;
  /**
   * Append a labelled `<pubkey>: <jwt>` block inside resolver_preload, backing
   * up the config first. Idempotent: no-op (`changed:false`) when present.
   */
  appendAccount(opts: {
    natsConfigPath: string;
    accountName: string;
    accountPubkey: string;
    accountJwt: string;
  }): { ok: true; changed: boolean } | { ok: false; reason: string };
  /**
   * cortex#1265 — bootstrap an INITIAL operator-mode skeleton into a config that
   * has NO `resolver_preload` yet (the local-only path: a never-federates stack
   * never runs `join`, so nothing else renders the operator-mode blocks). Renders
   * `operator:` + optional `system_account:` + `resolver: MEMORY` +
   * `resolver_preload { <federation account> [, <system account>] }` via
   * `renderOperatorModeBlocks`, KEEPING the bus's own
   * `server_name`/`listen`/`http`/`jetstream.domain`, and backing up the config
   * first. The subsequent `appendAccount` then adds the agents account.
   *
   * cortex#1480 (join-1, epic #1479) — the orchestrator ALSO calls this when
   * resolver_preload already EXISTS but is missing the federation (and/or
   * system) account the package carries — the exact "does not define account
   * <FED>" gap a bus bootstrapped before FED existed (or hand-converted
   * carrying only the agents account) fell into forever under the old
   * block-presence-only gate. `renderOperatorModeBlocks` handles both shapes:
   * idempotent `changed:false` when the bus is ALREADY operator-mode under the
   * SAME operator with every package account already preloaded; ENSURES any
   * missing package account into the existing block (`changed:true`) when some
   * are absent; refuses (ok:false) on a malformed package OR a bus already
   * operator-mode under a DIFFERENT operator (never clobber).
   *
   * cortex#1265 (PR8) — when the target config does NOT exist yet (a truly
   * from-scratch stack), `baseIdentity` (when supplied) lets the adapter SYNTHESISE
   * the hard-isolated base config first (server_name/listen/jetstream, derived
   * from the stack's OWN config — never fabricated) and then render the
   * operator-mode blocks onto it, so the whole config is created in one shot. When
   * the file is absent AND `baseIdentity` is undefined the adapter keeps the
   * historical refusal (never invent a server identity).
   */
  bootstrapOperatorMode(opts: {
    natsConfigPath: string;
    package: OperatorModeLeafPackage;
    baseIdentity?: NatsBaseIdentity;
  }): { ok: true; changed: boolean } | { ok: false; reason: string };
}

/** Restart the nats-server + the cortex daemon (composes launchctl/systemctl). */
export interface ServiceRestartPort {
  /**
   * BLOCK 2 — read-only resolution of the launchd/systemd descriptors that
   * `restartNats` / `restartDaemon` WOULD target. Surfaced in the dry-run plan so
   * the operator verifies the (potentially SHARED) nats-server blast target
   * before `--apply`. `undefined` ⇒ no matching service found.
   */
  resolveTargets(opts: { natsConfigPath: string; cortexConfigPath: string }): {
    natsDescriptor?: string;
    daemonDescriptor?: string;
  };
  /** Hard-restart the nats-server bound to `natsConfigPath` (loads new resolver_preload). */
  restartNats(natsConfigPath: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Restart the cortex daemon loading `cortexConfigPath` (reconnect with new creds). */
  restartDaemon(cortexConfigPath: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * cortex#2533 — stop the nats-server bound to `natsConfigPath` and keep it
   * stopped (the `$G` store is moved aside in that window). OPTIONAL: absent ⇒
   * `--move-g-store` refuses (never move the store under a live server).
   */
  stopNats?(natsConfigPath: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** cortex#2533 — start the nats-server {@link stopNats} stopped. */
  startNats?(natsConfigPath: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * cortex#1265 (v5.30.2) — config write-back for a DEFAULTED `nats.credsPath`. When
 * make-live had to synthesise the bus-creds path (neither `--creds` nor config
 * supplied it), it persists the resolved path into the daemon's config so the
 * daemon actually connects with it (runtime.ts only passes `credsPath` when set —
 * an unset path → no creds → own-auth Authorization Violation on the operator-mode
 * bus) and the config self-documents. Targets the SYSTEM/bus layer
 * (`config.nats.credsPath`), NEVER `stack.nats_infra`: a surgical single-key set
 * that preserves every other key + comment (encryption / federated JWTs survive).
 */
export interface MakeLiveConfigWritePort {
  /** Persist `nats.credsPath = credsPath` into `systemConfigPath` (idempotent). */
  writeBusCredsPath(opts: { systemConfigPath: string; credsPath: string }):
    | { ok: true; path: string; changed: boolean }
    | { ok: false; reason: string };
}

/**
 * cortex#1483 (join-4) — a snapshot of `natsConfigPath`'s bytes (or absence),
 * taken BEFORE the resolver/bootstrap mutation, so a restart that leaves the
 * bus unhealthy can be rolled back to EXACTLY the pre-make-live state.
 */
export interface NatsConfigSnapshot {
  natsConfigPath: string;
  /** The prior file contents, or `undefined` if the file did not exist. */
  contents: string | undefined;
}

/**
 * cortex#1483 (join-4, epic #1479) — the CANARY safety port GUARDING make-live's
 * nats-server restart: validate-before-reload, snapshot-before-mutate,
 * settle-window health-verify (via {@link probeHealthWithSettle}), and
 * auto-rollback on a genuinely-unhealthy bus. It hardens two failure modes: a
 * hand-edit or a bad render taking a live public stack down with no recovery,
 * and a restart whose success was trusted by EXIT CODE alone (`launchctl
 * kickstart`/`systemctl restart` returning 0 while nats-server then crashes on
 * the new config at runtime).
 *
 * cortex#1495 — this is a GUARDED/CANARIED restart, NOT an absolute
 * "crash-proof" guarantee. Known gaps: on a host without `nats-server` on PATH
 * the `-t` gate cannot run (SKIPPED — the caller warns loudly + proceeds), and
 * the hub-side SIGHUP reload path (`network secret`) is out of this slice's
 * scope. It makes the common failure modes recoverable + loud, not impossible.
 *
 * OPTIONAL on {@link MakeLivePorts}: absent ⇒ the pre-#1483 behaviour
 * (`restartNats`'s exit code trusted as-is, no validate/snapshot/rollback) —
 * kept for callers/tests that predate this slice.
 */
export interface NatsCanaryPort {
  /**
   * `nats-server -c <natsConfigPath> -t` — the syntax gate. cortex#1495 BLOCKER:
   * returns a THREE-state {@link ConfigValidationOutcome} (valid / invalid /
   * skipped). Reload ONLY on `valid`; refuse on `invalid`; on `skipped`
   * (`nats-server` not on PATH / spawn failed) the caller warns LOUDLY that the
   * gate did not run, then proceeds — never a silent fail-open pass.
   */
  validateConfig(natsConfigPath: string): Promise<ConfigValidationOutcome>;
  /** Pure READ: capture `natsConfigPath`'s current bytes (or absence). Taken BEFORE any mutation. */
  snapshot(natsConfigPath: string): NatsConfigSnapshot;
  /** Restore `natsConfigPath` to exactly the snapshotted bytes (or delete it if it did not exist). */
  restore(snapshot: NatsConfigSnapshot): void;
  /**
   * A single post-restart health probe (e.g. the config's own monitor
   * `/healthz`). cortex#1495 important 3 — the healthy variant may carry
   * `inconclusive: true` (#831 no-monitor) so the caller logs "inconclusive,
   * treated as healthy" rather than "verified healthy".
   */
  isHealthy(natsConfigPath: string): Promise<HealthProbeResult>;
  /**
   * cortex#2533 — BOOT the rollback snapshot on a throwaway copy (random
   * loopback ports, scratch store, outbound URLs pointed at a dead port) and
   * report whether it came up. `nats-server -t` does not resolve a leaf
   * remote's `account:`, so a snapshot can pass `-t` and still refuse to boot —
   * and the canary's rollback restores exactly that snapshot. Three states,
   * like {@link validateConfig}: refuse on `unbootable`, warn + proceed on
   * `skipped` (no `nats-server` binary / no prior config).
   */
  bootTest(snapshot: NatsConfigSnapshot): Promise<SnapshotBootOutcome>;
}

/** cortex#2533 — the verdict of {@link NatsCanaryPort.bootTest}. */
export type SnapshotBootOutcome =
  | { status: "bootable" }
  | { status: "unbootable"; reason: string }
  | { status: "skipped"; reason: string };

/** cortex#2533 — what make-live found at `<store_dir>/jetstream/$G`. */
export type GStoreInspection =
  /** JetStream is off (or there is no config yet) — no store to worry about. */
  | { status: "no-jetstream" }
  | { status: "absent"; storeDir: string }
  | { status: "present"; storeDir: string; gStorePath: string; streams: GStoreStream[] }
  /** JetStream is on but the store dir cannot be resolved (no/relative `store_dir`). */
  | { status: "unknown"; reason: string };

/**
 * cortex#2533 — the anonymous `$G` JetStream store an operator-mode server
 * cannot recover. make-live refuses a conversion while it exists unless
 * `--move-g-store` is passed; then it is MOVED aside (never deleted) while the
 * server is stopped, and moved back on rollback.
 */
export interface GStorePort {
  /** Read-only: resolve `store_dir` from the config (includes followed) and look for `jetstream/$G`. */
  inspect(natsConfigPath: string): GStoreInspection;
  /** Rename `gStorePath` to a timestamped dir beside `<storeDir>/jetstream`. */
  moveAside(opts: { gStorePath: string; storeDir: string }):
    | { ok: true; movedTo: string }
    | { ok: false; reason: string };
  /** Rename `movedTo` back to `gStorePath`. Refuses (never merges) when `gStorePath` exists again. */
  moveBack(opts: { movedTo: string; gStorePath: string }): { ok: true } | { ok: false; reason: string };
}

export interface MakeLivePorts {
  creds: CredsMintPort;
  accountExport: AccountExportPort;
  resolver: ResolverPreloadPort;
  restart: ServiceRestartPort;
  /**
   * cortex#1265 (v5.30.2) — OPTIONAL: persist a DEFAULTED `nats.credsPath` back to
   * config. Absent ⇒ the write-back is skipped (back-compat for callers/tests that
   * predate it; only `deriveMakeLiveInputs` + `buildLiveMakeLivePorts` supply it).
   */
  configWrite?: MakeLiveConfigWritePort;
  /**
   * cortex#1483 (join-4) — OPTIONAL: the canary safety wrapper around the nats
   * restart (validate/snapshot/health/rollback). Absent ⇒ pre-#1483 behaviour.
   */
  natsCanary?: NatsCanaryPort;
  /**
   * cortex#2533 — OPTIONAL: the `$G` store pre-flight for an anonymous →
   * operator-mode conversion. Absent ⇒ no check (callers/tests that predate it).
   */
  gStore?: GStorePort;
  /**
   * cortex#1483 (join-4) — settle-window tuning for the post-restart health
   * verdict (see {@link probeHealthWithSettle}). Only consulted when
   * {@link MakeLivePorts.natsCanary} is wired. Absent ⇒
   * {@link probeHealthWithSettle}'s own sane defaults.
   */
  settle?: SettleWindowOptions;
  /**
   * cortex#1483 (join-4) — injectable wall-clock wait for the settle-window
   * backoff delays. Absent ⇒ the real `setTimeout`-backed clock.
   */
  clock?: ClockPort;
}

// =============================================================================
// Inputs + state + result
// =============================================================================

/** Observable pre-make-live state (read from config + filesystem). */
export interface MakeLiveState {
  /** Does the daemon's connection creds file (`nats.credsPath`) exist on disk? */
  credsFileExists: boolean;
  /** Does the nats config's resolver_preload already carry the agents account pubkey? */
  resolverHasAccount: boolean;
}

export interface MakeLiveInputs {
  principal: string;
  stackSlug: string;
  stackId: string;
  /** `ANDREAS_<STACK>_AGENTS` — the account name to land the daemon on. */
  agentsAccountName: string;
  /** `stack.nats_infra.agents_account` pubkey (provision wrote it). REQUIRED. */
  agentsAccountPubkey: string;
  /** `nats.name` — the bot/user name minted under the agents account. */
  botName: string;
  /** `nats.credsPath` — the daemon's connection creds (where new creds land). */
  credsPath: string;
  /** Path to the cortex config the daemon loads (for daemon-restart discovery). */
  cortexConfigPath: string;
  /**
   * cortex#1265 (v5.30.2) — true when `credsPath` was DEFAULTED (neither `--creds`
   * nor `config.nats.credsPath` supplied it). Drives the config write-back: a
   * defaulted path is persisted into `systemConfigWritePath` so the daemon connects
   * with it. An explicit `--creds`/config value is NEVER overwritten.
   */
  credsPathDefaulted?: boolean;
  /**
   * cortex#1265 (v5.30.2) — the config file a DEFAULTED `nats.credsPath` is written
   * back into: the SYSTEM-layer `system/system.yaml` in a config-split layout, else
   * the legacy monolith file. Consulted only when `credsPathDefaulted` is true AND
   * `ports.configWrite` is present.
   */
  systemConfigWritePath?: string;
  /**
   * cortex#1265 — the operator-mode leaf package assembled from
   * `stack.nats_infra.{operator_jwt, account, account_jwt, system_account,
   * system_account_jwt}` (provision populates these). Present ⇒ a bus with no
   * `resolver_preload` is BOOTSTRAPPED operator-mode (instead of refused). Absent
   * ⇒ the #794 refusal stands (no JWTs to render with).
   */
  operatorModePackage?: OperatorModeLeafPackage;
  /**
   * cortex#1265 (PR8) — the stack's own derived nats-server base identity, used to
   * SYNTHESISE a hard-isolated base config when `natsConfigPath` does not exist yet
   * (the truly from-scratch path). Derived from the stack's own config (listen from
   * `nats.url`, names `<slug>-<principal>`) — never fabricated. Absent ⇒ a missing
   * config file keeps the historical "create the base config first" refusal.
   */
  baseIdentity?: NatsBaseIdentity;
  /**
   * Path to the nats-server config carrying resolver_preload. BLOCK 1 — derived
   * PER-STACK from `stack.nats_infra.config_path` (or `--nats-config`); there is
   * NO shared default, so a co-located stack on its own nats-server never targets
   * the wrong (shared) config.
   */
  natsConfigPath: string;
  force: boolean;
  apply: boolean;
  /**
   * cortex#2533 — `--move-g-store`: on an anonymous → operator-mode conversion,
   * move an existing `<store_dir>/jetstream/$G` aside (server stopped, never
   * deleted, moved back on rollback) instead of refusing.
   */
  moveGStore?: boolean;
  state: MakeLiveState;
}

export type StepStatus = "mint" | "wire" | "restart" | "move" | "ok";

export interface PlanItem {
  step: string;
  status: StepStatus;
  detail: string;
}

export interface MakeLiveResult {
  ok: boolean;
  reason?: string;
  applied: boolean;
  plan: PlanItem[];
  steps: string[];
}

// =============================================================================
// Plan (pure)
// =============================================================================

/**
 * Decide which steps are NEEDED from observable state. A first migration is
 * signalled by the resolver NOT yet carrying the agents account; on that path
 * the creds are (re-)minted even if a (stale, old-account) creds file exists.
 */
export function planMakeLive(inputs: MakeLiveInputs): {
  credsNeeded: boolean;
  resolverNeeded: boolean;
  natsRestartNeeded: boolean;
  daemonRestartNeeded: boolean;
  plan: PlanItem[];
} {
  const { force, state } = inputs;
  const resolverNeeded = force || !state.resolverHasAccount;
  // First migration (resolver absent) ⇒ mint regardless of a stale creds file.
  const credsNeeded = force || !state.resolverHasAccount || !state.credsFileExists;
  // M2 — the resolver_preload append actually CHANGES the file only when the
  // account is ABSENT (append is keyed on the pubkey; a present account no-ops).
  // `--force` re-mints creds but must NOT trigger a no-op hard-restart of a
  // (potentially SHARED) nats-server, so the nats restart is gated on the
  // resolver genuinely changing, not merely on `resolverNeeded`.
  const resolverWillChange = !state.resolverHasAccount;
  const natsRestartNeeded = resolverWillChange;
  const daemonRestartNeeded = credsNeeded || natsRestartNeeded;

  const plan: PlanItem[] = [
    {
      step: "resolver_preload account",
      status: resolverNeeded ? "wire" : "ok",
      detail: `${inputs.agentsAccountName} (${inputs.agentsAccountPubkey}) → ${inputs.natsConfigPath}`,
    },
    {
      step: "nats-server restart",
      status: natsRestartNeeded ? "restart" : "ok",
      detail: inputs.natsConfigPath,
    },
    {
      step: "bus creds (agents account)",
      status: credsNeeded ? "mint" : "ok",
      detail: `${inputs.botName} @ ${inputs.agentsAccountName} → ${inputs.credsPath}`,
    },
    {
      step: "cortex daemon restart",
      status: daemonRestartNeeded ? "restart" : "ok",
      detail: inputs.cortexConfigPath,
    },
  ];
  return { credsNeeded, resolverNeeded, natsRestartNeeded, daemonRestartNeeded, plan };
}

function renderPlanLine(item: PlanItem): string {
  return `[${item.status.padEnd(8)}] ${item.step.padEnd(28)} ${item.detail}`;
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Land a provisioned stack's daemon onto its agents account. Pure over `ports`;
 * NEVER throws (port failures surface as `{ ok: false, reason }`).
 *
 * Dry-run (`apply === false`): returns the plan; mutates nothing.
 * Apply: resolver append → creds mint → nats restart → daemon restart, fail-fast.
 */
export async function makeLiveStack(
  inputs: MakeLiveInputs,
  ports: MakeLivePorts,
): Promise<MakeLiveResult> {
  // Guard: the agents account must have been provisioned first.
  if (inputs.agentsAccountPubkey === "") {
    return {
      ok: false,
      applied: false,
      plan: [],
      reason:
        "stack.nats_infra.agents_account is not set — run `cortex network provision " +
        `${inputs.stackSlug} --apply` + "` first to mint the account tree.",
      steps: [],
    };
  }

  // M3 / cortex#1265 — operator-mode handling. make-live teaches the nats-server a
  // new account by appending to `resolver_preload`; a bus with no such block (the
  // anonymous / hard-isolated `halden` pattern, OR a fresh local-only stack) is not
  // yet operator-mode. Two outcomes, decided BEFORE any mint/restart (so the choice
  // shows in dry-run too), against the SAME natsConfigPath the rest of the flow
  // targets (BLOCK 1 derives it per-stack):
  //   - operator-mode JWTs in config (provision populated them) ⇒ BOOTSTRAP an
  //     initial operator-mode skeleton (cortex#1265 local-only path).
  //   - no JWTs ⇒ the #794 refusal stands — nothing to render with.
  //
  // cortex#1480 (join-1, epic #1479) — bootstrap must ALSO fire when
  // resolver_preload already EXISTS but is missing an account THIS package
  // carries (FED and/or SYS), not only when the block is wholly absent. A bus
  // bootstrapped before its FED account existed (or hand-converted carrying
  // only the AGENTS account) keeps `hasResolverPreload` true forever, so the
  // old `!hasResolverPreload`-only gate never revisited it and FED was never
  // preloaded — the "does not define account <FED>" fail-closed that blocked
  // the metafactory-community bring-up. `hasAccount` is the SAME generic
  // per-pubkey presence probe the always-run AGENTS append (step 1 below)
  // already uses; reusing it here keeps the two checks from drifting.
  const resolverBlockPresent = ports.resolver.hasResolverPreload(inputs.natsConfigPath);
  const opPkg = inputs.operatorModePackage;
  const fedAlreadyPreloaded =
    opPkg === undefined || ports.resolver.hasAccount(inputs.natsConfigPath, opPkg.account);
  const sysAlreadyPreloaded =
    opPkg?.systemAccount === undefined ||
    opPkg.systemAccount.length === 0 ||
    ports.resolver.hasAccount(inputs.natsConfigPath, opPkg.systemAccount);
  const bootstrapNeeded =
    !resolverBlockPresent || (opPkg !== undefined && (!fedAlreadyPreloaded || !sysAlreadyPreloaded));
  if (bootstrapNeeded && inputs.operatorModePackage === undefined) {
    return {
      ok: false,
      applied: false,
      plan: [],
      reason:
        `${inputs.natsConfigPath} has no resolver_preload { … } block — this stack's bus is not ` +
        "operator-mode, and stack.nats_infra carries no operator-mode JWTs to bootstrap one. Run " +
        `\`cortex network provision ${inputs.stackSlug} --apply\` first (it populates ` +
        "operator_jwt + account_jwt), or convert the bus by hand (docs/sop-stack-onboarding.md §B0.1).",
      steps: [],
    };
  }

  const { credsNeeded, resolverNeeded, natsRestartNeeded, daemonRestartNeeded, plan: corePlan } =
    planMakeLive(inputs);

  // cortex#2533 — the `$G` store pre-flight, decided BEFORE any mutation (so it
  // shows in dry-run too). Only an anonymous → operator-mode conversion (no
  // resolver_preload block yet) leaves a `$G` store the new server cannot
  // recover; an already-operator-mode bus has no live `$G` store to strand.
  const preflight = gStorePreflight(inputs, ports, bootstrapNeeded && !resolverBlockPresent);
  if (!preflight.ok) {
    return { ok: false, applied: false, plan: [], reason: preflight.reason, steps: [] };
  }
  const gStoreMove = preflight.move;

  // cortex#1265 — prepend the bootstrap step to the plan when it is needed.
  // cortex#2533 — the `$G` move sits right before the nats-server restart it rides on.
  const movePlan: PlanItem[] =
    gStoreMove === undefined
      ? []
      : [
          {
            step: "$G store move-aside",
            status: "move",
            detail:
              `${gStoreMove.gStorePath} → ${gStoreMoveTarget(gStoreMove.storeDir, "<timestamp>")} ` +
              `(${describeGStoreStreams(gStoreMove.streams)}); nats-server stopped first, never deleted, moved back on rollback`,
          },
        ];
  const corePlanWithMove = corePlan.flatMap((item) =>
    item.step === "nats-server restart"
      ? [
          ...movePlan,
          gStoreMove === undefined ? item : { ...item, detail: `${item.detail} (stop → move $G aside → start)` },
        ]
      : [item],
  );
  const plan: PlanItem[] = bootstrapNeeded
    ? [
        {
          step: "operator-mode bootstrap",
          status: "wire",
          detail:
            `ensure operator + resolver_preload carries the federation account (+ system, if any) → ` +
            inputs.natsConfigPath,
        },
        ...corePlanWithMove,
      ]
    : corePlanWithMove;
  const planLines = plan.map(renderPlanLine);

  // BLOCK 2 — resolve (read-only) the launchd/systemd descriptors the nats-server +
  // daemon restarts will target. make-live's highest-blast action is a HARD RESTART
  // of a potentially SHARED nats-server, so the operator must be able to preview the
  // exact service before --apply. Resolved here (not apply-only) so it shows in the
  // dry-run plan AND prefixes the apply transcript.
  const targets = ports.restart.resolveTargets({
    natsConfigPath: inputs.natsConfigPath,
    cortexConfigPath: inputs.cortexConfigPath,
  });
  const targetLines = [
    `nats-server restart target → ${inputs.natsConfigPath} :: ${targets.natsDescriptor ?? "NOT FOUND (no launchd/systemd service runs nats-server -c this config)"}`,
    `cortex daemon restart target → ${inputs.cortexConfigPath} :: ${targets.daemonDescriptor ?? "NOT FOUND (no cortex daemon service loads this config)"}`,
  ];

  if (!inputs.apply) {
    // Surface a dry-run WARNING when a NEEDED restart has no discoverable service —
    // catch a missing descriptor before --apply rather than mid-pipeline.
    const warnings: string[] = [];
    if (natsRestartNeeded && targets.natsDescriptor === undefined) {
      warnings.push(
        "WARNING: nats-server restart is needed but no service running " +
          `nats-server -c ${inputs.natsConfigPath} was found — --apply would fail at the restart step.`,
      );
    }
    if (daemonRestartNeeded && targets.daemonDescriptor === undefined) {
      warnings.push(
        "WARNING: cortex daemon restart is needed but no service loading " +
          `${inputs.cortexConfigPath} was found — --apply would fail at the daemon restart.`,
      );
    }
    // cortex#1265 (v5.30.2) — preview the credsPath write-back when it was defaulted.
    const defaultNote =
      inputs.credsPathDefaulted === true && inputs.systemConfigWritePath !== undefined
        ? [
            "",
            `nats.credsPath defaulted → ${inputs.credsPath} (would be written to config ${inputs.systemConfigWritePath} on --apply)`,
          ]
        : [];
    // cortex#2533 — preview the pre-mutation rollback boot-test.
    const bootTestNote =
      natsRestartNeeded && ports.natsCanary !== undefined
        ? [
            "",
            `rollback snapshot: --apply boots a throwaway copy of ${inputs.natsConfigPath} (random loopback ports, ` +
              "scratch store) BEFORE mutating, and refuses if it does not come up (it only warns when the " +
              "boot test cannot run, e.g. no nats-server binary).",
          ]
        : [];
    return {
      ok: true,
      applied: false,
      plan,
      steps: [
        ...planLines,
        "",
        ...targetLines,
        ...(preflight.notes.length > 0 ? ["", ...preflight.notes] : []),
        ...(warnings.length > 0 ? ["", ...warnings] : []),
        ...bootTestNote,
        ...defaultNote,
        "",
        credsNeeded || resolverNeeded
          ? "Re-run with --apply to land the daemon on its agents account."
          : "Already live on the agents account — nothing to do (re-run with --force to re-mint).",
      ],
    };
  }

  // Prefix the apply transcript with the resolved blast targets too (so the
  // post-hoc record shows exactly which services were restarted).
  const steps: string[] = [...targetLines, ...preflight.notes];

  // cortex#1483 (join-4) — CANARY safety: snapshot the nats config BEFORE any
  // mutation (bootstrap/resolver) so a restart that leaves the bus unhealthy
  // can be rolled back to EXACTLY the pre-make-live bytes. A pure READ, taken
  // only when a nats restart will actually happen AND a canary port is wired
  // (opt-in — absent ⇒ pre-#1483 behaviour, no snapshot/validate/rollback).
  const natsSnapshot =
    natsRestartNeeded && ports.natsCanary !== undefined
      ? ports.natsCanary.snapshot(inputs.natsConfigPath)
      : undefined;

  // cortex#2533 — BOOT-TEST the rollback target before mutating. The rollback
  // restores exactly this snapshot; if it cannot boot, a failed canary leaves
  // the bus DOWN, so refuse while nothing has changed yet.
  if (natsSnapshot !== undefined && ports.natsCanary !== undefined) {
    const boot = await bootTestSnapshot(ports.natsCanary, natsSnapshot);
    if (!boot.ok) {
      return { ok: false, applied: false, plan, steps, reason: boot.reason };
    }
    steps.push(boot.note);
  }

  // 0. (cortex#1265) Bootstrap the operator-mode skeleton when the bus has no
  //    resolver_preload yet — renders operator + resolver: MEMORY + the federation
  //    account, KEEPING the bus's own server_name/listen/http. The agents account
  //    is appended in step 1 below. Done BEFORE the append so the block exists.
  let resolverChanged = false;
  // bootstrapNeeded ⇒ operatorModePackage is defined (the guard above returns
  // early otherwise). Re-narrow on the field directly to avoid a non-null `!`.
  if (bootstrapNeeded && inputs.operatorModePackage !== undefined) {
    const boot = ports.resolver.bootstrapOperatorMode({
      natsConfigPath: inputs.natsConfigPath,
      package: inputs.operatorModePackage,
      ...(inputs.baseIdentity !== undefined && { baseIdentity: inputs.baseIdentity }),
    });
    if (!boot.ok) return fail(plan, steps, `operator-mode bootstrap failed: ${boot.reason}`);
    resolverChanged = boot.changed;
    steps.push(
      boot.changed
        ? `operator-mode bootstrap: ensured operator + resolver_preload carries the federation/system account(s) in ${inputs.natsConfigPath}`
        : `operator-mode bootstrap: bus already operator-mode with all required accounts (no-op)`,
    );
  }

  // 1. Teach the NATS server the agents account (append to resolver_preload).
  if (resolverNeeded) {
    const exported = await ports.accountExport.exportAccount(inputs.agentsAccountName);
    if (!exported.ok) return fail(plan, steps, `export-account failed: ${exported.reason}`);
    // BLOCK 3 — the resolver_preload map is keyed by the JWT's subject (the account
    // pubkey). We write the CONFIG pubkey as the KEY but the EXPORTED JWT as the
    // VALUE; if they diverge (slug drift / a re-provision that re-minted the account /
    // a stale nats_infra), the entry is `<configPubkey>: <jwt-for-a-different-account>`.
    // nats-server keys the entry under jwt.sub, so the daemon creds (minted under the
    // NAMED account) land in an account the server keyed differently → auth failure
    // after restart. Cross-check the two and refuse on mismatch.
    if (exported.pubKey !== inputs.agentsAccountPubkey) {
      return fail(
        plan,
        steps,
        "account pubkey drift: stack.nats_infra.agents_account is " +
          `${inputs.agentsAccountPubkey} but \`arc nats export-account ${inputs.agentsAccountName}\` ` +
          `returned ${exported.pubKey}. The config pubkey and the named account have diverged — ` +
          "re-run `cortex network provision` to reconcile before make-live.",
      );
    }
    const appended = ports.resolver.appendAccount({
      natsConfigPath: inputs.natsConfigPath,
      accountName: inputs.agentsAccountName,
      accountPubkey: inputs.agentsAccountPubkey,
      accountJwt: exported.jwt,
    });
    if (!appended.ok) return fail(plan, steps, `resolver_preload append failed: ${appended.reason}`);
    // OR with any bootstrap change (cortex#1265) — a single nats restart covers both.
    resolverChanged = resolverChanged || appended.changed;
    steps.push(
      appended.changed
        ? `resolver_preload: appended ${inputs.agentsAccountName} (${inputs.agentsAccountPubkey})`
        : `resolver_preload: ${inputs.agentsAccountName} already present (no-op)`,
    );
  } else {
    steps.push(`resolver_preload: ${inputs.agentsAccountName} already present (no-op)`);
  }

  // 2. Restart the nats-server so the MEMORY resolver loads the new account.
  //    Done BEFORE minting the daemon's new creds so there is never a window
  //    where the creds on disk name an account the running server doesn't yet
  //    know (which would surface a transient own-auth Authorization Violation if
  //    the live daemon reconnected in that window). Both the OLD shared account
  //    and the new agents account coexist in the resolver across this restart,
  //    so the still-running daemon (on its OLD creds) reconnects cleanly.
  //    M2 — gated on the resolver having ACTUALLY changed (not merely on
  //    `--force`): a `--force` re-mint over an already-present account must not
  //    hard-restart a (potentially shared) nats-server for a no-op resolver.
  if (resolverChanged) {
    const canary = ports.natsCanary;

    // cortex#1483 (join-4) — VALIDATE-BEFORE-RELOAD: `nats-server -c <conf> -t`.
    // Reload the resolver/bootstrap change onto the LIVE bus ONLY when it
    // validates. cortex#1495 BLOCKER — three outcomes, and a "could not
    // validate" is NOT treated as "valid":
    //   - invalid → restore + refuse (never crash the bus on a config we KNOW is
    //     broken);
    //   - skipped → the `-t` gate could not run (`nats-server` not on PATH);
    //     WARN LOUDLY that the safety gate did not run, then proceed (so a host
    //     without the binary isn't hard-blocked) — never a silent fail-open pass;
    //   - valid   → proceed silently.
    if (canary !== undefined) {
      // The live adapter never throws (it maps spawn ENOENT to `skipped`); a
      // stray throw is a contract violation → fail-SAFE as `invalid`/refuse.
      let validated: ConfigValidationOutcome;
      try {
        validated = await canary.validateConfig(inputs.natsConfigPath);
      } catch (err) {
        validated = {
          status: "invalid",
          reason: `nats-server config validation could not run: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (validated.status === "invalid") {
        if (natsSnapshot !== undefined) canary.restore(natsSnapshot);
        return fail(
          plan,
          steps,
          `nats-server config validation (-t) failed before restart, refusing to restart ` +
            `(reverted the resolver_preload/bootstrap write): ${validated.reason}`,
        );
      }
      if (validated.status === "skipped") {
        steps.push(
          `WARN: could not run \`nats-server -t\` — ${validated.reason}; proceeding WITHOUT the ` +
            `pre-reload validation safety gate (a broken config will not be caught before restart)`,
        );
      }
    }

    // cortex#1483 (join-4) — restart, then a SETTLE-WINDOW health verdict (not a
    // single immediate probe — see restart-with-settle.ts for why). Absent a
    // canary port, the restart's exit code is trusted as-is (pre-#1483).
    // cortex#1495 nit 2 — no local try/catch INSIDE the probe helper: the make-live
    // restart/health ports don't throw (the live adapters map spawn ENOENT/fetch
    // errors to typed results), matching the ports-don't-throw convention every
    // other step in makeLiveStack already relies on (mint/export/append). The one
    // guard that IS load-bearing — the rollback restore — is kept below.
    //
    // cortex#1495 v2 (suggestion) — this restart→settle-probe→rollback shape
    // PARALLELS join's `restartAndProbe` in network-lib.ts. They are deliberately
    // NOT extracted into one helper: the shared CORE already lives in
    // `probeHealthWithSettle` + `settleFailureReason` + `INCONCLUSIVE_HEALTH_NOTICE`,
    // and the surrounding orchestration differs materially (join restores LEAF
    // state + threads warnings/network/usedCache into a JoinResult; make-live
    // restores the WHOLE nats config into a MakeLiveResult). A further helper would
    // need callbacks for restart/restore/result-shape and add coupling for little
    // gain, so the parallel is documented rather than abstracted.
    type UpResult = { ok: true; inconclusive: boolean } | { ok: false; reason: string };
    const probe = async (): Promise<UpResult> => {
      if (canary === undefined) return { ok: true, inconclusive: false };
      const settled = await probeHealthWithSettle(
        () => canary.isHealthy(inputs.natsConfigPath),
        ports.settle,
        ports.clock ?? realClock,
      );
      if (!settled.healthy) {
        return { ok: false, reason: settleFailureReason(settled.attempts, settled.reason) };
      }
      return { ok: true, inconclusive: settled.inconclusive === true };
    };
    const restartAndProbe = async (): Promise<UpResult> => {
      const r = await ports.restart.restartNats(inputs.natsConfigPath);
      if (!r.ok) return r;
      return probe();
    };

    // cortex#2533 — the `--move-g-store` bring-up: stop → move `$G` aside →
    // start → probe, tracking how far it got so the rollback can undo exactly
    // that. `gStorePreflight` only yields a move when stopNats/startNats and the
    // gStore port are all wired; `moveOps` re-narrows them for the type checker.
    const moveOps =
      gStoreMove !== undefined &&
      ports.gStore !== undefined &&
      ports.restart.stopNats !== undefined &&
      ports.restart.startNats !== undefined
        ? {
            gStore: ports.gStore,
            stopNats: ports.restart.stopNats.bind(ports.restart),
            startNats: ports.restart.startNats.bind(ports.restart),
            ...gStoreMove,
          }
        : undefined;
    let natsStopped = false;
    let movedTo: string | undefined;
    const startAndProbe = async (): Promise<UpResult> => {
      if (moveOps === undefined) return restartAndProbe();
      const started = await moveOps.startNats(inputs.natsConfigPath);
      if (!started.ok) return { ok: false, reason: `nats-server start failed: ${started.reason}` };
      natsStopped = false;
      return probe();
    };
    const bringUpWithMove = async (): Promise<UpResult> => {
      if (moveOps === undefined) return restartAndProbe();
      const stopped = await moveOps.stopNats(inputs.natsConfigPath);
      if (!stopped.ok) return { ok: false, reason: `nats-server stop failed: ${stopped.reason}` };
      natsStopped = true;
      const moved = moveOps.gStore.moveAside({ gStorePath: moveOps.gStorePath, storeDir: moveOps.storeDir });
      if (!moved.ok) return { ok: false, reason: `moving the $G store aside failed: ${moved.reason}` };
      movedTo = moved.movedTo;
      steps.push(`$G store moved aside (nats-server stopped, NOT deleted): ${moveOps.gStorePath} → ${moved.movedTo}`);
      return startAndProbe();
    };

    // cortex#2533 — recovery after the config was restored. Without a move this
    // is the plain restart. With one, the `$G` store goes back while the server
    // is stopped. If it cannot go back, the bus is still started on the restored
    // config (a DOWN bus is the worse outcome) and the note names both paths.
    const recoverWithMove = async (): Promise<{ up: UpResult; notes: string[]; stranded: boolean }> => {
      if (moveOps === undefined) return { up: await restartAndProbe(), notes: [], stranded: false };
      const notes: string[] = [];
      if (movedTo === undefined) {
        // Nothing was moved: bring the server up on the restored config.
        return { up: natsStopped ? await startAndProbe() : await restartAndProbe(), notes, stranded: false };
      }
      const strandedNote = (why: string, at: string): string =>
        `$G store NOT moved back (${why}) — it is still at ${at}; stop nats-server and move it to ` +
        `${moveOps.gStorePath} by hand`;
      if (!natsStopped) {
        const stopped = await moveOps.stopNats(inputs.natsConfigPath);
        if (!stopped.ok) {
          notes.push(strandedNote(`could not stop nats-server: ${stopped.reason}`, movedTo));
          return { up: await restartAndProbe(), notes, stranded: true };
        }
        natsStopped = true;
      }
      const back = moveOps.gStore.moveBack({ movedTo, gStorePath: moveOps.gStorePath });
      if (back.ok) {
        notes.push(`$G store moved back: ${movedTo} → ${moveOps.gStorePath}`);
        movedTo = undefined;
      } else {
        notes.push(strandedNote(back.reason, movedTo));
      }
      return { up: await startAndProbe(), notes, stranded: !back.ok };
    };

    const initial = await bringUpWithMove();
    if (!initial.ok) {
      // cortex#1483 (join-4) — AUTO-ROLLBACK: restore the pre-mutation snapshot
      // and re-restart, health-probing the RECOVERY restart too (never trust its
      // exit code alone — a recovery that exits 0 but leaves the bus down must
      // still report failure, mirroring join's #821 rollback). This restore IS
      // guarded: makeLiveStack has no outer never-throws boundary, so a throwing
      // restore/recovery must become a clear "rollback FAILED" verdict, never an
      // uncaught escape that leaves the bus down with no message.
      let rollbackNote: string;
      if (natsSnapshot !== undefined && canary !== undefined) {
        try {
          canary.restore(natsSnapshot);
          const { up: recovery, notes, stranded } = await recoverWithMove();
          const extra = notes.length > 0 ? `; ${notes.join("; ")}` : "";
          const health = recovery.ok && recovery.inconclusive ? INCONCLUSIVE_HEALTH_NOTICE : "verified healthy";
          // A bus that came back WITHOUT its $G store is not "the prior state" —
          // never claim so when the operator has a manual move-back to do.
          rollbackNote = recovery.ok
            ? stranded
              ? `rolled back nats config + restarted (bus up, ${health}) but its $G streams are OFFLINE until the store is moved back — intervene manually${extra}`
              : `rolled back nats config + restarted (bus restored to prior state, ${health})${extra}`
            : `rolled back nats config but the recovery restart did NOT bring the bus back up (${recovery.reason}) — bus may be DOWN, intervene manually${extra}`;
        } catch (err) {
          rollbackNote =
            `rollback FAILED (${err instanceof Error ? err.message : String(err)}) — bus may be DOWN, intervene manually` +
            (movedTo !== undefined ? `; the $G store is at ${movedTo}` : "");
        }
      } else {
        rollbackNote =
          "no canary snapshot available (natsCanary port not wired) — could not roll back " +
          "automatically; bus may be DOWN, intervene manually";
      }
      steps.push(`WARN: ${rollbackNote}`);
      return fail(plan, steps, `nats-server restart failed (${initial.reason}); ${rollbackNote}`);
    }
    if (movedTo !== undefined) {
      steps.push(
        `NOTE: the $G streams are now OFFLINE — the store at ${movedTo} is kept on disk (not deleted) but no ` +
          "server serves it. On a shared bus this includes other stacks' streams. Recover any you still need " +
          "by re-creating them under an operator-mode account; delete the moved dir only once nothing needs it.",
      );
    }
    steps.push(
      `nats-server restarted (loaded ${inputs.agentsAccountName} into MEMORY resolver` +
        `${canary === undefined ? "" : initial.inconclusive ? `, ${INCONCLUSIVE_HEALTH_NOTICE}` : ", verified healthy"})`,
    );
  }

  // 3. Mint the daemon's bus creds under the agents account (server now knows it).
  if (credsNeeded) {
    const minted = await ports.creds.mint({
      botName: inputs.botName,
      account: inputs.agentsAccountName,
      credsPath: inputs.credsPath,
      force: inputs.force,
    });
    if (!minted.ok) return fail(plan, steps, `creds mint failed: ${minted.reason}`);
    steps.push(`bus creds minted: ${inputs.botName} @ ${inputs.agentsAccountName} → ${minted.credsPath} (chmod 600)`);
  } else {
    steps.push(`bus creds present (untouched): ${inputs.credsPath}`);
  }

  // 3.5 (cortex#1265, v5.30.2). When `nats.credsPath` was DEFAULTED (neither
  //     --creds nor config supplied it), persist the resolved path into the daemon's
  //     config BEFORE the daemon restart, so it reconnects with the creds it just
  //     minted. runtime.ts only passes credsPath when set — an unset path means no
  //     creds → own-auth Authorization Violation on the operator-mode bus. Surgical
  //     single-key set on the SYSTEM/bus layer; NEVER touches nats_infra. Fail-fast
  //     (before the restart) so we never restart into a broken-auth state.
  if (
    inputs.credsPathDefaulted === true &&
    inputs.systemConfigWritePath !== undefined &&
    ports.configWrite !== undefined
  ) {
    const wrote = ports.configWrite.writeBusCredsPath({
      systemConfigPath: inputs.systemConfigWritePath,
      credsPath: inputs.credsPath,
    });
    if (!wrote.ok) {
      return fail(
        plan,
        steps,
        `nats.credsPath write-back failed: ${wrote.reason}. The bus creds were minted at ` +
          `${inputs.credsPath} but the daemon config still lacks nats.credsPath — add ` +
          `\`nats.credsPath: ${inputs.credsPath}\` to ${inputs.systemConfigWritePath} by hand, then re-run.`,
      );
    }
    steps.push(
      wrote.changed
        ? `nats.credsPath defaulted → ${inputs.credsPath} (written to config ${wrote.path})`
        : `nats.credsPath already ${inputs.credsPath} in config ${wrote.path} (no-op)`,
    );
  }

  // 4. Restart the cortex daemon so it reconnects with the new creds.
  if (daemonRestartNeeded) {
    const r = await ports.restart.restartDaemon(inputs.cortexConfigPath);
    if (!r.ok) return fail(plan, steps, `cortex daemon restart failed: ${r.reason}`);
    steps.push(`cortex daemon restarted — reconnecting under ${inputs.agentsAccountName}`);
  }

  if (!credsNeeded && !resolverNeeded) {
    steps.push("");
    steps.push("Already live on the agents account — nothing changed.");
  } else {
    steps.push("");
    steps.push(`Landed ${inputs.stackId} on ${inputs.agentsAccountName}.`);
    steps.push(
      "Verify: the nats-server /connz?auth=true shows this stack's connection under the agents account, " +
        "and the daemon log carries 0 own-auth Authorization Violation.",
    );
  }

  return { ok: true, applied: true, plan, steps };
}

/**
 * cortex#2533 — the `$G` store pre-flight. `converting` is true only for an
 * anonymous → operator-mode bootstrap (no resolver_preload block yet). Refuses
 * (before any mutation) when a `$G` store exists and `--move-g-store` was not
 * passed, or when it was passed but the stop/start or canary ports it needs
 * are missing. Returns the move to perform (if any) plus transcript notes.
 */
function gStorePreflight(
  inputs: MakeLiveInputs,
  ports: MakeLivePorts,
  converting: boolean,
):
  | { ok: true; move?: Omit<Extract<GStoreInspection, { status: "present" }>, "status">; notes: string[] }
  | { ok: false; reason: string } {
  const nothingToMove = (why: string): string[] =>
    inputs.moveGStore === true ? [`--move-g-store: ${why} — nothing to move`] : [];
  if (!converting) {
    return { ok: true, notes: nothingToMove("not an anonymous → operator-mode conversion") };
  }
  if (ports.gStore === undefined) return { ok: true, notes: [] };

  const g = ports.gStore.inspect(inputs.natsConfigPath);
  if (g.status === "no-jetstream") {
    return { ok: true, notes: nothingToMove("JetStream is not enabled on this bus") };
  }
  if (g.status === "absent") {
    return { ok: true, notes: nothingToMove(`no $G store under ${g.storeDir}/jetstream`) };
  }
  if (g.status === "unknown") {
    return {
      ok: true,
      notes: [
        `WARN: could not check for a $G JetStream store (${g.reason}). If <store_dir>/jetstream/$G exists, ` +
          "the operator-mode server cannot recover it: /healthz stays 503 and the canary rolls back.",
      ],
    };
  }

  const contents = describeGStoreStreams(g.streams);
  const target = gStoreMoveTarget(g.storeDir, "<timestamp>");
  if (inputs.moveGStore !== true) {
    return {
      ok: false,
      reason:
        `${inputs.natsConfigPath} is an anonymous ($G) bus with a JetStream $G account store at ` +
        `${g.gStorePath} (${contents}). After the switch to operator-mode, nats-server cannot recover ` +
        "those streams, so /healthz stays 503 and the canary would roll the change back. On a bus shared " +
        "by several stacks this store may hold their streams too. Nothing was changed. To proceed, " +
        "migrate or drain those streams first. Only if they are empty or disposable, re-run with " +
        `--move-g-store: make-live then stops nats-server, moves the store to ${target}, starts it on ` +
        "the operator-mode config, and moves the store back if the canary rolls back. On success those " +
        "streams go OFFLINE: the moved store is kept on disk (never deleted) but no server serves it.",
    };
  }
  if (ports.restart.stopNats === undefined || ports.restart.startNats === undefined) {
    return {
      ok: false,
      reason:
        `--move-g-store: cannot stop/start the nats-server for ${inputs.natsConfigPath} on this host, and ` +
        `the $G store at ${g.gStorePath} must never be moved under a running server. Nothing was changed.`,
    };
  }
  if (ports.natsCanary === undefined) {
    return {
      ok: false,
      reason:
        "--move-g-store needs the canary (snapshot + health check + rollback) to move the $G store back " +
        "on a failed restart, and it is not wired. Nothing was changed.",
    };
  }
  return {
    ok: true,
    move: { gStorePath: g.gStorePath, storeDir: g.storeDir, streams: g.streams },
    notes: [
      `$G store at ${g.gStorePath} (${contents}) — --move-g-store: will be moved to ${target} with nats-server ` +
        "stopped; its streams go OFFLINE after the switch (kept on disk, not served)",
    ],
  };
}

/**
 * cortex#2533 — boot-test the rollback snapshot through the canary port. A
 * throwing port is a contract violation and fails SAFE (refuse), like the
 * `-t` gate. A snapshot of a config that did not exist has nothing to boot:
 * the rollback just removes the file.
 */
async function bootTestSnapshot(
  canary: NatsCanaryPort,
  snapshot: NatsConfigSnapshot,
): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
  if (snapshot.contents === undefined) {
    return {
      ok: true,
      note: `rollback snapshot: ${snapshot.natsConfigPath} did not exist before make-live (rollback removes it) — nothing to boot-test`,
    };
  }
  let outcome: SnapshotBootOutcome;
  try {
    outcome = await canary.bootTest(snapshot);
  } catch (err) {
    outcome = {
      status: "unbootable",
      reason: `the boot test could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (outcome.status === "bootable") {
    return {
      ok: true,
      note: `rollback snapshot boot-tested: a throwaway copy of ${snapshot.natsConfigPath} came up (random loopback ports, scratch store)`,
    };
  }
  if (outcome.status === "skipped") {
    return {
      ok: true,
      note:
        `WARN: rollback snapshot NOT boot-tested (${outcome.reason}). \`nats-server -t\` does not resolve a ` +
        "leaf remote's `account:`, so a snapshot that passes -t can still refuse to boot — if the canary " +
        "rolls back, the bus may stay DOWN.",
    };
  }
  return {
    ok: false,
    reason:
      `the rollback snapshot of ${snapshot.natsConfigPath} does not boot (${outcome.reason}). make-live ` +
      "restores this exact file if the canary fails, so a failed canary would leave the bus DOWN. Nothing " +
      "was changed. Fix the current config so it boots, then re-run (`nats-server -t` does not catch a " +
      "leaf remote whose `account:` the server does not define).",
  };
}

function fail(plan: PlanItem[], steps: string[], reason: string): MakeLiveResult {
  // Surface the steps accumulated so far so a mid-pipeline abort shows how far
  // make-live got (mirrors network-provision-lib's fail()).
  return { ok: false, reason, applied: true, plan, steps };
}
