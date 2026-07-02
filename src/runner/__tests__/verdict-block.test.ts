/**
 * compass#89 (§4 L3) — unit coverage for the OPTIONAL
 * `confidentiality_lens_ran` field on the shared verdict-block parser
 * (`src/runner/verdict-block.ts`).
 *
 * The field is machine-checkable execution evidence that the Confidentiality
 * lens ran. It is OPTIONAL for wire back-compat: a verdict block emitted before
 * this field existed (or by the sage engine, which defers its lens threading to
 * compass#99) MUST still parse. When present it MUST be a boolean.
 *
 * These tests exercise `parseVerdictBlock` directly (no pipeline harness) so the
 * absent / present-true / present-false / present-wrong-type matrix is pinned in
 * isolation.
 */

import { describe, expect, test } from "bun:test";
import { parseVerdictBlock } from "../verdict-block";

/** A minimal valid verdict block, before the optional field is added. */
const BASE = {
  verdict: "commented",
  summary: "one-line summary",
  github_review_id: 0,
  github_review_url: "",
  submitted_at: "2026-07-02T00:00:00Z",
  commit_id: "deadbeef",
  findings: { blockers: 0, majors: 0, nits: 0 },
  inline_comments: 0,
} as const;

describe("parseVerdictBlock — confidentiality_lens_ran (compass#89)", () => {
  test("absent field parses OK (back-compat) and stays undefined", () => {
    const r = parseVerdictBlock(JSON.stringify(BASE));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.confidentiality_lens_ran).toBeUndefined();
    expect("confidentiality_lens_ran" in r.value).toBe(false);
  });

  test("present true is carried through verbatim", () => {
    const r = parseVerdictBlock(JSON.stringify({ ...BASE, confidentiality_lens_ran: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.confidentiality_lens_ran).toBe(true);
  });

  test("present false is carried through verbatim (NOT coerced to absent)", () => {
    const r = parseVerdictBlock(JSON.stringify({ ...BASE, confidentiality_lens_ran: false }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.confidentiality_lens_ran).toBe(false);
    expect("confidentiality_lens_ran" in r.value).toBe(true);
  });

  test("present-but-wrong-type is a contract error (validate-if-present)", () => {
    const r = parseVerdictBlock(JSON.stringify({ ...BASE, confidentiality_lens_ran: "yes" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toContain("confidentiality_lens_ran must be a boolean");
  });
});
