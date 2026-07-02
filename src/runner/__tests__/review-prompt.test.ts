import { describe, test, expect } from "bun:test";
import { buildReviewPrompt } from "../review-prompt";
import type { ReviewRequestPayload } from "../../bus/review-events";

function payload(over: Partial<ReviewRequestPayload> = {}): ReviewRequestPayload {
  return {
    repo: "the-metafactory/cortex",
    pr: 900,
    reviewer: "sage",
    ...over,
  };
}

/** Pull the LAST fenced ```json block out of the prompt (mirrors the pipeline). */
function lastJsonBlock(text: string): string | null {
  const re = /```json\s*\r?\n([\s\S]*?)\r?\n```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    if (m[1] !== undefined) blocks.push(m[1]);
    m = re.exec(text);
  }
  return blocks.length === 0 ? null : (blocks[blocks.length - 1] ?? null);
}

describe("buildReviewPrompt (cortex#911)", () => {
  test("names the PR to review", () => {
    expect(buildReviewPrompt(payload())).toContain("Review PR the-metafactory/cortex#900");
  });

  test("the embedded example block is VALID JSON (cortex#917 blocker)", () => {
    // The prompt tells the model to emit a block parsed with JSON.parse; the
    // example it shows must therefore itself be valid JSON, or a model copying
    // the "exact shape" reproduces the no-verdict failure this fixes.
    const block = lastJsonBlock(buildReviewPrompt(payload()));
    expect(block).not.toBeNull();
    expect(() => JSON.parse(block!)).not.toThrow();
  });

  test("names every contract field + the allowed enum values in prose", () => {
    const p = buildReviewPrompt(payload());
    for (const field of [
      "verdict",
      "summary",
      "github_review_id",
      "github_review_url",
      "submitted_at",
      "commit_id",
      "findings",
      "inline_comments",
    ]) {
      expect(p).toContain(field);
    }
    expect(p).toContain("LAST such block");
    // allowed values stated in prose, OUTSIDE the JSON example
    expect(p).toContain('"approved", "changes-requested", or');
  });

  test("post=true on GitHub → non-interactive gh pr review, no confirmation", () => {
    const p = buildReviewPrompt(payload({ post: true })); // forge omitted ⇒ github
    expect(p).toContain("gh pr review");
    expect(p).not.toContain("glab");
    expect(p).toContain("Do NOT ask for confirmation");
    // id/url is conditional ("if the forge returns…") — honest for note-only forges
    expect(p).toMatch(/if the forge returns a review\/note id and url/i);
  });

  test("post=true on GitLab → glab, not gh (cortex#917 round 3)", () => {
    const p = buildReviewPrompt(payload({ post: true, forge: "gitlab" }));
    expect(p).toContain("glab");
    expect(p).not.toContain("gh pr review");
    expect(p).toContain("MR"); // GitLab vocabulary, not "PR"
  });

  test("post falsy → instruct NOT to post + no post CLI", () => {
    const p = buildReviewPrompt(payload({ post: false }));
    expect(p).toContain("Do NOT post");
    expect(p).not.toContain("gh pr review");
    expect(p).not.toContain("glab");
  });

  test("post omitted behaves as no-post", () => {
    expect(buildReviewPrompt(payload())).toContain("Do NOT post");
  });

  test("is pure — identical input yields byte-identical output", () => {
    expect(buildReviewPrompt(payload({ post: true }))).toBe(buildReviewPrompt(payload({ post: true })));
  });

  test("is pure even with a flavor stamped (compass#89)", () => {
    expect(buildReviewPrompt(payload({ flavor: "security" }))).toBe(
      buildReviewPrompt(payload({ flavor: "security" })),
    );
  });
});

describe("buildReviewPrompt — flavor → primary lens (compass#89 drift-1)", () => {
  // THE load-bearing regression test. Before the fix, the flavor never reached
  // the prompt, so `code-review.security` and `code-review.typescript` produced
  // a BYTE-IDENTICAL prompt (the flavor-inert SEV-1). If this ever passes again
  // by being equal, drift-1 has reopened.
  test("security-flavor prompt !== typescript-flavor prompt", () => {
    const security = buildReviewPrompt(payload({ flavor: "security" }));
    const typescript = buildReviewPrompt(payload({ flavor: "typescript" }));
    expect(security).not.toBe(typescript);
  });

  test("security selects the Security lens as the primary lens", () => {
    const p = buildReviewPrompt(payload({ flavor: "security" }));
    expect(p).toContain("**Security** lens as the primary lens");
  });

  test("confidentiality selects the Confidentiality lens as the primary lens", () => {
    const p = buildReviewPrompt(payload({ flavor: "confidentiality" }));
    expect(p).toContain("**Confidentiality** lens as the primary lens");
  });

  test("an unmapped flavor falls back to the FullReview primary lens", () => {
    const p = buildReviewPrompt(payload({ flavor: "typescript" }));
    expect(p).toContain("**FullReview** lens as the primary lens");
  });

  test("an unstamped payload (no flavor) falls back to FullReview", () => {
    const p = buildReviewPrompt(payload());
    expect(p).toContain("**FullReview** lens as the primary lens");
  });

  test("confidentiality primary directive differs from the always-on exposure mention", () => {
    // The confidentiality flavor names Confidentiality as the PRIMARY lens, and
    // the always-on exposure block ALSO mentions the Confidentiality lens for
    // every flavor. They must be distinct strings so the primary-lens signal is
    // not merely the ever-present exposure mention.
    const conf = buildReviewPrompt(payload({ flavor: "confidentiality" }));
    const ts = buildReviewPrompt(payload({ flavor: "typescript" }));
    expect(conf).toContain("**Confidentiality** lens as the primary lens");
    expect(ts).not.toContain("**Confidentiality** lens as the primary lens");
  });
});

describe("buildReviewPrompt — always-on exposure + confidentiality (compass#89 §4 L3)", () => {
  const FLAVORS = [
    undefined,
    "generic",
    "typescript",
    "security",
    "confidentiality",
  ] as const;

  for (const flavor of FLAVORS) {
    test(`exposure instruction is present for flavor=${flavor ?? "(none)"} (fires on EVERY flavor)`, () => {
      const p = buildReviewPrompt(payload(flavor === undefined ? {} : { flavor }));
      // The runtime gh check the reviewer must run.
      expect(p).toContain("gh repo view the-metafactory/cortex --json visibility");
      // Fail-closed exposure semantics.
      expect(p).toContain("EXPOSED");
      expect(p).toMatch(/errors, rate-limits, or returns\s+an unknown\/empty visibility/);
      // Never-quote rule (redaction discipline baked into the prompt).
      expect(p).toContain("NEVER quote suspected");
      expect(p).toContain("`file:line`");
    });
  }

  test("emits the machine-checkable confidentiality_lens_ran verdict field", () => {
    const p = buildReviewPrompt(payload({ flavor: "confidentiality" }));
    expect(p).toContain("confidentiality_lens_ran");
    // …and the sample block stays valid JSON with the new field present.
    const block = lastJsonBlock(p);
    expect(block).not.toBeNull();
    const parsed = JSON.parse(block!) as Record<string, unknown>;
    expect(parsed).toHaveProperty("confidentiality_lens_ran");
    expect(typeof parsed.confidentiality_lens_ran).toBe("boolean");
  });

  test("builder stays PURE — it never actually shells out (no runtime gh call)", () => {
    // Determinism guard: the exposure check is an INSTRUCTION to the reviewer,
    // not a side effect of the builder. Same payload in → identical string out.
    expect(buildReviewPrompt(payload({ flavor: "confidentiality" }))).toBe(
      buildReviewPrompt(payload({ flavor: "confidentiality" })),
    );
  });
});
