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
