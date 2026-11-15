import { describe, expect, test } from "bun:test";
import { unusedPerFile } from "../check-unused-exports";
import { compare } from "../lib/ratchet";

describe("check-unused-exports", () => {
  test("counts unused exports and types per file, and leaves out files with none", () => {
    const counts = unusedPerFile([
      { file: "src/b.ts", exports: [{ name: "one" }], types: [{ name: "Two" }] },
      { file: "src/a.ts", exports: [{ name: "three" }], types: [] },
      { file: "src/c.ts", exports: [], types: [] },
    ]);
    expect(counts).toEqual({ "src/a.ts": 1, "src/b.ts": 2 });
    expect(Object.keys(counts)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a file that gains an export with no importer grows past the baseline (#3097 routineAddArgs)", () => {
    const after = unusedPerFile([{ file: "src/w.ts", exports: [{ name: "conversationRoutineId" }, { name: "routineAddArgs" }], types: [{ name: "Deps" }] }]);
    expect(compare({ "src/w.ts": 2 }, after).grown).toEqual(["src/w.ts: 2 -> 3"]);
  });
});
