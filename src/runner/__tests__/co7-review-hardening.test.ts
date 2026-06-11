/**
 * CO-7 (epic cortex#939) — review-hardening composer tests.
 *
 * Asserts the per-scope composition: M1 prompt selection, M2 session selection,
 * M6 compliance (budget) composition, M4 egress guard — each short-circuiting to
 * the pre-CO-7 behaviour on `local`.
 */

import { describe, test, expect } from "bun:test";

import type { ReviewRequestPayload } from "../../bus/review-events";
import type { AcceptPolicy } from "../../common/types/offering";
import { buildReviewPrompt } from "../review-prompt";
import { UNTRUSTED_CONTENT_PREAMBLE } from "../untrusted-content-boundary";
import {
  reviewPromptForScope,
  reviewSessionOptsForScope,
  resolveComplianceOk,
  makeEgressGuard,
} from "../co7-review-hardening";

const payload: ReviewRequestPayload = {
  repo: "the-metafactory/cortex",
  pr: 7,
  reviewer: "echo",
  title: "Add X",
};

describe("reviewPromptForScope (M1)", () => {
  test("local ⇒ the plain trusted prompt (byte-identical)", () => {
    const builder = reviewPromptForScope("local");
    expect(builder(payload)).toBe(buildReviewPrompt(payload));
  });
  test("public ⇒ the untrusted-content boundary prompt", () => {
    const builder = reviewPromptForScope("public");
    expect(builder(payload).startsWith(UNTRUSTED_CONTENT_PREAMBLE)).toBe(true);
  });
  test("federated ⇒ the untrusted-content boundary prompt", () => {
    const builder = reviewPromptForScope("federated");
    expect(builder(payload).startsWith(UNTRUSTED_CONTENT_PREAMBLE)).toBe(true);
  });
});

describe("reviewSessionOptsForScope (M2)", () => {
  const baseline = { agentId: "echo", allowedTools: ["Read", "Write"], cwd: "/repo" };
  test("local ⇒ baseline unchanged", () => {
    expect(
      reviewSessionOptsForScope({ baseline, scope: "local", agentId: "echo" }),
    ).toBe(baseline);
  });
  test("public ⇒ locked (no Write, settings isolation)", () => {
    const out = reviewSessionOptsForScope({
      baseline,
      scope: "public",
      agentId: "echo",
      scratchDir: "/tmp/s",
    });
    expect(out.allowedTools).not.toContain("Write");
    expect(out.settingsIsolation).toBe(true);
    expect(out.allowedDirs).toEqual(["/tmp/s"]);
  });
});

describe("resolveComplianceOk (M6)", () => {
  const publicNoCap: AcceptPolicy = {
    kind: "surface",
    surface: "github",
    predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
  };
  const publicWithCap: AcceptPolicy = {
    ...publicNoCap,
    limits: { cost_cents_per_request: 25 },
  };

  test("local ⇒ prior default passes through (true)", () => {
    expect(
      resolveComplianceOk({ scope: "local", accept: undefined }).complianceOk,
    ).toBe(true);
  });

  test("public with no cost authority ⇒ fail-closed (false)", () => {
    const r = resolveComplianceOk({
      scope: "public",
      accept: publicNoCap,
      priorComplianceOk: true,
    });
    expect(r.complianceOk).toBe(false);
  });

  test("public with a cost cap ⇒ budget admits, but prior=false still refuses", () => {
    // M6 can only tighten: a false prior (the CO-5-pending secure default)
    // dominates even when the budget admits.
    const r = resolveComplianceOk({
      scope: "public",
      accept: publicWithCap,
      priorComplianceOk: false,
    });
    expect(r.complianceOk).toBe(false);
  });

  test("public with a cost cap AND prior=true ⇒ admits, degraded", () => {
    const r = resolveComplianceOk({
      scope: "public",
      accept: publicWithCap,
      priorComplianceOk: true,
    });
    expect(r.complianceOk).toBe(true);
    expect(r.degraded).toBe(true);
  });
});

describe("makeEgressGuard (M4)", () => {
  test("local never blocks (no scan)", () => {
    const guard = makeEgressGuard("local");
    expect(guard("ghp_abcdefghijklmnopqrstuvwxyz0123456789").block).toBe(false);
  });
  test("public blocks a leak", () => {
    const guard = makeEgressGuard("public");
    const r = guard("token ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r.block).toBe(true);
  });
  test("public passes clean prose", () => {
    const guard = makeEgressGuard("public");
    expect(guard("### Approved\n\nLGTM, clean diff.").block).toBe(false);
  });
});
