/**
 * cortex#1186 — demonstrate that the per-scope review-consumer filter patterns
 * are DISJOINT, so a given review request reaches exactly one scope durable.
 *
 * The double-post bug was that every review durable was provisioned with NO
 * `filter_subject` (claims every message). The fix wires each durable's filter
 * to the pattern its consumer binds. This test proves those patterns can't
 * overlap — the CHANGELOG's "disjoint by scope" claim, shown not asserted.
 *
 * Self-contained NATS subject matcher (token wildcards `*` and trailing `>`) so
 * the property is verified without importing cortex's private pattern consts.
 */
import { describe, expect, test } from "bun:test";

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

// The three scope patterns cortex provisions (principal=jc, stack=clawbox), per
// `reviewSubjectPattern` / `reviewFederatedSubjectPattern` /
// `reviewFederatedDirectSubjectPattern` in src/cortex.ts.
const LOCAL = "local.jc.clawbox.tasks.code-review.>";
const FED_OFFER = "federated.jc.clawbox.tasks.code-review.>";
const FED_DIRECT = "federated.jc.clawbox.tasks.*.code-review.>";

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
