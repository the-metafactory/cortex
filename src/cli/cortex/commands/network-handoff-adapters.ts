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
 * The hub-authorize leg ({@link buildLiveHubAuthPort}) is the ONE port
 * genuinely local to this module — it now reads the REAL `hub_authorized_at`
 * registry marker (cortex#1498), via the SAME `buildAdmissionStatePort` `/mine`
 * read the seal leg uses (one registry round trip serves both legs).
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
 * The hub-authorize leg adapter — a DOCUMENTED STUB (cortex#1485), retained
 * only as the documented fallback shape / for tests that want an
 * always-undefined port. Production wires {@link buildLiveHubAuthPort}
 * instead (cortex#1498).
 *
 * `resolveHubAuthorized` ALWAYS returns `confirmed: undefined` — this was the
 * ONLY possible answer before the registry grew a `hub_authorized_at` marker:
 * the member has no hub-side visibility (cortex#1481) and the admission row
 * carried only an opaque sealed-secret ciphertext (ADR-0018 Q1), nothing that
 * said "the hub owner authorized this member".
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
 * cortex#1498 (epic #1479 follow-up) — the LIVE hub-authorize leg adapter.
 *
 * Reads the member's own admission row via the SAME `/mine` PoP-read path the
 * seal leg uses ({@link import("./network-adapters").buildAdmissionStatePort}
 * — `OwnAdmissionState.hubAuthorizedAt`, populated from the registry's
 * `hub_authorized_at` column). This makes the signal a REAL `boolean`:
 *   - `confirmed: true`  — the row carries a `hub_authorized_at` stamp (the
 *     hub owner ran `cortex network authorize`).
 *   - `confirmed: false` — the row exists (or doesn't) but carries NO stamp —
 *     a real "not yet authorized", per the module doc's hub-authorize
 *     semantics (a real `false`, `--hub-authorized-confirmed` cannot override
 *     it — see `network-handoff-lib.ts`'s `hubAuthorizeDone`).
 *   - `confirmed: undefined` — ONLY when the admission read itself failed
 *     (registry unreachable, no seed/registry-url configured) — the
 *     documented fallback for "cannot auto-verify from here", same as the
 *     pre-#1498 stub, so `--hub-authorized-confirmed` still has a real job in
 *     a degraded-connectivity case.
 *
 * `member` is UNUSED here — same limitation `buildAdmissionStatePort`'s seal
 * leg already has: the `/mine` PoP read can only prove possession of THIS
 * host's own signing key, so it can only ever answer "is MY OWN row
 * authorized", never a third party's. `handoff status <member>` is only
 * authoritative when `member` is the principal running the command (mirrors
 * the leaf-up leg's own local-only caveat in `gatherHandoffSignals`).
 */
export function buildLiveHubAuthPort(cfg: LivePortsConfig): HandoffHubAuthPort {
  const admission = buildAdmissionStatePort(cfg);
  return {
    async resolveHubAuthorized(networkId: string, _member: string): Promise<HubAuthorizeResolution> {
      const res = await admission.resolve(networkId);
      if (!res.ok) {
        return {
          confirmed: undefined,
          reason: `cannot read the hub-authorize marker from the registry — ${res.reason}`,
        };
      }
      if (res.state.hubAuthorizedAt !== undefined) {
        return { confirmed: true };
      }
      return {
        confirmed: false,
        reason:
          "the registry admission row carries no hub_authorized_at marker yet — the hub owner has not " +
          "run `cortex network authorize` for this member",
      };
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
    hubAuth: buildLiveHubAuthPort(cfg),
    config: buildDoctorConfigPort({
      networks,
      ...(cfg.natsConfigPath !== undefined && { natsConfigPath: cfg.natsConfigPath }),
    }),
    monitor: buildMonitorPort(cfg),
  };
}
