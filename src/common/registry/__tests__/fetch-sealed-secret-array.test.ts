/**
 * cortex#1996 D2 (RFC-0006 §8.1) — member-side selection of a per-key
 * `sealed_secrets[]` entry, with the FULL crypto round-trip.
 *
 * The receive side accepts BOTH shapes: it PREFERS an array entry addressed to
 * the joining stack's own key (the covered-2nd-stack transport path, #1748) and
 * falls back to the legacy single `sealed_secret` slot. Fail-closed against
 * untrusted registry data: ambiguous / malformed arrays never yield a blob.
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "nkeys.js";
import { sealToPrincipal } from "../../crypto/seal-to-principal";
import { encodeLeafSecretEnvelope } from "../sealed-leaf-secret";
import { fetchSealedLeafSecret, selectSealedCiphertextForStack, type FetchLike } from "../fetch-sealed-secret";
import { materialFromSeedString, type StackIdentityMaterial } from "../../../bus/stack-provisioning";

function newMember(): StackIdentityMaterial {
  const kp = createUser();
  const seed = new TextDecoder().decode(kp.getSeed());
  return materialFromSeedString(seed);
}

function fakeRegistry(rows: unknown[]): FetchLike {
  return async (url) => {
    if (url.endsWith("/admission-requests/mine")) {
      return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
}

async function sealedFor(material: StackIdentityMaterial, leafPsk: string, leafUser: string): Promise<string> {
  return sealToPrincipal(encodeLeafSecretEnvelope({ leaf_psk: leafPsk, leaf_user: leafUser }), material.pubkeyB64);
}

describe("fetchSealedLeafSecret — per-key sealed_secrets[] selection", () => {
  test("covered 2nd stack opens the entry addressed to ITS OWN key on a covering row", async () => {
    // The covering row's peer_pubkey is the FIRST stack's key; the array carries
    // the 2nd (covered) stack's own sealed creds. The 2nd stack selects its entry.
    const firstStack = newMember();
    const secondStack = newMember();
    const sealedForSecond = await sealedFor(secondStack, "PSK-second", "alice");
    const fetchImpl = fakeRegistry([
      {
        request_id: "r1",
        principal_id: "alice",
        peer_pubkey: firstStack.pubkeyB64,
        network_id: "metafactory",
        status: "ADMITTED",
        sealed_secret: null,
        sealed_secrets: [{ target_stack_pubkey: secondStack.pubkeyB64, sealed_secret: sealedForSecond }],
      },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: secondStack, fetchImpl });
    expect(res).toEqual({ ok: true, kind: "psk", leafPsk: "PSK-second", leafUser: "alice" });
  });

  test("PREFERS the array entry over a legacy slot sealed to a different key", async () => {
    const member = newMember();
    const stranger = newMember();
    const sealedForMember = await sealedFor(member, "PSK-mine", "alice");
    const sealedForStranger = await sealedFor(stranger, "PSK-stranger", "bob");
    const fetchImpl = fakeRegistry([
      {
        request_id: "r1",
        principal_id: "alice",
        peer_pubkey: stranger.pubkeyB64,
        network_id: "metafactory",
        status: "ADMITTED",
        sealed_secret: sealedForStranger, // legacy slot NOT for me
        sealed_secrets: [{ target_stack_pubkey: member.pubkeyB64, sealed_secret: sealedForMember }],
      },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok && res.kind === "psk" && res.leafPsk).toBe("PSK-mine");
  });

  test("falls back to the legacy single slot when no array entry is addressed to my key", async () => {
    const member = newMember();
    const other = newMember();
    const sealedForMember = await sealedFor(member, "PSK-legacy", "alice");
    const fetchImpl = fakeRegistry([
      {
        request_id: "r1",
        principal_id: "alice",
        peer_pubkey: member.pubkeyB64,
        network_id: "metafactory",
        status: "ADMITTED",
        sealed_secret: sealedForMember,
        sealed_secrets: [{ target_stack_pubkey: other.pubkeyB64, sealed_secret: "AAAA" }], // not for me
      },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok && res.kind === "psk" && res.leafPsk).toBe("PSK-legacy");
  });

  test("two DISTINCT ciphertexts addressed to my key → ambiguous → soft-closed", async () => {
    const member = newMember();
    const a = await sealedFor(member, "PSK-a", "alice");
    const b = await sealedFor(member, "PSK-b", "alice");
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: "x", network_id: "metafactory", status: "ADMITTED", sealed_secret: null, sealed_secrets: [{ target_stack_pubkey: member.pubkeyB64, sealed_secret: a }] },
      { request_id: "r2", principal_id: "alice", peer_pubkey: "y", network_id: "metafactory", status: "ADMITTED", sealed_secret: null, sealed_secrets: [{ target_stack_pubkey: member.pubkeyB64, sealed_secret: b }] },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok).toBe(false);
  });
});

describe("selectSealedCiphertextForStack — pure fail-closed selection", () => {
  test("non-array sealed_secrets is ignored; legacy slot wins", () => {
    const rows = [{ sealed_secret: "legacy-blob", sealed_secrets: "not-an-array" as unknown }];
    expect(selectSealedCiphertextForStack(rows, "mykey")).toBe("legacy-blob");
  });

  test("malformed entries are skipped; a valid one for my key wins", () => {
    const rows = [
      {
        sealed_secret: null,
        sealed_secrets: [
          { target_stack_pubkey: "", sealed_secret: "x" }, // empty key
          { target_stack_pubkey: "mykey" }, // missing blob
          null,
          "str",
          { target_stack_pubkey: "mykey", sealed_secret: "good" },
        ] as unknown,
      },
    ];
    expect(selectSealedCiphertextForStack(rows, "mykey")).toBe("good");
  });

  test("same ciphertext addressed to my key across rows is NOT ambiguous (deduped)", () => {
    const rows = [
      { sealed_secret: null, sealed_secrets: [{ target_stack_pubkey: "mykey", sealed_secret: "same" }] as unknown },
      { sealed_secret: null, sealed_secrets: [{ target_stack_pubkey: "mykey", sealed_secret: "same" }] as unknown },
    ];
    expect(selectSealedCiphertextForStack(rows, "mykey")).toBe("same");
  });

  test("no entry for my key and no legacy slot → undefined", () => {
    const rows = [{ sealed_secret: null, sealed_secrets: [{ target_stack_pubkey: "other", sealed_secret: "x" }] as unknown }];
    expect(selectSealedCiphertextForStack(rows, "mykey")).toBeUndefined();
  });
});
