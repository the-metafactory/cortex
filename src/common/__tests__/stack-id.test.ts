import { test, expect, describe } from "bun:test";
import { stackSlugFromStackId } from "../stack-id";

describe("stackSlugFromStackId", () => {
  test("jc/default -> default", () => {
    expect(stackSlugFromStackId("jc/default")).toBe("default");
  });

  test("andreas/meta-factory -> meta-factory", () => {
    expect(stackSlugFromStackId("andreas/meta-factory")).toBe("meta-factory");
  });

  test("bare slug with no slash passes through unchanged", () => {
    expect(stackSlugFromStackId("foo")).toBe("foo");
  });

  test("empty string passes through unchanged", () => {
    expect(stackSlugFromStackId("")).toBe("");
  });

  // network-doctor-lib's PRIOR local impl (`parts.length === 2 ? parts[1] : stackId`)
  // returned "a/b/c" unchanged for this input — a >2-segment id fell through its
  // length check. Adopting this authority fn there DOES change that one
  // degenerate-case result (see PR discussion on #1516/#1531). That's intended:
  // canonical stack.id is always 2-part `{principal}/{slug}`, so no real stack.id
  // ever hits this path — conforming onto the ADR-0004 authority (last segment,
  // mirroring the shell `${id##*/}` step) is the point of this slice, not an
  // accidental behavior change.
  test("multiple slashes: takes the LAST segment (lastIndexOf, not a 2-part split)", () => {
    expect(stackSlugFromStackId("a/b/c")).toBe("c");
  });

  test("trailing slash: last segment is empty", () => {
    expect(stackSlugFromStackId("jc/")).toBe("");
  });
});
