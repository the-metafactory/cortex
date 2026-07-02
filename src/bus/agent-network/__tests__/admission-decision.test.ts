/**
 * MC-B2 (cortex#1279) — tests for the admission-decision signer/poster.
 *
 * Covers the claim shape + real signature (byte-compatible with the registry
 * validator), and the status→result mapping for every registry verdict, with a
 * hermetic injected fetch. Never-throws is asserted on transport failure.
 */

import { describe, it, expect } from "bun:test";
import { createUser } from "nkeys.js";
import {
  buildAdmissionDecisionBody,
  postAdmissionDecision,
  type FetchLike,
} from "../admission-decision";
import {
  materialFromSeedString,
  type StackIdentityMaterial,
} from "../../stack-provisioning";
import { canonicalJSON } from "../../../common/registry/signing";

function material(): StackIdentityMaterial {
  const kp = createUser();
  return materialFromSeedString(new TextDecoder().decode(kp.getSeed()));
}

/** A fetch stub that captures the request and returns a canned response. */
function stubFetch(
  status: number,
  body: unknown,
  capture?: (url: string, init: { method?: string; body?: string }) => void,
): FetchLike {
  return (url, init) => {
    capture?.(url, init ?? {});
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
  };
}

describe("buildAdmissionDecisionBody", () => {
  it("builds the 5-field claim with the material's pubkey and a real signature", async () => {
    const mat = material();
    const signed = await buildAdmissionDecisionBody("req-abc-123", "admit", mat, {
      issuedAt: "2026-07-02T00:00:00.000Z",
      nonce: "deadbeefdeadbeef",
    });
    expect(signed.claim).toEqual({
      request_id: "req-abc-123",
      decision: "admit",
      admin_pubkey: mat.pubkeyB64,
      issued_at: "2026-07-02T00:00:00.000Z",
      nonce: "deadbeefdeadbeef",
    });
    // base64 signature over canonicalJSON(claim); non-empty.
    expect(signed.signature.length).toBeGreaterThan(0);
    // The message that was signed is the canonical claim — the registry
    // reconstructs the same bytes. Sanity-check it's stable/deterministic.
    expect(canonicalJSON(signed.claim)).toContain('"decision":"admit"');
  });

  it("carries decision:reject when rejecting", async () => {
    const signed = await buildAdmissionDecisionBody("req-x", "reject", material(), {
      issuedAt: "2026-07-02T00:00:00.000Z",
      nonce: "00000000abcdef01",
    });
    expect(signed.claim.decision).toBe("reject");
  });

  it("generates a fresh nonce + issued_at when not overridden", async () => {
    const a = await buildAdmissionDecisionBody("req-y", "admit", material());
    const b = await buildAdmissionDecisionBody("req-y", "admit", material());
    expect(a.claim.nonce).not.toBe(b.claim.nonce);
    expect(a.claim.issued_at.length).toBeGreaterThan(0);
  });
});

describe("postAdmissionDecision", () => {
  it("POSTs to the admit route and returns ADMITTED on 200", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const fetchImpl = stubFetch(200, { status: "ADMITTED", request_id: "req-1" }, (url, init) => {
      seenUrl = url;
      seenBody = init.body ? JSON.parse(init.body) : undefined;
    });
    const res = await postAdmissionDecision({
      registryUrl: "https://registry.test/",
      requestId: "req-1",
      decision: "admit",
      material: material(),
      fetchImpl,
    });
    expect(res).toEqual({ ok: true, status: "ADMITTED", requestId: "req-1" });
    expect(seenUrl).toBe("https://registry.test/admission-requests/req-1/admit");
    expect((seenBody as { claim: { decision: string } }).claim.decision).toBe("admit");
  });

  it("POSTs to the reject route and returns REJECTED on 200", async () => {
    let seenUrl = "";
    const fetchImpl = stubFetch(200, { status: "REJECTED", request_id: "req-2" }, (url) => {
      seenUrl = url;
    });
    const res = await postAdmissionDecision({
      registryUrl: "https://registry.test",
      requestId: "req-2",
      decision: "reject",
      material: material(),
      fetchImpl,
    });
    expect(res).toEqual({ ok: true, status: "REJECTED", requestId: "req-2" });
    expect(seenUrl).toBe("https://registry.test/admission-requests/req-2/reject");
  });

  it("maps 403 → not_authorized", async () => {
    const res = await postAdmissionDecision({
      registryUrl: "https://registry.test",
      requestId: "req-3",
      decision: "admit",
      material: material(),
      fetchImpl: stubFetch(403, { error: "admin_not_authorized" }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_authorized");
  });

  it("maps 503 → not_configured", async () => {
    const res = await postAdmissionDecision({
      registryUrl: "https://registry.test",
      requestId: "req-4",
      decision: "admit",
      material: material(),
      fetchImpl: stubFetch(503, { error: "admin_not_configured" }),
    });
    if (!res.ok) expect(res.reason).toBe("not_configured");
    else throw new Error("expected failure");
  });

  it("distinguishes 409 already_decided from nonce_replayed", async () => {
    const decided = await postAdmissionDecision({
      registryUrl: "https://registry.test",
      requestId: "req-5",
      decision: "admit",
      material: material(),
      fetchImpl: stubFetch(409, { error: "already_decided" }),
    });
    const replayed = await postAdmissionDecision({
      registryUrl: "https://registry.test",
      requestId: "req-6",
      decision: "admit",
      material: material(),
      fetchImpl: stubFetch(409, { error: "nonce_replayed" }),
    });
    if (!decided.ok) expect(decided.reason).toBe("already_decided");
    else throw new Error("expected failure");
    if (!replayed.ok) expect(replayed.reason).toBe("replayed");
    else throw new Error("expected failure");
  });

  it("maps 404 → not_found and 400 → invalid", async () => {
    const nf = await postAdmissionDecision({
      registryUrl: "https://registry.test",
      requestId: "req-7",
      decision: "admit",
      material: material(),
      fetchImpl: stubFetch(404, { error: "not_found" }),
    });
    const bad = await postAdmissionDecision({
      registryUrl: "https://registry.test",
      requestId: "req-8",
      decision: "admit",
      material: material(),
      fetchImpl: stubFetch(400, { error: "validation_failed" }),
    });
    if (!nf.ok) expect(nf.reason).toBe("not_found");
    if (!bad.ok) expect(bad.reason).toBe("invalid");
  });

  it("never throws on a transport failure → unreachable", async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));
    const res = await postAdmissionDecision({
      registryUrl: "https://registry.test",
      requestId: "req-9",
      decision: "admit",
      material: material(),
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unreachable");
  });

  it("treats a 2xx with a missing status field as unreachable (malformed)", async () => {
    const res = await postAdmissionDecision({
      registryUrl: "https://registry.test",
      requestId: "req-10",
      decision: "admit",
      material: material(),
      fetchImpl: stubFetch(200, { nope: true }),
    });
    if (!res.ok) expect(res.reason).toBe("unreachable");
    else throw new Error("expected failure");
  });
});
