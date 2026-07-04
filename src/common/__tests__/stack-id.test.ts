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

  test("multiple slashes: takes the LAST segment (lastIndexOf, not a 2-part split)", () => {
    expect(stackSlugFromStackId("a/b/c")).toBe("c");
  });

  test("trailing slash: last segment is empty", () => {
    expect(stackSlugFromStackId("jc/")).toBe("");
  });
});
