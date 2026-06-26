/**
 * cortex#1230 — dev-worker robustness: branch-collision handling (Bug 1) +
 * post-session commit-state decision (Bug 2).
 *
 * Same shape as `commit-signing.ts`: PURE deciders (`decideBranchAction`,
 * `decidePostSessionAction`) take plain state and return an action, and a thin
 * IO seam (`WorktreeIO`) does the git/gh spawning. The production seam in
 * `dev-consumer-boot.ts` wires `WorktreeIO` to real `git`/`gh`; tests drive the
 * deciders + the orchestration (`createWorktreeHandlingExistingBranch`) with a
 * recording fake and never touch a real repo.
 *
 * ## Bug 1 — branch collision
 * The dispatched branch is a FIXED `feat/{N}-{repo}` (orchestrator-command),
 * so a re-dispatch collides with a prior run's leftover branch and the naive
 * `git worktree add -b <branch>` fails (`a branch named '…' already exists`).
 * {@link createWorktreeHandlingExistingBranch} never hard-fails on an existing
 * branch:
 *   - branch absent                       → create fresh (`-b`).
 *   - branch STALE (no commits ahead of   → delete + recreate fresh. A stale
 *     base AND no open PR)                   leftover is worthless; reclaim it.
 *   - branch has commits OR an open PR    → REUSE it (`git worktree add` with no
 *                                            `-b`) — the warm-resume path: the
 *                                            CC session resumes and continues
 *                                            the in-flight work / open PR.
 *
 * ## Bug 2 — no commits → push refused
 * The pipeline pushes + opens the PR but the AGENT must commit. After the CC
 * session {@link decidePostSessionAction} reads the worktree's git state:
 *   - uncommitted changes present (agent  → COMMIT them (fallback) so the run
 *     forgot to commit)                      isn't lost, then proceed.
 *   - commits ahead, clean tree           → proceed (the agent committed).
 *   - nothing at all                      → a clear typed failure naming "no
 *                                            implementation", NOT forge's
 *                                            confusing "no commits to verify".
 */

// ---------------------------------------------------------------------------
// Bug 1 — branch-collision handling
// ---------------------------------------------------------------------------

/** The git state of the dispatched branch, relative to its base. */
export interface BranchState {
  /** Does a local ref `refs/heads/<branch>` already exist? */
  branchExists: boolean;
  /**
   * Commits on the branch ahead of `origin/<base>`. `"unknown"` when the probe
   * could NOT determine it (a `git rev-list` error) — a fail-SAFE sentinel the
   * decider treats as "do not delete", NEVER coerced to `0`.
   */
  commitsAhead: number | "unknown";
  /**
   * The number of an OPEN PR whose head is this branch, `null` when CONFIRMED
   * none, or `"unknown"` when the probe failed (a `gh` error) — the same
   * fail-SAFE sentinel that forbids the destructive path.
   */
  openPrNumber: number | null | "unknown";
}

/** What {@link createWorktreeHandlingExistingBranch} does about the branch. */
export type BranchAction =
  /** Branch absent — `git worktree add <path> -b <branch> origin/<base>`. */
  | { kind: "create-fresh" }
  /** Branch is a stale leftover — delete it, then create fresh. */
  | { kind: "recreate-stale" }
  /** Branch carries work / an open PR — reuse it (warm-resume); never `-b`. */
  | { kind: "reuse-existing"; openPrNumber: number | null };

/**
 * Decide what to do about a (possibly pre-existing) dispatched branch. PURE.
 *
 * Order is load-bearing, and the invariant is FAIL-SAFE: the destructive path
 * (`recreate-stale` → `git branch -D`) is reachable ONLY when BOTH probes
 * CONFIRMED the branch is worthless — `commitsAhead === 0` AND `openPrNumber ===
 * null`. An OPEN PR, commits-ahead, OR an INDETERMINATE probe (`"unknown"`, e.g.
 * a transient git/gh error) all route to `reuse-existing` — never delete from
 * an unknown state, because unpushed local commits live only in this branch
 * (the warm-resume case Bug 2 creates). When in doubt, keep the branch.
 */
export function decideBranchAction(state: BranchState): BranchAction {
  if (!state.branchExists) return { kind: "create-fresh" };
  // A CONFIRMED open PR always reuses (carry the number for the log).
  if (typeof state.openPrNumber === "number") {
    return { kind: "reuse-existing", openPrNumber: state.openPrNumber };
  }
  // FAIL SAFE: any indeterminate probe ⇒ reuse, NEVER the `git branch -D` path.
  if (state.commitsAhead === "unknown" || state.openPrNumber === "unknown") {
    return { kind: "reuse-existing", openPrNumber: null };
  }
  if (state.commitsAhead > 0) return { kind: "reuse-existing", openPrNumber: null };
  // Both probes CONFIRMED: 0 commits ahead, no open PR → genuinely stale.
  return { kind: "recreate-stale" };
}

/**
 * IO seam — the git/gh operations {@link createWorktreeHandlingExistingBranch}
 * needs. Production wires these to real `git`/`gh` (see `dev-consumer-boot.ts`);
 * tests inject a recording fake. Kept narrow — exactly the verbs the
 * branch-handling orchestration uses.
 */
export interface WorktreeIO {
  /** True iff a local ref `refs/heads/<branch>` exists. */
  branchExists(branch: string): Promise<boolean>;
  /**
   * Count of commits on `<branch>` ahead of `origin/<base>`. MUST return
   * `"unknown"` (not `0`) when the probe cannot determine it — a probe error
   * read as `0` would mis-classify a branch with unpushed commits as stale and
   * delete it. Fail SAFE.
   */
  commitsAhead(branch: string, base: string): Promise<number | "unknown">;
  /**
   * The number of an OPEN PR whose head is `<branch>`, `null` when CONFIRMED
   * none, or `"unknown"` when the probe failed. Same fail-SAFE contract as
   * {@link WorktreeIO.commitsAhead}.
   */
  openPrNumber(branch: string): Promise<number | null | "unknown">;
  /** Prune worktree refs whose directories no longer exist (best-effort). */
  pruneWorktrees(): Promise<void>;
  /** Delete the local branch (`git branch -D <branch>`). */
  deleteBranch(branch: string): Promise<void>;
  /** `git worktree add <path> -b <branch> origin/<base>` — fresh branch. */
  addWorktreeNewBranch(path: string, branch: string, base: string): Promise<void>;
  /** `git worktree add <path> <branch>` — check out the EXISTING branch. */
  addWorktreeExistingBranch(path: string, branch: string): Promise<void>;
}

/** Result of {@link createWorktreeHandlingExistingBranch}. */
export interface CreateWorktreeResult {
  /** The worktree path created (echoes the input). */
  path: string;
  /** Which branch action was taken — surfaced for the boot log. */
  action: BranchAction;
}

/**
 * Create a worktree for `branch` at `path`, handling a PRE-EXISTING branch
 * instead of failing (Bug 1). Composes the IO seam with {@link decideBranchAction}.
 *
 * Prunes stale worktree refs first so a leftover worktree dir that was deleted
 * out from under git (the common cleanup-failure shape) doesn't block a
 * recreate/reuse. A genuinely live worktree still holding the branch will make
 * the underlying `git worktree add` throw — the caller maps that to a typed
 * `cant_do` failure (NOT a crash), which is the acceptable surfaced outcome.
 */
export async function createWorktreeHandlingExistingBranch(
  io: WorktreeIO,
  opts: { branch: string; base: string; path: string },
): Promise<CreateWorktreeResult> {
  const { branch, base, path } = opts;

  // Clear refs to worktree dirs that no longer exist so a recreate/reuse isn't
  // blocked by a half-cleaned prior run. Best-effort — never the failure.
  await io.pruneWorktrees();

  const branchExists = await io.branchExists(branch);
  if (!branchExists) {
    await io.addWorktreeNewBranch(path, branch, base);
    return { path, action: { kind: "create-fresh" } };
  }

  // Branch exists — is it worth keeping? (commits ahead OR an open PR ⇒ reuse).
  const [commitsAhead, openPrNumber] = await Promise.all([
    io.commitsAhead(branch, base),
    io.openPrNumber(branch),
  ]);
  const action = decideBranchAction({ branchExists: true, commitsAhead, openPrNumber });

  switch (action.kind) {
    case "recreate-stale":
      await io.deleteBranch(branch);
      await io.addWorktreeNewBranch(path, branch, base);
      return { path, action };
    case "reuse-existing":
      await io.addWorktreeExistingBranch(path, branch);
      return { path, action };
    case "create-fresh":
      // Unreachable (branchExists is true here) — handled defensively so the
      // switch is exhaustive and a future decider change can't silently skip
      // creating the worktree.
      await io.addWorktreeNewBranch(path, branch, base);
      return { path, action };
  }
}

// ---------------------------------------------------------------------------
// Bug 2 — post-session commit-state decision
// ---------------------------------------------------------------------------

/** The worktree's git state after the CC session, relative to base. */
export interface DevWorktreeStatus {
  /** Commits on the branch ahead of `origin/<base>`. */
  commitsAhead: number;
  /** True when the working tree has uncommitted changes (tracked or untracked). */
  hasUncommittedChanges: boolean;
}

/** What the consumer does after the CC session, before the forge push. */
export type PostSessionAction =
  /** Agent committed (commits ahead, clean tree) — push straight through. */
  | { kind: "proceed" }
  /** Agent edited but left changes uncommitted — fallback-commit, then push. */
  | { kind: "commit-then-proceed" }
  /** Agent produced nothing — fail with a clear "no implementation" reason. */
  | { kind: "fail-no-implementation" };

/**
 * Decide the post-session action from the worktree's git state. PURE.
 *
 * Uncommitted changes ALWAYS win the leftover-commit path (capture the work
 * whether or not earlier commits exist — never lose a partial run). A clean
 * tree with commits ahead proceeds. A clean tree with nothing ahead is the
 * "session produced no implementation" failure.
 */
export function decidePostSessionAction(status: DevWorktreeStatus): PostSessionAction {
  if (status.hasUncommittedChanges) return { kind: "commit-then-proceed" };
  if (status.commitsAhead > 0) return { kind: "proceed" };
  return { kind: "fail-no-implementation" };
}
