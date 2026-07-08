/**
 * `cortex network doctor` — injected-dependency seams (cortex#1484, epic #1479).
 *
 * Mirrors the `network-ping-ports.ts` pattern: the orchestrator
 * (`network-doctor-lib.ts`) is PURE over these ports; the live adapters (in
 * `network-doctor-adapters.ts`) wire the real config file, the local
 * nats-server HTTP monitor, and the `MyelinRuntime` probe bus; tests inject
 * fakes that never touch fs/NATS.
 *
 * `doctor` verifies the WHOLE federation path from the joining member's own
 * machine and reports pass/fail + a fix + the responsible role, PER LEG. It
 * is READ-ONLY except for the ONE bounded probe echo (the SAME probe transport
 * `cortex network ping` uses — see `network-ping-ports.ts`/`network-ping-lib.ts`).
 */

import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
import type { NetworkPingPorts } from "./network-ping-ports";

// =============================================================================
// Config port — read-only `policy.federated.networks[]`
// =============================================================================

/** The composed networks snapshot `doctor` checks against. */
export interface DoctorNetworksSnapshot {
  networks: PolicyFederatedNetwork[];
}

/**
 * Read-only config seam. The LIVE adapter reads the COMPOSED
 * `policy.federated.networks[]` off the already-loaded `LoadedConfig` (the same
 * source `derivePingInputs` uses), so it reflects exactly what the daemon loads
 * — including the config-split layout, where `policy.federated` lives in
 * `stacks/<slug>.yaml` and a raw re-parse of the pointer file would find none.
 * Tests inject a fake snapshot.
 */
export interface DoctorConfigPort {
  /** The composed `policy.federated.networks[]`. Never throws — resolves to
   *  `{ networks: [] }` when the config declares none. */
  readNetworks(): DoctorNetworksSnapshot;
  /**
   * Best-effort EXPECTED federation account for `networkId`, derived from the
   * rendered per-network leaf-include file's `account:` line (operator-mode
   * bus) when one is on disk. `undefined` when not derivable (e.g. a `$G`
   * default-bus leaf carries no `account:` line, or the leaf hasn't been
   * rendered yet) — the leaf-account-bound check degrades to warn/report-only
   * in that case rather than failing. Never throws.
   */
  expectedFedAccount(networkId: string): string | undefined;
  /**
   * cortex#1482 (epic #1479, join-3, Pair 2) — best-effort: does the bus's
   * OWN nats-server config (the SAME file the `natsConfigPath` adapter input
   * points at) declare `accountPubkey` as a `resolver_preload { … }` KEY? A
   * leaf remote binds an account that MUST be preloaded on this bus, or the
   * bus can't authenticate the leaf at boot — this catches the mismatch
   * statically, before it becomes a boot/auth failure. `undefined` when it
   * cannot be determined (no natsConfigPath, file missing, or the config
   * carries NO `resolver_preload { … }` block at all — e.g. a
   * non-operator-mode / hard-isolated bus, where the question doesn't
   * apply). Never throws.
   */
  resolverPreloadHasAccount(accountPubkey: string): boolean | undefined;
  /**
   * cortex#1728 Guard 1 — scan the RESOLVED local nats config (the config file +
   * every file it `include`s) for an operator-mode-FATAL `leafnodes {
   * authorization { users … } }` block. On an operator-mode bus that block
   * crashes nats-server on its NEXT restart ("operator-mode does not allow
   * specifying users in leafnode config"), and `nats-server -t` does NOT catch
   * it — so a `doctor` run is the only pre-restart signal a member gets. Returns
   * the offending file path(s) + removal fix; `[]` when clean or the config is
   * not operator-mode (the block is legal on a $G bus). Never throws — an absent
   * config resolves to `[]`.
   */
  scanLeafnodeAuthorizationBomb(): { path: string; fix: string }[];
}

// =============================================================================
// Monitor port — the local nats-server HTTP monitor `/leafz` surface
// =============================================================================

/** One leaf connection as reported by `/leafz`. */
export interface LeafzEntry {
  account?: string;
  name?: string;
  in_msgs?: number;
  out_msgs?: number;
}

/** The raw `/leafz` response body (only the fields `doctor` inspects). */
export interface LeafzResponse {
  leafs?: LeafzEntry[];
}

/**
 * Read-only local nats-server monitor seam. `resolve()` mirrors
 * `network-adapters.ts`'s `resolveMonitorBase` — same URL precedence
 * (`--monitor-url` → derived from the stack's nats config → the upstream
 * default `:8222`) and the same `configured` flag (the #831 "absent monitor
 * = inconclusive" signal: `configured === false` means this bus declares no
 * monitor at all, vs a genuinely-unreachable one).
 */
export interface MonitorPort {
  /** Resolved monitor base URL + whether a monitor is genuinely CONFIGURED
   *  for this bus (vs the bare upstream-default fallback). */
  resolve(): { url: string; configured: boolean };
  /** Fetch `/leafz`. Returns `undefined` on ANY failure (unreachable,
   *  non-2xx, malformed body, timeout) — never throws. */
  fetchLeafz(): Promise<LeafzResponse | undefined>;
}

// =============================================================================
// The ports bundle
// =============================================================================

export interface NetworkDoctorPorts {
  config: DoctorConfigPort;
  monitor: MonitorPort;
  /**
   * The exact probe-bus port shape `cortex network ping` uses — the SAME
   * transport (not re-implemented) so `doctor`'s peer-reachable leg performs
   * the same real echoed round-trip `ping` does, just orchestrated as one
   * check per configured peer instead of a `ping -c` report.
   */
  probe: NetworkPingPorts;
}
