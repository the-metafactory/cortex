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
import type { StackLeafBinding } from "../../../common/nats/leaf-remote-renderer";
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
  /** Network ids that currently have an include file present. */
  list(): string[];
  /**
   * Absolute path to the nats-server config the plist should load (`-c`). This
   * is the config that `include`s the per-network leaf files; the leaf port
   * owns where it lives so the plist port can be told which path to ensure.
   */
  natsConfigPath(): string;
}

/**
 * The launchd plist seam (S3 `ensureConfigArg`/`renderProgramArguments`).
 * `ensureConfigLoaded` rewrites the nats-server plist so it loads
 * `configPath` (closing the configured-but-dormant trap, DD-6);
 * `dropConfigArg` reverts to a bare invocation when no networks remain.
 */
export interface PlistPort {
  /** Ensure the nats-server plist loads `configPath` via `-c`. Idempotent. */
  ensureConfigLoaded(configPath: string): void;
  /** Remove the `-c <configPath>` arg from the plist (leave teardown). */
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
 * The daemon-restart seam — `launchctl kickstart` of the stack's nats-server
 * (and/or cortex) so the rendered config takes effect. Injected so tests
 * assert the restart was requested without touching launchctl.
 */
export interface DaemonPort {
  /** Restart the stack daemon so the new leaf config is loaded. */
  restart(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * Read-only leaf-link telemetry for `status` (the nats-server monitor `/leafz`
 * surface, when available). Optional — `status` degrades gracefully to "link
 * state unknown" when no provider is wired (S4 keeps this injected; the live
 * monitor client is out of S4 scope).
 */
export interface LeafStatePort {
  /** Per-network leaf link state + in/out counters, keyed by network id. */
  linkStates(): Promise<Record<string, LeafLinkState>>;
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

/** The full port bundle the orchestrator depends on. */
export interface NetworkPorts {
  registry: NetworkRegistryPort;
  leafFile: LeafFilePort;
  plist: PlistPort;
  configStore: ConfigStorePort;
  daemon: DaemonPort;
  /** Optional — status link telemetry. Absent → link state "unknown". */
  leafState?: LeafStatePort;
}
