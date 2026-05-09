/**
 * G-1100.B: Envelope validator tests.
 *
 * Uses the real example envelopes from upstream myelin as fixtures —
 * valid-envelope.json and invalid-missing-sovereignty.json — copied
 * into __fixtures__/ at vendor time. If the schema is upgraded, these
 * fixtures should be re-copied alongside the schema (see
 * SCHEMA_SOURCE_COMMIT in envelope-validator.ts).
 */

import { describe, expect, test } from "bun:test";
import {
  SCHEMA_SOURCE_COMMIT,
  tryParseEnvelope,
  validateEnvelope,
} from "../envelope-validator";
import validEnvelope from "../vendor/__fixtures__/valid-envelope.json" with { type: "json" };
import invalidMissingSovereignty from "../vendor/__fixtures__/invalid-missing-sovereignty.json" with { type: "json" };

describe("envelope-validator", () => {
  test("schema source commit is recorded for upgrade audit", () => {
    expect(SCHEMA_SOURCE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  test("validates the upstream valid example", () => {
    const result = validateEnvelope(validEnvelope);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(result.envelope.sovereignty.classification).toBe("local");
      expect(result.envelope.sovereignty.model_class).toBe("local-only");
    }
  });

  test("rejects the upstream invalid example (missing sovereignty)", () => {
    const result = validateEnvelope(invalidMissingSovereignty);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The Ajv error path or schemaPath should reference sovereignty.
      const surfacesSovereignty = result.errors.some(
        (e) =>
          e.instancePath.includes("sovereignty") ||
          e.schemaPath.includes("sovereignty") ||
          e.params?.missingProperty === "sovereignty",
      );
      expect(surfacesSovereignty).toBe(true);
    }
  });

  test("rejects an envelope with bad sovereignty.classification", () => {
    const bad = {
      ...(validEnvelope as object),
      sovereignty: {
        ...(validEnvelope as { sovereignty: object }).sovereignty,
        classification: "secret", // not in {local, federated, public}
      },
    };
    const result = validateEnvelope(bad);
    expect(result.ok).toBe(false);
  });

  test("rejects an envelope with non-uuid id", () => {
    const bad = { ...(validEnvelope as object), id: "not-a-uuid" };
    const result = validateEnvelope(bad);
    expect(result.ok).toBe(false);
  });

  test("rejects an envelope missing required type field", () => {
    const bad = { ...(validEnvelope as { type?: string } & object) };
    delete (bad as { type?: string }).type;
    const result = validateEnvelope(bad);
    expect(result.ok).toBe(false);
  });

  test("accepts an envelope without optional correlation_id and extensions", () => {
    const minimal = { ...(validEnvelope as object) };
    delete (minimal as { correlation_id?: string }).correlation_id;
    delete (minimal as { extensions?: object }).extensions;
    const result = validateEnvelope(minimal);
    expect(result.ok).toBe(true);
  });

  test("tryParseEnvelope returns the envelope on valid input", () => {
    const env = tryParseEnvelope(validEnvelope);
    expect(env).not.toBeNull();
    expect(env?.type).toBe("ops.deploy.completed");
  });

  test("tryParseEnvelope returns null on invalid input", () => {
    const env = tryParseEnvelope(invalidMissingSovereignty);
    expect(env).toBeNull();
  });

  test("tryParseEnvelope returns null on garbage", () => {
    expect(tryParseEnvelope(null)).toBeNull();
    expect(tryParseEnvelope("a string")).toBeNull();
    expect(tryParseEnvelope(42)).toBeNull();
    expect(tryParseEnvelope({})).toBeNull();
  });

  // signed_by coverage — added per Echo cycle-1 review of #71. The schema
  // defines a oneOf over ed25519 and hub-stamp; without these tests the
  // identity-attestation path is silent. Base64 strings are 88-char ed25519
  // sig length per the schema's minLength constraint.
  const ED25519_SIG = "A".repeat(88);

  test("accepts an envelope with valid ed25519 signed_by", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: {
        method: "ed25519",
        principal: "did:mf:luna",
        signature: ED25519_SIG,
        at: "2026-05-08T09:00:00Z",
      },
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.signed_by?.method).toBe("ed25519");
    }
  });

  test("accepts an envelope with valid hub-stamp signed_by", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: {
        method: "hub-stamp",
        principal: "did:mf:luna",
        stamped_by: "did:mf:hub-eu-1",
        signature: ED25519_SIG,
        at: "2026-05-08T09:00:00Z",
      },
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(true);
    if (result.ok && result.envelope.signed_by?.method === "hub-stamp") {
      expect(result.envelope.signed_by.stamped_by).toBe("did:mf:hub-eu-1");
    }
  });

  test("rejects an ed25519 signed_by missing the signature field", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: {
        method: "ed25519",
        principal: "did:mf:luna",
        // signature: missing
        at: "2026-05-08T09:00:00Z",
      },
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("rejects a hub-stamp signed_by missing stamped_by", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: {
        method: "hub-stamp",
        principal: "did:mf:luna",
        // stamped_by: missing — required for hub-stamp shape
        signature: ED25519_SIG,
        at: "2026-05-08T09:00:00Z",
      },
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("rejects a signed_by with non-DID principal", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: {
        method: "ed25519",
        principal: "not-a-did",
        signature: ED25519_SIG,
        at: "2026-05-08T09:00:00Z",
      },
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });
});
