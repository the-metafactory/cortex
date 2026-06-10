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
});
