/**
 * IAW CFG.b.3 — unit tests for the shared `nats.subjects` validator
 * (src/common/types/nats-subjects.ts). The schema-level loud-failure behaviour
 * is exercised end-to-end in src/common/config/__tests__/system-layer.test.ts;
 * here we pin the primitives the schema is built from.
 */

import { test, expect, describe } from "bun:test";
import {
  NATS_SUBSCRIBE_SUBJECT_RE,
  invalidSubscribeSubjectReason,
  firstDuplicateSubject,
  NatsSubjectsSchema,
} from "../nats-subjects";

describe("NATS_SUBSCRIBE_SUBJECT_RE — subscribe-pattern grammar", () => {
  const valid = [
    "local.andreas.research.tasks.chat",
    "local.{principal}.{stack}.tasks.*.>",
    "local.{principal}.system.>",
    "federated.research-collab.tasks.code_review",
    "*",
    ">",
    "a.*.b",
    "tasks.*.>",
  ];
  for (const s of valid) {
    test(`accepts "${s}"`, () => {
      expect(NATS_SUBSCRIBE_SUBJECT_RE.test(s)).toBe(true);
      expect(invalidSubscribeSubjectReason(s)).toBeNull();
    });
  }

  const invalid = [
    "",                       // empty
    "local. bad .subject",    // whitespace in segments
    "local.>.tasks",          // `>` not final
    "local..tasks",           // empty segment
    ".leading.dot",           // leading dot
    "trailing.dot.",          // trailing dot
    "UPPER.case",             // uppercase not allowed
    "local.{unknown}.x",      // unknown placeholder token
    "local.{principal}>.x",   // malformed placeholder/wildcard mash
  ];
  for (const s of invalid) {
    test(`rejects "${s}"`, () => {
      expect(invalidSubscribeSubjectReason(s)).not.toBeNull();
    });
  }
});

describe("firstDuplicateSubject", () => {
  test("returns null for a distinct list", () => {
    expect(firstDuplicateSubject(["a.b", "a.c", "d.>"])).toBeNull();
  });
  test("returns the first duplicated pattern", () => {
    expect(firstDuplicateSubject(["a.b", "a.c", "a.b"])).toBe("a.b");
  });
});

describe("NatsSubjectsSchema", () => {
  test("defaults to []", () => {
    expect(NatsSubjectsSchema.parse(undefined)).toEqual([]);
  });
  test("accepts a valid list", () => {
    expect(
      NatsSubjectsSchema.parse(["local.{principal}.{stack}.tasks.*.>"]),
    ).toEqual(["local.{principal}.{stack}.tasks.*.>"]);
  });
  test("rejects a malformed entry", () => {
    expect(() => NatsSubjectsSchema.parse(["bad subject"])).toThrow(
      /not a valid NATS subscribe pattern/i,
    );
  });
  test("rejects a duplicate entry with the first-seen index", () => {
    expect(() => NatsSubjectsSchema.parse(["x.y", "x.y"])).toThrow(
      /duplicate subject pattern.*x\.y.*first seen at index 0/i,
    );
  });
});
