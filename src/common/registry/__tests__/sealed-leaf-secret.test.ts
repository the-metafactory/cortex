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
  encodeLeafSecretEnvelopeV2,
  decodeAnyLeafSecretEnvelope,
  isLeafSecretEnvelopeV2,
  UnsupportedEnvelopeVersionError,
  LEAF_SECRET_ENVELOPE_VERSION,
  LEAF_SECRET_ENVELOPE_VERSION_V2,
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

  // #1596 — the v1 decoder must reject a KNOWN-newer envelope with a clear
  // "upgrade" error, NOT the old misleading "missing leaf_psk" path (which the
  // C-1315 diagnostic then reports as "sealed to a different pubkey / corrupted").
  test("v1 decoder rejects a v2 payload with UnsupportedEnvelopeVersionError (not 'missing leaf_psk')", () => {
    const v2blob = encodeLeafSecretEnvelopeV2({
      creds: "-----BEGIN NATS USER JWT-----\nFAKE\n------END NATS USER JWT------\n",
      leaf_user: "alice/lab",
      minted_at: "2026-07-06T00:00:00.000Z",
    });
    expect(() => decodeLeafSecretEnvelope(v2blob)).toThrow(UnsupportedEnvelopeVersionError);
    expect(() => decodeLeafSecretEnvelope(v2blob)).toThrow(/upgrade cortex/i);
    expect(() => decodeLeafSecretEnvelope(v2blob)).not.toThrow(/missing leaf_psk/);
  });
});

// Clearly-fake creds text — never realistic JWT/nkey material.
const FAKE_CREDS =
  "-----BEGIN NATS USER JWT-----\nFAKE.JWT.PART\n------END NATS USER JWT------\n" +
  "-----BEGIN USER NKEY SEED-----\nSUAFAKEFAKEFAKE\n------END USER NKEY SEED------\n";
const MINTED_AT = "2026-07-06T12:00:00.000Z";

describe("v2 envelope (creds payload) — #1596", () => {
  test("round-trips creds + leaf_user + minted_at via decodeAny", () => {
    const env = decodeAnyLeafSecretEnvelope(
      encodeLeafSecretEnvelopeV2({ creds: FAKE_CREDS, leaf_user: "alice/lab", minted_at: MINTED_AT }),
    );
    expect(env.v).toBe(LEAF_SECRET_ENVELOPE_VERSION_V2);
    expect(isLeafSecretEnvelopeV2(env)).toBe(true);
    if (isLeafSecretEnvelopeV2(env)) {
      expect(env.creds).toBe(FAKE_CREDS);
      expect(env.leaf_user).toBe("alice/lab");
      expect(env.minted_at).toBe(MINTED_AT);
      expect(env.payload_key).toBeUndefined();
    }
  });

  test("v2 rides payload_key + kid (K on the same envelope)", () => {
    const env = decodeAnyLeafSecretEnvelope(
      encodeLeafSecretEnvelopeV2({
        creds: FAKE_CREDS,
        leaf_user: "alice/lab",
        minted_at: MINTED_AT,
        payload_key: FAKE_K,
        payload_key_kid: FAKE_KID,
      }),
    );
    expect(isLeafSecretEnvelopeV2(env)).toBe(true);
    if (isLeafSecretEnvelopeV2(env)) {
      expect(env.payload_key).toBe(FAKE_K);
      expect(env.payload_key_kid).toBe(FAKE_KID);
    }
  });

  test("decodeAny still decodes a v1 blob (and narrows to NOT v2)", () => {
    const env = decodeAnyLeafSecretEnvelope(
      encodeLeafSecretEnvelope({ leaf_psk: "psk-1", leaf_user: "alice" }),
    );
    expect(env.v).toBe(LEAF_SECRET_ENVELOPE_VERSION);
    expect(isLeafSecretEnvelopeV2(env)).toBe(false);
  });

  test("decodeAny rejects an UNKNOWN newer version (v3) with the upgrade error", () => {
    const v3 = JSON.stringify({ v: 3, creds: FAKE_CREDS, leaf_user: "alice/lab", minted_at: MINTED_AT });
    expect(() => decodeAnyLeafSecretEnvelope(v3)).toThrow(UnsupportedEnvelopeVersionError);
    expect(() => decodeAnyLeafSecretEnvelope(v3)).toThrow(/upgrade cortex/i);
  });

  test("v2 fails closed on a missing creds field", () => {
    const bad = JSON.stringify({ v: 2, leaf_user: "alice/lab", minted_at: MINTED_AT });
    expect(() => decodeAnyLeafSecretEnvelope(bad)).toThrow(/v2 payload missing creds/);
  });

  test("v2 fails closed on a missing minted_at field", () => {
    const bad = JSON.stringify({ v: 2, creds: FAKE_CREDS, leaf_user: "alice/lab" });
    expect(() => decodeAnyLeafSecretEnvelope(bad)).toThrow(/v2 payload missing minted_at/);
  });

  test("v2 fails closed on a non-date minted_at (a garbage string is not a timestamp)", () => {
    const bad = JSON.stringify({ v: 2, creds: FAKE_CREDS, leaf_user: "alice/lab", minted_at: "x" });
    expect(() => decodeAnyLeafSecretEnvelope(bad)).toThrow(/parseable ISO-8601 date/);
  });

  test("v2 fails closed on a missing leaf_user (subject) field", () => {
    const bad = JSON.stringify({ v: 2, creds: FAKE_CREDS, minted_at: MINTED_AT });
    expect(() => decodeAnyLeafSecretEnvelope(bad)).toThrow(/v2 payload missing leaf_user/);
  });

  test("a v2 blob carries no leaf_psk (the discriminant, not an either-field relaxation)", () => {
    const json = encodeLeafSecretEnvelopeV2({ creds: FAKE_CREDS, leaf_user: "alice/lab", minted_at: MINTED_AT });
    expect(json).not.toContain("leaf_psk");
    expect(json).toContain('"v":2');
  });

  test("v2 encoder fails fast on empty creds / leaf_user / bad minted_at (producer-side)", () => {
    expect(() => encodeLeafSecretEnvelopeV2({ creds: "", leaf_user: "alice/lab", minted_at: MINTED_AT })).toThrow(/empty creds/);
    expect(() => encodeLeafSecretEnvelopeV2({ creds: FAKE_CREDS, leaf_user: "", minted_at: MINTED_AT })).toThrow(/empty leaf_user/);
    expect(() => encodeLeafSecretEnvelopeV2({ creds: FAKE_CREDS, leaf_user: "alice/lab", minted_at: "nope" })).toThrow(/minted_at/);
  });

  test("a string version (v: \"2\") is rejected, not mis-routed to the v1 path", () => {
    const bad = JSON.stringify({ v: "2", creds: FAKE_CREDS, leaf_user: "alice/lab", minted_at: MINTED_AT });
    expect(() => decodeAnyLeafSecretEnvelope(bad)).toThrow(/`v` must be a number/);
    expect(() => decodeAnyLeafSecretEnvelope(bad)).not.toThrow(/missing leaf_psk/);
  });
});
