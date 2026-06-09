/**
 * S4 (#738) — the REAL + DRY-RUN port adapters for `cortex network`.
 *
 * The orchestration (`network-lib.ts`) is pure over {@link NetworkPorts}. This
 * module builds the two concrete bundles:
 *
 *   - {@link buildLivePorts}   — mutates the live deployment (leaf include file,
 *     nats-server plist, the stack's federation config, launchctl). Used only
 *     on `--apply`.
 *   - {@link buildDryRunPorts} — the DEFAULT-safe bundle: every effect is a
 *     no-op that the orchestrator's step log captures, so an accidental run
 *     during development touches nothing (the S4 SAFETY rule). Reads still hit
 *     disk (a dry-run join needs to know the current config to show the diff),
 *     but no write/exec/restart happens.
 *
 * Wiring of the S1–S3 pieces:
 *   - S1 `NetworkRegistryClient` (pin+verify, DD-9) + `registerStackIdentity`
 *     (proof-of-possession, reused from provision-stack) → {@link NetworkRegistryPort}.
 *   - S3 `renderLeafIncludeFile` + `leafIncludeFileName` → {@link LeafFilePort}.
 *   - S3 `ensureConfigArg` + `renderProgramArguments` → {@link PlistPort}.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";

import { parse as parseYaml, parseDocument } from "yaml";

import { expandTilde } from "../../../common/config/loader";
import {
  ensureLeafInclude,
  leafIncludeFileName,
  natsConfigCanBindAccount,
  removeLeafInclude,
  renderLeafIncludeFile,
  resolveLeafBindMode,
} from "../../../common/nats/leaf-remote-renderer";
import {
  bunExecRunner,
  currentServicePlatform,
  selectNatsServiceManager,
  type NatsServiceManager,
  type ServicePlatform,
} from "../../../common/nats/nats-service-manager";
import { NetworkRegistryClient } from "../../../common/registry/network-client";
import {
  findCortexDaemonDescriptor,
  type DaemonLocatorIO,
} from "./daemon-locator";
import {
  buildRegistrationClaim,
  materialFromSeedString,
  registerStackIdentity,
  resolveMergedStacks,
  resolveMergedCapabilities,
  isStackRegistered,
  type StackIdentityMaterial,
  type ClaimCapability,
} from "../../../bus/stack-provisioning";
import type {
  PolicyFederatedNetwork,
  PolicyPublic,
} from "../../../common/types/cortex-config";

import type {
  ConfigStorePort,
  DaemonPort,
  LeafFilePort,
  LeafStatePort,
  NatsServerPort,
  NetworkPorts,
  NetworkRegistryPort,
  PlistPort,
  RenderLeafInputs,
} from "./network-ports";
import type {
  PublicPolicyPort,
  PublicRegistryPort,
  PublicScopePorts,
  PublicSubscribePort,
} from "./network-public-ports";

/** Everything the live adapters need, threaded from the CLI flags. */
export interface LivePortsConfig {
  networkId: string;
  principalId: string;
  stackId: string;
  registryUrl?: string;
  registryPubkey?: string;
  seedPath?: string;
  /**
   * C-791 — the principal ROOT seed path (the FIRST stack's seed), present ONLY
   * when joining a SECOND+ stack of an already-registered principal. Mirrors
   * `provision-stack register --principal-seed`: the join's register step then
   * SIGNS the add-stack claim with the ROOT (the authorization the registry
   * requires — `principal_pubkey` stays the registered root, so the rotation
   * gate admits it) while {@link LivePortsConfig.seedPath} is the NEW stack's
   * own signing key (its pubkey becomes the new stack's `stack_pubkey`). The
   * existing stacks are fetch+merged so the full-overwrite register route does
   * not drop them. Omitted → first-stack register (the pre-C-791 path), with an
   * idempotency skip when the stack is already on record (see
   * {@link registerWithCapabilities}).
   */
  rootSeedPath?: string;
  natsConfigPath?: string;
  /**
   * macOS (launchd) nats-server descriptor — the plist whose `ProgramArguments`
   * carry `-c <config>` and that `launchctl kickstart` restarts. On a Linux
   * stack this is absent and {@link LivePortsConfig.unitPath} is set instead.
   */
  plistPath?: string;
  /**
   * #763 — Linux (systemd) nats-server descriptor: the systemd unit whose
   * `[Service] ExecStart=` carries `-c <config>` and that `systemctl restart`
   * reloads. Mutually-platform-exclusive with {@link LivePortsConfig.plistPath}.
   */
  unitPath?: string;
  /**
   * #763 — platform the join runs on. Selects launchd vs systemd service
   * management. Defaults to `process.platform` when omitted (the CLI sets it
   * explicitly; tests pin it).
   */
  platform?: ServicePlatform;
  monitorUrl?: string;
  /**
   * #800 — the cortex.yaml the stack's CORTEX daemon loads (the join's
   * `--config`, default `~/.config/cortex/cortex.yaml`). Used to LOCATE the
   * daemon's launchd/systemd service for the restart: the daemon is the service
   * whose argv carries `--config <cortexConfigPath>`. Without it the restart
   * fell back to guessing `ai.meta-factory.cortex.<stack-slug>`, which fails
   * whenever the slug differs from the plist suffix (e.g. `jc/default` →
   * `ai.meta-factory.cortex.meta-factory`).
   */
  cortexConfigPath?: string;
  /**
   * #762 — the capability ids this stack announces INTO `networkId`, sourced
   * from the network's `announce_capabilities[]` policy block. The federated
   * `registerStack` step announces these to the registry with
   * `networks: [networkId]` so the principal joins the network's roster
   * (`membersFromPrincipals` — implicit membership via `capability.networks[]`).
   * Empty/absent → the stack registers with no capability targeting the network
   * (the pre-#762 behaviour that left the roster empty); the join then warns and
   * preserves any existing hand-pins rather than wiping them.
   */
  announceCapabilities?: string[];
  /**
   * #813 — test-only seam for the fail-closed daemon guard
   * ({@link assertDaemonLoadsConfig}). In production this is absent and the
   * guard scans the real `~/Library/LaunchAgents` / `~/.config/systemd/user`
   * via {@link liveDaemonLocatorIO}. Tests inject a fake `io` (+ dirs) so they
   * can exercise the live write path without a real installed daemon — and can
   * assert the refuse-on-mismatch branch deterministically.
   */
  daemonLocatorOverride?: {
    io: DaemonLocatorIO;
    launchAgentsDir?: string;
    systemdUserDir?: string;
  };
}

// =============================================================================
// Registry port — S1 client + provision-stack register (proof-of-possession).
// =============================================================================

/** Load + re-derive identity material from a seed file. Never throws. */
function loadSeedMaterial(
  seedPathRaw: string,
  label: string,
): { ok: true; material: StackIdentityMaterial } | { ok: false; reason: string } {
  const seedFile = expandTilde(seedPathRaw);
  if (!existsSync(seedFile)) {
    return { ok: false, reason: `${label} seed file not found at ${seedFile}` };
  }
  try {
    return { ok: true, material: materialFromSeedString(readFileSync(seedFile, "utf-8")) };
  } catch (err) {
    return { ok: false, reason: `${label} seed load failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Shared idempotent proof-of-possession registration (reused by the S4
 * `registerStack` and the S5 public-index announce/deregister). Loads the seed,
 * builds + signs the claim with the supplied `capabilities`, and POSTs it. An
 * EMPTY `capabilities` list de-advertises the stack on the public index
 * (the registry searches over the claim's `capabilities`). Never throws.
 *
 * C-791 — multi-stack principals:
 *
 *   1. **Idempotency skip.** Before posting, probe whether THIS stack is already
 *      registered with its current pubkey. If so, the register is a NO-OP (the
 *      DD-4 "re-running converges" promise) — crucially, this is what lets a
 *      2nd-stack join succeed even WITHOUT a root seed when the stack was
 *      already registered out-of-band (e.g. by `provision-stack register
 *      --principal-seed`), instead of 409-ing at the rotation gate.
 *   2. **Root-signed add-stack.** When {@link LivePortsConfig.rootSeedPath} is
 *      set (the principal's root/first-stack seed), the claim is SIGNED BY THE
 *      ROOT and the principal's existing stacks are fetch+merged in, so the
 *      registry admits the add-stack (its `principal_pubkey` stays the
 *      registered root) and the full-overwrite upsert preserves the other
 *      stacks. This is the #787 root-authorization, NOT relaxed: a non-root key
 *      still cannot mint an accepted add-stack claim.
 */
async function registerWithCapabilities(
  cfg: LivePortsConfig,
  capabilities: ClaimCapability[],
  /**
   * C-791 — enable the idempotency SKIP (federated join only). The public
   * announce/deregister path re-registers to CHANGE the advertised capability
   * set with the SAME pubkey, so it must NOT short-circuit on a pubkey match.
   * Federated `registerStack` passes `true`; the public ports pass the default
   * `false`. NOTE (MAJOR 1): even on the federated path the skip fires ONLY when
   * the stack pubkey AND the announced capabilities are ALREADY on record — if
   * caps still need announcing (the principal isn't yet in the network roster),
   * the join proceeds rather than skipping (see {@link isStackRegistered}).
   */
  allowIdempotentSkip = false,
): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
  const url = cfg.registryUrl ?? "";
  const registryPubkey = cfg.registryPubkey;
  if (cfg.seedPath === undefined) {
    return { ok: false, reason: "no --seed-path for registration" };
  }
  const matRes = loadSeedMaterial(cfg.seedPath, "--seed-path");
  if (!matRes.ok) return matRes;
  const material = matRes.material;

  // (2) Add-stack root material — load it up front (the skip below needs the
  // verified merge-read, which root-auth doesn't change, but the cap merge +
  // claim signing do). When a root seed is supplied, the ROOT signs the claim
  // and the existing stacks + caps are fetch+merged so the full-overwrite route
  // preserves them. Without it, this is a first-stack register (the new stack
  // both declares + signs — pre-C-791 behaviour).
  let rootMaterial: StackIdentityMaterial | undefined;
  if (cfg.rootSeedPath !== undefined) {
    const rootRes = loadSeedMaterial(cfg.rootSeedPath, "--principal-seed");
    if (!rootRes.ok) return rootRes;
    rootMaterial = rootRes.material;
  }

  // (1) Idempotency (federated join): skip ONLY when fully converged — the
  // stack pubkey AND the announced capabilities are already on record. This is
  // the MAJOR 1 fix: an already-registered stack whose network caps are NOT yet
  // announced must STILL register so the announce lands the principal in the
  // network roster (0-peers-otherwise). A registry error here is non-fatal: we
  // fall through to the normal register, which surfaces the registry's own
  // error. Gated by `allowIdempotentSkip` so the public-index announce path
  // never short-circuits.
  if (allowIdempotentSkip) {
    const idempotent = await isStackRegistered({
      registryUrl: url,
      principalId: cfg.principalId,
      stackId: cfg.stackId,
      stackPubkey: material.pubkeyB64,
      ...(registryPubkey !== undefined && { registryPubkey }),
      announce: capabilities,
    });
    if (idempotent === "registered") {
      return { ok: true, note: "already registered + announced (idempotent skip)" };
    }
  }

  const isAddStack = rootMaterial !== undefined;

  const stacksRes = await resolveMergedStacks({
    principalId: cfg.principalId,
    stackId: cfg.stackId,
    stackPubkey: material.pubkeyB64,
    registryUrl: url,
    ...(registryPubkey !== undefined && { registryPubkey }),
    isAddStack,
  });
  if (!stacksRes.ok) return { ok: false, reason: stacksRes.reason };

  // MAJOR 2 — merge the announced capabilities into the principal's existing
  // set so the full-overwrite register does not drop prior-network caps (which
  // would evict those networks from the principal's roster membership).
  const capsRes = await resolveMergedCapabilities({
    principalId: cfg.principalId,
    registryUrl: url,
    ...(registryPubkey !== undefined && { registryPubkey }),
    announce: capabilities,
    isAddStack,
  });
  if (!capsRes.ok) return { ok: false, reason: capsRes.reason };

  const body = await buildRegistrationClaim({
    principalId: cfg.principalId,
    material,
    ...(rootMaterial !== undefined && { rootMaterial }),
    stacks: stacksRes.stacks,
    capabilities: capsRes.capabilities,
  });
  let result;
  try {
    result = await registerStackIdentity({ registryUrl: url, principalId: cfg.principalId, body });
  } catch (err) {
    return { ok: false, reason: `registry POST failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!result.ok) {
    return { ok: false, reason: `registry rejected registration (HTTP ${result.status.toString()})` };
  }
  return { ok: true, note: `HTTP ${result.status.toString()}` };
}

function buildRegistryPort(cfg: LivePortsConfig): NetworkRegistryPort {
  const url = cfg.registryUrl ?? "";
  const client = new NetworkRegistryClient({
    url,
    ...(cfg.registryPubkey !== undefined ? { pubkey: cfg.registryPubkey } : {}),
  });

  return {
    async registerStack() {
      // #762 — federated register MUST announce the stack's declared
      // capabilities INTO this network so the principal joins the network's
      // roster. Roster membership is implicit (`membersFromPrincipals`): a
      // principal is "in" `networkId` iff one of its announced capabilities
      // lists `networkId` in `capability.networks[]`. The pre-#762 code
      // registered with an EMPTY capability list — the principal appeared at
      // `/principals/{id}` but never in `/networks/{networkId}/roster`, so a
      // registry-resolved join wrote 0 peers (and risked wiping a working
      // hand-pin). We tag each announced capability with `networks: [networkId]`.
      //
      // This is a registry CONTROL-PLANE action (a signed HTTP POST to
      // /principals/.../register), NOT a `federated.*` wire envelope — the
      // network name never goes on the bus (federation-wire-protocol check 1).
      const announced = (cfg.announceCapabilities ?? []).map((id) => ({
        id,
        networks: [cfg.networkId],
      }));
      // C-791 — federated register: enable the idempotency skip (a re-run or a
      // join-after-provision-stack-register converges instead of 409-ing) and
      // honour the optional root seed (root-signed add-stack for a 2nd stack).
      return registerWithCapabilities(cfg, announced, true);
    },
    fetchVerified(networkId) {
      // S1's fetchAndCache returns { descriptor, roster } on ok and refreshes
      // the disk cache (DD-10) — exactly the port's contract.
      return client.fetchAndCache(networkId);
    },
    loadCached(networkId) {
      return client.loadCached(networkId);
    },
  };
}

// =============================================================================
// Leaf-file port — S3 renderer output written to the nats config dir.
// =============================================================================

/** Directory the per-network leaf include files live in (beside nats config). */
function leafDir(cfg: LivePortsConfig): string {
  const natsConfig = expandTilde(cfg.natsConfigPath ?? "");
  return dirname(natsConfig);
}

function buildLeafFilePort(cfg: LivePortsConfig, mutate: boolean): LeafFilePort {
  const dir = leafDir(cfg);
  return {
    write(inputs: RenderLeafInputs) {
      const content = renderLeafIncludeFile(inputs.descriptor, inputs.binding);
      if (!mutate) return; // dry-run: render to validate, but do not write.
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, leafIncludeFileName(inputs.descriptor.network_id)), content, "utf-8");
    },
    remove(networkId) {
      if (!mutate) return;
      const p = join(dir, leafIncludeFileName(networkId));
      rmSync(p, { force: true });
    },
    ensureInclude(networkId) {
      // #754 — wire the main nats config to `include` the rendered leaf file.
      // Read local.conf, apply S3's idempotent ensure, write back. Dry-run is
      // inert (the orchestrator's step log still records the intended action).
      if (!mutate) return;
      const configPath = expandTilde(cfg.natsConfigPath ?? "");
      const current = existsSync(configPath)
        ? readFileSync(configPath, "utf-8")
        : "";
      const next = ensureLeafInclude(current, networkId);
      if (next === current) return; // byte-stable no-op.
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, next, "utf-8");
    },
    removeInclude(networkId) {
      // #754 — leave teardown: drop the include directive (inverse of ensure).
      if (!mutate) return;
      const configPath = expandTilde(cfg.natsConfigPath ?? "");
      if (!existsSync(configPath)) return;
      const current = readFileSync(configPath, "utf-8");
      const next = removeLeafInclude(current, networkId);
      if (next === current) return; // no-op.
      writeFileSync(configPath, next, "utf-8");
    },
    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => /^leafnodes-[a-z][a-z0-9-]*\.conf$/.test(f))
        .map((f) => f.replace(/^leafnodes-/, "").replace(/\.conf$/, ""));
    },
    natsConfigPath() {
      return expandTilde(cfg.natsConfigPath ?? "");
    },
    canBindAccount(account) {
      // #794 — pure READ (identical in live + dry-run): an anonymous bus that
      // can't bind the leaf account would crash nats-server on restart, so the
      // orchestrator refuses BEFORE any mutation. An absent/empty config file is
      // anonymous-by-definition → cannot bind.
      const configPath = expandTilde(cfg.natsConfigPath ?? "");
      const text = existsSync(configPath)
        ? readFileSync(configPath, "utf-8")
        : "";
      return natsConfigCanBindAccount(text, account);
    },
    resolveBindMode(account, hasCreds) {
      // #799 — pure READ (identical in live + dry-run): choose the leaf-remote
      // bind mode by bus type. operator-mode + account → account-bound; $G
      // /default + creds → no-account (creds JWT binds); neither possible →
      // refuse. An absent/empty config file reads as a $G/default bus.
      const configPath = expandTilde(cfg.natsConfigPath ?? "");
      const text = existsSync(configPath)
        ? readFileSync(configPath, "utf-8")
        : "";
      return resolveLeafBindMode(text, account, hasCreds);
    },
  };
}

// =============================================================================
// nats-server service management — the launchd/systemd abstraction (#763).
//
// Pre-#763 this adapter hardcoded launchd: it read/wrote the plist
// `ProgramArguments` and restarted via `launchctl`. On Linux (clawbox) the
// descriptor is a systemd unit, so feeding it here errored cryptically
// ("ProgramArguments is empty"). The launchd/systemd split now lives in
// `src/common/nats/nats-service-manager.ts` (the `NatsServiceManager` seam);
// this adapter only selects the right manager per platform/descriptor and
// threads it into BOTH the `PlistPort` (config-arg ensure) and the
// `NatsServerPort` (restart) — the two ports the orchestrator already depends
// on. The macOS behavior is byte-for-byte the lifted launchd implementation.
// =============================================================================

/**
 * Resolve the nats-server service descriptor for the stack: the systemd unit
 * (`unitPath`) on Linux, the launchd plist (`plistPath`) on macOS. Returns the
 * tilde-expanded path, or `undefined` when the platform's descriptor is unset
 * (a caller that does not manage the nats-server service — the port then no-ops
 * gracefully, matching the pre-#763 "plist not found" contract).
 */
function descriptorPathFor(cfg: LivePortsConfig): string | undefined {
  const platform = cfg.platform ?? currentServicePlatform();
  const raw = platform === "linux" ? cfg.unitPath ?? cfg.plistPath : cfg.plistPath ?? cfg.unitPath;
  if (raw === undefined || raw === "") return undefined;
  return expandTilde(raw);
}

/**
 * Build the {@link NatsServiceManager} for the stack, or `undefined` when no
 * descriptor is configured for the platform. A descriptor whose type does not
 * match the platform (plist-on-Linux / unit-on-macOS) makes
 * `selectNatsServiceManager` throw a CLEAR error — the join's never-throws
 * orchestration surfaces it as a `{ ok: false }` (it runs inside the port
 * methods, which the orchestrator's try/await guards).
 */
function buildServiceManager(
  cfg: LivePortsConfig,
  mutate: boolean,
): NatsServiceManager | undefined {
  const descriptorPath = descriptorPathFor(cfg);
  if (descriptorPath === undefined) return undefined;
  return selectNatsServiceManager({
    descriptorPath,
    platform: cfg.platform ?? currentServicePlatform(),
    mutate,
    exec: bunExecRunner,
  });
}

function buildPlistPort(cfg: LivePortsConfig, mutate: boolean): PlistPort {
  return {
    ensureConfigLoaded(configPath) {
      buildServiceManager(cfg, mutate)?.ensureConfigLoaded(configPath);
    },
    dropConfigArg(configPath) {
      buildServiceManager(cfg, mutate)?.dropConfigArg(configPath);
    },
  };
}

// =============================================================================
// Config-store port — read/write policy.federated.networks[] in stacks/<stack>.yaml.
// =============================================================================

/**
 * The config file that carries `policy.federated.networks[]`, resolved from the
 * daemon's REAL `--config` ({@link LivePortsConfig.cortexConfigPath}) — NOT from
 * `cfg.stackId` (#805 / #807).
 *
 * The split-brain bug (#805): the join used to derive its write target from the
 * `stackId` slug + a hardcoded `~/.config/cortex`, ignoring the daemon's actual
 * `--config`. On JC's single-file deployment (`cortex.yaml`, stack.id
 * `jc/default`) the join wrote `~/.config/cortex/stacks/default.yaml` while the
 * daemon read `~/.config/cortex/cortex.yaml` — status said "joined", the leaf
 * never linked. We now resolve the target from `cortexConfigPath`, the same path
 * the daemon loads, so the policy block always lands where the daemon reads it.
 *
 * Layout-aware, mirroring the daemon's composer read path (`loader.ts`
 * `composeRawConfig`), which the shell `resolve_stack_config_path` also targets
 * in the canonical `<slug>/<slug>.yaml` render — the daemon and the join MUST
 * agree on which file holds the `policy:` block:
 *
 *   - **config-split (migration 0003 / #714):** the dir of `cortexConfigPath`
 *     contains `system/system.yaml` (the layout marker the loader's composer
 *     keys on). The `policy:` block lives in `<dir>/stacks/<basename>.yaml`,
 *     where `<basename>` is the `cortexConfigPath` filename without `.yaml`.
 *     The slug is the pointer BASENAME, not `cfg.stackId` — that decoupling is
 *     exactly #807's directory-layout drift corner (dir `meta-factory`,
 *     stack.id `jc/default` → target keyed off the dir/basename, not `default`).
 *     INVARIANT: the composer wholesale-replaces `policy.federated.networks` by
 *     sort-order across `stacks/*.yaml`, so the `stacks/` dir is expected to
 *     carry exactly ONE policy-bearing file; a second one would override the
 *     join's write (merge-by-id is a tracked follow-up, not handled here).
 *   - **monolith (single-file, legacy):** no `system/system.yaml` beside it. The
 *     `policy:` block lives in the monolith file itself = `cortexConfigPath`.
 *     This is the #805 single-file fix — the daemon reads `cortex.yaml`, so
 *     policy must land in `cortex.yaml`.
 *
 * Read + write both call this, so the change keeps them symmetric. Falls back to
 * the pre-#805 behaviour (slug + `~/.config/cortex`) only when `cortexConfigPath`
 * is empty — which in practice never happens, since the CLI always sets it
 * (defaults to the expanded {@link DEFAULT_CONFIG_PATH} via
 * `cortexConfigPathFromFlags`).
 */
function stackConfigPath(cfg: LivePortsConfig): string {
  const cortexConfigPath = cfg.cortexConfigPath;
  // Pre-#805 fallback: only when no --config is threaded. The CLI always sets
  // it (default DEFAULT_CONFIG_PATH), so this branch is effectively unreachable
  // in production — it's a belt-and-braces guard for direct port construction.
  if (cortexConfigPath === undefined || cortexConfigPath === "") {
    const slug = cfg.stackId.split("/")[1] ?? "default";
    const cortexDir = expandTilde("~/.config/cortex");
    const perStackDir = join(cortexDir, slug);
    if (existsSync(join(perStackDir, "system", "system.yaml"))) {
      return join(perStackDir, "stacks", `${slug}.yaml`);
    }
    return join(cortexDir, "stacks", `${slug}.yaml`);
  }

  // #805/#807 — resolve from the daemon's real --config, layout-aware.
  const configPath = expandTilde(cortexConfigPath); // defensive; CLI pre-expands
  const configDir = dirname(configPath);
  // Config-split: the per-stack dir is marked by `<dir>/system/system.yaml`
  // (the same marker the loader's composer keys on). The `policy:` block belongs
  // in `<dir>/stacks/<basename>.yaml` — the file the composer reads it from. The
  // slug is the pointer BASENAME (not cfg.stackId — #807's drift corner).
  const splitMarker = join(configDir, "system", "system.yaml");
  if (existsSync(splitMarker)) {
    const base = basename(configPath).replace(/\.ya?ml$/i, "");
    return join(configDir, "stacks", `${base}.yaml`);
  }
  // Monolith (single-file, legacy) — policy lands in the monolith itself, the
  // file the daemon reads (#805). No <dir>/system/system.yaml beside it.
  return configPath;
}

/**
 * #813 — fail-closed guard against the RESIDUAL split-brain (adversarial CASE N).
 *
 * `stackConfigPath` trusts the passed `--config`. When the principal OMITS
 * `--config`, `cortexConfigPathFromFlags` defaults to `~/.config/cortex/
 * cortex.yaml`; for a config-split stack living in a SUBDIR the resolved write
 * then lands on the default monolith path while the daemon reads
 * `<dir>/<slug>.yaml` — a silent re-split (and a regression vs the old
 * stackId-slug logic, which handled aligned subdir stacks).
 *
 * BEFORE any live policy write we confirm a running cortex daemon actually
 * loads the resolved `--config`, reusing the SAME discovery the restart step
 * uses ({@link findCortexDaemonDescriptor}). If NO daemon matches we THROW —
 * the join/leave orchestrator's write `try/catch` converts that into a clean
 * `{ ok: false }` abort BEFORE `writeFileSync`, so no orphan policy block is
 * left behind. Only the LIVE path runs this (mutate=true); dry-run returns
 * early and injected test ports never reach this adapter.
 */
function assertDaemonLoadsConfig(cfg: LivePortsConfig): void {
  // No `--config` threaded → nothing to verify against; the daemon-restart step
  // already surfaces the unset-config error, so don't double-fail here.
  if (cfg.cortexConfigPath === undefined || cfg.cortexConfigPath === "") return;
  const platform = cfg.platform ?? currentServicePlatform();
  const override = cfg.daemonLocatorOverride;
  const descriptorPath = findCortexDaemonDescriptor({
    platform,
    cortexConfigPath: cfg.cortexConfigPath,
    launchAgentsDir: override?.launchAgentsDir ?? expandTilde("~/Library/LaunchAgents"),
    systemdUserDir: override?.systemdUserDir ?? expandTilde("~/.config/systemd/user"),
    io: override?.io ?? liveDaemonLocatorIO,
  });
  if (descriptorPath === undefined) {
    const resolved = expandTilde(cfg.cortexConfigPath);
    throw new Error(
      `no running cortex daemon loads --config ${resolved}; ` +
        `pass --config <the path your daemon uses> ` +
        `(e.g. ~/.config/cortex/<stack>/<stack>.yaml)`,
    );
  }
}

function buildConfigStorePort(cfg: LivePortsConfig, mutate: boolean): ConfigStorePort {
  const path = stackConfigPath(cfg);
  return {
    readNetworks() {
      if (!existsSync(path)) return [];
      const raw = parseYaml(readFileSync(path, "utf-8")) as
        | { policy?: { federated?: { networks?: PolicyFederatedNetwork[] } } }
        | null;
      return raw?.policy?.federated?.networks ?? [];
    },
    writeNetworks(networks) {
      if (!mutate) return;
      // #813 — fail closed before mutating the principal's config in place.
      assertDaemonLoadsConfig(cfg);
      // #813 — preserve comments: the join now rewrites the principal's
      // hand-maintained monolith in place. parseDocument + setIn keeps the
      // header/inline comments (incl. `# DO NOT EDIT BY HAND`) that
      // parseYaml→stringifyYaml would strip.
      const doc = existsSync(path)
        ? parseDocument(readFileSync(path, "utf-8"))
        : parseDocument("");
      doc.setIn(["policy", "federated", "networks"], networks);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, doc.toString(), "utf-8");
    },
  };
}

// =============================================================================
// Daemon port — restart the stack's CORTEX daemon (#800).
//
// We DISCOVER the daemon's launchd/systemd service by matching the descriptor
// whose argv carries `--config <cortexConfigPath>` (the cortex.yaml the daemon
// loads), then restart it via its real `<key>Label</key>` / unit id through the
// shared {@link selectNatsServiceManager} mechanism. The pre-#800 code guessed
// `ai.meta-factory.cortex.<stack-slug>`, which fails (113/503) whenever the slug
// differs from the plist suffix — the `jc/default` → `…cortex.meta-factory`
// case. We no longer guess: an unresolvable daemon returns a CLEAR reason rather
// than kickstarting a fabricated label.
// =============================================================================

/** Live {@link DaemonLocatorIO} backed by real `fs`. */
const liveDaemonLocatorIO: DaemonLocatorIO = {
  listDir(dir) {
    try {
      return readdirSync(dir);
    } catch (_err) {
      // Missing/unreadable dir → no candidates here. Caller treats as "not found".
      return [];
    }
  },
  readFile(path) {
    return readFileSync(path, "utf-8");
  },
  exists(path) {
    return existsSync(path);
  },
};

function buildDaemonPort(cfg: LivePortsConfig, mutate: boolean): DaemonPort {
  return {
    async restart() {
      if (!mutate) return { ok: true }; // dry-run: pretend success.
      const platform = cfg.platform ?? currentServicePlatform();
      if (cfg.cortexConfigPath === undefined) {
        return {
          ok: false,
          reason:
            "cannot locate the cortex daemon service: no cortex config path threaded " +
            "(internal: LivePortsConfig.cortexConfigPath unset)",
        };
      }
      const descriptorPath = findCortexDaemonDescriptor({
        platform,
        cortexConfigPath: cfg.cortexConfigPath,
        launchAgentsDir: expandTilde("~/Library/LaunchAgents"),
        systemdUserDir: expandTilde("~/.config/systemd/user"),
        io: liveDaemonLocatorIO,
      });
      if (descriptorPath === undefined) {
        const where = platform === "darwin" ? "~/Library/LaunchAgents" : "~/.config/systemd/user";
        return {
          ok: false,
          reason:
            `no cortex daemon service found referencing --config ${cfg.cortexConfigPath} ` +
            `under ${where} — is the stack daemon installed? (arc upgrade Cortex)`,
        };
      }
      let mgr;
      try {
        // NB: `selectNatsServiceManager` is named for its original nats-server
        // caller, but it's generic — it restarts ANY launchd/systemd descriptor
        // by reading its `<key>Label</key>` / unit id. Here we hand it the CORTEX
        // daemon descriptor we just discovered, not a nats-server one.
        mgr = selectNatsServiceManager({ descriptorPath, platform, mutate, exec: bunExecRunner });
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      return mgr.restart();
    },
  };
}

// =============================================================================
// Nats-server port — restart the nats-server service so it reloads local.conf
// (#757). The join mutates local.conf (leaf include + `include` directive); the
// nats-server process that reads local.conf must be restarted for the leaf to
// take effect. The restart is delegated to the platform's
// {@link NatsServiceManager}: `launchctl kickstart -k gui/<uid>/<label>` on
// macOS (label read from the plist `<key>Label</key>`), `systemctl
// [--user] restart <unit>` on Linux (#763, unit id read from the `.service`
// file name). No hardcoded service id; no platform branching here.
// =============================================================================

function buildNatsServerPort(cfg: LivePortsConfig, mutate: boolean): NatsServerPort {
  return {
    async restart() {
      // `buildServiceManager` → `selectNatsServiceManager` throws on a
      // platform/descriptor mismatch (plist-on-Linux / unit-on-macOS, #763).
      // The orchestrator awaits this restart OUTSIDE a try/catch, so we honor
      // the never-throws contract here and surface the clear message as a
      // `{ ok: false }` reason rather than letting it escape as a stack trace.
      let mgr: NatsServiceManager | undefined;
      try {
        mgr = buildServiceManager(cfg, mutate);
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      if (mgr === undefined) {
        return {
          ok: false,
          reason:
            "no nats-server service descriptor configured (set stack.nats_infra.plist_path on macOS or unit_path on Linux)",
        };
      }
      return mgr.restart();
    },
  };
}

// =============================================================================
// Leaf-state port — nats-server monitor /leafz for status.
// =============================================================================

/**
 * C-797 — the nats-server HTTP monitor endpoint defaults to `127.0.0.1:8222`
 * (the upstream default `http_port`). Before this fix `buildLeafStatePort`
 * returned `undefined` whenever `--monitor-url` was omitted, so `cortex network
 * status` never queried `/leafz` and every link fell back to `link:unknown` —
 * even though leafz (the authoritative source) showed the leaf up. Defaulting
 * the monitor URL makes status read the authoritative leaf-state out of the box;
 * a genuinely-unreachable monitor still degrades gracefully to "unknown" via the
 * fetch catch below.
 */
export const DEFAULT_MONITOR_URL = "http://127.0.0.1:8222";

export function buildLeafStatePort(cfg: LivePortsConfig): LeafStatePort {
  // C-797 — always wire the port; default to the local nats-server monitor when
  // no `--monitor-url` was supplied. (Previously: undefined ⇒ no port ⇒
  // link:unknown for everyone.)
  const base = (cfg.monitorUrl ?? DEFAULT_MONITOR_URL).replace(/\/+$/, "");
  return {
    async linkStates() {
      try {
        const res = await fetch(`${base}/leafz`);
        if (!res.ok) return {};
        const body = (await res.json()) as {
          leafs?: {
            account?: string;
            name?: string;
            in_msgs?: number;
            out_msgs?: number;
          }[];
        };
        const out: Record<
          string,
          { state: "established"; inMsgs?: number; outMsgs?: number }
        > = {};
        for (const leaf of body.leafs ?? []) {
          // `/leafz` reports each leaf connection by its remote/leaf-node name
          // (`name`), falling back to the bound NATS `account`. `networkStatus`
          // joins these against each network's `leaf_node` (C-797), so an
          // established leaf maps onto its network and reports `established`
          // (up) rather than `unknown`.
          const key = leaf.name ?? leaf.account ?? "";
          if (key === "") continue;
          out[key] = {
            state: "established",
            inMsgs: leaf.in_msgs,
            outMsgs: leaf.out_msgs,
          };
        }
        return out;
      } catch (err) {
        // Monitor genuinely unreachable — status degrades to "unknown" link
        // state (the #797 graceful-fallback path, preserved).
        process.stderr.write(
          `network-adapters: leaf-state fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return {};
      }
    },
  };
}

// =============================================================================
// Bundle builders
// =============================================================================

function buildPorts(cfg: LivePortsConfig, mutate: boolean): NetworkPorts {
  return {
    registry: buildRegistryPort(cfg),
    leafFile: buildLeafFilePort(cfg, mutate),
    plist: buildPlistPort(cfg, mutate),
    configStore: buildConfigStorePort(cfg, mutate),
    daemon: buildDaemonPort(cfg, mutate),
    natsServer: buildNatsServerPort(cfg, mutate),
    // C-797 — always present now (defaults to the local monitor); status reads
    // the authoritative leafz view instead of falling back to link:unknown.
    leafState: buildLeafStatePort(cfg),
  };
}

/** Live ports — every effect mutates the deployment. Use only on `--apply`. */
export function buildLivePorts(cfg: LivePortsConfig): NetworkPorts {
  return buildPorts(cfg, true);
}

/**
 * Dry-run ports — reads hit disk; every WRITE/EXEC/RESTART is a no-op (the
 * orchestrator's step log still records the intended action). The S4 default.
 */
export function buildDryRunPorts(cfg: LivePortsConfig): NetworkPorts {
  return buildPorts(cfg, false);
}

// =============================================================================
// S5 (#739) — public-scope adapters (join/leave public)
// =============================================================================

/**
 * The system-layer config file that carries `nats.subjects[]` — `system/system.yaml`
 * under the cortex config dir (the config-split puts the transport block in the
 * system layer, NOT the stack file — the double-message structural fix). The
 * `public.>` subscription is added/removed here.
 */
function systemConfigPath(): string {
  return join(expandTilde("~/.config/cortex"), "system", "system.yaml");
}

/** The literal `public.>` subscribe pattern. */
const PUBLIC_SUBSCRIBE = "public.>";

// S5 — public capability announce/deregister: re-register the stack with (caps)
// or (empty) so the registry's `/capabilities` public index includes/drops it.
function buildPublicRegistryPort(cfg: LivePortsConfig): PublicRegistryPort {
  return {
    async announceCapabilities(capabilities) {
      return registerWithCapabilities(
        cfg,
        capabilities.map((id) => ({ id })),
      );
    },
    async deregisterCapabilities() {
      // De-advertise — register with an EMPTY capability list.
      return registerWithCapabilities(cfg, []);
    },
  };
}

// S5 — manage `public.>` in system.yaml's `nats.subjects[]`.
function buildPublicSubscribePort(mutate: boolean): PublicSubscribePort {
  const path = systemConfigPath();
  const readSubjects = (): string[] => {
    if (!existsSync(path)) return [];
    const raw = parseYaml(readFileSync(path, "utf-8")) as
      | { nats?: { subjects?: string[] } }
      | null;
    return raw?.nats?.subjects ?? [];
  };
  return {
    hasPublicSubscription() {
      return readSubjects().includes(PUBLIC_SUBSCRIBE);
    },
    addPublicSubscription() {
      if (!mutate) return;
      // #813 — preserve comments via the Document API (parseYaml→stringifyYaml
      // strips the principal's hand-maintained system.yaml comments in place).
      const doc = existsSync(path)
        ? parseDocument(readFileSync(path, "utf-8"))
        : parseDocument("");
      const subjects = readSubjects();
      // Idempotent — never double-bind (the cortex#491 double-message footgun).
      if (!subjects.includes(PUBLIC_SUBSCRIBE)) subjects.push(PUBLIC_SUBSCRIBE);
      doc.setIn(["nats", "subjects"], subjects);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, doc.toString(), "utf-8");
    },
    removePublicSubscription() {
      if (!mutate) return;
      if (!existsSync(path)) return;
      // #813 — preserve comments via the Document API.
      const doc = parseDocument(readFileSync(path, "utf-8"));
      const subjects = readSubjects().filter((s) => s !== PUBLIC_SUBSCRIBE);
      // Only the array exists to rewrite if there were subjects; if `nats.subjects`
      // was absent, readSubjects() returned [] and setIn writes an empty array —
      // matching the prior parseYaml behaviour's early-return on undefined.
      if (doc.getIn(["nats", "subjects"]) === undefined) return;
      doc.setIn(["nats", "subjects"], subjects);
      writeFileSync(path, doc.toString(), "utf-8");
    },
  };
}

// S5 — read/write `policy.public` in the stack file (same file S4's
// ConfigStorePort writes policy.federated.networks[] to).
function buildPublicPolicyPort(cfg: LivePortsConfig, mutate: boolean): PublicPolicyPort {
  const path = stackConfigPath(cfg);
  return {
    readPublic() {
      if (!existsSync(path)) return undefined;
      const raw = parseYaml(readFileSync(path, "utf-8")) as
        | { policy?: { public?: PolicyPublic } }
        | null;
      return raw?.policy?.public;
    },
    writePublic(next) {
      if (!mutate) return;
      // #813 — fail closed before mutating the principal's config in place (same
      // policy file as ConfigStorePort.writeNetworks).
      assertDaemonLoadsConfig(cfg);
      // #813 — preserve comments via the Document API.
      const doc = existsSync(path)
        ? parseDocument(readFileSync(path, "utf-8"))
        : parseDocument("");
      if (next === undefined) {
        // Leave teardown — drop the block entirely.
        doc.deleteIn(["policy", "public"]);
      } else {
        doc.setIn(["policy", "public"], next);
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, doc.toString(), "utf-8");
    },
  };
}

function buildPublicPorts(cfg: LivePortsConfig, mutate: boolean): PublicScopePorts {
  return {
    registry: buildPublicRegistryPort(cfg),
    subscribe: buildPublicSubscribePort(mutate),
    policy: buildPublicPolicyPort(cfg, mutate),
    daemon: buildDaemonPort(cfg, mutate),
  };
}

/** Live public-scope ports — mutate system.yaml + stack config. `--apply` only. */
export function buildLivePublicPorts(cfg: LivePortsConfig): PublicScopePorts {
  return buildPublicPorts(cfg, true);
}

/**
 * Dry-run public-scope ports — the S5 default-safe posture. Reads hit disk (so
 * idempotency checks like `hasPublicSubscription` are accurate); every
 * WRITE/RESTART is a no-op. An accidental `join public` during development
 * touches nothing.
 */
export function buildDryRunPublicPorts(cfg: LivePortsConfig): PublicScopePorts {
  return buildPublicPorts(cfg, false);
}
