/**
 * cortex#1503 — subject-set algebra behind the shared-stream subject union.
 */

import { describe, expect, test } from "bun:test";
import { missingSubjects, subjectCovers, subjectsOverlap } from "../subject-set";

describe("subjectCovers", () => {
  test("identical subjects cover each other", () => {
    expect(subjectCovers("local.a.s.tasks.code-review.*", "local.a.s.tasks.code-review.*")).toBe(true);
  });

  test("arc's broad `local.*.*.tasks.code-review.>` covers a stack's `*` pattern", () => {
    expect(
      subjectCovers("local.*.*.tasks.code-review.>", "local.alice.default.tasks.code-review.*"),
    ).toBe(true);
  });

  test("a legacy trailing `>` covers the single-token `*` form (cortex#1199)", () => {
    expect(
      subjectCovers("local.alice.default.tasks.code-review.>", "local.alice.default.tasks.code-review.*"),
    ).toBe(true);
  });

  test("the narrower pattern does not cover the broader one", () => {
    expect(
      subjectCovers("local.alice.default.tasks.code-review.*", "local.*.*.tasks.code-review.>"),
    ).toBe(false);
    expect(
      subjectCovers("local.alice.default.tasks.code-review.*", "local.alice.default.tasks.code-review.>"),
    ).toBe(false);
  });

  test("another stack's subject is not covered", () => {
    expect(
      subjectCovers("local.alice.default.tasks.code-review.*", "local.alice.work.tasks.code-review.*"),
    ).toBe(false);
  });

  test("terminal `>` needs at least one more token", () => {
    expect(subjectCovers("a.b.>", "a.b")).toBe(false);
    expect(subjectCovers("a.b.>", "a.b.c.d")).toBe(true);
  });
});

describe("subjectsOverlap", () => {
  test("two stacks' patterns are disjoint", () => {
    expect(
      subjectsOverlap("local.alice.default.tasks.code-review.*", "local.alice.work.tasks.code-review.*"),
    ).toBe(false);
  });

  test("wildcards that can match a common subject overlap", () => {
    expect(subjectsOverlap("local.*.work.x", "local.alice.*.x")).toBe(true);
    expect(subjectsOverlap("a.>", "a.b.c")).toBe(true);
  });

  test("the Offer (3 task tokens) and Direct (4) patterns are disjoint", () => {
    expect(
      subjectsOverlap("federated.a.s.tasks.code-review.*", "federated.a.s.tasks.*.code-review.>"),
    ).toBe(false);
  });
});

describe("missingSubjects", () => {
  const DEFAULT = "local.alice.default.tasks.code-review.*";
  const WORK = "local.alice.work.tasks.code-review.*";

  test("nothing to add when every desired subject is covered", () => {
    expect(missingSubjects([DEFAULT], [DEFAULT])).toEqual([]);
    expect(missingSubjects(["local.*.*.tasks.code-review.>"], [WORK])).toEqual([]);
  });

  test("a second stack's disjoint subject is missing (safe to add)", () => {
    expect(missingSubjects([DEFAULT], [WORK])).toEqual([WORK]);
  });

  test("a subject that partially overlaps a live one is never proposed", () => {
    // Live `local.alice.*.tasks.code-review.x` overlaps the desired pattern but
    // does not cover it — appending would make the stream's subjects overlap.
    expect(missingSubjects(["local.alice.*.tasks.code-review.x"], [WORK])).toEqual([]);
  });

  test("proposes only additions, whatever else the stream carries", () => {
    expect(missingSubjects([DEFAULT, "local.bob.default.tasks.code-review.*"], [WORK])).toEqual([WORK]);
  });

  test("duplicate desired subjects are proposed once", () => {
    expect(missingSubjects([DEFAULT], [WORK, WORK])).toEqual([WORK]);
  });
});
