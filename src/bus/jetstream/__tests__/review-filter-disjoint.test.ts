/**
 * cortex#1186 — demonstrate that the per-scope review-consumer filter patterns
 * are DISJOINT, so a given review request reaches exactly one scope durable.
 *
 * The double-post bug was that every review durable was provisioned with NO
 * `filter_subject` (claims every message). The fix wires each durable's filter
 * to the pattern its consumer binds. This test exercises the SAME production
 * builder cortex provisions from (`reviewScopePatterns`), so it proves the real
 * filters are disjoint — not hand-copied sample strings (sage cortex#1187 R2).
 *
 * Self-contained NATS subject matcher (token wildcards `*` and trailing `>`).
 */
import { describe, expect, test } from "bun:test";
import { reviewScopePatterns } from "../review-subjects";

/** Minimal NATS subject/pattern match: `*` = exactly one token, `>` = one-or-more
 *  trailing tokens (only valid as the last token). */
function subjectMatches(subject: string, pattern: string): boolean {
  const subTokens = subject.split(".");
  const patTokens = pattern.split(".");
  for (let i = 0; i < patTokens.length; i++) {
    const p = patTokens[i]!;
    if (p === ">") return i < subTokens.length; // ≥1 trailing token required
    if (i >= subTokens.length) return false;
    if (p !== "*" && p !== subTokens[i]) return false;
  }
  return subTokens.length === patTokens.length;
}

// The REAL scope patterns cortex provisions from (principal=jc, stack=clawbox).
const { local: LOCAL, federatedOffer: FED_OFFER, federatedDirect: FED_DIRECT } =
  reviewScopePatterns("jc", "clawbox");

describe("cortex#1186 — review-consumer filter patterns are disjoint by scope", () => {
  test("a local review request matches ONLY the local filter", () => {
    const subject = "local.jc.clawbox.tasks.code-review.typescript";
    expect(subjectMatches(subject, LOCAL)).toBe(true);
    expect(subjectMatches(subject, FED_OFFER)).toBe(false);
    expect(subjectMatches(subject, FED_DIRECT)).toBe(false);
  });

  test("a federated review request never matches the local filter", () => {
    const offer = "federated.jc.clawbox.tasks.code-review.typescript";
    const direct = "federated.jc.clawbox.tasks.@did-mf-x.code-review.typescript";
    expect(subjectMatches(offer, LOCAL)).toBe(false);
    expect(subjectMatches(direct, LOCAL)).toBe(false);
    // federated-offer and federated-direct cover different shapes (the direct
    // one carries the `@{did}` token the offer pattern has no slot for).
    expect(subjectMatches(offer, FED_OFFER)).toBe(true);
    expect(subjectMatches(direct, FED_OFFER)).toBe(false);
    expect(subjectMatches(direct, FED_DIRECT)).toBe(true);
  });

  test("the local and federated prefixes can never both match one subject", () => {
    for (const subject of [
      "local.jc.clawbox.tasks.code-review.typescript",
      "federated.jc.clawbox.tasks.code-review.python",
      "federated.jc.clawbox.tasks.@did-mf-sage.code-review.rust",
    ]) {
      const matched = [LOCAL, FED_OFFER, FED_DIRECT].filter((p) => subjectMatches(subject, p));
      expect(matched.length).toBeLessThanOrEqual(1);
    }
  });
});
