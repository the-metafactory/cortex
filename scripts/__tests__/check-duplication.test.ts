import { describe, expect, test } from "bun:test";
import { type Clone, clonesPerFile, compare, total } from "../check-duplication";

const side = (name: string) => ({ name, start: 1, end: 6 });
const clone = (a: string, b: string): Clone => ({ firstFile: side(a), secondFile: side(b) });

describe("clonesPerFile", () => {
  test("counts a cross-file clone on both files and a same-file clone once", () => {
    expect(clonesPerFile([clone("a.ts", "b.ts"), clone("a.ts", "a.ts")])).toEqual({ "a.ts": 2, "b.ts": 1 });
  });
});

describe("compare", () => {
  test("a new copy of an existing block grows both files", () => {
    const { grown, shrunk } = compare({ "a.ts": 1 }, { "a.ts": 2, "c.ts": 1 });
    expect(grown).toEqual(["a.ts: 1 -> 2", "c.ts: 0 -> 1"]);
    expect(shrunk).toEqual([]);
  });

  test("a removed copy is reported so the baseline gets lowered", () => {
    expect(compare({ "a.ts": 2, "b.ts": 1 }, { "a.ts": 1 }).shrunk).toEqual(["a.ts: 2 -> 1", "b.ts: 1 -> 0"]);
  });

  test("equal counts pass", () => {
    expect(compare({ "a.ts": 3 }, { "a.ts": 3 })).toEqual({ grown: [], shrunk: [] });
  });
});

test("total sums clone sides", () => {
  expect(total({ "a.ts": 2, "b.ts": 3 })).toBe(5);
});
