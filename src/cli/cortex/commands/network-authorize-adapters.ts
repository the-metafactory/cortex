/**
 * cortex#1498 (epic #1479 follow-up) — LIVE adapters for `cortex network authorize`.
 *
 * Two real side effects the orchestrator (`network-authorize-lib.ts`) depends on:
 *   - the admin-signed admission-row LOOKUP (find the member's ADMITTED row) —
 *     the SAME `GET /admission-requests?status=ADMITTED` + filter shape
 *     `network-secret-adapters.ts`'s lookup uses (hub-admin authority collapses
 *     with the registry-admin read allowlist for the common single-principal
 *     deployment — see the same NOTE there).
 *   - the hub-admin-signed authorize POST — stamps `hub_authorized_at` onto
 *     the row (cortex#1498). Mints nothing; no local fs/nats-config write at
 *     all (unlike `network secret`, `authorize` never touches the hub-local
 *     nats-server config — it is a registry-only write).
 *
 * AUTHORITY COUPLING (v1 design choice — governance question, flagged not
 * resolved): stamping `hub_authorized_at` currently requires the SAME
 * hub-admin authority (`REGISTRY_HUB_ADMIN_PUBKEYS`, falling back to
 * `REGISTRY_ADMIN_PUBKEYS`) that attaches the sealed secret — the authorize
 * route reuses the sealed-secret route's `verifyHubAdminWrite` gate verbatim
 * (ADR-0018 Q5). Whether the HUB OWNER — the person who actually applies the
 * leaf `authorization` on their own VM — should be a DISTINCT authority from
 * the registry/network admin (rather than collapsed into the hub-admin
 * allowlist) is a governance question for the team (Andreas), not settled
 * here. The `#1481` hub-owner-artifact flow already assumes the hub owner and
 * the seal-issuing admin can be different people; wiring a hub-owner-scoped
 * signing authority for this stamp would make the guided-join handoff's
 * "whose job is it" model fully faithful. Tracked as a follow-up.
 */

import { randomNonce, signAdminRequest, type StackIdentityMaterial } from "../../../bus/stack-provisioning";
import { samePubkey } from "../../../common/registry/pubkey-normalize";
import type { AdmissionLookupPort, HubAuthorizeDeliveryPort, NetworkAuthorizePorts } from "./network-authorize-ports";

export interface LiveAuthorizePortsConfig {
  /** Registry base URL. */
  registryUrl: string;
  /** The HUB-ADMIN identity (signs the admission-list read + the authorize claim). */
  material: StackIdentityMaterial;
  /** Injectable fetch (tests). Production omits → globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

/** Build the full live port bundle. */
export function buildLiveAuthorizePorts(cfg: LiveAuthorizePortsConfig): NetworkAuthorizePorts {
  return {
    admission: buildLiveAdmissionLookupPort(cfg),
    delivery: buildLiveHubAuthorizeDeliveryPort(cfg),
  };
}

interface AdmissionRow {
  request_id: string;
  principal_id: string;
  peer_pubkey: string;
  network_id: string | null;
  status: string;
}

function buildLiveAdmissionLookupPort(cfg: LiveAuthorizePortsConfig): AdmissionLookupPort {
  const base = cfg.registryUrl.replace(/\/+$/, "");
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  return {
    async findAdmittedRow(networkId, memberPubkey) {
      // Admin-signed read of the ADMITTED list (x-admin-signed header) — the
      // SAME shape `network-secret-adapters.ts`'s lookup uses. NOTE: the
      // registry's read gate checks the REGISTRY-admin allowlist; for a
      // single-principal deployment the hub-admin seed IS the registry-admin
      // (Q5 collapse), so this works. A fully-separable deployment must put
      // the hub-admin on REGISTRY_ADMIN_PUBKEYS for the lookup.
      const claim = { admin_pubkey: cfg.material.pubkeyB64, issued_at: new Date().toISOString() };
      const signed = await signAdminRequest(cfg.material.seed, claim);
      const resp = await fetchImpl(`${base}/admission-requests?status=ADMITTED`, {
        method: "GET",
        headers: { "Content-Type": "application/json", "x-admin-signed": JSON.stringify(signed) },
      });
      if (!resp.ok) {
        throw new Error(`registry admission list failed (HTTP ${resp.status.toString()}): ${await resp.text()}`);
      }
      const rows = (await resp.json()) as AdmissionRow[];
      // cortex#1482 — compare via `samePubkey` (encoding-blind) so a member
      // passed as an nkey OR base64 resolves the SAME registry row (rows store
      // base64). The lib already normalizes to base64 before calling, but the
      // adapter stays robust either way — consistent with what `secret`/`admit`
      // do post-#1482.
      const row = rows.find(
        (r) => r.network_id === networkId && r.status === "ADMITTED" && samePubkey(r.peer_pubkey, memberPubkey),
      );
      return row ? { request_id: row.request_id, principal_id: row.principal_id } : undefined;
    },
  };
}

function buildLiveHubAuthorizeDeliveryPort(cfg: LiveAuthorizePortsConfig): HubAuthorizeDeliveryPort {
  const base = cfg.registryUrl.replace(/\/+$/, "");
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  return {
    async postAuthorize(requestId) {
      const claim = {
        request_id: requestId,
        hub_admin_pubkey: cfg.material.pubkeyB64,
        issued_at: new Date().toISOString(),
        nonce: randomNonce(),
      };
      const signed = await signAdminRequest(cfg.material.seed, claim);
      const resp = await fetchImpl(`${base}/admission-requests/${encodeURIComponent(requestId)}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });
      if (!resp.ok) {
        throw new Error(`registry rejected authorize (HTTP ${resp.status.toString()}): ${await resp.text()}`);
      }
    },
  };
}
