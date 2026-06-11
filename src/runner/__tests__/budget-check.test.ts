/**
 * CO-7 M6 (epic cortex#939) — BudgetCheck seam tests.
 *
 * Asserts the FAIL-CLOSED contract: public work with no declared cost authority
 * REFUSES; a declared per-request cap admits but is flagged `degraded`;
 * local/federated are not budget-gated.
 */

import { describe, test, expect } from "bun:test";

import { checkBudget } from "../budget-check";
import type { AcceptPolicy } from "../../common/types/offering";

const publicAcceptNoCap: AcceptPolicy = {
  kind: "surface",
  surface: "github",
  predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
};

const publicAcceptWithCap: AcceptPolicy = {
  kind: "surface",
  surface: "github",
  predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
  limits: { cost_cents_per_request: 50 },
};

describe("checkBudget — non-public scopes", () => {
  test("local is not budget-gated", () => {
    const d = checkBudget("local", undefined);
    expect(d.budgetOk).toBe(true);
    expect(d.degraded).toBe(false);
  });
  test("federated is not budget-gated", () => {
    const d = checkBudget("federated", {
      kind: "network",
      network: "metafactory",
    });
    expect(d.budgetOk).toBe(true);
    expect(d.degraded).toBe(false);
  });
});

describe("checkBudget — public fail-closed", () => {
  test("public with NO cost authority REFUSES (fail closed)", () => {
    const d = checkBudget("public", publicAcceptNoCap);
    expect(d.budgetOk).toBe(false);
    expect(d.degraded).toBe(false);
    expect(d.reason).toContain("fail-closed");
  });

  test("public with NO accept at all REFUSES", () => {
    const d = checkBudget("public", undefined);
    expect(d.budgetOk).toBe(false);
  });

  test("public with a declared per-request cap admits but is degraded", () => {
    const d = checkBudget("public", publicAcceptWithCap);
    expect(d.budgetOk).toBe(true);
    expect(d.degraded).toBe(true);
    expect(d.reason).toContain("50");
  });
});
