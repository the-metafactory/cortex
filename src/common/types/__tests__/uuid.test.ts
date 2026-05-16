/**
 * Unit tests for the shared UUID validators (cortex#196).
 *
 * Coverage: strict vs loose semantics + the canary cases
 * (uppercase, malformed, empty, near-miss).
 */

import { describe, expect, test } from "bun:test";
import { isUuid, isUuidLoose } from "../uuid";

describe("isUuid — strict v1-v5", () => {
  test("accepts canonical lowercase v4", () => {
    expect(isUuid("9d2c4e8a-1b3f-4c5d-9e6f-7a8b9c0d1e2f")).toBe(true);
  });

  test("accepts uppercase via case-insensitive flag", () => {
    expect(isUuid("9D2C4E8A-1B3F-4C5D-9E6F-7A8B9C0D1E2F")).toBe(true);
  });

  test("accepts canonical v1 (version=1 nibble)", () => {
    expect(isUuid("9d2c4e8a-1b3f-1c5d-9e6f-7a8b9c0d1e2f")).toBe(true);
  });

  test("rejects v6 (version nibble outside 1-5)", () => {
    expect(isUuid("9d2c4e8a-1b3f-6c5d-9e6f-7a8b9c0d1e2f")).toBe(false);
  });

  test("rejects v7 (version nibble outside 1-5)", () => {
    expect(isUuid("9d2c4e8a-1b3f-7c5d-9e6f-7a8b9c0d1e2f")).toBe(false);
  });

  test("rejects bad variant nibble (c instead of 8/9/a/b)", () => {
    expect(isUuid("9d2c4e8a-1b3f-4c5d-ce6f-7a8b9c0d1e2f")).toBe(false);
  });

  test("rejects non-hex characters", () => {
    expect(isUuid("not-a-uuid-shape-string-here-at-all")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isUuid("")).toBe(false);
  });

  test("rejects truncated UUID", () => {
    expect(isUuid("9d2c4e8a-1b3f-4c5d-9e6f-7a8b9c0d1e2")).toBe(false);
  });
});

describe("isUuidLoose — any hex 8-4-4-4-12", () => {
  test("accepts canonical v4 (overlap with strict)", () => {
    expect(isUuidLoose("9d2c4e8a-1b3f-4c5d-9e6f-7a8b9c0d1e2f")).toBe(true);
  });

  test("accepts v6 (the whole point — strict would reject)", () => {
    expect(isUuidLoose("9d2c4e8a-1b3f-6c5d-9e6f-7a8b9c0d1e2f")).toBe(true);
  });

  test("accepts v7 (the whole point — strict would reject)", () => {
    expect(isUuidLoose("9d2c4e8a-1b3f-7c5d-9e6f-7a8b9c0d1e2f")).toBe(true);
  });

  test("accepts bad-variant-nibble form (looser than strict)", () => {
    expect(isUuidLoose("9d2c4e8a-1b3f-4c5d-ce6f-7a8b9c0d1e2f")).toBe(true);
  });

  test("rejects non-hex characters", () => {
    expect(isUuidLoose("not-a-uuid-shape-string-here-at-all")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isUuidLoose("")).toBe(false);
  });

  test("rejects wrong dash layout", () => {
    expect(isUuidLoose("9d2c4e8a1b3f4c5d9e6f7a8b9c0d1e2f")).toBe(false);
  });
});
