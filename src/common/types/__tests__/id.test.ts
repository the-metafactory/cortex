/**
 * Unit tests for the shared letter-prefix kebab id regex (cortex#150).
 *
 * Coverage: canonical id shapes + the trilogy's edge cases (leading
 * digit, leading hyphen, uppercase, empty).
 */

import { describe, expect, test } from "bun:test";
import { LETTER_PREFIX_ID_REGEX } from "../id";

describe("LETTER_PREFIX_ID_REGEX", () => {
  test("accepts a single letter", () => {
    expect(LETTER_PREFIX_ID_REGEX.test("a")).toBe(true);
  });

  test("accepts canonical agent ids", () => {
    expect(LETTER_PREFIX_ID_REGEX.test("luna")).toBe(true);
    expect(LETTER_PREFIX_ID_REGEX.test("echo")).toBe(true);
    expect(LETTER_PREFIX_ID_REGEX.test("team-research")).toBe(true);
  });

  test("accepts ids with internal digits (letter-prefix rule)", () => {
    expect(LETTER_PREFIX_ID_REGEX.test("agent-2026")).toBe(true);
    expect(LETTER_PREFIX_ID_REGEX.test("a1")).toBe(true);
    expect(LETTER_PREFIX_ID_REGEX.test("team-42-research")).toBe(true);
  });

  test("rejects leading digit (cortex#141 trilogy)", () => {
    expect(LETTER_PREFIX_ID_REGEX.test("2bad-prefix")).toBe(false);
    expect(LETTER_PREFIX_ID_REGEX.test("123")).toBe(false);
  });

  test("rejects leading hyphen", () => {
    expect(LETTER_PREFIX_ID_REGEX.test("-luna")).toBe(false);
  });

  test("rejects uppercase", () => {
    expect(LETTER_PREFIX_ID_REGEX.test("Luna")).toBe(false);
    expect(LETTER_PREFIX_ID_REGEX.test("LUNA")).toBe(false);
  });

  test("rejects whitespace", () => {
    expect(LETTER_PREFIX_ID_REGEX.test("my agent")).toBe(false);
    expect(LETTER_PREFIX_ID_REGEX.test(" luna")).toBe(false);
    expect(LETTER_PREFIX_ID_REGEX.test("luna ")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(LETTER_PREFIX_ID_REGEX.test("")).toBe(false);
  });

  test("rejects underscore (kebab is hyphen-only)", () => {
    expect(LETTER_PREFIX_ID_REGEX.test("my_agent")).toBe(false);
  });

  test("rejects dotted segments (capability ids use a different regex)", () => {
    expect(LETTER_PREFIX_ID_REGEX.test("code-review.typescript")).toBe(false);
  });
});
