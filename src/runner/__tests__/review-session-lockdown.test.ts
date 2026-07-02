/**
 * CO-7 M2 (epic cortex#939) — least-privilege review session lockdown tests.
 *
 * Asserts: local is passthrough (byte-identical); wider scope replaces the
 * permissive guardrails with the locked profile (minimal tools, explicit
 * write/spawn denials, tight bash allowlist, scratch-only dirs, settings
 * isolation, the bash-guard engagement channel); an absent scratch dir fails
 * CLOSED to no-dirs-granted (never the principal's cwd); the baseline is never
 * mutated.
 */

import { describe, test, expect } from "bun:test";

import {
  lockdownReviewSessionOpts,
  LOCKED_REVIEW_ALLOWED_TOOLS,
  LOCKED_REVIEW_DISALLOWED_TOOLS,
  LOCKED_REVIEW_BASH_ALLOWLIST,
  type ReviewSessionOpts,
} from "../review-session-lockdown";

const baseline: ReviewSessionOpts = {
  agentId: "echo",
  agentName: "Echo",
  allowedTools: ["Read", "Edit", "Write", "Bash", "Task"],
  allowedDirs: ["/Users/principal/repo", "/Users/principal/.config"],
  cwd: "/Users/principal/repo",
  timeoutMs: 600000,
  bashAllowlist: { rules: [{ pattern: "^git( |$)" }], repos: [] },
};

describe("lockdownReviewSessionOpts — local passthrough", () => {
  test("local scope returns the baseline UNCHANGED (same reference)", () => {
    const out = lockdownReviewSessionOpts({ baseline, scope: "local", agentId: "echo" });
    expect(out).toBe(baseline); // byte-identical — same object.
  });
});

describe("lockdownReviewSessionOpts — wider scope lockdown", () => {
  const locked = lockdownReviewSessionOpts({
    baseline,
    scope: "public",
    agentId: "echo",
    scratchDir: "/tmp/review-scratch",
  });

  test("does not mutate the baseline", () => {
    expect(baseline.allowedTools).toEqual(["Read", "Edit", "Write", "Bash", "Task"]);
    expect(baseline.allowedDirs).toEqual([
      "/Users/principal/repo",
      "/Users/principal/.config",
    ]);
  });

  test("replaces allowedTools with the minimal read+bash set (no Edit/Write/Task)", () => {
    expect(locked.allowedTools).toEqual([...LOCKED_REVIEW_ALLOWED_TOOLS]);
    expect(locked.allowedTools).not.toContain("Edit");
    expect(locked.allowedTools).not.toContain("Write");
    expect(locked.allowedTools).not.toContain("Task");
  });

  test("explicitly disallows write/spawn tools (defense-in-depth)", () => {
    expect(locked.disallowedTools).toEqual([...LOCKED_REVIEW_DISALLOWED_TOOLS]);
    for (const t of ["Edit", "Write", "NotebookEdit", "Task"]) {
      expect(locked.disallowedTools).toContain(t);
    }
  });

  test("installs the tight review bash allowlist (no broad git/gh/bun)", () => {
    expect(locked.bashAllowlist).toEqual(LOCKED_REVIEW_BASH_ALLOWLIST);
    // The tight allowlist must NOT carry a bare `^git( |$)` (broad git).
    const patterns = locked.bashAllowlist?.rules.map((r) => r.pattern) ?? [];
    expect(patterns).not.toContain("^git( |$)");
    expect(patterns).not.toContain("^gh( |$)");
    // It DOES carry the forge review post + read-only git inspection.
    expect(patterns.some((p) => p.includes("gh pr (review"))).toBe(true);
    expect(patterns.some((p) => p.includes("git (show|diff"))).toBe(true);
  });

  test("confines allowedDirs to the scratch dir only", () => {
    expect(locked.allowedDirs).toEqual(["/tmp/review-scratch"]);
  });

  test("turns settings isolation ON (strip ambient hooks/secrets)", () => {
    expect(locked.settingsIsolation).toBe(true);
  });

  test("sets the bash-guard engagement channel to the agent id", () => {
    expect(locked.channel).toBe("echo");
  });

  test("preserves non-security baseline fields (agentName, timeout)", () => {
    expect(locked.agentName).toBe("Echo");
    expect(locked.timeoutMs).toBe(600000);
  });
});

describe("lockdownReviewSessionOpts — fail-closed scratch dir", () => {
  test("an absent scratch dir grants NO dirs (never the principal cwd)", () => {
    const locked = lockdownReviewSessionOpts({
      baseline,
      scope: "public",
      agentId: "echo",
      // scratchDir omitted
    });
    expect(locked.allowedDirs).toEqual([]);
    // crucially NOT the baseline cwd / config dir.
    expect(locked.allowedDirs).not.toContain("/Users/principal/repo");
    expect(locked.allowedDirs).not.toContain("/Users/principal/.config");
  });

  test("federated scope is locked down the same way as public", () => {
    const locked = lockdownReviewSessionOpts({
      baseline,
      scope: "federated",
      agentId: "echo",
      scratchDir: "/tmp/s",
    });
    expect(locked.allowedTools).toEqual([...LOCKED_REVIEW_ALLOWED_TOOLS]);
    expect(locked.settingsIsolation).toBe(true);
    expect(locked.allowedDirs).toEqual(["/tmp/s"]);
  });
});

describe("LOCKED_REVIEW_BASH_ALLOWLIST — read-only gh api/repo for grounding + exposure (compass#98 C2)", () => {
  // Mirror the bash-guard's per-segment matcher exactly: bash-guard.hook.ts tests
  // each split command segment with `new RegExp(rule.pattern, "i")`.
  const permits = (cmd: string): boolean =>
    LOCKED_REVIEW_BASH_ALLOWLIST.rules.some((r) => new RegExp(r.pattern, "i").test(cmd));

  test("PERMITS the F6 grounding contents fetch for each canonical doc", () => {
    expect(permits("gh api repos/o/r/contents/CONTEXT.md")).toBe(true);
    expect(permits("gh api repos/o/r/contents/docs/architecture.md")).toBe(true);
    expect(permits("gh api repos/o/r/contents/compass/ecosystem/CONTEXT-MAP.md")).toBe(true);
    // deep owner/repo slugs still bind
    expect(permits("gh api repos/the-metafactory/cortex/contents/CONTEXT.md")).toBe(true);
  });

  test("PERMITS the pipe-free raw-media fetch form the F6 directive instructs", () => {
    expect(
      permits('gh api repos/o/r/contents/CONTEXT.md -H "Accept: application/vnd.github.raw"'),
    ).toBe(true);
  });

  test("PERMITS the bare read form with no trailing args", () => {
    expect(permits("gh api repos/o/r/contents/CONTEXT.md")).toBe(true);
  });

  test("DENIES the contents write/delete primitive (cortex#1420 BLOCK — gh api is method-polymorphic)", () => {
    // `gh api` has no verb of its own — the HTTP method comes from `--method`/`-X`,
    // and `/contents/<path>` is a write/delete-capable GitHub endpoint. A
    // start-anchored-only pattern let these through; the fix end-anchors the
    // pattern to the one documented read shape.
    expect(
      permits("gh api repos/o/r/contents/x --method PUT -f message=m -f content=YQ=="),
    ).toBe(false);
    expect(permits("gh api repos/o/r/contents/x -X DELETE -f message=m -f sha=abc")).toBe(false);
    expect(permits("gh api repos/o/r/contents/x -f a=b")).toBe(false);
  });

  test("PERMITS the #89/#96 exposure check (was DENIED under lockdown before C2)", () => {
    expect(permits("gh repo view the-metafactory/cortex --json visibility")).toBe(true);
    expect(permits("gh repo view o/r --json visibility")).toBe(true);
  });

  test("still DENIES non-contents gh api + secret/credential reads", () => {
    expect(permits("gh api user")).toBe(false);
    expect(permits("gh secret list")).toBe(false);
    expect(permits("gh api repos/o/r/actions/secrets")).toBe(false);
    expect(permits("gh api repos/o/r/actions/secrets/FOO")).toBe(false);
    expect(permits("gh api")).toBe(false);
    expect(permits("gh auth token")).toBe(false);
    expect(permits("gh auth status")).toBe(false);
  });

  test("the gh repo entry is anchored to `--json visibility` ONLY (no broader gh repo)", () => {
    expect(permits("gh repo view o/r --json nameWithOwner")).toBe(false);
    expect(permits("gh repo delete o/r")).toBe(false);
    expect(permits("gh repo clone o/r")).toBe(false);
    expect(permits("gh repo view o/r")).toBe(false); // no --json visibility
  });

  test("the two new entries are tightly anchored — no bare `gh api` / `gh repo`", () => {
    const patterns = LOCKED_REVIEW_BASH_ALLOWLIST.rules.map((r) => r.pattern);
    // the widened entries exist…
    expect(patterns.some((p) => p.includes("contents"))).toBe(true);
    expect(patterns.some((p) => p.includes("--json visibility"))).toBe(true);
    // …and NOTHING broader leaked in (a bare `^gh api`/`^gh repo` would open the
    // whole read API — secrets, auth, actions — to an untrusted reviewer).
    expect(patterns).not.toContain("^gh api");
    expect(patterns).not.toContain("^gh api ");
    expect(patterns).not.toContain("^gh api( |$)");
    expect(patterns).not.toContain("^gh repo");
    expect(patterns).not.toContain("^gh repo ");
    expect(patterns).not.toContain("^gh repo( |$)");
  });

  test("pre-existing forge-review + read-only git entries are preserved", () => {
    // Regression: widening must not drop the CO-7 M2 baseline rules.
    expect(permits("gh pr review 900 --approve")).toBe(true);
    expect(permits("gh pr diff 900")).toBe(true);
    expect(permits("glab mr diff 12")).toBe(true);
    expect(permits("git show HEAD")).toBe(true);
    // still no broad git / gh
    expect(permits("git push origin main")).toBe(false);
    expect(permits("gh issue create")).toBe(false);
  });
});
