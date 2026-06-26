/**
 * cortex#1230 — tests for `runner/dev-worktree.ts`.
 *
 *   Bug 1 — branch-collision handling:
 *     - `decideBranchAction` truth table (pure).
 *     - `createWorktreeHandlingExistingBranch` orchestration against a recording
 *       fake `WorktreeIO`: absent → create-fresh; stale → delete+recreate;
 *       commits-ahead → reuse; open-PR → reuse. A re-dispatch with a stale
 *       branch NEVER hard-fails.
 *   Bug 2 — post-session commit decision:
 *     - `decidePostSessionAction` truth table (pure).
 */

import { describe, expect, test } from "bun:test";
import {
  decideBranchAction,
  decidePostSessionAction,
  createWorktreeHandlingExistingBranch,
  type WorktreeIO,
  type BranchState,
  type BranchAction,
} from "../dev-worktree";

// ---------------------------------------------------------------------------
// Recording fake WorktreeIO
// ---------------------------------------------------------------------------

interface RecordingIO extends WorktreeIO {
  calls: string[];
}

function recordingIO(state: {
  branchExists: boolean;
  commitsAhead?: number | "unknown";
  openPrNumber?: number | null | "unknown";
}): RecordingIO {
  const calls: string[] = [];
  return {
    calls,
    branchExists: async () => {
      calls.push("branchExists");
      return state.branchExists;
    },
    commitsAhead: async () => {
      calls.push("commitsAhead");
      return state.commitsAhead ?? 0;
    },
    openPrNumber: async () => {
      calls.push("openPrNumber");
      return state.openPrNumber ?? null;
    },
    pruneWorktrees: async () => {
      calls.push("pruneWorktrees");
    },
    deleteBranch: async () => {
      calls.push("deleteBranch");
    },
    addWorktreeNewBranch: async () => {
      calls.push("addWorktreeNewBranch");
    },
    addWorktreeExistingBranch: async () => {
      calls.push("addWorktreeExistingBranch");
    },
  };
}

const OPTS = { branch: "feat/1196-cortex", base: "main", path: "/tmp/Cortex-x" };

// ---------------------------------------------------------------------------
// Bug 1 — decideBranchAction (pure)
// ---------------------------------------------------------------------------

describe("decideBranchAction", () => {
  const cases: { name: string; state: BranchState; expectKind: BranchAction["kind"] }[] = [
    {
      name: "absent → create-fresh",
      state: { branchExists: false, commitsAhead: 0, openPrNumber: null },
      expectKind: "create-fresh",
    },
    {
      name: "exists, no commits, no PR → recreate-stale",
      state: { branchExists: true, commitsAhead: 0, openPrNumber: null },
      expectKind: "recreate-stale",
    },
    {
      name: "exists with commits, no PR → reuse-existing",
      state: { branchExists: true, commitsAhead: 3, openPrNumber: null },
      expectKind: "reuse-existing",
    },
    {
      name: "exists with an open PR (even 0 commits ahead) → reuse-existing",
      state: { branchExists: true, commitsAhead: 0, openPrNumber: 57 },
      expectKind: "reuse-existing",
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(decideBranchAction(c.state).kind).toBe(c.expectKind);
    });
  }

  test("an open PR wins over commits-ahead and carries the PR number", () => {
    const action = decideBranchAction({ branchExists: true, commitsAhead: 9, openPrNumber: 42 });
    expect(action).toEqual({ kind: "reuse-existing", openPrNumber: 42 });
  });

  // FAIL-SAFE: an indeterminate probe must NEVER reach recreate-stale.
  test("commitsAhead unknown (probe failed) → reuse-existing, never delete", () => {
    expect(
      decideBranchAction({ branchExists: true, commitsAhead: "unknown", openPrNumber: null }).kind,
    ).toBe("reuse-existing");
  });

  test("openPrNumber unknown (probe failed) → reuse-existing, never delete", () => {
    expect(
      decideBranchAction({ branchExists: true, commitsAhead: 0, openPrNumber: "unknown" }).kind,
    ).toBe("reuse-existing");
  });

  test("both probes unknown → reuse-existing (when in doubt, keep the branch)", () => {
    expect(
      decideBranchAction({
        branchExists: true,
        commitsAhead: "unknown",
        openPrNumber: "unknown",
      }).kind,
    ).toBe("reuse-existing");
  });

  test("a CONFIRMED open PR still wins even when commitsAhead is unknown", () => {
    expect(
      decideBranchAction({ branchExists: true, commitsAhead: "unknown", openPrNumber: 7 }),
    ).toEqual({ kind: "reuse-existing", openPrNumber: 7 });
  });

  test("recreate-stale requires BOTH probes confirmed (0 commits AND no PR)", () => {
    expect(
      decideBranchAction({ branchExists: true, commitsAhead: 0, openPrNumber: null }).kind,
    ).toBe("recreate-stale");
  });
});

// ---------------------------------------------------------------------------
// Bug 1 — createWorktreeHandlingExistingBranch (orchestration)
// ---------------------------------------------------------------------------

describe("createWorktreeHandlingExistingBranch", () => {
  test("absent branch → prune then `-b` create-fresh", async () => {
    const io = recordingIO({ branchExists: false });
    const result = await createWorktreeHandlingExistingBranch(io, OPTS);

    expect(result.action.kind).toBe("create-fresh");
    expect(result.path).toBe("/tmp/Cortex-x");
    expect(io.calls).toEqual(["pruneWorktrees", "branchExists", "addWorktreeNewBranch"]);
  });

  test("stale existing branch → delete + recreate (re-dispatch does NOT hard-fail)", async () => {
    const io = recordingIO({ branchExists: true, commitsAhead: 0, openPrNumber: null });
    const result = await createWorktreeHandlingExistingBranch(io, OPTS);

    expect(result.action.kind).toBe("recreate-stale");
    expect(io.calls).toContain("deleteBranch");
    expect(io.calls).toContain("addWorktreeNewBranch");
    // Never the existing-branch (reuse) path for a stale branch.
    expect(io.calls).not.toContain("addWorktreeExistingBranch");
  });

  test("branch with commits → reuse the existing branch (warm-resume, no `-b`)", async () => {
    const io = recordingIO({ branchExists: true, commitsAhead: 2, openPrNumber: null });
    const result = await createWorktreeHandlingExistingBranch(io, OPTS);

    expect(result.action.kind).toBe("reuse-existing");
    expect(io.calls).toContain("addWorktreeExistingBranch");
    expect(io.calls).not.toContain("deleteBranch");
    expect(io.calls).not.toContain("addWorktreeNewBranch");
  });

  test("branch with an open PR → reuse, surfacing the PR number", async () => {
    const io = recordingIO({ branchExists: true, commitsAhead: 0, openPrNumber: 88 });
    const result = await createWorktreeHandlingExistingBranch(io, OPTS);

    expect(result.action).toEqual({ kind: "reuse-existing", openPrNumber: 88 });
    expect(io.calls).toContain("addWorktreeExistingBranch");
    expect(io.calls).not.toContain("deleteBranch");
  });

  // FAIL-SAFE (regression guard for the major review finding): a probe that
  // FAILS (commitsAhead/openPrNumber → "unknown") must REUSE the branch, never
  // `git branch -D` it. Locks in "when in doubt, never delete unpushed work".
  test("commitsAhead probe failed (unknown) → reuse, branch is NEVER deleted", async () => {
    const io = recordingIO({ branchExists: true, commitsAhead: "unknown", openPrNumber: null });
    const result = await createWorktreeHandlingExistingBranch(io, OPTS);

    expect(result.action.kind).toBe("reuse-existing");
    expect(io.calls).toContain("addWorktreeExistingBranch");
    expect(io.calls).not.toContain("deleteBranch");
    expect(io.calls).not.toContain("addWorktreeNewBranch");
  });

  test("both probes failed (unknown) → reuse, branch is NEVER deleted", async () => {
    const io = recordingIO({
      branchExists: true,
      commitsAhead: "unknown",
      openPrNumber: "unknown",
    });
    const result = await createWorktreeHandlingExistingBranch(io, OPTS);

    expect(result.action.kind).toBe("reuse-existing");
    expect(io.calls).not.toContain("deleteBranch");
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — decidePostSessionAction (pure)
// ---------------------------------------------------------------------------

describe("decidePostSessionAction", () => {
  test("commits ahead, clean tree → proceed", () => {
    expect(
      decidePostSessionAction({ commitsAhead: 1, hasUncommittedChanges: false }).kind,
    ).toBe("proceed");
  });

  test("uncommitted changes → commit-then-proceed (even with commits already ahead)", () => {
    expect(
      decidePostSessionAction({ commitsAhead: 0, hasUncommittedChanges: true }).kind,
    ).toBe("commit-then-proceed");
    expect(
      decidePostSessionAction({ commitsAhead: 2, hasUncommittedChanges: true }).kind,
    ).toBe("commit-then-proceed");
  });

  test("nothing ahead, clean tree → fail-no-implementation", () => {
    expect(
      decidePostSessionAction({ commitsAhead: 0, hasUncommittedChanges: false }).kind,
    ).toBe("fail-no-implementation");
  });
});
