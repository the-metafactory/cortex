import { describe, expect, test } from "bun:test";
import { deskApiVersionProblems, type DeskApiSnapshot } from "../check-desk-api";

const BASE: DeskApiSnapshot = {
  version: "1.2.0",
  routes: ["GET /api/desk", "POST /api/desk/goal"],
  phraseCodes: ["a.one", "a.two"],
  vocabulary: ["RULE_ACTIONS: \"archive\"", "RULE_ACTIONS: \"snooze\""],
};

const head = (patch: Partial<DeskApiSnapshot>): DeskApiSnapshot => ({ ...BASE, ...patch });

describe("deskApiVersionProblems", () => {
  test("passes an unchanged contract at an unchanged version", () => {
    expect(deskApiVersionProblems(BASE, BASE)).toEqual([]);
  });

  test.each([
    ["a route", { routes: ["GET /api/desk"] }],
    ["a phrase code", { phraseCodes: ["a.one"] }],
    ["a vocabulary value", { vocabulary: ["RULE_ACTIONS: \"archive\""] }],
  ] as const)("requires a major bump when %s is removed", (_label, patch) => {
    const problems = deskApiVersionProblems(BASE, head(patch));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("A major bump is required");
    expect(deskApiVersionProblems(BASE, head({ ...patch, version: "1.3.0" }))).toHaveLength(1);
    expect(deskApiVersionProblems(BASE, head({ ...patch, version: "2.0.0" }))).toEqual([]);
  });

  test("names the removed route", () => {
    expect(deskApiVersionProblems(BASE, head({ routes: ["GET /api/desk"] }))[0]).toContain("POST /api/desk/goal");
  });

  test("requires a minor bump when an entry is only added, and passes once it is bumped", () => {
    const added = { routes: [...BASE.routes, "GET /api/desk/new"] };
    const problems = deskApiVersionProblems(BASE, head(added));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("A minor bump is required");
    expect(deskApiVersionProblems(BASE, head({ ...added, version: "1.2.1" }))).toHaveLength(1);
    expect(deskApiVersionProblems(BASE, head({ ...added, version: "1.3.0" }))).toEqual([]);
  });

  test("rejects a version that is not MAJOR.MINOR.PATCH", () => {
    expect(deskApiVersionProblems(BASE, head({ version: "one" }))).toHaveLength(1);
  });
});
