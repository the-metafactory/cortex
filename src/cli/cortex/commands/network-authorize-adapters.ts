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
 */

import { canonicalJSON } from "../../../common/registry/signing";
import { signClaimWithSeed, randomNonce, type StackIdentityMaterial } from "../../../bus/stack-provisioning";
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
      const signature = await signClaimWithSeed(cfg.material.seed, new TextEncoder().encode(canonicalJSON(claim)));
      const resp = await fetchImpl(`${base}/admission-requests?status=ADMITTED`, {
        method: "GET",
        headers: { "Content-Type": "application/json", "x-admin-signed": JSON.stringify({ claim, signature }) },
      });
      if (!resp.ok) {
        throw new Error(`registry admission list failed (HTTP ${resp.status.toString()}): ${await resp.text()}`);
      }
      const rows = (await resp.json()) as AdmissionRow[];
      const row = rows.find((r) => r.network_id === networkId && r.peer_pubkey === memberPubkey && r.status === "ADMITTED");
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
      const signature = await signClaimWithSeed(cfg.material.seed, new TextEncoder().encode(canonicalJSON(claim)));
      const resp = await fetchImpl(`${base}/admission-requests/${encodeURIComponent(requestId)}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim, signature }),
      });
      if (!resp.ok) {
        throw new Error(`registry rejected authorize (HTTP ${resp.status.toString()}): ${await resp.text()}`);
      }
    },
  };
}
