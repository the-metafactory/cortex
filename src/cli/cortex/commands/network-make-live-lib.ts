/**
 * C-1257 (PR7/#1225, ADR-0013 Model B) — the pure orchestration behind
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
 */

import type { OperatorModeLeafPackage, NatsBaseIdentity } from "../../../common/nats/leaf-remote-renderer";

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
   * `resolver_preload { <federation account> }` via `renderOperatorModeBlocks`,
   * KEEPING the bus's own `server_name`/`listen`/`http`/`jetstream.domain`, and
   * backing up the config first. Idempotent: `changed:false` when the bus is
   * already operator-mode under the SAME operator. Refuses (ok:false) on a
   * malformed package OR a bus already operator-mode under a DIFFERENT operator
   * (never clobber). The subsequent `appendAccount` then adds the agents account.
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
  state: MakeLiveState;
}

export type StepStatus = "mint" | "wire" | "restart" | "ok";

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
  const bootstrapNeeded = !ports.resolver.hasResolverPreload(inputs.natsConfigPath);
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
  // cortex#1265 — prepend the bootstrap step to the plan when it is needed.
  const plan: PlanItem[] = bootstrapNeeded
    ? [
        {
          step: "operator-mode bootstrap",
          status: "wire",
          detail: `render operator + resolver_preload (federation account) → ${inputs.natsConfigPath}`,
        },
        ...corePlan,
      ]
    : corePlan;
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
    return {
      ok: true,
      applied: false,
      plan,
      steps: [
        ...planLines,
        "",
        ...targetLines,
        ...(warnings.length > 0 ? ["", ...warnings] : []),
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
  const steps: string[] = [...targetLines];

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
        ? `operator-mode bootstrap: rendered operator + resolver_preload (federation account) into ${inputs.natsConfigPath}`
        : `operator-mode bootstrap: bus already operator-mode (no-op)`,
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
    const r = await ports.restart.restartNats(inputs.natsConfigPath);
    if (!r.ok) return fail(plan, steps, `nats-server restart failed: ${r.reason}`);
    steps.push(`nats-server restarted (loaded ${inputs.agentsAccountName} into MEMORY resolver)`);
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

function fail(plan: PlanItem[], steps: string[], reason: string): MakeLiveResult {
  // Surface the steps accumulated so far so a mid-pipeline abort shows how far
  // make-live got (mirrors network-provision-lib's fail()).
  return { ok: false, reason, applied: true, plan, steps };
}
