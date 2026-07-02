import { describe, test, expect } from "bun:test";
import { buildReviewPrompt, workflowForFlavor } from "../review-prompt";
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

describe("workflowForFlavor — flavor → CodeReview workflow (compass#96 F3)", () => {
  test("security → SecurityReview", () => {
    expect(workflowForFlavor("security")).toBe("SecurityReview");
  });
  test("hardening → HardeningReview", () => {
    expect(workflowForFlavor("hardening")).toBe("HardeningReview");
  });
  test("skill-quality → SkillReview", () => {
    expect(workflowForFlavor("skill-quality")).toBe("SkillReview");
  });
  test("confidentiality → FullReview (F3 decision: no separate ConfidentialityReview)", () => {
    // The always-on §4 L3 exposure block already makes the Confidentiality lens
    // primary on every review, so the confidentiality flavor runs FullReview.
    expect(workflowForFlavor("confidentiality")).toBe("FullReview");
  });
  test("language flavors → FullReview", () => {
    for (const f of ["generic", "typescript", "python", "rust", "go", "sql", "docs"] as const) {
      expect(workflowForFlavor(f)).toBe("FullReview");
    }
  });
  test("an unstamped flavor (undefined) → FullReview", () => {
    expect(workflowForFlavor(undefined)).toBe("FullReview");
  });
});

describe("buildReviewPrompt — contractual workflow invocation (compass#96 F3)", () => {
  test("emits the CONTRACTUAL 'Invoke the CodeReview skill' directive", () => {
    const p = buildReviewPrompt(payload({ flavor: "security" }));
    expect(p).toContain("Invoke the CodeReview skill");
  });

  test("security names the SecurityReview workflow in the directive", () => {
    const p = buildReviewPrompt(payload({ flavor: "security" }));
    expect(p).toContain("**SecurityReview** workflow");
  });

  test("hardening names the HardeningReview workflow", () => {
    const p = buildReviewPrompt(payload({ flavor: "hardening" }));
    expect(p).toContain("**HardeningReview** workflow");
  });

  test("skill-quality names the SkillReview workflow", () => {
    const p = buildReviewPrompt(payload({ flavor: "skill-quality" }));
    expect(p).toContain("**SkillReview** workflow");
  });

  test("a language flavor names the FullReview workflow", () => {
    const p = buildReviewPrompt(payload({ flavor: "typescript" }));
    expect(p).toContain("**FullReview** workflow");
  });

  test("an unstamped payload (no flavor) names the FullReview workflow", () => {
    const p = buildReviewPrompt(payload());
    expect(p).toContain("**FullReview** workflow");
  });

  test("confidentiality names the FullReview workflow (F3 decision)", () => {
    const p = buildReviewPrompt(payload({ flavor: "confidentiality" }));
    expect(p).toContain("**FullReview** workflow");
  });

  // THE load-bearing drift-1 regression (compass#89, preserved through F3):
  // a flavor that names a DEDICATED workflow must not produce the same prompt
  // as a language flavor. If these are ever byte-equal, flavor routing is inert.
  test("security-flavor prompt !== typescript-flavor prompt", () => {
    const security = buildReviewPrompt(payload({ flavor: "security" }));
    const typescript = buildReviewPrompt(payload({ flavor: "typescript" }));
    expect(security).not.toBe(typescript);
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

describe("buildReviewPrompt — CONTEXT.md/ADR grounding (compass#98 F6)", () => {
  test("emits the grounding directive on every review", () => {
    const p = buildReviewPrompt(payload());
    expect(p).toContain(
      "Ground this review in the TARGET repo's own documented architecture",
    );
  });

  test("names all three canonical grounding docs (skill ArchitectureDocs §1)", () => {
    const p = buildReviewPrompt(payload());
    expect(p).toContain("CONTEXT.md");
    expect(p).toContain("docs/architecture.md");
    expect(p).toContain("compass/ecosystem/CONTEXT-MAP.md");
  });

  test("instructs the PIPE-FREE raw-media gh api fetch (M2 guard forbids pipes)", () => {
    const p = buildReviewPrompt(payload());
    // The un-piped raw-media form the widened lockdown allowlist (C2) permits.
    expect(p).toContain(
      'gh api repos/<owner>/<repo>/contents/<path> -H "Accept: application/vnd.github.raw"',
    );
    // …and explicitly steers OFF the ArchitectureDocs `| base64 -d` pipe, which
    // rejectsChaining would block before the allowlist is consulted.
    expect(p).toContain("base64 -d");
    expect(p).toMatch(/bash guard forbids pipes/i);
  });

  test("instructs the _Avoid_ alias + M1–M7 layer-direction cross-check", () => {
    const p = buildReviewPrompt(payload());
    expect(p).toContain("_Avoid_");
    expect(p).toMatch(/layer boundary in the wrong direction/i);
  });

  test("requires the pinned, greppable provenance line (identical shape across carriers)", () => {
    const p = buildReviewPrompt(payload());
    expect(p).toContain(
      "architecture-docs: CONTEXT.md (loaded|not-found), docs/architecture.md (loaded|not-found), CONTEXT-MAP.md (loaded|not-found)",
    );
    // The canonical line uses the hyphenated `(not-found)` token, not `(missing)`
    // — enforced by the pinned shape above (the prompt also explicitly names the
    // forbidden `(missing)`/`(absent)` variants as guidance, so we cannot assert
    // their global absence; the pinned-shape match is the real contract).
    expect(p).toContain("CONTEXT-MAP.md (loaded|not-found)");
  });

  test("grounding sits BETWEEN the lens directive and the exposure block", () => {
    const p = buildReviewPrompt(payload({ flavor: "security" }));
    const lensIdx = p.indexOf("Invoke the CodeReview skill");
    const groundIdx = p.indexOf("Ground this review in the TARGET repo");
    const exposureIdx = p.indexOf(
      "Before reviewing, determine the target repo's exposure",
    );
    expect(lensIdx).toBeGreaterThanOrEqual(0);
    expect(exposureIdx).toBeGreaterThanOrEqual(0);
    expect(groundIdx).toBeGreaterThan(lensIdx);
    expect(exposureIdx).toBeGreaterThan(groundIdx);
  });

  test("never-quote redaction discipline is carried into the grounding step too", () => {
    const p = buildReviewPrompt(payload());
    expect(p).toContain("NEVER quote suspected confidential content");
  });

  test("builder stays PURE with grounding (same input → byte-identical output)", () => {
    expect(buildReviewPrompt(payload({ flavor: "typescript" }))).toBe(
      buildReviewPrompt(payload({ flavor: "typescript" })),
    );
  });

  test("grounding is flavor-independent, yet drift-1 (security ≠ typescript) still holds", () => {
    const security = buildReviewPrompt(payload({ flavor: "security" }));
    const typescript = buildReviewPrompt(payload({ flavor: "typescript" }));
    // The whole prompts still differ (the lens directive names a distinct
    // workflow) — drift-1 stays pinned shut.
    expect(security).not.toBe(typescript);
    // …but the grounding directive itself is identical across flavors.
    const ground = "Ground this review in the TARGET repo's own documented architecture";
    expect(security).toContain(ground);
    expect(typescript).toContain(ground);
  });
});
