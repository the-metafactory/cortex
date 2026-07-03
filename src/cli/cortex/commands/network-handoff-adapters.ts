/**
 * `cortex network handoff` — LIVE adapters (cortex#1485, epic #1479, join-6).
 *
 * Wires the three leg signals the pure orchestrator (`network-handoff-lib.ts`)
 * depends on. Two are REUSED wholesale (no reimplementation):
 *   - the seal leg's `admission` port is `buildAdmissionStatePort` from
 *     `network-adapters.ts` (the SAME member PoP `/mine` read `status` uses).
 *   - the leaf-up leg's `config` + `monitor` ports are `buildDoctorConfigPort`
 *     + `buildMonitorPort` from `network-doctor-adapters.ts` (the SAME
 *     `readNetworks()` + `/leafz` reads `doctor` uses).
 *
 * The one adapter that is genuinely local to this module is the hub-authorize
 * leg — and it is a DOCUMENTED STUB. See {@link buildStubHubAuthPort}.
 */

import type { LivePortsConfig } from "./network-adapters";
import { buildAdmissionStatePort } from "./network-adapters";
import { buildDoctorConfigPort, buildMonitorPort } from "./network-doctor-adapters";
import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
import type {
  HandoffHubAuthPort,
  HubAuthorizeResolution,
  NetworkHandoffPorts,
} from "./network-handoff-ports";

/**
 * The hub-authorize leg adapter — a DOCUMENTED STUB (cortex#1485).
 *
 * `resolveHubAuthorized` ALWAYS returns `confirmed: undefined`, because there
 * is NO signal a member's machine can read to confirm the hub owner applied
 * the authorization:
 *   - The member has no hub-side visibility at all (the cortex#1481 constraint
 *     that made `admit`/`secret` grow a seal-only path in the first place).
 *   - The registry's admission row carries only an OPAQUE ciphertext sealed to
 *     the member's OWN pubkey (ADR-0018 Q1) — there is nothing on it that says
 *     "the hub owner has authorized this member". This is the SAME gap
 *     `cortex network doctor`'s Pair 3 leg (`sealed-secret-hub-authorized`,
 *     cortex#1482) already documents and always `skip`s.
 *   - A successful leaf connection is NOT a usable signal here — leaf-up is
 *     precisely the thing this handoff GATES on hub-authorize, so inferring
 *     hub-authorize from it would be circular.
 *
 * The clean fix — and the counterpart WRITE this stub is designed to read the
 * moment it exists — is an EXPLICIT per-member marker on the registry
 * admission row (a `hub_authorized_at` timestamp / boolean) that the hub owner
 * STAMPS when they apply the authorization. That is a real change to the
 * registry's `admission_requests` SQL table (`src/services/network-registry/
 * src/{types,store}.ts`) plus a hub-owner-side action (most naturally a flag on
 * the existing `secret add-member` / `admit` seal path), so it is out of scope
 * for THIS slice — tracked as a follow-up. The pure state model
 * ({@link import("./network-handoff-lib").deriveHandoffState}) already types
 * this signal `boolean | undefined` and treats `undefined` as fail-closed
 * (NOT done), so the moment a live `hub_authorized_at` read is wired here,
 * nothing in the state model or the leaf-up guard changes.
 */
export function buildStubHubAuthPort(): HandoffHubAuthPort {
  return {
    resolveHubAuthorized(_networkId: string, _member: string): Promise<HubAuthorizeResolution> {
      return Promise.resolve({
        confirmed: undefined,
        reason:
          "cannot be confirmed from the member side — the registry admission row carries no hub-owner " +
          "authorization marker today (documented stub; needs a `hub_authorized_at`-style field the hub " +
          "owner stamps on the seal path — follow-up). Treated as NOT done, fail-closed.",
      });
    },
  };
}

/**
 * Build the live handoff ports bundle from the resolved {@link LivePortsConfig}
 * + the composed `policy.federated.networks[]` (read off the already-loaded
 * config, NOT re-parsed — the config-split #814 concern). Read-only: every
 * port here only reads (admission `/mine`, `/leafz`, config); none mutate.
 */
export function buildLiveHandoffPorts(
  cfg: LivePortsConfig,
  networks: PolicyFederatedNetwork[],
): NetworkHandoffPorts {
  return {
    admission: buildAdmissionStatePort(cfg),
    hubAuth: buildStubHubAuthPort(),
    config: buildDoctorConfigPort({
      networks,
      ...(cfg.natsConfigPath !== undefined && { natsConfigPath: cfg.natsConfigPath }),
    }),
    monitor: buildMonitorPort(cfg),
  };
}
