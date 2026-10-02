/**
 * G1d / T1 (cortex#1139, ADR-0013 sovereign model) — the pure orchestration behind
 * `cortex network provision <stack>`: the one-command sovereign account-topology
 * setup. Stands up a principal's OWN nsc account tree so a stack can federate.
 *
 * The pipeline (ensure-shaped, idempotent end-to-end; ADR-0013 §Decision-4
 * "make standing up your own nsc operator trivial"):
 *
 *   1. ensure the NSC operator        (arc nats init-operator)   — per principal
 *   2. ensure the federation account  (arc nats add-account)     — per stack, leaf-bound
 *   3. ensure the per-stack agents account (arc nats add-account)— ADR-0012 isolation
 *   3a. ensure JetStream on the agents account (nsc edit account) — cortex#2534
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
 * (the same field `make-live` / `network join` derive their `--nats-config` from).
 * Without it make-live had NO per-stack target and could not find the bus to
 * bootstrap — the operator fell back to a manual `nsc generate config --mem-resolver`.
 * The value is preserved if already set (never clobbered) and falls back to the
 * convention otherwise, with one exception (cortex#2535): when `<slug>.conf` does
 * not exist and another stack of the same principal shares the bus (same
 * `nats.url` host:port), provision adopts that stack's existing `config_path`
 * (+ `plist_path`), or leaves the field unset when none or several are found.
 * See {@link resolveNatsConfigPath}.
 *
 * This module is PURE over injected ports — zero fs / arc / nsc. The live
 * adapters live in `network-provision-adapters.ts`; the arc account-tree seam is
 * {@link OperatorProvisioningPort} (operator-provisioning.ts) + the existing
 * {@link FederationWiringPort}. cortex runs nsc through arc (ADR-0013), with ONE
 * exception: {@link AgentsJetStreamPort}, whose live adapter shells
 * `nsc edit account` because arc has no verb to grant an account JetStream yet
 * (arc#384). Swap that adapter for the arc verb once it ships.
 *
 * ## Agents-account JetStream (cortex#2534)
 *
 * The daemon lands in the agents account (make-live) and provisions its streams
 * there, so that account needs JetStream limits. arc's `add-account` mints it
 * WITHOUT any, so step 3a grants unlimited mem/disk storage and reads the JWT
 * back to verify. An existing agents account is PROBED first (a read-only
 * `arc nats export-account`, also in dry-run): limits present ⇒ `[ok]`, absent ⇒
 * `[wire]`. That repairs accounts minted before the fix. The FED and SYS accounts
 * never get JetStream.
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
 * have no dry-run mode in arc). Its only arc call is the read-only agents-account
 * JetStream probe, made when config already records the agents account.
 * `--apply` executes the mints + wiring + config write-back, fail-fast: the
 * whole plan is validated before the first mutation, and any arc failure aborts
 * BEFORE the config write so no half-provisioned config block is left behind.
 */

import { decodeJwtClaims } from "../../../common/nats/jwt";
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
     * Omitted when provision could not find one (cortex#2535): nothing is
     * written, so make-live keeps its `--nats-config` refusal.
     */
    configPath?: string;
    /** cortex#2535 — a sibling stack's `plist_path`, adopted with its config path. */
    plistPath?: string;
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
   * `notFound` distinguishes "no SYS account exists" from a real arc failure.
   * Since cortex#1333, provision ensures SYS at step 3.5 before this export, so a
   * `notFound` here is an arc operator-store inconsistency (NOT a benign skip):
   * the caller hard-fails on either result to avoid persisting a JetStream stack
   * config without a `system_account`.
   */
  exportSystem(opts: { name: string }): Promise<
    { ok: true; pubKey: string; jwt: string } | { ok: false; reason: string; notFound: boolean }
  >;
}

/**
 * cortex#2534 — grants the per-stack agents account JetStream (unlimited mem +
 * disk storage). The live adapter shells `nsc edit account` (arc has no verb for
 * it yet — arc#384). Idempotent; NEVER throws. The orchestrator verifies the
 * grant by reading the account JWT back through {@link OperatorModeExportPort}.
 */
export interface AgentsJetStreamPort {
  enable(opts: { name: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** A sibling stack's bus endpoint + nats-server paths, read from its config (cortex#2535). */
export interface SiblingStackBus {
  stackId: string;
  /** The sibling's `nats.url`, if set. */
  natsUrl?: string;
  /** The sibling's `stack.nats_infra.config_path`, if set. */
  configPath?: string;
  /** The sibling's `stack.nats_infra.plist_path`, if set. */
  plistPath?: string;
}

/** One discovered sibling: its bus fields, or why its config could not be read. */
export type SiblingStackRead =
  | { ok: true; stack: SiblingStackBus }
  | { ok: false; stackId: string; reason: string };

/**
 * cortex#2535 — read-only fs seam for picking `stack.nats_infra.config_path`
 * when config has none. File checks and config reads only; it never probes a
 * live process or port, so provision stays deterministic.
 */
export interface NatsConfigLocatorPort {
  /** Does the file at `path` (may be `~`-prefixed) exist? */
  exists(path: string): boolean;
  /** Absolute form of `path`, so `~/x` and `$HOME/x` compare equal. */
  resolvePath(path: string): string;
  /** The OTHER stacks of `principal` discovered on this host (never `selfStackId`). */
  siblingStacks(principal: string, selfStackId: string): SiblingStackRead[];
}

/** The full port bundle the orchestrator depends on. */
export interface ProvisionPorts {
  operator: OperatorProvisioningPort;
  signing: SigningIdentityPort;
  federationWiring: FederationWiringPort;
  configWrite: ProvisionConfigWritePort;
  export: OperatorModeExportPort;
  jetstream: AgentsJetStreamPort;
  natsConfig: NatsConfigLocatorPort;
}

// =============================================================================
// nats-server config path resolution (cortex#2535)
// =============================================================================

/** The NATS default client port, used when `nats.url` carries none. */
const DEFAULT_NATS_PORT = "4222";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Normalise a `nats.url` to a comparable `host:port`: the first server of a
 * comma list, lowercase host, loopback aliases folded together, default port
 * 4222, scheme ignored (a scheme-less `host:port` is read as `nats://`).
 * `undefined` when absent or unparseable.
 */
export function busEndpoint(url: string | undefined): string | undefined {
  const first = url?.split(",")[0]?.trim();
  if (first === undefined || first === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `nats://${first}`);
  } catch (_err) {
    // Unparseable url: no endpoint to compare, so no sibling can match. Safe to ignore.
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "") return undefined;
  const port = parsed.port === "" ? DEFAULT_NATS_PORT : parsed.port;
  return `${LOOPBACK_HOSTS.has(host) ? "loopback" : host}:${port}`;
}

/** Where `stack.nats_infra.config_path` comes from on this run. */
export type NatsConfigResolution =
  /** Set by `--nats-config` or already in the stack config. Never touched. */
  | { source: "explicit"; configPath: string }
  /**
   * `~/.config/nats/<slug>.conf`: it exists on disk, or no other stack of the
   * principal shares this stack's bus, so it names the stack's own server that
   * make-live creates from `nats.url` (cortex#1265 PR8). `why` says which.
   */
  | { source: "convention"; configPath: string; exists: boolean; why: string }
  /** Adopted from the one sibling stack of the same principal on the same bus. */
  | { source: "sibling"; configPath: string; plistPath?: string; siblingStackId: string; endpoint: string }
  /** Left unset: make-live and join need `--nats-config`. */
  | { source: "unset"; why: string };

/** Step 1: a value from `--nats-config` or the stack config, kept as given. */
function explicitNatsConfig(inputs: Pick<ProvisionInputs, "configPath">): NatsConfigResolution | undefined {
  return inputs.configPath !== undefined && inputs.configPath !== ""
    ? { source: "explicit", configPath: inputs.configPath }
    : undefined;
}

/** The `config_path` / `plist_path` a resolution writes back (absent = not written). */
export function natsConfigPaths(res: NatsConfigResolution): { configPath?: string; plistPath?: string } {
  if (res.source === "unset") return {};
  if (res.source === "sibling" && res.plistPath !== undefined) return { configPath: res.configPath, plistPath: res.plistPath };
  return { configPath: res.configPath };
}

/** Conventional per-stack nats-server config path. */
export function conventionalNatsConfigPath(slug: string): string {
  return `~/.config/nats/${slug}.conf`;
}

/**
 * Pick the stack's nats-server config path (cortex#2535). In order:
 *
 *   1. a value from `--nats-config` or the stack config wins, untouched;
 *   2. `~/.config/nats/<slug>.conf` when that file exists;
 *   3. when a sibling stack of the same principal has a `nats.url` with the
 *      same host:port (a SHARED bus): that sibling's `config_path`, when
 *      exactly one distinct existing file is named (its `plist_path` comes
 *      along if this stack has none). Siblings that disagree, or none naming
 *      an existing file, leave the field unset;
 *   4. no sibling on the same bus: `<slug>.conf` even though it does not exist
 *      yet. It names the stack's own server, which make-live creates from
 *      `nats.url` (the cortex#1265 PR8 bootstrap), so the convention stays.
 *
 * A sibling config that cannot be read also leaves the field unset: it may be
 * on the same bus, so neither branch can be chosen safely. On a shared bus a
 * `<slug>.conf` that no server runs would turn make-live's clear
 * `--nats-config` refusal into a misleading "restart target NOT FOUND".
 */
export function resolveNatsConfigPath(
  inputs: Pick<ProvisionInputs, "principal" | "stackId" | "stackSlug" | "configPath" | "natsUrl" | "plistPathSet">,
  locator: NatsConfigLocatorPort,
): NatsConfigResolution {
  const explicit = explicitNatsConfig(inputs);
  if (explicit !== undefined) return explicit;
  const conventional = conventionalNatsConfigPath(inputs.stackSlug);
  if (locator.exists(conventional)) {
    return { source: "convention", configPath: conventional, exists: true, why: "exists on disk" };
  }

  const missing = `${conventional} does not exist`;
  const endpoint = busEndpoint(inputs.natsUrl);
  if (endpoint === undefined) {
    return {
      source: "convention",
      configPath: conventional,
      exists: false,
      why: "not created yet; the stack has no usable nats.url to compare with other stacks",
    };
  }

  const reads = locator.siblingStacks(inputs.principal, inputs.stackId);
  const unreadable = reads.flatMap((r) => (r.ok ? [] : [`${r.stackId} (${r.reason})`]));
  const sameBus = reads.flatMap((r) =>
    r.ok && busEndpoint(r.stack.natsUrl) === endpoint ? [r.stack] : [],
  );
  const matches = sameBus.filter(
    (s) => s.configPath !== undefined && s.configPath !== "" && locator.exists(s.configPath),
  );
  const byPath = new Map<string, SiblingStackBus[]>();
  for (const m of matches) {
    const key = locator.resolvePath(m.configPath ?? "");
    byPath.set(key, [...(byPath.get(key) ?? []), m]);
  }

  if (byPath.size > 1) {
    const listed = matches.map((m) => `${m.stackId} → ${m.configPath ?? ""}`).join(", ");
    return { source: "unset", why: `${missing} and sibling stacks on ${endpoint} disagree (${listed})` };
  }
  if (unreadable.length > 0) {
    return {
      source: "unset",
      why: `${missing} and sibling stack config(s) could not be read, so the bus's config cannot be confirmed: ${unreadable.join(", ")}`,
    };
  }
  if (sameBus.length === 0) {
    return {
      source: "convention",
      configPath: conventional,
      exists: false,
      why: `not created yet; no other stack of ${inputs.principal} is on ${endpoint}, so make-live creates it from nats.url`,
    };
  }
  const agreeing = [...byPath.values()][0];
  const sibling = agreeing?.[0];
  if (agreeing === undefined || sibling?.configPath === undefined) {
    const shared = sameBus.map((s) => s.stackId).join(", ");
    return { source: "unset", why: `${missing} and the stacks sharing ${endpoint} (${shared}) record no existing config_path` };
  }

  // The plist comes along only when this stack has none and the agreeing
  // siblings name one plist between them.
  const plists = new Set(
    agreeing.flatMap((s) => (s.plistPath !== undefined && s.plistPath !== "" ? [locator.resolvePath(s.plistPath)] : [])),
  );
  const plistPath =
    inputs.plistPathSet !== true && plists.size === 1
      ? agreeing.find((s) => s.plistPath !== undefined && s.plistPath !== "")?.plistPath
      : undefined;
  return {
    source: "sibling",
    configPath: sibling.configPath,
    ...(plistPath !== undefined && { plistPath }),
    siblingStackId: sibling.stackId,
    endpoint,
  };
}

/** The plan row describing the chosen nats-server config path. */
function natsConfigPlanItem(res: NatsConfigResolution): PlanItem {
  const step = "nats-server config path";
  switch (res.source) {
    case "explicit":
      return { step, status: "ok", detail: `${res.configPath} (from --nats-config or the stack config; untouched)` };
    case "convention":
      return { step, status: "wire", detail: `${res.configPath} (${res.why})` };
    case "sibling":
      return {
        step,
        status: "wire",
        detail:
          `${res.configPath} (from sibling stack ${res.siblingStackId} on ${res.endpoint}` +
          (res.plistPath !== undefined ? `; plist_path ${res.plistPath}` : "") +
          ")",
      };
    case "unset":
      return { step, status: "skip", detail: `left unset: ${res.why}` };
  }
}

/** The follow-up note printed when the config path is left unset. */
function natsConfigUnsetNote(res: NatsConfigResolution): string[] {
  if (res.source !== "unset") return [];
  return [
    "NOTE: stack.nats_infra.config_path was left unset. `cortex network make-live` and `cortex network join` " +
      "will need --nats-config <path> (the nats-server config serving this stack's nats.url), or set " +
      "stack.nats_infra.config_path in the stack config.",
  ];
}

// =============================================================================
// Agents-account JetStream probe (cortex#2534)
// =============================================================================

/**
 * Does an account JWT carry JetStream limits? JetStream counts as on when `nats.limits.mem_storage` or `disk_storage` is non-zero (-1 =
 * unlimited, >0 = a byte cap), at the top level or in any `tiered_limits` tier.
 * `undefined` when the JWT does not decode.
 */
export function accountJwtHasJetStream(jwt: string): boolean | undefined {
  const claims = decodeJwtClaims(jwt);
  if (claims === undefined) return undefined;
  const nats = claims.nats;
  if (nats === null || typeof nats !== "object") return false;
  const limits = (nats as Record<string, unknown>).limits;
  if (limits === null || typeof limits !== "object") return false;
  const l = limits as Record<string, unknown>;
  const nonZero = (v: unknown): boolean => typeof v === "number" && v !== 0;
  if (nonZero(l.mem_storage) || nonZero(l.disk_storage)) return true;
  const tiers = l.tiered_limits;
  if (tiers === null || typeof tiers !== "object") return false;
  return Object.values(tiers).some(
    (t) => t !== null && typeof t === "object" && (nonZero((t as Record<string, unknown>).mem_storage) || nonZero((t as Record<string, unknown>).disk_storage)),
  );
}

/** What the read-only probe of the agents account found. */
export type AgentsJetStreamProbe =
  | { status: "enabled" }
  | { status: "disabled" }
  /** The export failed or the JWT did not decode — cannot tell. */
  | { status: "unknown"; reason: string }
  /** The account nsc resolves by name is not the one config records (wrong nsc operator context?). */
  | { status: "drift"; exportedPubKey: string }
  /** Not probed: config records no agents account yet (it is minted this run). */
  | { status: "not-probed" };

/** Read the agents account's JWT (read-only) and classify its JetStream state. */
async function probeAgentsJetStream(
  name: string,
  expectedPubKey: string,
  exportPort: OperatorModeExportPort,
): Promise<AgentsJetStreamProbe> {
  const res = await exportPort.exportAccount(name);
  if (!res.ok) return { status: "unknown", reason: res.reason };
  if (res.pubKey !== expectedPubKey) return { status: "drift", exportedPubKey: res.pubKey };
  const enabled = accountJwtHasJetStream(res.jwt);
  if (enabled === undefined) return { status: "unknown", reason: `the ${name} account JWT did not decode` };
  return { status: enabled ? "enabled" : "disabled" };
}

/**
 * The refusal message when a probe cannot vouch for the account (`unknown`, or
 * nsc resolves a different pubkey than expected), else `undefined`. Shared by the
 * pre-mutation guard and step 3a so both report the same cause.
 */
function agentsProbeProblem(
  name: string,
  probe: AgentsJetStreamProbe,
  expectedPubKey: string | undefined,
): string | undefined {
  if (probe.status === "unknown") {
    return `cannot read the ${name} account JWT to check JetStream: ${probe.reason}.`;
  }
  if (probe.status === "drift") {
    return (
      `agents account pubkey drift: expected ${expectedPubKey ?? "(unset)"} but nsc resolves ${name} ` +
      `to ${probe.exportedPubKey}. Check the current nsc operator context.`
    );
  }
  return undefined;
}

/**
 * Step 3a (cortex#2534) — make sure the agents account carries JetStream limits.
 * The runtime provisions its streams there after make-live. Granted only when
 * the JWT has none (hand-set limits are never overwritten), then verified by
 * reading the JWT back. `existedBefore` adds the resolver_preload caveat: a bus
 * that is already live keeps the old JWT (make-live only appends a MISSING
 * account — cortex#2539).
 */
async function ensureAgentsJetStream(
  name: string,
  probe: AgentsJetStreamProbe,
  pubKey: string,
  existedBefore: boolean,
  ports: ProvisionPorts,
): Promise<{ ok: true; steps: string[] } | { ok: false; reason: string }> {
  const problem = agentsProbeProblem(name, probe, pubKey);
  if (problem !== undefined) return { ok: false, reason: problem };
  if (probe.status === "enabled") {
    return { ok: true, steps: [`agents account JetStream present (untouched): ${name}`] };
  }

  const en = await ports.jetstream.enable({ name });
  if (!en.ok) return { ok: false, reason: `enabling JetStream on ${name} failed: ${en.reason}` };

  const check = await probeAgentsJetStream(name, pubKey, ports.export);
  if (check.status !== "enabled") {
    const seen = agentsProbeProblem(name, check, pubKey) ?? `the account still has JetStream disabled.`;
    return {
      ok: false,
      reason: `JetStream grant on ${name} could not be verified — ${seen} Aborting before the config write.`,
    };
  }

  const steps = [`agents account JetStream enabled (mem/disk unlimited, verified): ${name}`];
  if (existedBefore) {
    steps.push(
      `  if this stack is already live, its nats-server resolver_preload still holds the old ${name} JWT: ` +
        `replace it with \`arc nats export-account ${name} --json\`'s jwt and restart nats-server ` +
        `(a SIGHUP does not reload resolver_preload; cortex#2539).`,
    );
  }
  return { ok: true, steps };
}

/** The JetStream plan row, from the probe. `[ok]` only when limits were read. */
function agentsJetStreamPlanItem(inputs: ProvisionInputs, probe: AgentsJetStreamProbe): PlanItem {
  const name = inputs.agentsAccountName;
  const step = "agents account JetStream";
  switch (probe.status) {
    case "enabled":
      return { step, status: "ok", detail: `${name} (JetStream limits present)` };
    case "disabled":
      return { step, status: "wire", detail: `${name} (JetStream disabled → grant unlimited mem/disk)` };
    case "unknown":
      return { step, status: "wire", detail: `${name} (JetStream state unknown: ${probe.reason})` };
    case "drift":
      return {
        step,
        status: "wire",
        detail:
          `${name} (pubkey drift: config records ${inputs.state.agentsAccount}, nsc resolves ` +
          `${probe.exportedPubKey} — check the current nsc operator; ` +
          `${inputs.force ? "--force re-probes after add-account" : "--apply refuses"})`,
      };
    case "not-probed":
      return { step, status: "wire", detail: `${name} (grant unlimited mem/disk after mint)` };
  }
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
  /**
   * The SYS (system) account name (default "SYS"). Since cortex#1333 provision
   * ensures it (step 3.5) and hard-requires its export (step 5.6) — no longer a
   * best-effort/optional export, as JetStream operator-mode fatals without it.
   */
  systemAccountName: string;
  /** `stack.nkey_seed_path` — where the signing seed is / will be written. */
  seedPath: string;
  /** Conventional leaf `.creds` path recorded in config (minted at join). */
  credsPath: string;
  /**
   * cortex#1265 (PR8) — the per-stack nats-server config path recorded under
   * `stack.nats_infra.config_path`. make-live derives its `--nats-config` from
   * it. Here it is only the EXPLICIT value (`--nats-config` or the stack
   * config); when absent, {@link resolveNatsConfigPath} picks one (cortex#2535).
   */
  configPath?: string;
  /** The stack's `nats.url` — matched against sibling stacks when `configPath` is absent. */
  natsUrl?: string;
  /** Does the stack config already set `stack.nats_infra.plist_path`? A sibling's is then not adopted. */
  plistPathSet?: boolean;
  force: boolean;
  apply: boolean;
  state: ProvisionState;
}

export type PlanStatus = "mint" | "generate" | "wire" | "export" | "ok" | "skip";

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
  resolved?: {
    account: string;
    agentsAccount: string;
    credsPath: string;
    /** Absent when the nats-server config path was left unset (cortex#2535). */
    configPath?: string;
    plistPath?: string;
    seedPath: string;
  };
  /** cortex#2535 — which branch picked `stack.nats_infra.config_path` (dry-run too). */
  natsConfig?: NatsConfigResolution;
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
export function buildProvisionPlan(
  inputs: ProvisionInputs,
  agentsJetStream: AgentsJetStreamProbe = { status: "not-probed" },
  // Callers that skip resolution (plan-only tests) get the explicit value, or
  // an unset row when there is none.
  natsConfig: NatsConfigResolution = explicitNatsConfig(inputs) ?? { source: "unset", why: "not resolved" },
): PlanItem[] {
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
    agentsJetStreamPlanItem(inputs, agentsJetStream),
    {
      // cortex#1333 — the SYS (system) account. An operator-mode NATS bus with
      // JetStream enabled FATALS at boot without a configured system_account. This
      // path cannot see whether a given stack enables JetStream (that lives in the
      // bus .conf, which provision never reads), so SYS is ensured unconditionally:
      // the trade is one extra account in the operator store for a non-JetStream
      // stack, in exchange for removing the boot-fatal on every JetStream stack.
      // (A JetStream-config gate would require provision to read the bus config —
      // see the PR discussion if that is preferred.) Minting is gated on
      // state.systemAccount in provisionStack (present-in-config => skip, absent
      // => mint). Retires the raw `nsc add account SYS` onboarding workaround.
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
    natsConfigPlanItem(natsConfig),
    {
      step: "stack.nats_infra write-back",
      status: "wire",
      detail:
        `account, agents_account, creds_path, ${writtenPathFields(natsConfig)}nkey_seed_path, ` +
        "operator_jwt, account_jwt, system_account[_jwt]",
    },
  ];
}

/** The `config_path` / `plist_path` names the write-back sets, with a trailing ", ". */
function writtenPathFields(res: NatsConfigResolution): string {
  const paths = natsConfigPaths(res);
  return (paths.configPath !== undefined ? "config_path, " : "") + (paths.plistPath !== undefined ? "plist_path, " : "");
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
  // cortex#2534 — read-only probe of an agents account config already records,
  // so the plan (dry-run included) reports its JetStream state.
  const agentsProbe: AgentsJetStreamProbe =
    inputs.state.agentsAccount !== undefined
      ? await probeAgentsJetStream(inputs.agentsAccountName, inputs.state.agentsAccount, ports.export)
      : { status: "not-probed" };
  // cortex#2535 — pick the nats-server config path (read-only fs checks).
  const natsConfig = resolveNatsConfigPath(inputs, ports.natsConfig);
  const natsPaths = natsConfigPaths(natsConfig);
  const plan = buildProvisionPlan(inputs, agentsProbe, natsConfig);
  const planLines = plan.map(renderPlanLine);

  if (!inputs.apply) {
    return {
      ok: true,
      applied: false,
      plan,
      natsConfig,
      steps: [
        ...planLines,
        ...natsConfigUnsetNote(natsConfig),
        "",
        "Re-run with --apply to execute.",
        "AFTER this: exchange the leaf shared secret + agree hub topology with your peer, then `cortex network join <network>`.",
      ],
    };
  }

  const { force, state } = inputs;
  const steps: string[] = [];

  // cortex#2534 — refuse BEFORE the first mutation when the agents account's
  // JetStream state cannot be verified, or nsc resolves a different account.
  // `--force` re-mints the tree, so there the account is re-probed after step 3.
  if (!force) {
    const problem = agentsProbeProblem(inputs.agentsAccountName, agentsProbe, state.agentsAccount);
    if (problem !== undefined) return fail(plan, steps, `${problem} Aborting before any change.`);
  }

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
  let agentsJetStream: AgentsJetStreamProbe = agentsProbe;
  let agentsMintedNow = false;
  if (agentsNeeded) {
    const r = await ports.operator.addAccount({ name: inputs.agentsAccountName });
    if (!r.ok) return fail(plan, steps, `add-account (agents) failed: ${r.reason}`);
    resolvedAgents = r.pubKey;
    agentsMintedNow = r.created;
    steps.push(`agents account ${r.created ? "minted" : "present"}: ${r.account} (${r.pubKey})`);
    if (r.created) {
      // arc mints the account with no JetStream limits.
      agentsJetStream = { status: "disabled" };
    } else if (
      (agentsProbe.status !== "enabled" && agentsProbe.status !== "disabled") ||
      r.pubKey !== state.agentsAccount
    ) {
      // It already sat in the nsc store and the pre-probe does not describe it:
      // read its state rather than assume it.
      agentsJetStream = await probeAgentsJetStream(inputs.agentsAccountName, r.pubKey, ports.export);
    }
  } else {
    steps.push(`agents account present: ${resolvedAgents}`);
  }

  // 3a. (cortex#2534) JetStream on the agents account.
  if (resolvedAgents === undefined) {
    return fail(plan, steps, "internal: agents account pubkey unresolved after mint (should not happen)");
  }
  const js = await ensureAgentsJetStream(inputs.agentsAccountName, agentsJetStream, resolvedAgents, !agentsMintedNow, ports);
  if (!js.ok) return fail(plan, steps, js.reason);
  steps.push(...js.steps);

  // 3.5 (cortex#1333) — ensure the SYS (system) account; see the rationale on the
  //     "system account" plan item above. Gated on state.systemAccount: mint only
  //     when config records no system_account, otherwise skip — this gate is the
  //     idempotency, no arc-side addAccount dedup is assumed. The SAME gate value
  //     drives the dedicated SYS export at step 5.6 (one constant, so mint and
  //     export can never drift apart), which writes system_account[_jwt] to config
  //     even when the operator/account JWTs are already present.
  const sysConfigMissingOrForced = force || state.systemAccount === undefined;
  if (sysConfigMissingOrForced) {
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

  // Defensive: both account pubkeys must be resolved before wiring/write-back
  // (the agents pubkey is already checked before step 3a).
  if (resolvedAccount === undefined) {
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

  // 5.6 — the SYS export is gated INDEPENDENTLY of the operator/account JWT
  // export, on the SAME constant that gated the mint at step 3.5. An older
  // provisioned stack can have operatorModeJwtsPresent === true (JWTs already in
  // config) yet still lack system_account; folding SYS into jwtExportNeeded would
  // mint SYS at step 3.5 but then SKIP the only write of system_account, leaving
  // the JetStream boot-fatal in place.
  //
  // A failed SYS export here FAILS provision (fail-fast, before the config
  // write) — SYS was just ensured, so not-found means an arc store inconsistency,
  // and returning ok while the advertised system_account wiring silently did not
  // happen would mislead the caller. This also matches the module invariant:
  // any arc failure aborts before the config write-back.
  if (sysConfigMissingOrForced) {
    const sysRes = await ports.export.exportSystem({ name: inputs.systemAccountName });
    if (!sysRes.ok) {
      // A failed SYS export is fatal: SYS was ensured at step 3.5, so not-found
      // means an arc operator-store inconsistency, and any failure leaves config
      // without system_account — a JetStream stack then boot-fatals ("system
      // account not setup") at first start while provision claimed success. Fail
      // loudly, with the remediation, BEFORE the config write (step 6) so no
      // short/misleading config is persisted.
      const why = sysRes.notFound
        ? `${inputs.systemAccountName} not found at export despite the step-3.5 ensure (arc store inconsistency)`
        : `system export failed: ${sysRes.reason}`;
      return fail(
        plan,
        steps,
        `${why} — system_account NOT written (a JetStream stack would boot-fatal at first start); ` +
          `aborting before config write. Remediation: re-run \`cortex network provision\`; if it persists, ` +
          `inspect the store with \`arc nats export-system --name ${inputs.systemAccountName} --json\` and ` +
          `repair the operator account tree.`,
      );
    }
    systemAccount = sysRes.pubKey;
    systemAccountJwt = sysRes.jwt;
    steps.push(`system_account exported + wired: ${inputs.systemAccountName}`);
  }

  // 6. Write the resolved nats_infra fields back to the stack config.
  const written = ports.configWrite.write({
    account: resolvedAccount,
    agentsAccount: resolvedAgents,
    credsPath: inputs.credsPath,
    ...natsPaths,
    seedPath: inputs.seedPath,
    ...(resolvedNkeyPub !== undefined && { nkeyPub: resolvedNkeyPub }),
    ...(operatorJwt !== undefined && { operatorJwt }),
    ...(accountJwt !== undefined && { accountJwt }),
    ...(systemAccount !== undefined && { systemAccount }),
    ...(systemAccountJwt !== undefined && { systemAccountJwt }),
  });
  if (!written.ok) return fail(plan, steps, `config write-back failed: ${written.reason}`);
  steps.push(
    `stack.nats_infra written (account, agents_account, creds_path, ${writtenPathFields(natsConfig)}nkey_seed_path` +
      (operatorJwt !== undefined ? ", operator_jwt, account_jwt" : "") +
      (systemAccount !== undefined ? ", system_account, system_account_jwt" : "") +
      ")",
  );
  steps.push(`nats-server config path: ${natsConfigPlanItem(natsConfig).detail}`);
  steps.push(...natsConfigUnsetNote(natsConfig));

  steps.push("");
  steps.push("Ready for `cortex network join <network>` — remaining: leaf shared secret + hub topology (two-party, out-of-band).");

  return {
    ok: true,
    applied: true,
    plan,
    steps,
    natsConfig,
    resolved: {
      account: resolvedAccount,
      agentsAccount: resolvedAgents,
      credsPath: inputs.credsPath,
      ...natsPaths,
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
