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
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";

import { parse as parseYaml, parseDocument } from "yaml";

import { expandTilde } from "../../../common/config/loader";
import {
  ensureLeafInclude,
  leafIncludeDirectivePresent,
  leafIncludeFileName,
  natsConfigCanBindAccount,
  natsConfigMonitorUrl,
  removeLeafInclude,
  renderLeafIncludeFile,
  renderOperatorModeBlocks,
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
import { NetworkCache } from "../../../common/registry/network-cache";
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
  resolveCapabilitiesAfterLeave,
  isStackRegistered,
  type StackIdentityMaterial,
  type ClaimCapability,
} from "../../../bus/stack-provisioning";
import type {
  PolicyFederatedNetwork,
  PolicyPublic,
} from "../../../common/types/cortex-config";

import type {
  CachedNetworkPort,
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
import { buildFederationWiringAdapter } from "./network-federation-wiring";
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
   * #821 MAJOR — bound the health-probe `fetch` so a nats-server that accepts
   * the monitor TCP connection but never RESPONDS (hung/deadlocked — exactly the
   * failure the probe exists to catch) cannot hang `joinNetwork` forever. The
   * probe aborts after this many ms and treats the abort as `healthy:false`.
   * Defaults to {@link DEFAULT_HEALTH_PROBE_TIMEOUT_MS}; tests pin a short value
   * so the timeout path is asserted without a real multi-second wait.
   */
  healthProbeTimeoutMs?: number;
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
   * `registerStack` step announces these to the registry tagged
   * `networks: [networkId]`. Under ADR-0018 Gap-B these caps NO LONGER confer
   * roster membership (that is now ADMITTED-derived — `rosterFromAdmissions`);
   * they are the member's capability FACET, surfaced in the roster once the
   * principal's network-pinned admission row is ADMITTED. Empty/absent → the
   * stack still requests admission (the join names `networkId`) but advertises
   * no capability for it; the join warns and preserves any existing hand-pins
   * rather than wiping them.
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
  /**
   * C-820 — union the announced capabilities into the principal's CURRENT
   * registered set (preserving prior-network `networks[]` tags) instead of
   * sending the announce verbatim. The federated `registerStack` passes `true`
   * UNCONDITIONALLY (decoupled from `--principal-seed`/add-stack): a plain
   * re-join into a SECOND network must still union or the full-overwrite
   * register clobbers the first network's tag and evicts the principal from its
   * roster (#820). The public-index announce/deregister path passes the default
   * `false` — it intentionally REPLACES the advertised cap set (the whole point
   * of `deregisterCapabilities` is to shrink it to empty), so it must NOT union.
   */
  mergeExistingCaps = false,
  /**
   * ADR-0018 Gap-A/Gap-B (BLOCK-1) — the target network this registration
   * REQUESTS ADMISSION INTO. When set, it is signed into the claim as
   * `network_id`; the registry's register hook stamps it onto the PENDING
   * admission row, so a `cortex network join <X>` writes a network-PINNED
   * (`network_id = X`) PENDING row that an admin `admit` can promote to an
   * ADMITTED row in network X's roster (`rosterFromAdmissions`). Only the
   * FEDERATED join (`registerStack`) passes this — `cfg.networkId`. The
   * public-index announce/deregister paths and the leave re-attestation pass
   * the default `undefined`: they must NOT raise a network-admission request (a
   * de-advertise / a LEAVE is not a join). Omitted → a network-less identity
   * register (the pre-ADR-0018 row), exactly as before.
   */
  networkId?: string,
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

  // MAJOR 2 / C-820 — merge the announced capabilities into the principal's
  // existing set so the full-overwrite register does not drop prior-network caps
  // (which would evict those networks from the principal's roster membership).
  // `mergeExistingCaps` is decoupled from `isAddStack`: the federated join always
  // unions (so a plain second-network re-join accumulates rather than clobbers,
  // #820), even without a root seed.
  const capsRes = await resolveMergedCapabilities({
    principalId: cfg.principalId,
    registryUrl: url,
    ...(registryPubkey !== undefined && { registryPubkey }),
    announce: capabilities,
    mergeExisting: mergeExistingCaps,
  });
  if (!capsRes.ok) return { ok: false, reason: capsRes.reason };

  const body = await buildRegistrationClaim({
    principalId: cfg.principalId,
    material,
    ...(rootMaterial !== undefined && { rootMaterial }),
    stacks: stacksRes.stacks,
    capabilities: capsRes.capabilities,
    // #825 — CAS token: the updated_at the merge read. The route 409s on a
    // concurrent change so two hosts joining/registering can't lost-update.
    ...(stacksRes.existingUpdatedAt !== undefined && { expectedUpdatedAt: stacksRes.existingUpdatedAt }),
    // ADR-0018 Gap-A/Gap-B (BLOCK-1) — pin the join's PENDING admission row to
    // the target network so an admin `admit` lands the principal in network
    // `networkId`'s `rosterFromAdmissions`. Only the federated `registerStack`
    // passes a `networkId`; the announce/deregister/leave paths omit it.
    ...(networkId !== undefined && { networkId }),
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
      // ADR-0018 Gap-B (BLOCK-1/N3) — roster membership is NO LONGER implicit in
      // the announced capabilities. Under Gap-B a principal is "in" `networkId`
      // iff they hold an ADMITTED admission row for it (`rosterFromAdmissions`);
      // the announced caps are an orthogonal FACET ("what an admitted member
      // offers"), joined on top of membership. So this register does TWO things:
      //   1. names the target network (`networkId` below) so the register hook
      //      raises a network-PINNED PENDING admission row an admin can `admit`
      //      (the actual roster-membership lever); and
      //   2. tags each announced cap with `networks: [networkId]` so that, ONCE
      //      ADMITTED, the member's capability facet surfaces in the roster.
      //
      // #762 history: the pre-#762 code registered with an EMPTY capability list
      // AND no network_id, so the principal never entered the network's roster
      // and a registry-resolved join wrote 0 peers (risking a hand-pin wipe).
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
      // C-820 — UNION the announced caps into the principal's existing set
      // (4th arg `true`), decoupled from the root seed: a plain re-join into a
      // SECOND network must accumulate `networks[]` (metafactory ∪ community),
      // not clobber the prior tag and evict the principal from that roster.
      // ADR-0018 Gap-A/Gap-B (BLOCK-1) — 5th arg `cfg.networkId` pins the join's
      // PENDING admission row to the joined network so `admit` lands it on that
      // network's `rosterFromAdmissions`. WITHOUT this the join writes a
      // network-less (`network_id = null`) row that can NEVER enter the named
      // roster — even after `admit`.
      return registerWithCapabilities(cfg, announced, true, true, cfg.networkId);
    },
    fetchVerified(networkId) {
      // S1's fetchAndCache returns { descriptor, roster } on ok and refreshes
      // the disk cache (DD-10) — exactly the port's contract.
      return client.fetchAndCache(networkId);
    },
    loadCached(networkId) {
      return client.loadCached(networkId);
    },
    async deregisterFromNetwork(networkId) {
      // C-820 (leave symmetry) — remove ONLY `networkId` from each capability's
      // registry `networks[]` (set-difference), re-attesting the reduced set so
      // the principal exits this ONE network's roster while staying in the
      // others. A registry control-plane POST, never a `federated.*` wire
      // envelope (the network name never goes on the bus). Never throws.
      //
      // SKIP cleanly (a `note`, not an error/warning) when the registry can't be
      // signed-to: no registry URL, or no seed to sign the re-attestation. Leave
      // is a LOCAL teardown first; a stack with no configured registry/seed just
      // has no registry roster to exit, so this is a no-op, not a failure.
      if (url === "" || cfg.seedPath === undefined || cfg.seedPath === "") {
        return {
          ok: true,
          note: "no registry url/seed configured — skipped registry cap retag (local leave only)",
        };
      }
      const retag = await resolveCapabilitiesAfterLeave({
        principalId: cfg.principalId,
        registryUrl: url,
        ...(cfg.registryPubkey !== undefined && { registryPubkey: cfg.registryPubkey }),
        networkId,
      });
      if (!retag.ok) return { ok: false, reason: retag.reason };
      if (!retag.present) {
        // No principal record / nothing to retag — a clean no-op.
        return { ok: true, note: "no registry capability record — nothing to retag" };
      }
      // Re-attest the COMPLETE reduced set through the full-overwrite register
      // route. `mergeExistingCaps:false` — we already computed the exact intended
      // set (the union-then-subtract), so we must NOT re-union it back in.
      return registerWithCapabilities(cfg, retag.capabilities, true, false);
    },
  };
}

// =============================================================================
// Leaf-file port — S3 renderer output written to the nats config dir.
// =============================================================================

/**
 * O-3 (cortex#1053 security-review MAJOR) — write `contents` to `path`
 * ATOMICALLY: write a sibling `<path>.tmp` first, then `renameSync` it over the
 * target. `rename(2)` is POSIX-atomic within a filesystem — a reader (here:
 * nats-server on its next launchd/systemd restart) sees EITHER the old bytes OR
 * the complete new bytes, NEVER a partial/truncated file.
 *
 * A plain `writeFileSync` is NOT atomic: a SIGKILL/OOM mid-write truncates the
 * file, and nats-server then reads corrupt HOCON and REFUSES to start → the bus
 * goes DOWN — the exact #794 hazard this slice exists to prevent (and which the
 * snapshot/rollback can't recover, since it runs AFTER the write+restart). The
 * `.tmp` sits beside the target so the rename stays same-filesystem (atomic).
 */
function atomicWriteFileSync(path: string, contents: string): void {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, contents, "utf-8");
  renameSync(tmpPath, path); // POSIX-atomic: old-or-new, never partial.
}

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
      // C-1224 (ADR-0013 Model B): for a secret-auth leaf the secret bytes live
      // INSIDE this file (the `user:secret@host` userinfo of the rendered `url`),
      // so it is a secret-at-rest. Write it 0600 AND re-chmod explicitly — the
      // create `mode` is masked by the process umask, so a permissive umask
      // (e.g. 022 → 0644) would otherwise leave it world-readable. 0600 is the
      // correct floor even for a creds-path-only leaf (defence in depth).
      const leafPath = join(dir, leafIncludeFileName(inputs.descriptor.network_id));
      writeFileSync(leafPath, content, { mode: 0o600 });
      chmodSync(leafPath, 0o600);
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
    convertToOperatorMode(pkg) {
      // O-3 (cortex#1053) — render the SOP §B0.1 operator-mode blocks into the
      // stack's nats config from the leaf package. The DECISION (convert /
      // already / refuse) is a PURE read (identical in live + dry-run); only the
      // WRITE-BACK is gated on `mutate`. An absent/empty config file reads as
      // anonymous (a brand-new stack), so renderOperatorModeBlocks converts it.
      const configPath = expandTilde(cfg.natsConfigPath ?? "");
      const current = existsSync(configPath)
        ? readFileSync(configPath, "utf-8")
        : "";
      const result = renderOperatorModeBlocks(current, pkg);
      // Only a genuine `converted` mutates the on-disk config. `already` is a
      // byte-stable no-op (skip the write); `refuse` writes nothing. Dry-run is
      // inert — it surfaces the decision in the step log without touching disk.
      if (result.status === "converted" && mutate) {
        mkdirSync(dirname(configPath), { recursive: true });
        // Security-review MAJOR (#1058) — ATOMIC write (tmp + rename). A
        // non-atomic writeFileSync truncated by a SIGKILL/OOM mid-write would
        // leave corrupt HOCON that crashes nats-server on its next restart →
        // bus DOWN, with no recovery (the snapshot runs after write+restart).
        atomicWriteFileSync(configPath, result.conf);
      }
      return result;
    },
    credsExist(path) {
      // #821 — pure READ (identical in live + dry-run): does the leaf creds file
      // exist AS A USABLE CREDS FILE? `nats-server -t` never dereferences it, so a
      // missing/empty/wrong-type creds file passes `-t` yet leaves the leaf
      // un-authenticatable. NIT-1 — beyond mere existence we require it to be a
      // regular NON-EMPTY file (a directory or 0-byte file is a dormant trap) and
      // sniff the `-----BEGIN NATS USER JWT-----` marker a real `.creds` carries.
      // The path is tilde-expanded to match how nats-server resolves it.
      const expanded = expandTilde(path);
      if (expanded.length === 0) return false;
      let st;
      try {
        st = statSync(expanded);
      } catch (_err) {
        return false; // ENOENT / unreadable → treat as missing.
      }
      if (!st.isFile() || st.size === 0) return false;
      // Sniff the NATS user-creds marker. A genuine `.creds` from `nsc`/the
      // provisioner carries the decorated JWT+seed block; reject a file that
      // does not (e.g. a stray text file at the conventional path).
      let head: string;
      try {
        head = readFileSync(expanded, "utf-8").slice(0, 512);
      } catch (_err) {
        return false;
      }
      return head.includes("-----BEGIN NATS USER JWT-----");
    },
    snapshotLeafState(networkId) {
      // #821 — capture the per-network include file bytes + WHETHER the base nats
      // config carried the `include` directive, so a failed restart can be rolled
      // back. A READ. We capture the directive PRESENCE (not the whole base
      // config bytes) so restore only ever touches the ONE directive the join
      // adds — never the externally-owned base `local.conf` as a whole.
      const includePath = join(dir, leafIncludeFileName(networkId));
      const configPath = expandTilde(cfg.natsConfigPath ?? "");
      const baseConfig =
        configPath.length > 0 && existsSync(configPath)
          ? readFileSync(configPath, "utf-8")
          : undefined;
      return {
        networkId,
        includeFile: existsSync(includePath)
          ? readFileSync(includePath, "utf-8")
          : undefined,
        // Record only whether the include DIRECTIVE was present pre-join. We do
        // NOT snapshot the whole base-config bytes — see restoreLeafState.
        natsConfig:
          baseConfig !== undefined &&
          leafIncludeDirectivePresentInBaseConfig(baseConfig, networkId)
            ? "directive-present"
            : undefined,
      };
    },
    restoreLeafState(snapshot) {
      // #821 — rollback: return the leaf state to its pre-join shape. Dry-run is
      // inert. NIT (code-review) — restore ONLY the per-network include file +
      // the single `include` DIRECTIVE the join added; NEVER rmSync the whole
      // base `local.conf` (it is the externally-owned `-c` config, #801, and may
      // carry directives this join never touched). We add/remove exactly the
      // directive via the same idempotent helpers join used.
      if (!mutate) return;
      const includePath = join(dir, leafIncludeFileName(snapshot.networkId));
      if (snapshot.includeFile === undefined) {
        // The include file did not exist pre-join — remove what the join wrote.
        rmSync(includePath, { force: true });
      } else {
        mkdirSync(dir, { recursive: true });
        // Security-review MAJOR (#1058) — atomic, same as the base config below:
        // a crash mid-rollback must never leave a truncated include file either.
        atomicWriteFileSync(includePath, snapshot.includeFile);
      }

      // Restore the include DIRECTIVE in the base config to its pre-join presence.
      const configPath = expandTilde(cfg.natsConfigPath ?? "");
      if (configPath.length === 0 || !existsSync(configPath)) return;
      const current = readFileSync(configPath, "utf-8");
      const directiveWasPresent = snapshot.natsConfig === "directive-present";
      const next = directiveWasPresent
        ? ensureLeafInclude(current, snapshot.networkId) // it was there → keep it
        : removeLeafInclude(current, snapshot.networkId); // join added it → drop it
      // Security-review MAJOR (#1058) — ATOMIC write (tmp + rename). The rollback
      // path has the identical non-atomicity hazard: a crash mid-rollback would
      // corrupt the very base config it is trying to restore → bus DOWN.
      if (next !== current) atomicWriteFileSync(configPath, next);
    },
  };
}

/**
 * #821 — does the base nats config already carry the `include
 * "leafnodes-<network>.conf"` directive? Thin wrapper over
 * {@link leafIncludeDirectivePresent} so the snapshot records directive PRESENCE
 * (the only base-config state the join changes) rather than the whole file.
 */
function leafIncludeDirectivePresentInBaseConfig(
  baseConfig: string,
  networkId: string,
): boolean {
  return leafIncludeDirectivePresent(baseConfig, networkId);
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
            `under ${where} — is the stack daemon installed? (arc upgrade cortex)`,
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

/**
 * #821 MAJOR — default health-probe timeout (ms). Bounds the `/healthz` fetch so
 * a hung monitor cannot stall the join. 5s is generous for a loopback probe yet
 * far below any "the CLI is wedged" threshold.
 */
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 5000;

/**
 * #821 MAJOR (code-review) — resolve the nats-server HTTP monitor BASE url the
 * health probe (and leaf-state) should hit. Precedence:
 *   1. explicit `--monitor-url` (cfg.monitorUrl) — highest, the principal's override;
 *   2. DERIVED from the stack's nats config (`http_port`/`monitor_port`/`http`),
 *      so a non-default bus (the community :8224) is probed on its OWN port;
 *   3. the upstream default `:8222`.
 * The config read is best-effort (a missing/unreadable file just falls through).
 */
function resolveMonitorBase(cfg: LivePortsConfig): { url: string; configured: boolean } {
  // #831 — `configured` says whether THIS bus actually declares a monitor
  // (explicit `--monitor-url` or an `http_port`/`monitor` in its nats config),
  // vs falling back to the upstream default `:8222`. The health probe uses it to
  // treat an absent monitor as INCONCLUSIVE rather than a failure.
  if (cfg.monitorUrl !== undefined && cfg.monitorUrl !== "") return { url: cfg.monitorUrl, configured: true };
  const configPath = expandTilde(cfg.natsConfigPath ?? "");
  if (configPath.length > 0 && existsSync(configPath)) {
    const derived = natsConfigMonitorUrl(readFileSync(configPath, "utf-8"));
    if (derived !== undefined) return { url: derived, configured: true };
  }
  return { url: DEFAULT_MONITOR_URL, configured: false };
}

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
    async validateConfig() {
      // #821 MAJOR-1 — cheap pre-restart syntax gate: `nats-server -c <cfg> -t`.
      // Dry-run is inert. The gate is NECESSARY-NOT-SUFFICIENT (a syntax check
      // that does not resolve leaf creds/accounts — it passed for the original
      // crash), so a non-zero exit is a HARD signal the config is broken, while a
      // missing `nats-server` binary is SKIPPED (returns ok) rather than blocking
      // the join on a machine where the test tool isn't installed.
      if (!mutate) return { ok: true };
      const configPath = expandTilde(cfg.natsConfigPath ?? "");
      if (configPath.length === 0) {
        // No config to test — the restart step will surface the real error.
        return { ok: true };
      }
      let result: { code: number; stderr: string };
      try {
        result = await bunExecRunner(["nats-server", "-c", configPath, "-t"]);
      } catch (err) {
        // Spawn failure (e.g. binary not on PATH) → SKIP the gate, don't block.
        process.stderr.write(
          `network join: skipping nats-server -t gate (could not run nats-server: ${err instanceof Error ? err.message : String(err)})\n`,
        );
        return { ok: true };
      }
      if (result.code !== 0) {
        return {
          ok: false,
          reason: `nats-server -c ${configPath} -t exited ${result.code.toString()}: ${result.stderr.trim()}`,
        };
      }
      return { ok: true };
    },
    async isHealthy() {
      // #821 — probe nats-server's HTTP monitor to confirm it actually came back
      // UP after the restart. `launchctl kickstart` / `systemctl restart` can
      // exit 0 even when the server then crashes on the new config at runtime
      // (the community incident). `/healthz` is nats-server's liveness endpoint;
      // a reachable 200 means the process is up and reading its config. A
      // dry-run never restarts, so it is trivially "healthy".
      if (!mutate) return { healthy: true };
      // #821 MAJOR (code-review) — target THIS bus's OWN monitor port. The
      // community bus monitors on :8224, not the upstream-default :8222; probing
      // the wrong port would ECONNREFUSED and false-trip a rollback on a GOOD
      // join. Precedence: explicit --monitor-url wins; else derive the port from
      // the stack's nats config (`http_port`/`monitor_port`/`http`); else the
      // upstream default.
      const monitor = resolveMonitorBase(cfg);
      // #831 — when THIS bus declares no monitor, the liveness probe is
      // INCONCLUSIVE, not a failure. `restart()` already exited 0; without a
      // monitor we cannot confirm liveness, but we MUST NOT roll back a join
      // whose policy + peer were already written (the false-FAIL incident: a
      // single-file `local.conf` with no `http_port` ECONNREFUSED `:8222` and
      // rolled back a good join). Absent monitor → treat as healthy.
      if (!monitor.configured) return { healthy: true };
      const base = monitor.url.replace(/\/+$/, "");
      // #821 MAJOR — BOUND the probe. A monitor that accepts the TCP connection
      // but never responds (hung/deadlocked nats-server — exactly the failure the
      // probe exists to catch) would hang an unbounded `fetch` forever and stall
      // joinNetwork with no verdict. AbortSignal.timeout aborts after the
      // configured budget; a timeout/abort is treated as healthy:false (the
      // restart did NOT bring a responsive bus up).
      const timeoutMs = cfg.healthProbeTimeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
      try {
        const res = await fetch(`${base}/healthz`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          return {
            healthy: false,
            reason: `nats-server monitor ${base}/healthz returned HTTP ${res.status.toString()}`,
          };
        }
        return { healthy: true };
      } catch (err) {
        // A timeout/abort means the monitor accepted but did not respond in time
        // — the bus is hung, NOT healthy. A connection error means it's down or
        // the port isn't listening. Either way the restart did NOT bring a
        // healthy bus up. Distinguish the timeout for an actionable reason.
        const isTimeout =
          err instanceof DOMException && err.name === "TimeoutError";
        return {
          healthy: false,
          reason: isTimeout
            ? `nats-server monitor ${base}/healthz timed out after ${timeoutMs.toString()}ms (accepted the connection but never responded — bus hung)`
            : `nats-server monitor ${base} unreachable: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
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
  // #821 MAJOR (code-review) — use the SAME monitor-base resolution as the health
  // probe (explicit flag → derived-from-config → default), so status reads the
  // bus's OWN monitor port (community :8224) instead of the wrong default :8222.
  const base = resolveMonitorBase(cfg).url.replace(/\/+$/, "");
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
// Cached-network port — C-850, on-disk network-cache descriptors for status.
// =============================================================================

/**
 * C-850 — read the last-known-good network descriptor cache
 * (`~/.config/cortex/network-cache/*.json`, the SAME dir the join writes after a
 * DD-9-verified fetch) so `cortex network status` can surface REGISTERED
 * networks (descriptor cached, not joined by this stack). Read-only: it only
 * ever `list()`s. Membership is read from the cached ROSTER (the verified
 * per-peer list) when present, falling back to the descriptor's lightweight
 * `members[]`. A missing/corrupt cache degrades to `[]` inside {@link NetworkCache.list}.
 */
export function buildCachedNetworkPort(): CachedNetworkPort {
  // The SAME `~/.config/cortex/network-cache/` the registry client writes to
  // (DD-10), so status reads exactly what join cached. Resolve via `expandTilde`
  // (which honours `$HOME`) rather than letting NetworkCache default to
  // `os.homedir()` — the rest of the CLI resolves config paths through
  // expandTilde, and $HOME-honouring is what keeps the read hermetic under the
  // tests' temp-$HOME isolation (os.homedir() would punch through to the real
  // home and leak the developer's live cache into a config-less status run).
  const cache = new NetworkCache({
    cacheDir: expandTilde(join("~", ".config", "cortex", "network-cache")),
  });
  return {
    list() {
      return cache.list().map((record) => {
        const rosterPeers = record.roster.members.map((m) => m.principal_id);
        // Prefer the verified roster's principal ids; fall back to the
        // descriptor's lightweight `members[]` if the roster is empty.
        const peers =
          rosterPeers.length > 0 ? rosterPeers : record.descriptor.members;
        return { networkId: record.descriptor.network_id, peers };
      });
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
    // C-850 — always wire the cached-descriptor enumerator so `status` surfaces
    // REGISTERED networks (descriptor cached, not joined). Read-only; a missing
    // cache dir degrades to no registered rows.
    cachedNetworks: buildCachedNetworkPort(),
    // G1c (#1117, ADR-0013 Model B) — wire the local-side `federated.>`
    // export/import by shelling to `arc nats add-federation-export`. The port
    // is always wired; step (b.4) in joinNetwork uses it only when the bus is
    // operator-mode (leafAccount !== undefined). Dry-run ports set apply=false.
    federationWiring: buildFederationWiringAdapter(),
    // G1c — mirror the mutate flag as `apply` so the wiring step knows whether
    // to actually run arc (apply=true) or just print the plan (apply=false).
    apply: mutate,
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
