/**
 * cortex#2020 — capability dual-accept WINDOW helpers (RFC-0008 §4 follow-ups,
 * Wave 3 of epic myelin#286).
 *
 * These tests pin the WINDOW invariant: the helpers only ever WIDEN. Grammar
 * acceptance equals today's legacy behavior exactly (underscore ids still
 * accepted); segment-prefix matching is ADDED on top of exact membership
 * without removing any exact match. The flag-day TIGHTEN is NOT exercised here
 * (it does not happen in this window).
 */

import { describe, expect, test } from "bun:test";
import {
  capabilityIdAcceptedInWindow,
  capabilitySegmentPrefixMatches,
  anyAdvertisedSegmentPrefixMatches,
} from "../capability-window";
import { CAPABILITY_ID_REGEX } from "../capability";

describe("capabilityIdAcceptedInWindow — dual-accept grammar (RFC-0008 §4.1)", () => {
  test("ratified kebab ids are accepted", () => {
    expect(capabilityIdAcceptedInWindow("code-review")).toBe(true);
    expect(capabilityIdAcceptedInWindow("code-review.typescript")).toBe(true);
    expect(capabilityIdAcceptedInWindow("dev.implement")).toBe(true);
  });

  test("underscore ids STILL accepted during the window (legacy disjunct)", () => {
    // The ratified ./wire grammar rejects `_`; the window keeps folding them via
    // the legacy CAPABILITY_ID_REGEX so nothing that folds today stops folding.
    expect(capabilityIdAcceptedInWindow("code_review")).toBe(true);
    expect(capabilityIdAcceptedInWindow("image-gen.dall_e_3")).toBe(true);
  });

  test("window acceptance equals the legacy regex EXACTLY (subset property)", () => {
    // The ratified grammar is a strict subset of the legacy regex, so the
    // disjunction must never differ from the legacy regex alone — that is what
    // makes the window a behavior-preserving no-op until flag-day R.
    const samples = [
      "code-review",
      "code-review.typescript",
      "code_review",
      "image-gen.dall_e_3",
      "dev.implement",
      "a", // single char — legacy accepts, ./wire rejects (min 2); window = legacy
      "a.b", // single-char segments — same
      "trailing-", // legacy accepts trailing hyphen, ./wire rejects
      "Code-Review", // uppercase — both reject
      "code review", // whitespace — both reject
      ".leading-dot",
      "trailing-dot.",
      "2d-render", // digit prefix — both reject
      "",
    ];
    for (const s of samples) {
      expect(capabilityIdAcceptedInWindow(s)).toBe(CAPABILITY_ID_REGEX.test(s));
    }
  });

  test("ids ungrammatical under BOTH grammars are rejected", () => {
    expect(capabilityIdAcceptedInWindow("Code-Review")).toBe(false);
    expect(capabilityIdAcceptedInWindow("code review")).toBe(false);
    expect(capabilityIdAcceptedInWindow("")).toBe(false);
    expect(capabilityIdAcceptedInWindow(".leading")).toBe(false);
  });
});

describe("capabilitySegmentPrefixMatches — ratified §4.2 directional matcher", () => {
  test("a shallower requirement matches a deeper advertisement", () => {
    expect(capabilitySegmentPrefixMatches("code-review", "code-review.typescript")).toBe(true);
    expect(capabilitySegmentPrefixMatches("code-review", "code-review")).toBe(true);
  });

  test("a deeper requirement does NOT match a shallower advertisement", () => {
    expect(capabilitySegmentPrefixMatches("code-review.typescript", "code-review")).toBe(false);
  });

  test("segment-boundary, not raw string prefix (masking case)", () => {
    expect(capabilitySegmentPrefixMatches("code-rev", "code-review")).toBe(false);
  });

  test("malformed (underscore) ids never match here — false, not throw", () => {
    // Underscore ids fail the ratified grammar, so the matcher yields false; the
    // caller's exact-string membership is what keeps such ids matching today.
    expect(capabilitySegmentPrefixMatches("code_review", "code_review")).toBe(false);
  });
});

describe("anyAdvertisedSegmentPrefixMatches — the ADDED consumer disjunct", () => {
  test("adds a deeper-specialization match without touching exact membership", () => {
    const advertised = ["code-review.typescript.strict"];
    // Today's exact membership would NOT match `code-review.typescript`…
    expect(advertised.includes("code-review.typescript")).toBe(false);
    // …but the added segment-prefix disjunct does (the deeper advertiser qualifies).
    expect(anyAdvertisedSegmentPrefixMatches("code-review.typescript", advertised)).toBe(true);
  });

  test("does not fabricate a match the ratified matcher would deny", () => {
    // A generic advertiser does NOT satisfy a specific requirement via this
    // disjunct (that path is the consumers' bespoke `includes('code-review')`).
    expect(anyAdvertisedSegmentPrefixMatches("code-review.typescript", ["code-review"])).toBe(false);
  });

  test("empty advertised set yields no match", () => {
    expect(anyAdvertisedSegmentPrefixMatches("dev.implement", [])).toBe(false);
  });
});
