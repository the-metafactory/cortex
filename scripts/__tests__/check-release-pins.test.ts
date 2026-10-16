import { describe, expect, test } from "bun:test";
import { contractShape, sdkBumpMissing, unlockedGitDeps, untaggedGitPins } from "../check-release-pins";

describe("untaggedGitPins", () => {
  const today = "2026-10-16";

  test("a git dependency pinned to a commit fails, a tag passes, registry ranges are ignored", () => {
    const problems = untaggedGitPins(
      {
        a: "https://github.com/o/a.git#e6c320fadb96873d2a2758664acdd21a918f063c",
        b: "https://github.com/o/b.git#v0.12.0",
        c: "^1.2.3",
        d: "github:o/d",
      },
      {},
      today,
    );
    expect(problems).toEqual([
      "a: https://github.com/o/a.git#e6c320fadb96873d2a2758664acdd21a918f063c is not a release tag",
      "d: github:o/d is not a release tag",
    ]);
  });

  test("an exception covers its exact pin until it expires", () => {
    const pin = "github:o/x#0e4968c6b48bf9887198fa4c5ef34736dc10a68d";
    const exceptions = { x: { pin, reason: "no tags", expires: "2026-12-31" } };
    expect(untaggedGitPins({ x: pin }, exceptions, today)).toEqual([]);
    expect(untaggedGitPins({ x: pin }, exceptions, "2027-01-01")).toEqual(["x: exception expired 2026-12-31 (no tags)"]);
    expect(untaggedGitPins({ x: "github:o/x#1111111" }, exceptions, today)).toEqual(["x: github:o/x#1111111 is not a release tag"]);
  });
});

describe("sdkBumpMissing", () => {
  const base = 'export declare const SURFACE_SDK_VERSION = "1.1.0";\nexport interface A { x: string }\n';

  test("a new exported member without a version bump fails", () => {
    expect(sdkBumpMissing(base, base.replace("x: string", "x: string; y?: boolean"))).toBe(true);
  });

  test("the same change with a bump passes", () => {
    const head = base.replace("x: string", "x: string; y?: boolean").replace("1.1.0", "1.2.0");
    expect(sdkBumpMissing(base, head)).toBe(false);
  });

  test("a doc-comment-only change needs no bump", () => {
    expect(sdkBumpMissing(base, base.replace("export interface", "/** Docs. */\nexport interface"))).toBe(false);
    expect(contractShape("// note\nexport type T = 1;")).toBe("export type T = 1;");
  });
});

describe("release tag shape", () => {
  test("a branch name is not a release tag", () => {
    expect(untaggedGitPins({ x: "github:o/x#main", y: "github:o/y#semver:^1.2.0" }, {}, "2026-10-16")).toEqual([
      "x: github:o/x#main is not a release tag",
    ]);
  });

  test("a contract change after a URL string on the same line still needs a bump", () => {
    const base = 'export declare const SURFACE_SDK_VERSION = "1.1.0";\nexport type U = "https://a" | "b";\n';
    expect(sdkBumpMissing(base, base.replace('| "b"', '| "b" | "c"'))).toBe(true);
  });
});

describe("unlockedGitDeps", () => {
  const deps = { "@o/x": "github:o/x#v1.0.0", y: "^1.0.0" };

  test("passes a tag the lockfile fixes to a commit with an integrity hash", () => {
    const lock = '    "@o/x": ["@o/x@github:o/x#0e4968c", { "dependencies": {} }, "o-x-0e4968c", "sha512-abc=="],\n';
    expect(unlockedGitDeps(deps, lock)).toEqual([]);
  });

  test("fails a git dep the lockfile does not fix", () => {
    expect(unlockedGitDeps(deps, '    "y": ["y@1.0.0", "", {}, "sha512-def=="],\n')).toHaveLength(1);
  });
});
