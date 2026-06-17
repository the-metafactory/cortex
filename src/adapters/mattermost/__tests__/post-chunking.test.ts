/**
 * Regression: a long Mattermost post (a composed flow's YAML, a big advisory)
 * was DROPPED with HTTP 500 "app.post.save.app_error" — the MM save layer 500s
 * well below the API's MaxPostSize. postReply now chunks under that ceiling, so
 * the content survives as a thread instead of vanishing (the symptom: Yarrow's
 * compose ack showed "Run this flow?" with no flow YAML/name above it).
 */

import { describe, expect, test } from "bun:test";
import { splitForMattermost, sanitizeForMattermost } from "../poller";

const MM_MAX_CHARS = 3800;

describe("splitForMattermost", () => {
  test("short message → single chunk, unchanged", () => {
    expect(splitForMattermost("hello")).toEqual(["hello"]);
  });

  test("long message → multiple chunks, each under the ceiling", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}: ${"x".repeat(40)}`).join("\n");
    expect(long.length).toBeGreaterThan(MM_MAX_CHARS);
    const chunks = splitForMattermost(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MM_MAX_CHARS);
    // No content lost (modulo the \n join boundaries).
    expect(chunks.join("\n").replace(/\n+/g, "\n")).toContain("line 399");
  });

  test("a single oversized line (no newlines) is hard-sliced under the ceiling", () => {
    const oneLine = "y".repeat(MM_MAX_CHARS * 3 + 17);
    const chunks = splitForMattermost(oneLine);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MM_MAX_CHARS);
    expect(chunks.join("").length).toBe(oneLine.length); // nothing dropped
  });
});

describe("sanitizeForMattermost", () => {
  test("strips save-rejected control chars, keeps newlines and tabs", () => {
    const dirty = "a\u0001b\u0007cde\n\tkeep\u007f";
    const clean = sanitizeForMattermost(dirty);
    expect(clean).toBe("abcde\n\tkeep");
  });
});
