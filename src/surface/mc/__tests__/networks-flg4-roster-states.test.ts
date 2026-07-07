/**
 * FLG-4 (docs/plan-mc-future-state.md §4.D) — `handleListNetworks` roster-state
 * projection + the DAEMON-SIDE SHAPE CONTRACT (the DashboardSnapshot no-interiors
 * analog for this read, mirroring the FLG-1/FLG-3 contract tests).
 *
 * Two load-bearing properties:
 *   1. `roster_states` flows through the handler verbatim from the read (seal /
 *      hub-authorize / admission-state incl. departed vs revoked / authorship).
 *   2. NO SECRET MATERIAL crosses the seam: the wire carries a boolean `sealed`
 *      signal + a timestamp + a resolved authorship verdict — never a sealed
 *      ciphertext, a payload key, a PSK, or a raw `{claim, signature}` (invariant
 *      6 / ADR-0005 no-interiors, enforced here the way the worker's
 *      `dashboard-snapshot-contract` test enforces it on `/api/state`).
 */

import { describe, it, expect } from "bun:test";
import {
  handleListNetworks,
  type NetworksView,
  type ListNetworksResponse,
} from "../api/networks";
import type { NetworkConfidentialityPosture } from "../../../common/crypto/network-encryption-policy";
import type {
  AdmittedMemberState,
  ResolveAdmittedRosterResult,
} from "../../../bus/agent-network/admission-read";

const CLEARTEXT: NetworkConfidentialityPosture = { mode: "off", keyPresent: false, keyId: null };

function viewWithStates(networkId: string, states: AdmittedMemberState[], admitted: string[], pending: string[] = []): NetworksView {
  const result: ResolveAdmittedRosterResult = {
    ok: true,
    roster: { admitted, pending, states, authoritative: true },
  };
  return {
    localPrincipal: "andreas",
    networks: () => [{ networkId, leafNode: `${networkId}-leaf`, confidentiality: CLEARTEXT }],
    resolveAdmittedRoster: () => Promise.resolve(result),
  };
}

async function body(res: Response): Promise<ListNetworksResponse> {
  return (await res.json()) as ListNetworksResponse;
}

const STATES: AdmittedMemberState[] = [
  { principal_id: "andreas", status: "ADMITTED", sealed: true, hub_authorized_at: "2026-07-08T00:00:00.000Z", authorship: "verified" },
  { principal_id: "jc", status: "ADMITTED", sealed: false, hub_authorized_at: null, authorship: "unchecked" },
  { principal_id: "leaver", status: "DEPARTED", sealed: false, hub_authorized_at: null, authorship: "unchecked" },
  { principal_id: "kicked", status: "REVOKED", sealed: false, hub_authorized_at: null, authorship: "unchecked" },
];

describe("handleListNetworks — FLG-4 roster_states", () => {
  it("projects per-member states onto the wire DTO (seal / hub-authorize / state / authorship)", async () => {
    const res = await handleListNetworks(viewWithStates("metafactory", STATES, ["andreas", "jc"]), null);
    expect(res.status).toBe(200);
    const net = (await body(res)).networks[0];
    expect(net).toBeDefined();
    const rs = net?.roster_states ?? [];
    expect(rs).toHaveLength(4);

    const andreas = rs.find((s) => s.principal === "andreas");
    expect(andreas).toEqual({
      principal: "andreas",
      admission_state: "admitted",
      sealed: true,
      hub_authorized_at: "2026-07-08T00:00:00.000Z",
      authorship: "verified",
    });
  });

  it("keeps DEPARTED and REVOKED as DISTINCT wire states ('left' ≠ 'kicked')", async () => {
    const res = await handleListNetworks(viewWithStates("metafactory", STATES, ["andreas", "jc"]), null);
    const rs = (await body(res)).networks[0]?.roster_states ?? [];
    expect(rs.find((s) => s.principal === "leaver")?.admission_state).toBe("departed");
    expect(rs.find((s) => s.principal === "kicked")?.admission_state).toBe("revoked");
  });

  it("emits an empty roster_states array when the read carries none (honest absence, never omitted)", async () => {
    const view: NetworksView = {
      localPrincipal: "andreas",
      networks: () => [{ networkId: "metafactory", leafNode: "l", confidentiality: CLEARTEXT }],
      resolveAdmittedRoster: () =>
        Promise.resolve({ ok: true, roster: { admitted: ["andreas"], pending: [], authoritative: true } }),
    };
    const res = await handleListNetworks(view, null);
    const net = (await body(res)).networks[0];
    expect(net?.roster_states).toEqual([]);
  });

  // --- SHAPE CONTRACT: no-interiors / no-secret-material (invariant 6) --------
  it("SHAPE CONTRACT: no secret material or interior on any roster_state key", async () => {
    const res = await handleListNetworks(viewWithStates("metafactory", STATES, ["andreas", "jc"]), null);
    const rs = (await body(res)).networks[0]?.roster_states ?? [];
    const ALLOWED = new Set(["principal", "admission_state", "sealed", "hub_authorized_at", "authorship"]);
    const FORBIDDEN = /secret|cipher|payload_key|psk|creds|seed|signature|claim|private|nkey/i;
    for (const state of rs) {
      // Exactly the allowed metadata keys — no extra fields leak through.
      for (const key of Object.keys(state)) {
        expect(ALLOWED.has(key)).toBe(true);
      }
      // `sealed` is a boolean signal, never a string ciphertext.
      expect(typeof state.sealed).toBe("boolean");
      // No key or value smells like secret material.
      const serialized = JSON.stringify(state);
      expect(FORBIDDEN.test(serialized)).toBe(false);
    }
  });
});
