import { describe, expect, test } from "bun:test";
import { grownRules } from "../suppressions-guard.ts";

const base = {
  "src/a.ts": { "cortex/no-comments": { count: 3 }, "no-empty": { count: 1 } },
  "src/b.ts": { "cortex/no-comments": { count: 2 } },
};

describe("suppressions guard", () => {
  test("passes when the baseline shrinks", () => {
    expect(grownRules(base, { "src/a.ts": { "cortex/no-comments": { count: 1 } } })).toEqual([]);
  });

  test("passes a rename that moves counts to a new path", () => {
    const head = { "src/a-moved.ts": base["src/a.ts"], "src/b.ts": base["src/b.ts"] };
    expect(grownRules(base, head)).toEqual([]);
  });

  test("fails when --suppress-all adds violations", () => {
    const head = { ...base, "src/c.ts": { "cortex/no-comments": { count: 4 } } };
    expect(grownRules(base, head)).toEqual(["cortex/no-comments: 5 -> 9"]);
  });

  test("fails on a rule the base never suppressed", () => {
    const head = { ...base, "src/b.ts": { "cortex/no-comments": { count: 2 }, "@typescript-eslint/no-explicit-any": { count: 1 } } };
    expect(grownRules(base, head)).toEqual(["@typescript-eslint/no-explicit-any: 0 -> 1"]);
  });

  test("passes the first baseline of a rule the base config does not enable", () => {
    const head = { ...base, "src/b.ts": { "cortex/no-comments": { count: 2 }, "no-restricted-syntax": { count: 2 } } };
    expect(grownRules(base, head, (rule) => rule !== "no-restricted-syntax")).toEqual([]);
  });

  test("fails a rule the base config enables, though the base never suppressed it", () => {
    const head = { ...base, "src/b.ts": { "cortex/no-comments": { count: 2 }, "no-restricted-syntax": { count: 2 } } };
    expect(grownRules(base, head, () => true)).toEqual(["no-restricted-syntax: 0 -> 2"]);
  });
});
