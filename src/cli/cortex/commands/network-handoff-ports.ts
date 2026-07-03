/**
 * `cortex network handoff` — injected-dependency seams (cortex#1485, epic #1479, join-6).
 *
 * Mirrors the `network-doctor-ports.ts` pattern: the orchestrator
 * (`network-handoff-lib.ts`'s `runHandoffStatus`) is PURE over these ports;
 * the live adapters (`network-handoff-adapters.ts`) wire the real admission
 * registry read, the local nats-server monitor, and the documented hub-
 * authorize stub; tests inject fakes that never touch fs/HTTP.
 *
 * Two of the three ports are NOT new interfaces — they're reused directly:
 *   - `admission` is the SAME {@link AdmissionStatePort} `cortex network
 *     status`'s C-1350 admission lookup already defines (`network-ports.ts`).
 *   - `monitor` is the SAME {@link MonitorPort} `cortex network doctor`
 *     (#1484) already defines (`network-doctor-ports.ts`).
 * Only `hubAuth` (the documented-stub leg) and the read-only `config`
 * projection are new to this module.
 */

import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
import type { AdmissionStatePort } from "./network-ports";
import type { MonitorPort } from "./network-doctor-ports";

/** Read-only `policy.federated.networks[]` seam — the subset `handoff` needs
 *  from {@link import("./network-doctor-ports").DoctorConfigPort}. */
export interface HandoffConfigPort {
  /** Never throws — resolves to `{ networks: [] }` when the config declares none. */
  readNetworks(): { networks: PolicyFederatedNetwork[] };
}

/**
 * The hub-authorize leg's resolution. `confirmed: undefined` is the
 * DOCUMENTED-STUB state (see `network-handoff-lib.ts` module doc +
 * `network-handoff-adapters.ts`) — always what the live adapter returns
 * today, since no hub-owner-side marker exists yet on the registry row.
 * `reason` is present whenever `confirmed !== true`, explaining WHY (either
 * "not yet confirmed" or "cannot be determined — documented stub").
 */
export interface HubAuthorizeResolution {
  confirmed: boolean | undefined;
  reason?: string;
}

export interface HandoffHubAuthPort {
  /** Resolve the hub-authorize leg for `member` on `networkId`. Never throws. */
  resolveHubAuthorized(networkId: string, member: string): Promise<HubAuthorizeResolution>;
}

/** The full port bundle {@link import("./network-handoff-lib").runHandoffStatus} depends on. */
export interface NetworkHandoffPorts {
  /** seal leg — reused `AdmissionStatePort` (the member's own PoP `/mine` read). */
  admission: AdmissionStatePort;
  /** hub-authorize leg — documented stub today (see module doc). */
  hubAuth: HandoffHubAuthPort;
  /** leaf-up leg (network lookup half) — reused `readNetworks()` shape. */
  config: HandoffConfigPort;
  /** leaf-up leg (`/leafz` half) — reused `MonitorPort` from `doctor`. */
  monitor: MonitorPort;
}
