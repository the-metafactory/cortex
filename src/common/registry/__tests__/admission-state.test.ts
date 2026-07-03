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
  postDepartAdmission,
  departOwnAdmission,
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
    ...(over.updated_at !== undefined && { updated_at: over.updated_at }),
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

  test("REVOKED / REJECTED / DEPARTED / unknown map through", () => {
    expect(classifyOwnAdmissionRows([row({ status: "REVOKED" })], "metafactory", PUB).state).toBe("revoked");
    expect(classifyOwnAdmissionRows([row({ status: "REJECTED" })], "metafactory", PUB).state).toBe("rejected");
    expect(classifyOwnAdmissionRows([row({ status: "DEPARTED" })], "metafactory", PUB).state).toBe("departed");
    expect(classifyOwnAdmissionRows([row({ status: "WEIRD" })], "metafactory", PUB).state).toBe("unknown");
  });

  // C-1350 Slice 1 — a DEPARTED row threads updated_at through as the departed-at
  // date the quiet `admission: departed <date>` status line prints.
  test("DEPARTED row carries updated_at through as updatedAt (the departed-at date)", () => {
    const s = classifyOwnAdmissionRows(
      [row({ status: "DEPARTED", updated_at: "2026-07-03T10:00:00.000Z", request_id: "rD" })],
      "metafactory",
      PUB,
    );
    expect(s.state).toBe("departed");
    expect(s.updatedAt).toBe("2026-07-03T10:00:00.000Z");
    expect(s.requestId).toBe("rD");
  });

  // C-1350 (Slice 2) — the row's updated_at is threaded through as updatedAt so a
  // REVOKED member can be told WHEN they were removed.
  test("REVOKED row carries updated_at through as updatedAt (the revoked-at date)", () => {
    const s = classifyOwnAdmissionRows(
      [row({ status: "REVOKED", updated_at: "2026-07-01T09:30:00.000Z" })],
      "metafactory",
      PUB,
    );
    expect(s.state).toBe("revoked");
    expect(s.updatedAt).toBe("2026-07-01T09:30:00.000Z");
  });

  test("a row with no updated_at leaves updatedAt undefined (older registry)", () => {
    const s = classifyOwnAdmissionRows([row({ status: "REVOKED" })], "metafactory", PUB);
    expect(s.state).toBe("revoked");
    expect(s.updatedAt).toBeUndefined();
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

// =============================================================================
// C-1350 Slice 1 — postDepartAdmission (member-PoP write) + departOwnAdmission
// =============================================================================

describe("postDepartAdmission", () => {
  test("signs the depart claim + POSTs /admission-requests/:id/depart, returns the row", async () => {
    const material = realMaterial();
    let gotUrl = "";
    let gotMethod = "";
    let gotBody = "";
    const fetchImpl: FetchLike = async (url, init) => {
      gotUrl = url;
      gotMethod = init?.method ?? "";
      gotBody = init?.body ?? "";
      return { ok: true, status: 200, json: async () => row({ request_id: "req-abc", status: "DEPARTED", sealed_secret: null }) };
    };
    const res = await postDepartAdmission({
      registryUrl: "http://registry.test/",
      principalId: "jc",
      material,
      requestId: "req-abc",
      fetchImpl,
      now: () => new Date("2026-07-03T00:00:00.000Z"),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.row.status).toBe("DEPARTED");
    expect(gotUrl).toBe("http://registry.test/admission-requests/req-abc/depart"); // trailing slash trimmed
    expect(gotMethod).toBe("POST");
    // Client signs-what-it-sends: the posted claim carries EXACTLY the fields the
    // registry AdmissionDepartClaim canonicalises + a signature over them.
    const body = JSON.parse(gotBody) as { claim: Record<string, unknown>; signature: string };
    expect(body.claim.request_id).toBe("req-abc");
    expect(body.claim.principal_id).toBe("jc");
    expect(body.claim.peer_pubkey).toBe(material.pubkeyB64);
    expect(typeof body.claim.issued_at).toBe("string");
    expect(typeof body.claim.nonce).toBe("string");
    expect((body.claim.nonce as string).length).toBeGreaterThanOrEqual(8);
    expect(body.signature.length).toBeGreaterThan(0);
  });

  test("HTTP error → soft ok:false with the status (never throws)", async () => {
    const material = realMaterial();
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 409, json: async () => ({}) });
    const res = await postDepartAdmission({
      registryUrl: "http://r.test",
      principalId: "jc",
      material,
      requestId: "req-abc",
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("409");
  });

  test("transport throw → soft ok:false (never throws)", async () => {
    const material = realMaterial();
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await postDepartAdmission({
      registryUrl: "http://r.test",
      principalId: "jc",
      material,
      requestId: "req-abc",
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("errored");
  });
});

describe("departOwnAdmission (read → depart if ADMITTED)", () => {
  /** A fetch that answers the GET /mine read with `rows`, and any POST with `postResp`. */
  function fetchFor(
    rows: AdmissionMineRow[],
    postResp: { ok: boolean; status: number; body?: unknown } = { ok: true, status: 200 },
  ): FetchLike {
    return async (_url, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return { ok: true, status: 200, json: async () => rows };
      }
      return { ok: postResp.ok, status: postResp.status, json: async () => postResp.body ?? {} };
    };
  }

  test("an ADMITTED row is departed → outcome 'departed' with the request-id", async () => {
    const material = realMaterial();
    const admittedRow = row({ network_id: "metafactory", status: "ADMITTED", request_id: "rX", peer_pubkey: material.pubkeyB64 });
    const departedRow = { ...admittedRow, status: "DEPARTED", sealed_secret: null };
    const res = await departOwnAdmission(
      { registryUrl: "http://r.test", principalId: "jc", material, fetchImpl: fetchFor([admittedRow], { ok: true, status: 200, body: departedRow }) },
      "metafactory",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outcome).toBe("departed");
      if (res.outcome === "departed") expect(res.requestId).toBe("rX");
    }
  });

  test("a PENDING row → outcome 'not-applicable' (no depart POST fired)", async () => {
    const material = realMaterial();
    let posted = false;
    const fetchImpl: FetchLike = async (_url, init) => {
      if ((init?.method ?? "GET") !== "GET") posted = true;
      return { ok: true, status: 200, json: async () => [row({ network_id: "metafactory", status: "PENDING" })] };
    };
    const res = await departOwnAdmission({ registryUrl: "http://r.test", principalId: "jc", material, fetchImpl }, "metafactory");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outcome).toBe("not-applicable");
    expect(posted).toBe(false);
  });

  test("no row for the network → 'not-applicable'", async () => {
    const material = realMaterial();
    const res = await departOwnAdmission(
      { registryUrl: "http://r.test", principalId: "jc", material, fetchImpl: fetchFor([row({ network_id: "othernet", status: "ADMITTED" })]) },
      "metafactory",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outcome).toBe("not-applicable");
  });

  test("a /mine read failure → ok:false (non-fatal for the caller)", async () => {
    const material = realMaterial();
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const res = await departOwnAdmission({ registryUrl: "http://r.test", principalId: "jc", material, fetchImpl }, "metafactory");
    expect(res.ok).toBe(false);
  });

  test("an ADMITTED row whose depart POST fails → ok:false", async () => {
    const material = realMaterial();
    const admittedRow = row({ network_id: "metafactory", status: "ADMITTED", request_id: "rX", peer_pubkey: material.pubkeyB64 });
    const res = await departOwnAdmission(
      { registryUrl: "http://r.test", principalId: "jc", material, fetchImpl: fetchFor([admittedRow], { ok: false, status: 503 }) },
      "metafactory",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("503");
  });
});
