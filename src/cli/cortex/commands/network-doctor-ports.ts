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
 * is READ-ONLY except for the ONE bounded probe echo (reused verbatim from
 * `cortex network ping` — see `network-ping-ports.ts`/`network-ping-lib.ts`).
 */

import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
import type { NetworkPingPorts } from "./network-ping-ports";

// =============================================================================
// Config port — read-only `policy.federated.networks[]`
// =============================================================================

/** The raw on-disk networks snapshot `doctor` checks against. */
export interface DoctorNetworksSnapshot {
  networks: PolicyFederatedNetwork[];
}

/**
 * Read-only config seam. The LIVE adapter reads straight off the resolved
 * stack config file (the same `readNetworksFromConfig` pattern
 * join/leave/rotate-key use), NOT a cached/derived view — so `doctor` reports
 * against exactly what the daemon would load. Tests inject a fake snapshot.
 */
export interface DoctorConfigPort {
  /** `policy.federated.networks[]`, raw off disk. Never throws — an unreadable
   *  or absent config file resolves to `{ networks: [] }` (mirrors
   *  `readNetworksFromConfig`'s own empty-on-absent behaviour). */
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
   * The exact probe-bus port shape `cortex network ping` uses — reused
   * verbatim (not re-implemented) so `doctor`'s peer-reachable leg is the
   * SAME real echoed round-trip `ping` performs, just orchestrated as one
   * check per configured peer instead of a `ping -c` report.
   */
  probe: NetworkPingPorts;
}
