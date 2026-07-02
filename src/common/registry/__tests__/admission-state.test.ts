/**
 * C-1315 (#1315) — unit tests for the member-side admission-state read + classifier.
 *
 * `fetchOwnAdmissionRows` is transport-injectable; the classifier is pure. So the
 * whole module is covered hermetically with a stub fetch + a real (generated)
 * stack seed — no live registry.
 */

import { describe, expect, test } from "bun:test";
import { createUser } from "nkeys.js";

import {
  classifyOwnAdmissionRows,
  fetchOwnAdmissionRows,
  resolveOwnAdmissionState,
  rowHasSealedSecret,
  type AdmissionMineRow,
  type FetchLike,
} from "../admission-state";
import { materialFromSeedString, type StackIdentityMaterial } from "../../../bus/stack-provisioning";

/** A real material (the PoP read signs with it — the sign step must not throw). */
function realMaterial(): StackIdentityMaterial {
  const kp = createUser();
  const seed = new TextDecoder().decode(kp.getSeed());
  return materialFromSeedString(seed);
}

/** Build a mine row with sane defaults. */
function row(over: Partial<AdmissionMineRow> = {}): AdmissionMineRow {
  return {
    request_id: over.request_id ?? "req-abc",
    principal_id: over.principal_id ?? "jc",
    peer_pubkey: over.peer_pubkey ?? "PUBKEY==",
    network_id: over.network_id === undefined ? "metafactory" : over.network_id,
    status: over.status ?? "PENDING",
    sealed_secret: over.sealed_secret === undefined ? null : over.sealed_secret,
  };
}

// =============================================================================
// classifyOwnAdmissionRows (pure)
// =============================================================================

describe("classifyOwnAdmissionRows", () => {
  const PUB = "MYPUBKEY==";

  test("no row for the network → no-row (no request-id)", () => {
    const s = classifyOwnAdmissionRows([row({ network_id: "othernet" })], "metafactory", PUB);
    expect(s.state).toBe("no-row");
    expect(s.requestId).toBeUndefined();
    expect(s.hasSealedSecret).toBe(false);
    expect(s.peerPubkey).toBe(PUB);
  });

  test("PENDING → pending, request-id carried", () => {
    const s = classifyOwnAdmissionRows([row({ status: "PENDING", request_id: "r1" })], "metafactory", PUB);
    expect(s.state).toBe("pending");
    expect(s.requestId).toBe("r1");
    expect(s.hasSealedSecret).toBe(false);
  });

  test("ADMITTED with no sealed secret → admitted-unsealed", () => {
    const s = classifyOwnAdmissionRows([row({ status: "ADMITTED", sealed_secret: null })], "metafactory", PUB);
    expect(s.state).toBe("admitted-unsealed");
    expect(s.hasSealedSecret).toBe(false);
  });

  test("ADMITTED WITH a sealed secret → admitted-sealed", () => {
    const s = classifyOwnAdmissionRows([row({ status: "ADMITTED", sealed_secret: "SEALEDBLOB" })], "metafactory", PUB);
    expect(s.state).toBe("admitted-sealed");
    expect(s.hasSealedSecret).toBe(true);
  });

  test("empty-string sealed_secret is NOT sealed", () => {
    expect(rowHasSealedSecret(row({ sealed_secret: "" }))).toBe(false);
    const s = classifyOwnAdmissionRows([row({ status: "ADMITTED", sealed_secret: "" })], "metafactory", PUB);
    expect(s.state).toBe("admitted-unsealed");
  });

  test("REVOKED / REJECTED / unknown map through", () => {
    expect(classifyOwnAdmissionRows([row({ status: "REVOKED" })], "metafactory", PUB).state).toBe("revoked");
    expect(classifyOwnAdmissionRows([row({ status: "REJECTED" })], "metafactory", PUB).state).toBe("rejected");
    expect(classifyOwnAdmissionRows([row({ status: "WEIRD" })], "metafactory", PUB).state).toBe("unknown");
  });

  test("selects the row matching THIS network among several", () => {
    const rows = [
      row({ network_id: "metafactory", status: "ADMITTED", sealed_secret: "X", request_id: "rM" }),
      row({ network_id: "metafactory-community", status: "PENDING", request_id: "rC" }),
    ];
    const s = classifyOwnAdmissionRows(rows, "metafactory-community", PUB);
    expect(s.state).toBe("pending");
    expect(s.requestId).toBe("rC");
  });
});

// =============================================================================
// fetchOwnAdmissionRows (injected transport)
// =============================================================================

describe("fetchOwnAdmissionRows", () => {
  test("signs a PoP header, GETs /admission-requests/mine, returns rows", async () => {
    const material = realMaterial();
    let gotUrl = "";
    let gotHeader = "";
    const fetchImpl: FetchLike = async (url, init) => {
      gotUrl = url;
      gotHeader = init?.headers?.["x-pop-signed"] ?? "";
      return { ok: true, status: 200, json: async () => [row({ request_id: "r-1" })] };
    };
    const res = await fetchOwnAdmissionRows({
      registryUrl: "http://registry.test/",
      principalId: "jc",
      material,
      fetchImpl,
      now: () => new Date("2026-07-02T00:00:00.000Z"),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows[0]!.request_id).toBe("r-1");
    expect(gotUrl).toBe("http://registry.test/admission-requests/mine"); // trailing slash trimmed
    const signed = JSON.parse(gotHeader) as { claim: { principal_id: string; peer_pubkey: string }; signature: string };
    expect(signed.claim.principal_id).toBe("jc");
    expect(signed.claim.peer_pubkey).toBe(material.pubkeyB64);
    expect(signed.signature.length).toBeGreaterThan(0);
  });

  test("HTTP error → soft ok:false with the status", async () => {
    const material = realMaterial();
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const res = await fetchOwnAdmissionRows({ registryUrl: "http://r.test", principalId: "jc", material, fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("403");
  });

  test("non-array body → soft ok:false (never throws)", async () => {
    const material = realMaterial();
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ not: "an array" }) });
    const res = await fetchOwnAdmissionRows({ registryUrl: "http://r.test", principalId: "jc", material, fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("non-array");
  });

  test("transport throw → soft ok:false (never throws)", async () => {
    const material = realMaterial();
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await fetchOwnAdmissionRows({ registryUrl: "http://r.test", principalId: "jc", material, fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("errored");
  });
});

// =============================================================================
// resolveOwnAdmissionState (read + classify)
// =============================================================================

describe("resolveOwnAdmissionState", () => {
  test("read ok → classified state for the target network", async () => {
    const material = realMaterial();
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => [row({ network_id: "metafactory", status: "ADMITTED", sealed_secret: null, request_id: "rX" })],
    });
    const res = await resolveOwnAdmissionState(
      { registryUrl: "http://r.test", principalId: "jc", material, fetchImpl },
      "metafactory",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.state).toBe("admitted-unsealed");
      expect(res.state.requestId).toBe("rX");
      expect(res.state.peerPubkey).toBe(material.pubkeyB64);
    }
  });

  test("read failure propagates as ok:false", async () => {
    const material = realMaterial();
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const res = await resolveOwnAdmissionState(
      { registryUrl: "http://r.test", principalId: "jc", material, fetchImpl },
      "metafactory",
    );
    expect(res.ok).toBe(false);
  });
});
