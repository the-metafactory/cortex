/**
 * G1d / T1 (cortex#1139, ADR-0013 Model B) — the pure orchestration behind
 * `cortex network provision <stack>`: the one-command sovereign account-topology
 * setup. Stands up a principal's OWN nsc account tree so a stack can federate.
 *
 * The pipeline (ensure-shaped, idempotent end-to-end; ADR-0013 §Decision-4
 * "make standing up your own nsc operator trivial"):
 *
 *   1. ensure the NSC operator        (arc nats init-operator)   — per principal
 *   2. ensure the federation account  (arc nats add-account)     — per stack, leaf-bound
 *   3. ensure the per-stack agents account (arc nats add-account)— ADR-0012 isolation
 *   4. ensure the stack signing seed  (provision-stack generate) — chmod 600, no-clobber
 *   5. wire federated.> export/import (arc nats add-federation-export) — fed → agents
 *   6. export operator-mode JWTs       (arc nats export-{operator,account,system}) — cortex#1265
 *   7. write stack.nats_infra back    (account, agents_account, creds_path, config_path,
 *                                       nkey_seed_path, operator_jwt, account_jwt,
 *                                       system_account[_jwt])
 *
 * After this the stack is ready for `cortex network join` — only the two
 * irreducible two-party steps remain (the leaf shared secret + hub topology
 * agreement). The operator-mode `.conf` render + bus restart are STILL LEFT TO
 * JOIN (render-only here; join performs the O-3 conversion + #821 health probe),
 * so this verb stays NON-DISRUPTIVE. cortex#1265 only adds the config-side JWT
 * EXPORT that starves the renderer today: provision now populates the four
 * `stack.nats_infra.{operator_jwt, account_jwt, system_account, system_account_jwt}`
 * fields the O-3 join (and make-live bootstrap) read, so the operator runs zero
 * raw `nsc generate config`. It writes ONLY config, never the `.conf`.
 *
 * cortex#1265 (PR8) also closes the provision→make-live loop: provision now
 * records the per-stack nats-server config path under `stack.nats_infra.config_path`
 * (the conventional `~/.config/nats/<slug>.conf`, the same field `make-live` /
 * `network join` derive their `--nats-config` from). Without it make-live had NO
 * per-stack target and could not find the bus to bootstrap — the operator fell
 * back to a manual `nsc generate config --mem-resolver`. The value is preserved
 * if already set (never clobbered) and falls back to the convention otherwise.
 *
 * This module is PURE over injected ports — zero fs / arc / nsc. The live
 * adapters live in `network-provision-adapters.ts`; the arc account-tree seam is
 * {@link OperatorProvisioningPort} (operator-provisioning.ts) + the existing
 * {@link FederationWiringPort}. cortex NEVER runs nsc itself (ADR-0013 invariant).
 *
 * ## Idempotency & no-clobber
 *
 * Every step is ensure-shaped: present ⇒ no-op (rendered `[ok]`), absent ⇒ mint.
 * State is read from CONFIG + filesystem, so a converged re-run shells zero mint
 * calls (arc init-operator / add-account are themselves idempotent, but we skip
 * them when config already carries the resolved pubkeys). The signing seed is
 * NEVER overwritten without `--force` — an existing seed is left untouched
 * (no-clobber); `--force` is a deliberate rotation that re-mints it.
 *
 * ## Dry-run vs apply
 *
 * Dry-run (the DEFAULT-safe posture) computes the plan from config + filesystem
 * state and mutates NOTHING — it never shells the account-tree mint verbs (which
 * have no dry-run mode in arc). `--apply` executes the mints + wiring + config
 * write-back, fail-fast: the whole plan is validated before the first mutation,
 * and any arc failure aborts BEFORE the config write so no half-provisioned
 * config block is left behind.
 */

import type { FederationWiringPort } from "./network-ports";
import type { OperatorProvisioningPort } from "./operator-provisioning";

// =============================================================================
// Name derivation — nsc operator + account names from {principal}/{slug}
// =============================================================================

/** nsc account names are strict UPPER_SNAKE (`[A-Z][A-Z0-9_]+`, arc's guard). */
const ACCOUNT_NAME_RE = /^[A-Z][A-Z0-9_]+$/;
/** nsc operator names permit a slightly wider charset (`[A-Za-z][A-Za-z0-9_-]*`). */
const OPERATOR_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** UPPER_SNAKE a `{principal}` / `{slug}` segment (lowercase + hyphen → `_`). */
function upperSnake(segment: string): string {
  return segment.toUpperCase().replace(/-/g, "_");
}

/**
 * Derive the nsc operator + the two account names for a stack. The operator is
 * per-principal (`OP_<PRINCIPAL>`); the federation + agents accounts are
 * per-stack (`<PRINCIPAL>_<STACK>_FED` / `_AGENTS`) so a principal's second
 * stack mints DISTINCT accounts (ADR-0012 isolation — never shared).
 */
export function deriveProvisionNames(
  principal: string,
  slug: string,
): { ok: true; operatorName: string; federationAccountName: string; agentsAccountName: string } | { ok: false; reason: string } {
  const operatorName = `OP_${upperSnake(principal)}`;
  const base = `${upperSnake(principal)}_${upperSnake(slug)}`;
  const federationAccountName = `${base}_FED`;
  const agentsAccountName = `${base}_AGENTS`;
  if (!OPERATOR_NAME_RE.test(operatorName)) {
    return { ok: false, reason: `derived nsc operator name "${operatorName}" is invalid (principal "${principal}")` };
  }
  for (const n of [federationAccountName, agentsAccountName]) {
    if (!ACCOUNT_NAME_RE.test(n)) {
      return { ok: false, reason: `derived account name "${n}" is invalid (must be UPPER_SNAKE)` };
    }
  }
  return { ok: true, operatorName, federationAccountName, agentsAccountName };
}

// =============================================================================
// Ports
// =============================================================================

/** Signing-identity seam (composes `provision-stack generate` / generateStackIdentity). */
export interface SigningIdentityPort {
  /** Is a signing seed already present at `seedPath`? Drives the dry-run plan. */
  exists(seedPath: string): boolean;
  /** Mint a fresh signing seed (`chmod 600`); `force` clobbers an existing one. */
  generate(opts: { seedPath: string; force: boolean }):
    | { ok: true; nkeyPub: string; fingerprint: string }
    | { ok: false; reason: string };
}

/** Config write-back seam — persists the resolved `stack.nats_infra` fields. */
export interface ProvisionConfigWritePort {
  write(fields: {
    account: string;
    agentsAccount: string;
    credsPath: string;
    /**
     * cortex#1265 (PR8) — the per-stack nats-server config path, persisted under
     * `stack.nats_infra.config_path` (conventional `~/.config/nats/<slug>.conf`).
     * make-live derives its `--nats-config` target from this exact field; without
     * it make-live has no bus to bootstrap and the operator falls back to a manual
     * `nsc generate config`. Closes the provision→make-live loop.
     */
    configPath: string;
    seedPath: string;
    nkeyPub?: string;
    /**
     * cortex#1265 — the operator-mode JWTs that feed the O-3 join /
     * make-live-bootstrap renderer (`renderOperatorModeBlocks`). Persisted under
     * `stack.nats_infra.{operator_jwt, account_jwt, system_account,
     * system_account_jwt}` — the exact fields `network-derive` reads. Omitted
     * (left untouched) when not exported this run.
     */
    operatorJwt?: string;
    accountJwt?: string;
    systemAccount?: string;
    systemAccountJwt?: string;
  }): { ok: true } | { ok: false; reason: string };
}

/**
 * cortex#1265 — the export seam that bridges the minted nsc account tree to the
 * operator-mode `.conf` renderer. Shells `arc nats export-{operator,account,
 * system}` so cortex NEVER runs nsc (ADR-0013 invariant). Read-only over the nsc
 * store; NEVER throws (arc failures → `{ ok: false }`).
 */
export interface OperatorModeExportPort {
  /** `arc nats export-operator --name <name> --json` → operator JWT (+ pubkey). */
  exportOperator(opts: { name: string }): Promise<
    { ok: true; operatorJwt: string; pubKey: string } | { ok: false; reason: string }
  >;
  /** `arc nats export-account <name> --json` → account pubkey + JWT (exists today). */
  exportAccount(name: string): Promise<
    { ok: true; pubKey: string; jwt: string } | { ok: false; reason: string }
  >;
  /**
   * `arc nats export-system --name <name> --json` → SYS account pubkey + JWT.
   * `notFound` distinguishes "no SYS account exists" (a clean skip — SYS is
   * optional, `nsc add operator` does not mint one) from a real arc failure.
   */
  exportSystem(opts: { name: string }): Promise<
    { ok: true; pubKey: string; jwt: string } | { ok: false; reason: string; notFound: boolean }
  >;
}

/** The full port bundle the orchestrator depends on. */
export interface ProvisionPorts {
  operator: OperatorProvisioningPort;
  signing: SigningIdentityPort;
  federationWiring: FederationWiringPort;
  configWrite: ProvisionConfigWritePort;
  export: OperatorModeExportPort;
}

// =============================================================================
// Inputs + state + result
// =============================================================================

/** Observable pre-provision state (read from config + filesystem). */
export interface ProvisionState {
  /** `stack.nats_infra.account` (the leaf-bound federation account `A…` pubkey), if set. */
  federationAccount: string | undefined;
  /** `stack.nats_infra.agents_account` (`A…` pubkey), if set. */
  agentsAccount: string | undefined;
  /**
   * cortex#1333 — `stack.nats_infra.system_account` (the SYS account `A…` pubkey),
   * if set. Drives the ensure-shape of the SYS mint: present ⇒ skip (no-op),
   * absent ⇒ mint (JetStream operator-mode requires it). `--force` re-mints.
   */
  systemAccount: string | undefined;
  /** Does the signing seed file exist on disk? */
  signingSeedExists: boolean;
  /**
   * cortex#1265 — do `stack.nats_infra.operator_jwt` AND `account_jwt` already
   * sit in config? Drives the ensure-shape of the JWT export: present ⇒ skip the
   * export (no-op), absent ⇒ export + write. `--force` re-exports regardless.
   */
  operatorModeJwtsPresent: boolean;
}

export interface ProvisionInputs {
  principal: string;
  stackSlug: string;
  stackId: string;
  operatorName: string;
  federationAccountName: string;
  agentsAccountName: string;
  /** cortex#1265 — the SYS (system) account name to best-effort export (default "SYS"). */
  systemAccountName: string;
  /** `stack.nkey_seed_path` — where the signing seed is / will be written. */
  seedPath: string;
  /** Conventional leaf `.creds` path recorded in config (minted at join). */
  credsPath: string;
  /**
   * cortex#1265 (PR8) — the per-stack nats-server config path recorded under
   * `stack.nats_infra.config_path` (conventional `~/.config/nats/<slug>.conf`).
   * make-live derives its `--nats-config` from this; writing it here closes the
   * provision→make-live loop (no manual `nsc generate config`).
   */
  configPath: string;
  force: boolean;
  apply: boolean;
  state: ProvisionState;
}

export type PlanStatus = "mint" | "generate" | "wire" | "export" | "ok";

export interface PlanItem {
  step: string;
  status: PlanStatus;
  detail: string;
}

export interface ProvisionResult {
  ok: boolean;
  reason?: string;
  applied: boolean;
  plan: PlanItem[];
  /** Human-readable plan/result lines for the CLI renderer. */
  steps: string[];
  /** The resolved fields (present on a successful apply). */
  resolved?: { account: string; agentsAccount: string; credsPath: string; configPath: string; seedPath: string };
}

// =============================================================================
// Plan builder (pure)
// =============================================================================

/**
 * Compute the ensure-plan from observable state. Each step is `[ok]` when
 * already present, `[mint]`/`[generate]` when absent (or always, under
 * `--force`). The `federated.>` wiring is always a converge step (arc is
 * idempotent). The operator is treated as present iff the federation account is
 * (an account cannot exist without its operator).
 */
export function buildProvisionPlan(inputs: ProvisionInputs): PlanItem[] {
  const { force, state } = inputs;
  const operatorPresent = !force && state.federationAccount !== undefined;
  const fedPresent = !force && state.federationAccount !== undefined;
  const agentsPresent = !force && state.agentsAccount !== undefined;
  const sysPresent = !force && state.systemAccount !== undefined;
  const signingPresent = !force && state.signingSeedExists;
  const jwtsPresent = !force && state.operatorModeJwtsPresent;

  return [
    {
      step: "nsc operator",
      status: operatorPresent ? "ok" : "mint",
      detail: inputs.operatorName,
    },
    {
      step: "federation account",
      status: fedPresent ? "ok" : "mint",
      detail: fedPresent ? `${inputs.federationAccountName} (${state.federationAccount})` : inputs.federationAccountName,
    },
    {
      step: "agents account",
      status: agentsPresent ? "ok" : "mint",
      detail: agentsPresent ? `${inputs.agentsAccountName} (${state.agentsAccount})` : inputs.agentsAccountName,
    },
    {
      // cortex#1333 — the SYS (system) account. An operator-mode NATS bus with
      // JetStream enabled FATALS at boot without a configured system_account. We
      // can't tell from this path whether a given stack enables JetStream — but SYS
      // is inert when it doesn't and load-bearing when it does, so ensuring it is
      // the safe default either way, and it removes the downstream boot-fatal for
      // the JetStream case. Minting is gated on state.systemAccount in provisionStack
      // (present-in-config => skip, absent => mint). Retires the raw `nsc add
      // account SYS` workaround that #1332 documented.
      step: "system account",
      status: sysPresent ? "ok" : "mint",
      detail: sysPresent
        ? `${inputs.systemAccountName} (${state.systemAccount})`
        : `${inputs.systemAccountName} (required by JetStream operator-mode)`,
    },
    {
      step: "signing seed",
      status: signingPresent ? "ok" : "generate",
      detail: inputs.seedPath,
    },
    {
      step: "federated.> export/import",
      status: "wire",
      detail: `${inputs.federationAccountName} → ${inputs.agentsAccountName}`,
    },
    {
      step: "operator-mode JWTs export",
      status: jwtsPresent ? "ok" : "export",
      detail: `operator + ${inputs.federationAccountName} + ${inputs.systemAccountName} (system, ensured)`,
    },
    {
      step: "stack.nats_infra write-back",
      status: "wire",
      detail: "account, agents_account, creds_path, config_path, nkey_seed_path, operator_jwt, account_jwt, system_account[_jwt]",
    },
  ];
}

/** Render a plan item as a CLI line (`[mint ] nsc operator   OP_ANDREAS`). */
function renderPlanLine(item: PlanItem): string {
  const tag = item.status.padEnd(8);
  return `[${tag}] ${item.step.padEnd(28)} ${item.detail}`;
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Provision a stack's sovereign account topology. Pure over `ports`; NEVER
 * throws (port failures surface as `{ ok: false, reason }`).
 *
 * Dry-run (`apply === false`): returns the plan; mutates nothing.
 * Apply: executes mints + wiring + config write-back, fail-fast (validate the
 * full plan, then mutate; abort before the config write on any arc failure).
 */
export async function provisionStack(
  inputs: ProvisionInputs,
  ports: ProvisionPorts,
): Promise<ProvisionResult> {
  const plan = buildProvisionPlan(inputs);
  const planLines = plan.map(renderPlanLine);

  if (!inputs.apply) {
    return {
      ok: true,
      applied: false,
      plan,
      steps: [
        ...planLines,
        "",
        "Re-run with --apply to execute.",
        "AFTER this: exchange the leaf shared secret + agree hub topology with your peer, then `cortex network join <network>`.",
      ],
    };
  }

  const { force, state } = inputs;
  const steps: string[] = [];

  // The pubkeys we resolve (minted-or-existing) and write back to config.
  let resolvedAccount = state.federationAccount;
  let resolvedAgents = state.agentsAccount;
  let resolvedNkeyPub: string | undefined;

  const operatorNeeded = force || state.federationAccount === undefined;
  const fedNeeded = force || state.federationAccount === undefined;
  const agentsNeeded = force || state.agentsAccount === undefined;
  const signingNeeded = force || !state.signingSeedExists;

  // 1. NSC operator (per principal). Idempotent in arc; skipped when the
  //    federation account already exists (it cannot exist without its operator).
  if (operatorNeeded) {
    const r = await ports.operator.initOperator({ name: inputs.operatorName, force });
    if (!r.ok) return fail(plan, steps, `init-operator failed: ${r.reason}`);
    steps.push(`nsc operator ${r.alreadyExisted && !r.created ? "present" : r.created ? "minted" : "ensured"}: ${r.operator}`);
  } else {
    steps.push(`nsc operator present: ${inputs.operatorName}`);
  }

  // 2. Federation account (leaf-bound, per stack).
  if (fedNeeded) {
    const r = await ports.operator.addAccount({ name: inputs.federationAccountName });
    if (!r.ok) return fail(plan, steps, `add-account (federation) failed: ${r.reason}`);
    resolvedAccount = r.pubKey;
    steps.push(`federation account ${r.created ? "minted" : "present"}: ${r.account} (${r.pubKey})`);
  } else {
    steps.push(`federation account present: ${resolvedAccount}`);
  }

  // 3. Per-stack agents account (ADR-0012 isolation).
  if (agentsNeeded) {
    const r = await ports.operator.addAccount({ name: inputs.agentsAccountName });
    if (!r.ok) return fail(plan, steps, `add-account (agents) failed: ${r.reason}`);
    resolvedAgents = r.pubKey;
    steps.push(`agents account ${r.created ? "minted" : "present"}: ${r.account} (${r.pubKey})`);
  } else {
    steps.push(`agents account present: ${resolvedAgents}`);
  }

  // 3.5 (cortex#1333) — ensure the SYS (system) account; see the rationale on the
  //     "system account" plan item above. Gated on state.systemAccount: mint only
  //     when config records no system_account, otherwise skip — this gate is the
  //     idempotency, no arc-side addAccount dedup is assumed. The dedicated SYS
  //     export at step 5.6 (gated on the SAME condition) writes system_account[_jwt]
  //     to config even when the operator/account JWTs are already present — see the
  //     blocker that decoupling fixed (cortex#1335).
  const sysNeeded = force || state.systemAccount === undefined;
  if (sysNeeded) {
    const sys = await ports.operator.addAccount({ name: inputs.systemAccountName });
    if (!sys.ok) return fail(plan, steps, `add-account (system ${inputs.systemAccountName}) failed: ${sys.reason}`);
    steps.push(`system account ${sys.created ? "minted" : "present"}: ${sys.account} (${sys.pubKey})`);
  } else {
    steps.push(`system account present: ${state.systemAccount}`);
  }

  // 4. Signing seed (chmod 600, no-clobber unless --force).
  if (signingNeeded) {
    const r = ports.signing.generate({ seedPath: inputs.seedPath, force });
    if (!r.ok) return fail(plan, steps, `signing-seed generate failed: ${r.reason}`);
    resolvedNkeyPub = r.nkeyPub;
    steps.push(`signing seed ${force ? "rotated" : "generated"}: ${inputs.seedPath} (chmod 600)`);
  } else {
    steps.push(`signing seed present (untouched): ${inputs.seedPath}`);
  }

  // Defensive: both account pubkeys must be resolved before wiring/write-back.
  if (resolvedAccount === undefined || resolvedAgents === undefined) {
    return fail(plan, steps, "internal: account pubkeys unresolved after mint (should not happen)");
  }

  // 5. Wire the local-side federated.> export/import (fed-account → agents-account).
  const wire = await ports.federationWiring.wireLocalFederation({
    federationAccount: resolvedAccount,
    agentsAccount: resolvedAgents,
    apply: true,
  });
  if (!wire.ok) return fail(plan, steps, `federation wiring failed: ${wire.reason}`);
  steps.push(`federated.> export/import: ${wire.note ?? "wired"}`);

  // 5.5 (cortex#1265) — export the operator-mode JWTs so the O-3 join /
  // make-live-bootstrap renderer (renderOperatorModeBlocks) materialises the
  // operator-mode `.conf` with ZERO manual `nsc generate config`. Config-only +
  // NON-DISRUPTIVE: nothing here touches the live bus (provision's documented
  // invariant). Ensure-shaped: skipped when the JWTs already sit in config.
  let operatorJwt: string | undefined;
  let accountJwt: string | undefined;
  let systemAccount: string | undefined;
  let systemAccountJwt: string | undefined;
  const jwtExportNeeded = force || !state.operatorModeJwtsPresent;
  if (jwtExportNeeded) {
    const opRes = await ports.export.exportOperator({ name: inputs.operatorName });
    if (!opRes.ok) return fail(plan, steps, `export-operator failed: ${opRes.reason}`);
    operatorJwt = opRes.operatorJwt;

    const acctRes = await ports.export.exportAccount(inputs.federationAccountName);
    if (!acctRes.ok) return fail(plan, steps, `export-account (federation) failed: ${acctRes.reason}`);
    // Cross-check the exported account pubkey against the resolved federation
    // pubkey — a divergence would render a `.conf` binding the leaf to the WRONG
    // account (mirrors make-live's BLOCK 3 drift guard).
    if (acctRes.pubKey !== resolvedAccount) {
      return fail(
        plan,
        steps,
        `account pubkey drift: federation account ${inputs.federationAccountName} resolved to ` +
          `${resolvedAccount} but \`arc nats export-account\` returned ${acctRes.pubKey}.`,
      );
    }
    accountJwt = acctRes.jwt;
    steps.push(`operator-mode JWTs exported: operator + ${inputs.federationAccountName}`);
  } else {
    steps.push("operator-mode JWTs present in config (untouched)");
  }

  // 5.6 (cortex#1335 blocker) — the SYS export is gated INDEPENDENTLY of the
  // operator/account JWT export. An older provisioned stack can have
  // operatorModeJwtsPresent === true (JWTs already in config) yet still lack
  // system_account; folding SYS into jwtExportNeeded would mint SYS at step 3.5 but
  // then SKIP the only write of system_account, leaving the JetStream boot-fatal in
  // place. Gate on the SYS config field — the same condition that minted it above —
  // so SYS is exported and written exactly when (and only when) config lacks it.
  const sysExportNeeded = force || state.systemAccount === undefined;
  if (sysExportNeeded) {
    const sysRes = await ports.export.exportSystem({ name: inputs.systemAccountName });
    if (sysRes.ok) {
      systemAccount = sysRes.pubKey;
      systemAccountJwt = sysRes.jwt;
      steps.push(`system_account exported + wired: ${inputs.systemAccountName}`);
    } else if (sysRes.notFound) {
      // SYS was ensured at step 3.5, so not-found here implies an arc store
      // inconsistency — surface it loudly rather than silently leaving config short
      // (a stack that boots JetStream would still hit the boot-fatal).
      steps.push(
        `WARNING: ${inputs.systemAccountName} not found at export despite ensure — ` +
          `system_account NOT written; JetStream boot-fatal may persist`,
      );
    } else {
      steps.push(
        `WARNING: system export skipped — ${sysRes.reason}; system_account NOT written`,
      );
    }
  }

  // 6. Write the resolved nats_infra fields back to the stack config.
  const written = ports.configWrite.write({
    account: resolvedAccount,
    agentsAccount: resolvedAgents,
    credsPath: inputs.credsPath,
    configPath: inputs.configPath,
    seedPath: inputs.seedPath,
    ...(resolvedNkeyPub !== undefined && { nkeyPub: resolvedNkeyPub }),
    ...(operatorJwt !== undefined && { operatorJwt }),
    ...(accountJwt !== undefined && { accountJwt }),
    ...(systemAccount !== undefined && { systemAccount }),
    ...(systemAccountJwt !== undefined && { systemAccountJwt }),
  });
  if (!written.ok) return fail(plan, steps, `config write-back failed: ${written.reason}`);
  steps.push(
    "stack.nats_infra written (account, agents_account, creds_path, config_path, nkey_seed_path" +
      (operatorJwt !== undefined ? ", operator_jwt, account_jwt" : "") +
      (systemAccount !== undefined ? ", system_account, system_account_jwt" : "") +
      ")",
  );

  steps.push("");
  steps.push("Ready for `cortex network join <network>` — remaining: leaf shared secret + hub topology (two-party, out-of-band).");

  return {
    ok: true,
    applied: true,
    plan,
    steps,
    resolved: {
      account: resolvedAccount,
      agentsAccount: resolvedAgents,
      credsPath: inputs.credsPath,
      configPath: inputs.configPath,
      seedPath: inputs.seedPath,
    },
  };
}

function fail(plan: PlanItem[], steps: string[], reason: string): ProvisionResult {
  // Return the steps accumulated so far (not the original plan) so a
  // mid-pipeline abort surfaces how far provisioning actually got — e.g.
  // operator minted, federation account failed (cortex#1236 NIT 2).
  return { ok: false, reason, applied: true, plan, steps };
}
