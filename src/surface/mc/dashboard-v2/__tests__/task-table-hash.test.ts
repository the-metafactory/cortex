/**
 * Tests for the F-8 task-table hash (de)serializer.
 *
 * Pins the legacy `readHashFilters` / `writeHashFilters` round-trip
 * shape (`dashboard/index.html` lines ~2453-2503). The hash is principal
 * input — a hand-edited URL must never crash the parser, and an empty
 * filter+sort state must round-trip to the empty string (don't pollute
 * the URL with `#tasks?` for the default view).
 */

import { describe, it, expect } from "bun:test";
import {
  defaultHashState,
  parseHash,
  serializeHash,
} from "../lib/task-table-hash";

describe("parseHash", () => {
  it("returns defaults for empty hash", () => {
    expect(parseHash("")).toEqual(defaultHashState());
  });

  it("returns defaults for non-#tasks hashes (other apps' slots)", () => {
    expect(parseHash("#a/12345")).toEqual(defaultHashState());
  });

  it("parses priorities CSV, ignoring out-of-range entries", () => {
    const r = parseHash("#tasks?p=0,2,9,foo");
    expect(Array.from(r.filters.priorities).sort()).toEqual([0, 2]);
  });

  it("parses age=N for positive integers, defaults to 0 otherwise", () => {
    expect(parseHash("#tasks?age=15").filters.ageMinMinutes).toBe(15);
    expect(parseHash("#tasks?age=-5").filters.ageMinMinutes).toBe(0);
    expect(parseHash("#tasks?age=junk").filters.ageMinMinutes).toBe(0);
  });

  it("parses closed=1 as true, anything else as false", () => {
    expect(parseHash("#tasks?closed=1").filters.includeClosed).toBe(true);
    expect(parseHash("#tasks?closed=0").filters.includeClosed).toBe(false);
    expect(parseHash("#tasks?closed=true").filters.includeClosed).toBe(false);
  });

  it("parses search and preserves spaces", () => {
    expect(parseHash("#tasks?q=fix%20webhook").filters.search).toBe("fix webhook");
  });

  it("parses sort=key:dir for known keys", () => {
    const r = parseHash("#tasks?sort=priority:desc");
    expect(r.sort).toEqual({ key: "priority", dir: "desc" });
  });

  it("ignores unknown sort keys", () => {
    expect(parseHash("#tasks?sort=foo:asc").sort).toEqual({ key: "default", dir: "asc" });
  });

  it("defaults sort dir to asc when missing", () => {
    expect(parseHash("#tasks?sort=age").sort).toEqual({ key: "age", dir: "asc" });
  });
});

describe("serializeHash", () => {
  it("returns empty string for default state (don't pollute URL)", () => {
    expect(serializeHash(defaultHashState())).toBe("");
  });

  it("serializes priorities sorted numerically", () => {
    const out = serializeHash({
      ...defaultHashState(),
      filters: {
        ...defaultHashState().filters,
        priorities: new Set([2, 0, 1]),
      },
    });
    expect(out).toBe("#tasks?p=0%2C1%2C2");
  });

  it("serializes age, closed, search and sort together", () => {
    const out = serializeHash({
      filters: {
        priorities: new Set(),
        ageMinMinutes: 5,
        search: "webhook",
        includeClosed: true,
        iterationId: null,
      },
      sort: { key: "title", dir: "desc" },
    });
    // URLSearchParams ordering is insertion-defined; just check each key is present.
    expect(out.startsWith("#tasks?")).toBe(true);
    expect(out).toContain("age=5");
    expect(out).toContain("closed=1");
    expect(out).toContain("q=webhook");
    expect(out).toContain("sort=title%3Adesc");
  });

  // -----------------------------------------------------------------
  // F-16 — iteration filter (`?iter=<id>`) round-trip
  // -----------------------------------------------------------------

  it("F-16 — parseHash reads ?iter=<id> into iterationId", () => {
    const r = parseHash("#tasks?iter=01HFGT1234567890ABCDEFG");
    expect(r.filters.iterationId).toBe("01HFGT1234567890ABCDEFG");
  });

  it("F-16 — parseHash treats empty/whitespace ?iter= as null (no filter)", () => {
    expect(parseHash("#tasks?iter=").filters.iterationId).toBeNull();
    // URLSearchParams unescapes %20 to a single space.
    expect(parseHash("#tasks?iter=%20").filters.iterationId).toBeNull();
  });

  it("F-16 — defaultHashState seeds iterationId: null (no pin)", () => {
    expect(defaultHashState().filters.iterationId).toBeNull();
  });

  it("F-16 — serializeHash emits ?iter=<id> when a pin is set", () => {
    const out = serializeHash({
      ...defaultHashState(),
      filters: { ...defaultHashState().filters, iterationId: "it-42" },
    });
    expect(out).toContain("iter=it-42");
  });

  it("F-16 — serializeHash omits ?iter= when null (canonical empty stays empty)", () => {
    expect(serializeHash(defaultHashState())).toBe("");
  });

  it("F-16 — round-trips iterationId alongside other filters", () => {
    const start = {
      filters: {
        priorities: new Set([0]),
        ageMinMinutes: 0,
        search: "",
        includeClosed: false,
        iterationId: "it-42",
      },
      sort: { key: "default" as const, dir: "asc" as const },
    };
    const out = parseHash(serializeHash(start));
    expect(out.filters.iterationId).toBe("it-42");
    expect(Array.from(out.filters.priorities)).toEqual([0]);
  });

  it("round-trips a non-trivial state via parseHash → serializeHash → parseHash", () => {
    const start = {
      filters: {
        priorities: new Set([0, 2]),
        ageMinMinutes: 30,
        search: "fix",
        includeClosed: true,
        iterationId: null,
      },
      sort: { key: "state" as const, dir: "asc" as const },
    };
    const serialized = serializeHash(start);
    const parsed = parseHash(serialized);
    expect(Array.from(parsed.filters.priorities).sort()).toEqual([0, 2]);
    expect(parsed.filters.ageMinMinutes).toBe(30);
    expect(parsed.filters.search).toBe("fix");
    expect(parsed.filters.includeClosed).toBe(true);
    expect(parsed.sort).toEqual({ key: "state", dir: "asc" });
  });
});
