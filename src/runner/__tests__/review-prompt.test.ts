import { describe, test, expect } from "bun:test";
import { buildReviewPrompt } from "../review-prompt";
import type { ReviewRequestPayload } from "../../bus/review-events";

function payload(over: Partial<ReviewRequestPayload> = {}): ReviewRequestPayload {
  return {
    repo: "the-metafactory/cortex",
    pr: 900,
    reviewer: "sage",
    ...over,
  } as ReviewRequestPayload;
}

describe("buildReviewPrompt (cortex#911)", () => {
  test("names the PR to review", () => {
    const p = buildReviewPrompt({ agentId: "sage", payload: payload() });
    expect(p).toContain("Review PR the-metafactory/cortex#900");
  });

  test("always instructs the terminal fenced json verdict block", () => {
    const p = buildReviewPrompt({ agentId: "sage", payload: payload() });
    expect(p).toContain("```json");
    // every contract field is named so the model emits a parseable block
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
  });

  test("post=true → non-interactive gh pr review, no confirmation", () => {
    const p = buildReviewPrompt({ agentId: "sage", payload: payload({ post: true }) });
    expect(p).toContain("gh pr review");
    expect(p).toContain("Do NOT ask for confirmation");
    expect(p).toMatch(/report the created review's id and url/i);
  });

  test("post falsy → instruct NOT to post + link-less block", () => {
    const p = buildReviewPrompt({ agentId: "sage", payload: payload({ post: false }) });
    expect(p).toContain("Do NOT post");
    expect(p).not.toContain("gh pr review");
  });

  test("post omitted behaves as no-post", () => {
    const p = buildReviewPrompt({ agentId: "sage", payload: payload() });
    expect(p).toContain("Do NOT post");
  });

  test("is pure — identical input yields byte-identical output", () => {
    const a = buildReviewPrompt({ agentId: "sage", payload: payload({ post: true }) });
    const b = buildReviewPrompt({ agentId: "sage", payload: payload({ post: true }) });
    expect(a).toBe(b);
  });
});
