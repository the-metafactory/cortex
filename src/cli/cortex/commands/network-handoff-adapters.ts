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
 * REMOTE-MEMBER guard (Sage #1501): the `/mine` PoP read can only prove
 * possession of THIS host's OWN signing key, so it always resolves the row for
 * `cfg.principalId` — never a third party's. Reporting our OWN hub-authorize as
 * a REMOTE member's would be a false read (the SAME bug class the leaf-up leg's
 * remote-member guard in `gatherHandoffSignals` already fixes). So when the
 * requested `member` is NOT this host's own principal, the signal is
 * `undefined` (not observable from here) — NOT a read of our own row mislabeled
 * as theirs. `cfg.principalId` IS the `selfPrincipal` the orchestrator passes
 * (both derive from the SAME resolved principal in `runHandoff` / `runJoin`),
 * so the comparison is faithful without threading a second self argument.
 */
export function buildLiveHubAuthPort(cfg: LivePortsConfig): HandoffHubAuthPort {
  const admission = buildAdmissionStatePort(cfg);
  return {
    async resolveHubAuthorized(networkId: string, member: string): Promise<HubAuthorizeResolution> {
      if (member !== cfg.principalId) {
        // A member's hub-authorize marker lives on THEIR admission row, which
        // only THEIR machine can PoP-read. Never report this host's own row as
        // the remote member's — undefined = "not observable from here".
        return {
          confirmed: undefined,
          reason:
            `not observable for member "${member}" from "${cfg.principalId}"'s machine — the hub-authorize ` +
            `marker lives on the member's own admission row, which only their machine can PoP-read. Run ` +
            `this on the member's own machine for an authoritative reading.`,
        };
      }
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
