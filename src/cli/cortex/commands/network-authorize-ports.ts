/**
 * cortex#1498 (epic #1479 follow-up) — `cortex network authorize` injected-
 * dependency seams.
 *
 * Mirrors the `network-secret-ports.ts` pattern: the orchestrator
 * (`network-authorize-lib.ts`) is PURE over these ports; the live adapter
 * (`network-authorize-adapters.ts`) wires the real admin-signed admission
 * lookup + the hub-admin-signed authorize POST; tests inject fakes that never
 * touch HTTP.
 *
 * This command is the registry-side write half of the #1481 hub-owner
 * artifact hand-off: the CLI already renders the EXACT `leafnodes {}` snippet
 * the hub owner adds to their OWN nats-server config
 * (`renderHubOwnerArtifact`, `network-secret-lib.ts`); `cortex network
 * authorize` is the step they run AFTER applying it, stamping the registry's
 * `hub_authorized_at` (cortex#1498) so a member's `join --guided` / `handoff
 * status` sees a real signal instead of the honor-system
 * `--hub-authorized-confirmed` attestation.
 */

import type { AdmissionLookupPort } from "./network-secret-ports";

// The admission-row lookup is the IDENTICAL shape `network-secret-ports.ts`
// already defines (find the ADMITTED row for a network+member) — reused
// directly rather than redeclared.
export type { AdmissionLookupPort };

/** POST the hub-admin-signed authorize claim onto the ADMITTED row. HUB-ADMIN authority (ADR-0018 Q5). */
export interface HubAuthorizeDeliveryPort {
  /** Stamp `hub_authorized_at` on the row (idempotent server-side re-stamp on a re-run). */
  postAuthorize(requestId: string): Promise<void>;
}

/** The full port bundle the orchestrator depends on. */
export interface NetworkAuthorizePorts {
  admission: AdmissionLookupPort;
  delivery: HubAuthorizeDeliveryPort;
}
