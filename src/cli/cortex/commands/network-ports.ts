/**
 * S4 (Network Join Control Plane, #738 · epic #733 · spec
 * `docs/design-network-join-control-plane.md` §6 F4) — the injected-dependency
 * seams + the trust-boundary types for `cortex network join/leave/status`.
 *
 * ## Why ports
 *
 * `join` mutates the *live* deployment: it writes a nats-server leaf include
 * file, edits the launchd plist, rewrites a stack's federation config, and
 * restarts a daemon. None of that may run in a test (or accidentally during
 * development — CLAUDE.md / the S4 brief's SAFETY rule). So every side-effect
 * is a port: an interface the orchestrator (`network-lib.ts`) depends on, a
 * REAL adapter the CLI (`network.ts`) wires for production, and a FAKE the
 * tests assert against. The orchestrator itself is pure over its ports.
 *
 * ## The trust boundary — `VerifiedNetworkDescriptor` (S3-review N2)
 *
 * DD-9 requires that only a signature-verified descriptor reaches the leaf
 * renderer. S3 enforced that in PROSE. S4 makes it a TYPE: a
 * {@link VerifiedNetworkDescriptor} is a {@link NetworkDescriptor} branded with
 * a unique symbol that CANNOT be constructed outside this module. The only
 * mint is {@link brandVerified}, which this module calls EXCLUSIVELY from the
 * `NetworkRegistryPort.fetchVerified` success path (an `ok` result off S1's
 * pin+verify client). A descriptor that failed verification is a plain
 * `NetworkDescriptor` and is rejected by `tsc` at the `renderLeafInclude` call
 * site — the trust boundary is compiler-enforced, not reviewer-enforced.
 */

import type {
  NetworkDescriptor,
  NetworkRosterResult,
} from "../../../common/registry/types";
import type { NetworkFetchResult } from "../../../common/registry/network-client";
import type {
  AccountBindCheck,
  LeafBindMode,
  OperatorModeConversion,
  OperatorModeLeafPackage,
  StackLeafBinding,
} from "../../../common/nats/leaf-remote-renderer";
import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";

// =============================================================================
// Trust-boundary type — only a VERIFIED descriptor flows into the renderer.
// =============================================================================

/** Unique brand symbol. Not exported — un-forgeable outside this module. */
declare const VERIFIED_DESCRIPTOR: unique symbol;

/**
 * A {@link NetworkDescriptor} that has passed the DD-9 pin+verify gate. The
 * brand is phantom (zero runtime cost). Because the symbol is module-private,
 * NO caller can write `{ ...descriptor, [VERIFIED_DESCRIPTOR]: true }` — the
 * only way to obtain one is {@link brandVerified}, which this module calls only
 * from a verified-fetch `ok` branch. The leaf renderer entrypoint
 * ({@link RenderLeafInputs}) demands this type, so an UNVERIFIED descriptor is
 * a `tsc` error at the call site.
 */
export type VerifiedNetworkDescriptor = NetworkDescriptor & {
  readonly [VERIFIED_DESCRIPTOR]: true;
};

/**
 * Mint a {@link VerifiedNetworkDescriptor}. INTERNAL to the join orchestration:
 * callable only after a {@link NetworkRegistryPort} returned `status: "ok"`
 * (S1's client only returns `ok` when the response signature verified against
 * the pinned registry pubkey — DD-9). Never call this on a descriptor that has
 * not been through that gate.
 */
export function brandVerified(d: NetworkDescriptor): VerifiedNetworkDescriptor {
  return d as VerifiedNetworkDescriptor;
}

// =============================================================================
// Ports — every side effect the orchestrator depends on.
// =============================================================================

/**
 * The registry control-plane seam (S1). Wraps `NetworkRegistryClient` so the
 * orchestrator never imports the concrete transport. `registerStack` is the
 * idempotent proof-of-possession registration (reuses provision-stack's
 * `register`); `fetchVerified` returns S1's discriminated, pin+verified
 * descriptor+roster pair.
 */
export interface NetworkRegistryPort {
  /**
   * Register this stack's signing pubkey with the registry (idempotent —
   * re-registering the same pubkey converges). Returns a log-safe note on
   * success, or an error reason. DD-4 step (a).
   */
  registerStack(): Promise<{ ok: true; note: string } | { ok: false; reason: string }>;
  /**
   * Pull + pin+verify (DD-9) the descriptor + roster for `networkId`. On `ok`
   * the descriptor is safe to {@link brandVerified}; every other branch aborts
   * the join (or, for `unreachable`, lets the caller try {@link loadCached}).
   */
  fetchVerified(
    networkId: string,
  ): Promise<
    NetworkFetchResult<{ descriptor: NetworkDescriptor; roster: NetworkRosterResult }>
  >;
  /**
   * DD-10 fallback — last-known-good verified descriptor + roster, or
   * `undefined`. Used when `fetchVerified` returns `unreachable` so a join
   * configured during a transient registry outage still uses trusted cached
   * data.
   */
  loadCached(
    networkId: string,
  ): { descriptor: NetworkDescriptor; roster: NetworkRosterResult } | undefined;
  /**
   * C-820 (leave symmetry) — remove `networkId` from each of the principal's
   * registered capabilities' `networks[]` (set-difference) and re-attest the
   * reduced set, so `leave` exits this ONE network's roster while leaving the
   * principal's OTHER network memberships intact (the inverse of `registerStack`'s
   * union). A registry CONTROL-PLANE POST, never a `federated.*` wire envelope.
   * Returns a log-safe note on success, or an error reason. A `note` may also
   * report a clean no-op (no principal record / nothing to retag).
   */
  deregisterFromNetwork(
    networkId: string,
  ): Promise<{ ok: true; note: string } | { ok: false; reason: string }>;
}

/** Inputs to the leaf-include render — the trust boundary in one place. */
export interface RenderLeafInputs {
  /** A descriptor that PASSED DD-9 verification. Plain descriptors rejected. */
  descriptor: VerifiedNetworkDescriptor;
  /** The stack's local leaf binding (creds path + nkey-U account). */
  binding: StackLeafBinding;
}

/**
 * The nats-server leaf-include file seam (S3 renderer output written to disk).
 * `write` renders + persists the per-network include; `remove` deletes it on
 * `leave`; `list` reports which networks currently have an include (used to
 * decide whether to keep the plist `-c` arg).
 */
export interface LeafFilePort {
  /** Render (S3 `renderLeafIncludeFile`) + write the include for the network. */
  write(inputs: RenderLeafInputs): void;
  /** Delete a network's include file (idempotent — absent file is a no-op). */
  remove(networkId: string): void;
  /**
   * Ensure the nats config (`local.conf`) `include`s the network's leaf file
   * (#754 — close the dormant-leaf gap). Mirrors {@link PlistPort.ensureConfigLoaded}:
   * idempotent + byte-stable when the directive is already present. Without
   * this step nats-server loads a config that never references the rendered
   * leaf, so the leaf sits configured-but-dormant. Live adapter reads
   * `natsConfigPath()`, applies S3's `ensureLeafInclude`, and writes it back;
   * the dry-run adapter is inert.
   */
  ensureInclude(networkId: string): void;
  /**
   * Remove the network's `include` directive from the nats config (leave
   * teardown — the inverse of {@link ensureInclude}). Idempotent. Live adapter
   * applies S3's `removeLeafInclude`; dry-run inert.
   */
  removeInclude(networkId: string): void;
  /** Network ids that currently have an include file present. */
  list(): string[];
  /**
   * Absolute path to the nats-server config the plist should load (`-c`). This
   * is the config that `include`s the per-network leaf files; the leaf port
   * owns where it lives so the plist port can be told which path to ensure.
   */
  natsConfigPath(): string;
  /**
   * #794 — pre-flight: can the stack's nats config (`natsConfigPath()`) BIND a
   * leaf to `account` (nkey-U) without crashing nats-server? An anonymous /
   * hard-isolated bus (no operator-mode account tree) does NOT define the
   * account, so rendering a leaf that binds it makes nats-server crash on
   * startup (`cannot find local account "<A…>"`), taking the bus down. The
   * orchestrator calls this BEFORE any mutation and REFUSES the join when the
   * config can't bind — a READ, so live + dry-run behave identically. Delegates
   * to {@link natsConfigCanBindAccount}; an absent config file → cannot bind.
   */
  canBindAccount(account: string): AccountBindCheck;
  /**
   * #799 — choose the leaf-remote BIND MODE for the stack's nats config:
   *   - `operator-account` — operator-mode bus that defines the account →
   *     render an `account:`-bound remote (the #794-safe path).
   *   - `creds-only` — `$G`/default bus WITH creds → render a NO-account remote;
   *     the creds JWT binds it (the case #794 wrongly refused).
   *   - `refuse` — no creds (can't authenticate to the hub), or an operator-mode
   *     bus that doesn't define the account (would crash nats-server).
   *
   * Delegates to {@link resolveLeafBindMode}. The orchestrator calls this BEFORE
   * any mutation (a READ — identical in live + dry-run) and either renders the
   * chosen remote or refuses. `hasCreds` is judged from the stack's resolved
   * creds path; `account` is the candidate nkey-U (or `undefined`).
   */
  resolveBindMode(account: string | undefined, hasCreds: boolean): LeafBindMode;
  /**
   * O-3 (cortex#1053) — CONVERT an anonymous/hard-isolated bus to operator-mode
   * by rendering the SOP §B0.1 operator-mode blocks (operator JWT +
   * system_account + `resolver: MEMORY` + `resolver_preload`) from a leaf
   * package, KEEPING the stack's own identity/ports/JS domain and adding NO leaf
   * include (the join renders its own). Replaces the #794 "fail-fast and tell a
   * human to hand-edit `<slug>.conf`" with a one-command conversion.
   *
   *   - `converted` — the bus was anonymous; the live adapter WROTE the rendered
   *     operator-mode config back to `natsConfigPath()` (dry-run is inert).
   *   - `already` — the bus was already operator-mode under THIS package's
   *     operator JWT; a byte-stable no-op (no write).
   *   - `refuse` — material absent/malformed (the preserved #794 fail-fast), OR
   *     the bus is already operator-mode under a DIFFERENT operator (never
   *     clobber it).
   *
   * Delegates the rendering to {@link renderOperatorModeBlocks} (pure). The
   * orchestrator calls this ONLY when `resolveBindMode` would refuse an anonymous
   * bus AND a leaf package is present, then re-resolves the (now operator-mode)
   * bus. An absent config file reads as anonymous (a brand-new stack).
   */
  convertToOperatorMode(pkg: OperatorModeLeafPackage): OperatorModeConversion;
  /**
   * #821 — pre-flight: does the leaf `.creds` file at `path` actually EXIST on
   * disk? `nats-server -c <cfg> -t` only validates HOCON syntax — it does NOT
   * dereference a leaf remote's `credentials` path, so a remote pointing at a
   * NON-EXISTENT creds file passes `-t` yet makes nats-server fail at runtime
   * (the leaf can never authenticate). The community incident pointed at
   * `~/.config/nats/metafactory-community.creds`, which did not exist. The
   * orchestrator calls this BEFORE writing the include + restarting, and REFUSES
   * when the creds file is missing — a READ, identical in live + dry-run.
   */
  credsExist(path: string): boolean;
  /**
   * #821 — restart-safety SNAPSHOT. Capture the current on-disk leaf state for
   * `networkId` (the per-network include file + the base nats config's `include`
   * directive presence) so a failed nats-server restart can be ROLLED BACK to
   * the prior working bytes via {@link restoreLeafState}. Returned as an opaque
   * token. A READ — taken BEFORE the join mutates anything.
   */
  snapshotLeafState(networkId: string): LeafStateSnapshot;
  /**
   * #821 — restart-safety ROLLBACK. Restore the leaf state captured by
   * {@link snapshotLeafState}: rewrite (or delete) the per-network include file
   * and the base config's `include` directive to exactly the snapshot's bytes.
   * Called ONLY when a nats-server restart left the bus down, so the next
   * restart brings the bus back to its prior working state. Idempotent.
   */
  restoreLeafState(snapshot: LeafStateSnapshot): void;
}

/**
 * #821 — opaque rollback token for {@link LeafFilePort.snapshotLeafState} /
 * {@link LeafFilePort.restoreLeafState}. Captures whether the per-network leaf
 * include file existed (+ its bytes) and whether the base nats config carried
 * the `include` directive (+ its full bytes), so a failed restart can be
 * reverted to exactly the pre-join state.
 */
export interface LeafStateSnapshot {
  networkId: string;
  /** The per-network include file's prior contents, or `undefined` if absent. */
  includeFile: string | undefined;
  /** The base nats config's prior contents, or `undefined` if the file was absent. */
  natsConfig: string | undefined;
}

/**
 * The launchd plist seam (S3 `ensureConfigArg`/`renderProgramArguments`).
 * `ensureConfigLoaded` rewrites the nats-server plist so it loads `configPath`
 * (closing the configured-but-dormant trap, DD-6).
 *
 * #801 — `leave` NO LONGER calls `dropConfigArg`. The `-c <config>` arg names
 * the BASE nats-server config (`local.conf`); the per-network leaf remotes are
 * `include`d INTO it. Stripping the base `-c` on leave left nats-server with no
 * config to load → unstartable. The base `-c` is owned by stack provisioning,
 * never by join/leave. `dropConfigArg` stays on the port for provisioning-side
 * teardown (the inverse of `ensureConfigLoaded`), but the leave flow does not
 * use it.
 */
export interface PlistPort {
  /** Ensure the nats-server plist loads `configPath` via `-c`. Idempotent. */
  ensureConfigLoaded(configPath: string): void;
  /**
   * Remove the `-c <configPath>` arg from the plist. NOT used by `leave` (#801)
   * — retained for provisioning-side teardown (the inverse of
   * {@link PlistPort.ensureConfigLoaded}).
   */
  dropConfigArg(configPath: string): void;
}

/**
 * The stack-federation-config seam — reads + writes `policy.federated.
 * networks[]` for a stack (the config-split `stacks/<stack>.yaml`, DD-5). The
 * orchestrator computes the new networks array; this port persists it.
 */
export interface ConfigStorePort {
  /** Current `policy.federated.networks[]` for the stack (empty if none). */
  readNetworks(): PolicyFederatedNetwork[];
  /** Persist the full `policy.federated.networks[]` for the stack. */
  writeNetworks(networks: PolicyFederatedNetwork[]): void;
}

/**
 * The daemon-restart seam — `launchctl kickstart` of the stack's CORTEX daemon
 * so it reconnects after the leaf config takes effect. Injected so tests
 * assert the restart was requested without touching launchctl.
 */
export interface DaemonPort {
  /** Restart the stack (cortex) daemon so it reconnects to the bus. */
  restart(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * The nats-server-restart seam (#757). `join` mutates `local.conf` (the leaf
 * include + the `include` directive) and ensures the plist loads it — but
 * nats-server, the process that actually READS `local.conf`, must be restarted
 * for the leaf to take effect. Without this the leaf change stays dormant until
 * a manual `launchctl kickstart` of nats-server (the #757 trap, sibling of the
 * #754 dormant-include trap).
 *
 * The live adapter restarts the launchd service named by the join's `--plist`
 * (the **nats-server** plist, read from its `<key>Label</key>`); the dry-run
 * adapter is inert. The orchestrator calls this BEFORE {@link DaemonPort.restart}
 * so the bus carries the leaf before cortex reconnects.
 */
export interface NatsServerPort {
  /** Restart nats-server so it reloads `local.conf` (the new leaf include). */
  restart(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * #821 MAJOR-1 — a cheap PRE-RESTART config-syntax gate: run `nats-server -c
   * <cfg> -t` (the upstream config-test flag) so an obviously-broken config is
   * caught BEFORE the restart that would otherwise crash the bus. NOTE: `-t` is
   * a SYNTAX check — it does NOT dereference leaf creds paths or resolve a
   * leaf-remote's account against the account tree, so it PASSED for the original
   * #821 crash. It is therefore NECESSARY-NOT-SUFFICIENT: a cheap extra gate
   * layered ON TOP of the account-required + creds-exist + health-probe defenses,
   * never the primary defense. A dry-run is inert (returns ok). When `nats-server`
   * is not on PATH the gate is SKIPPED (returns ok) rather than blocking the join.
   */
  validateConfig(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * #821 — restart-safety HEALTH PROBE. After a restart, confirm nats-server
   * actually came back UP (its monitor port is listening / the process is
   * healthy). `launchctl kickstart` / `systemctl restart` can exit 0 even when
   * the server then crashes on the new config at runtime (the community
   * incident: the restart "succeeded" but nats-server exited 1 on the bad leaf,
   * leaving the bus DOWN). The orchestrator probes AFTER the restart; an
   * unhealthy result triggers a snapshot rollback + re-restart. Returns
   * `{ healthy: true }` when the server is reachable, else a reason.
   *
   * #821 NIT-2 (follow-up) — `/healthz` is a LIVENESS probe: it confirms the
   * server process is up, but cannot distinguish "up, and the leaf connected"
   * from "up, but the leaf remote was rejected". A stronger JOIN-verification
   * would additionally poll `/leafz` for the expected remote (the C-797
   * leaf-state surface). Tracked as a follow-up; liveness is sufficient to catch
   * the #821 crash (a crashed server fails `/healthz`).
   */
  isHealthy(): Promise<{ healthy: true } | { healthy: false; reason: string }>;
}

/**
 * Read-only leaf-link telemetry for `status` (the nats-server monitor `/leafz`
 * surface, when available). Optional — `status` degrades gracefully to "link
 * state unknown" when no provider is wired (S4 keeps this injected; the live
 * monitor client is out of S4 scope).
 */
export interface LeafStatePort {
  /**
   * Leaf link state + in/out counters, keyed by the leaf-node (remote) name as
   * reported by `/leafz`. `networkStatus` joins these against each network's
   * `leaf_node` (C-797), falling back to the network id and then "unknown".
   */
  linkStates(): Promise<Record<string, LeafLinkState>>;
}

/**
 * C-850 — read-only enumerator of last-known-good CACHED network descriptors
 * (`~/.config/cortex/network-cache/*.json`, written by S1 after a DD-9-verified
 * fetch). `networkStatus` merges these with the config-joined networks so a
 * network that is REGISTERED (its descriptor is cached) but not joined by THIS
 * stack — or joined with its leaf down — is surfaced with a lifecycle status
 * instead of being invisible (the #850 `metafactory-community` symptom).
 *
 * Optional on {@link NetworkPorts} (mirrors {@link LeafStatePort}): absent →
 * `status` reports config-joined networks only (the pre-C-850 behaviour). The
 * live adapter reads the on-disk cache dir; tests inject a fake list.
 */
export interface CachedNetworkPort {
  /**
   * Every cached network, narrowed to the fields a `registered` status row
   * renders. READ-ONLY — never writes or mutates the cache. Degrades to `[]`
   * when the cache dir is absent/unreadable (never throws).
   */
  list(): CachedNetworkSummary[];
}

/**
 * C-850 — one cached network descriptor, narrowed to what a `registered` row
 * surfaces. A registered network is not in this stack's config, so it has no
 * stack-local leaf-node / accept-subjects / max-hop; `networkStatus` fills
 * those with defaults and reads membership from here.
 */
export interface CachedNetworkSummary {
  /** The cached descriptor's `network_id`. */
  networkId: string;
  /** Known member principal ids (from the cached roster / descriptor members). */
  peers: string[];
}

/** One network's leaf link state for `status`. */
export interface LeafLinkState {
  /** ESTABLISHED / connecting / down / unknown. */
  state: "established" | "connecting" | "down" | "unknown";
  /** Messages received over the leaf since connect. */
  inMsgs?: number;
  /** Messages sent over the leaf since connect. */
  outMsgs?: number;
}

/**
 * G1c (#1117, ADR-0013 Model B) — the federation-wiring seam.
 *
 * Shells out to `arc nats add-federation-export` (arc#243 / G1b) to wire
 * the LOCAL-SIDE `federated.>` export/import between the stack's federation
 * account (leaf-bound) and its agents account. Called at step (b.4) in
 * `joinNetwork` — after bind-mode resolution (so the leaf account is known),
 * before the leaf file write (fail-fast before any mutation on arc failure).
 *
 * cortex NEVER calls nsc directly (ADR-0013 Model B invariant).
 * cortex NEVER passes a peer account (local-only wiring).
 */
export interface FederationWiringPort {
  /**
   * Wire the local-side `federated.>` export/import.
   *
   * @param params.federationAccount - The leaf-bound NSC account (nkey-A) —
   *   `stack.nats_infra.account`, resolved from `JoiningStack.account`.
   *   This is the `--from-account` for the arc primitive.
   * @param params.agentsAccount - The agents NSC account where the
   *   dispatch-listener subscribes (`--to-account`). Optional today: when
   *   absent (the current single-account config), falls back to
   *   `federationAccount` (same-account path — no cross-account routing
   *   needed). A dedicated `agents_account` config field is tracked as G1d
   *   (cortex#1117 follow-up).
   * @param params.apply - Mirror the join's dry-run/--apply flag. `false`
   *   (dry-run) → arc prints the plan, no nsc mutation. `true` → arc runs.
   *
   * @returns `{ ok: true, note }` on success (idempotent — already-present
   *   export+import is also `ok`). `{ ok: false, reason }` on arc failure or
   *   spawn error. NEVER throws.
   */
  wireLocalFederation(params: {
    federationAccount: string;
    agentsAccount: string | undefined;
    apply: boolean;
  }): Promise<{ ok: true; note?: string } | { ok: false; reason: string }>;
}

/** The full port bundle the orchestrator depends on. */
export interface NetworkPorts {
  registry: NetworkRegistryPort;
  leafFile: LeafFilePort;
  plist: PlistPort;
  configStore: ConfigStorePort;
  daemon: DaemonPort;
  /**
   * Restart nats-server so it reloads `local.conf` (#757). Optional so `leave`
   * / `status` and any caller that does not mutate the leaf can omit it; `join`
   * calls it when present. Absent → the nats-server restart step is skipped
   * (the pre-#757 behavior, kept for callers that don't supply it).
   */
  natsServer?: NatsServerPort;
  /** Optional — status link telemetry. Absent → link state "unknown". */
  leafState?: LeafStatePort;
  /**
   * C-850 — optional cached-descriptor enumerator for `status`. Absent →
   * `status` reports config-joined networks only (pre-C-850). Present →
   * `networkStatus` merges cached (REGISTERED) networks with the config-joined
   * set so registered-but-not-joined networks are no longer invisible.
   */
  cachedNetworks?: CachedNetworkPort;
  /**
   * G1c (#1117, ADR-0013 Model B) — federation-wiring seam. Optional for
   * backwards compatibility: when absent the wiring step is skipped (the
   * pre-G1c behaviour — the join still configures the leaf but does NOT wire
   * the local-side `federated.>` export/import). Present → step (b.4) runs
   * before the leaf write.
   */
  federationWiring?: FederationWiringPort;
  /**
   * G1c (#1117) — mirrors the `--apply` flag from the CLI. The wiring step
   * passes this to `FederationWiringPort.wireLocalFederation` so the arc
   * primitive runs in dry-run or apply mode consistently with the rest of the
   * join. Default: `false` (dry-run safe). Live ports set this to `true`.
   */
  apply?: boolean;
}
