/**
 * C-1349 Slice 1 — the sealed leaf-secret envelope now carries the per-network
 * payload key `K` (`payload_key`) AND its key id (`payload_key_kid`, the new
 * field). These tests pin:
 *   - encode → decode round-trips leaf_psk + leaf_user (unchanged baseline)
 *   - encode → decode round-trips payload_key + payload_key_kid when present
 *   - decode TOLERATES an old blob with neither field (backward compat)
 *   - decode tolerates payload_key present but kid absent, and vice-versa
 *   - decode fails closed on a malformed kid type
 *
 * Fixtures use CLEARLY-FAKE key material (never realistic K bytes).
 */

import { describe, test, expect } from "bun:test";
import {
  encodeLeafSecretEnvelope,
  decodeLeafSecretEnvelope,
  LEAF_SECRET_ENVELOPE_VERSION,
} from "../sealed-leaf-secret";

// Clearly-fake placeholder key material — an all-A base64 blob, never real K.
const FAKE_K = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const FAKE_KID = "metafactory/k1";

describe("encodeLeafSecretEnvelope / decodeLeafSecretEnvelope", () => {
  test("round-trips leaf_psk + leaf_user (no payload key) — baseline unchanged", () => {
    const env = decodeLeafSecretEnvelope(
      encodeLeafSecretEnvelope({ leaf_psk: "psk-1", leaf_user: "alice" }),
    );
    expect(env.v).toBe(LEAF_SECRET_ENVELOPE_VERSION);
    expect(env.leaf_psk).toBe("psk-1");
    expect(env.leaf_user).toBe("alice");
    expect(env.payload_key).toBeUndefined();
    expect(env.payload_key_kid).toBeUndefined();
  });

  test("round-trips payload_key + payload_key_kid when both present", () => {
    const env = decodeLeafSecretEnvelope(
      encodeLeafSecretEnvelope({
        leaf_psk: "psk-1",
        leaf_user: "alice",
        payload_key: FAKE_K,
        payload_key_kid: FAKE_KID,
      }),
    );
    expect(env.payload_key).toBe(FAKE_K);
    expect(env.payload_key_kid).toBe(FAKE_KID);
  });

  test("decode tolerates an OLD blob: JSON with neither payload field", () => {
    // A pre-#1349 envelope shape (v1, leaf_psk + leaf_user only).
    const oldBlob = JSON.stringify({ v: 1, leaf_psk: "psk-1", leaf_user: "alice" });
    const env = decodeLeafSecretEnvelope(oldBlob);
    expect(env.leaf_psk).toBe("psk-1");
    expect(env.payload_key).toBeUndefined();
    expect(env.payload_key_kid).toBeUndefined();
  });

  test("decode tolerates payload_key present but kid absent", () => {
    const blob = JSON.stringify({
      v: 1,
      leaf_psk: "psk-1",
      leaf_user: "alice",
      payload_key: FAKE_K,
    });
    const env = decodeLeafSecretEnvelope(blob);
    expect(env.payload_key).toBe(FAKE_K);
    expect(env.payload_key_kid).toBeUndefined();
  });

  test("decode tolerates kid present but payload_key absent (defensive)", () => {
    const blob = JSON.stringify({
      v: 1,
      leaf_psk: "psk-1",
      leaf_user: "alice",
      payload_key_kid: FAKE_KID,
    });
    const env = decodeLeafSecretEnvelope(blob);
    expect(env.payload_key).toBeUndefined();
    expect(env.payload_key_kid).toBe(FAKE_KID);
  });

  test("decode fails closed when payload_key_kid is the wrong type", () => {
    const blob = JSON.stringify({
      v: 1,
      leaf_psk: "psk-1",
      leaf_user: "alice",
      payload_key: FAKE_K,
      payload_key_kid: 42,
    });
    expect(() => decodeLeafSecretEnvelope(blob)).toThrow(/payload_key_kid/);
  });

  test("encode omits payload_key_kid when payload_key is present but kid is not", () => {
    const json = encodeLeafSecretEnvelope({
      leaf_psk: "psk-1",
      leaf_user: "alice",
      payload_key: FAKE_K,
    });
    expect(json).not.toContain("payload_key_kid");
    expect(json).toContain("payload_key");
  });
});
