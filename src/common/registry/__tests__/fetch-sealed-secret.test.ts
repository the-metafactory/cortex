/**
 * ADR-0018 PR5b — member-side fetch + unseal round-trip tests.
 *
 * Exercises the FULL crypto round-trip with REAL keys: mint a member identity,
 * seal a leaf-secret envelope to its pubkey (as the hub-admin would), serve it
 * through a fake `/admission-requests/mine`, and prove the member fetches +
 * unseals exactly its own PSK — and that wrong-network / no-blob / tampered /
 * wrong-recipient all fail soft-closed.
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "nkeys.js";
import { sealToPrincipal } from "../../crypto/seal-to-principal";
import {
  encodeLeafSecretEnvelope,
  encodeLeafSecretEnvelopeV2,
  decodeLeafSecretEnvelope,
} from "../sealed-leaf-secret";
import { fetchSealedLeafSecret, type FetchLike } from "../fetch-sealed-secret";
import { materialFromSeedString, type StackIdentityMaterial } from "../../../bus/stack-provisioning";
import { FAKE_CREDS } from "./fixtures";

function newMember(): StackIdentityMaterial {
  const kp = createUser();
  const seed = new TextDecoder().decode(kp.getSeed());
  return materialFromSeedString(seed);
}

/** A fake registry serving a fixed set of /mine rows. */
function fakeRegistry(rows: unknown[]): FetchLike {
  return async (url) => {
    if (url.endsWith("/admission-requests/mine")) {
      return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
}

async function sealedFor(material: StackIdentityMaterial, leafPsk: string, leafUser: string): Promise<string> {
  const plaintext = encodeLeafSecretEnvelope({ leaf_psk: leafPsk, leaf_user: leafUser });
  return sealToPrincipal(plaintext, material.pubkeyB64);
}

describe("fetchSealedLeafSecret — round-trip", () => {
  test("member fetches + unseals its own leaf PSK", async () => {
    const member = newMember();
    const sealed = await sealedFor(member, "PSK-abc", "alice");
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: sealed },
    ]);

    const res = await fetchSealedLeafSecret({
      registryUrl: "https://registry.example",
      networkId: "metafactory",
      principalId: "alice",
      material: member,
      fetchImpl,
    });
    expect(res).toEqual({ ok: true, kind: "psk", leafPsk: "PSK-abc", leafUser: "alice" });
  });

  test("selects the row for the TARGET network (ignores other networks)", async () => {
    const member = newMember();
    const sealedMeta = await sealedFor(member, "PSK-meta", "alice");
    const sealedOther = await sealedFor(member, "PSK-other", "alice");
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "other", status: "ADMITTED", sealed_secret: sealedOther },
      { request_id: "r2", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: sealedMeta },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok && res.kind === "psk" && res.leafPsk).toBe("PSK-meta");
  });

  test("no admitted+sealed row → soft-closed { ok: false }", async () => {
    const member = newMember();
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "PENDING", sealed_secret: null },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok).toBe(false);
  });

  test("a blob sealed to a DIFFERENT member does not open (fails soft-closed)", async () => {
    const member = newMember();
    const stranger = newMember();
    const sealedForStranger = await sealedFor(stranger, "PSK-x", "bob");
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: sealedForStranger },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok).toBe(false);
  });

  test("a tampered ciphertext fails soft-closed", async () => {
    const member = newMember();
    const sealed = await sealedFor(member, "PSK-abc", "alice");
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-3);
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: tampered },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok).toBe(false);
  });

  test("registry HTTP error → soft-closed", async () => {
    const member = newMember();
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "down" });
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok).toBe(false);
  });
});

// =============================================================================
// #1597 (epic #1595) — the v2 per-member credential-file payload.
// =============================================================================

async function sealedV2For(
  material: StackIdentityMaterial,
  leafUser: string,
  creds: string = FAKE_CREDS,
): Promise<string> {
  const plaintext = encodeLeafSecretEnvelopeV2({
    creds,
    leaf_user: leafUser,
    minted_at: "2026-07-06T00:00:00Z",
  });
  return sealToPrincipal(plaintext, material.pubkeyB64);
}

describe("fetchSealedLeafSecret — v2 credential-file payload (#1597)", () => {
  test("member fetches + unseals its own v2 credential (identity matches)", async () => {
    const member = newMember();
    const sealed = await sealedV2For(member, "alice/default");
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: sealed },
    ]);
    const res = await fetchSealedLeafSecret({
      registryUrl: "x",
      networkId: "metafactory",
      principalId: "alice",
      material: member,
      fetchImpl,
      expectedLeafUsers: ["alice/default", "alice"],
    });
    expect(res).toEqual({
      ok: true,
      kind: "creds",
      creds: FAKE_CREDS,
      leafUser: "alice/default",
      mintedAt: "2026-07-06T00:00:00Z",
    });
  });

  test("R7 — a v2 credential minted for a DIFFERENT subject is refused, creds never echoed", async () => {
    const member = newMember();
    const sealed = await sealedV2For(member, "mallory/default");
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: sealed },
    ]);
    const res = await fetchSealedLeafSecret({
      registryUrl: "x",
      networkId: "metafactory",
      principalId: "alice",
      material: member,
      fetchImpl,
      expectedLeafUsers: ["alice/default", "alice"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("mallory/default");
      expect(res.reason).toContain("R7");
      expect(res.reason).not.toContain(FAKE_CREDS.slice(0, 40));
    }
  });

  test("R7 fail-closed — a v2 payload with NO expected identities supplied is refused", async () => {
    const member = newMember();
    const sealed = await sealedV2For(member, "alice/default");
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: sealed },
    ]);
    // No expectedLeafUsers — the caller cannot vouch for its own identity, so a
    // v2 credential must NOT be installed even when it would have matched.
    const res = await fetchSealedLeafSecret({
      registryUrl: "x",
      networkId: "metafactory",
      principalId: "alice",
      material: member,
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("R7");
  });

  test("v1 envelopes are UNAFFECTED by expectedLeafUsers (no identity claim in v1)", async () => {
    const member = newMember();
    const sealed = await sealedFor(member, "PSK-abc", "some-hub-userinfo-user");
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: sealed },
    ]);
    const res = await fetchSealedLeafSecret({
      registryUrl: "x",
      networkId: "metafactory",
      principalId: "alice",
      material: member,
      fetchImpl,
      expectedLeafUsers: ["alice/default", "alice"],
    });
    expect(res).toEqual({ ok: true, kind: "psk", leafPsk: "PSK-abc", leafUser: "some-hub-userinfo-user" });
  });

  test("the M3 payload key rides the v2 envelope too", async () => {
    const member = newMember();
    const plaintext = encodeLeafSecretEnvelopeV2({
      creds: FAKE_CREDS,
      leaf_user: "alice/default",
      minted_at: "2026-07-06T00:00:00Z",
      payload_key: "K",
      payload_key_kid: "metafactory/k1",
    });
    const sealed = await sealToPrincipal(plaintext, member.pubkeyB64);
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: sealed },
    ]);
    const res = await fetchSealedLeafSecret({
      registryUrl: "x",
      networkId: "metafactory",
      principalId: "alice",
      material: member,
      fetchImpl,
      expectedLeafUsers: ["alice/default"],
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.kind === "creds") {
      expect(res.payloadKey).toBe("K");
      expect(res.payloadKeyKid).toBe("metafactory/k1");
    } else {
      throw new Error("expected the v2 creds kind");
    }
  });
});

describe("LeafSecretEnvelope — the M3 seam", () => {
  test("encode→decode round-trips leaf_psk + leaf_user", () => {
    const env = decodeLeafSecretEnvelope(encodeLeafSecretEnvelope({ leaf_psk: "p", leaf_user: "u" }));
    expect(env).toEqual({ v: 1, leaf_psk: "p", leaf_user: "u" });
  });

  test("tolerates the future payload_key field (M3 #1246 rides the same envelope)", () => {
    const json = encodeLeafSecretEnvelope({ leaf_psk: "p", leaf_user: "u", payload_key: "K" });
    const env = decodeLeafSecretEnvelope(json);
    expect(env.payload_key).toBe("K");
    expect(env.leaf_psk).toBe("p");
  });

  test("rejects a malformed envelope without echoing the plaintext", () => {
    expect(() => decodeLeafSecretEnvelope("not json")).toThrow(/not valid JSON/);
    expect(() => decodeLeafSecretEnvelope(JSON.stringify({ leaf_user: "u" }))).toThrow(/leaf_psk/);
  });
});
