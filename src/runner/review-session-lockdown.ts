/**
 * CO-7 M2 (epic cortex#939) — **least-privilege review session** for a
 * federated/public-scope review.
 *
 * ## The threat (design §6 attack #1, ADR-0008 DD-CO-6)
 *
 * The scariest injection outcome is **tool / capability escalation**: a review
 * session with bash/file-write/sibling-capability access is coaxed by crafted
 * PR content into executing commands, writing files, or reaching a higher
 * capability (`dev.implement`, `merge.approve`). On the principal's own machine
 * that is RCE-adjacent. A public reviewer therefore must run with the MINIMAL
 * toolset that lets it do its job and nothing more: read the diff, post a
 * review. NO bash beyond the forge-review CLI, NO arbitrary file write, NO
 * other-repo access, NO secrets, NO sibling-capability invocation.
 *
 * ## What M2 does
 *
 * {@link lockdownReviewSessionOpts} takes the baseline review `CCSessionOpts`
 * (from `buildReviewSessionOpts` in `cortex.ts`) and, for a wider-scope review,
 * REPLACES the permissive guardrails with a locked, allow-list-only profile:
 *
 *   - **`allowedTools`** — read-family + the forge-review post only. No `Edit`,
 *     `Write`, `NotebookEdit`, no `Task`/sub-agent spawn, no MCP write tools.
 *   - **`bashAllowlist`** — a TIGHT allowlist: read-only inspection (`git
 *     show/diff/log`, `cat`, `ls`, …) + the forge review post (`gh pr review`,
 *     `gh pr diff`, `gh pr view`, `glab`). NO general `git`/`bun`/`gh` (the dev
 *     path's broad allowlist is the HIGHER-authority profile and must NOT leak
 *     into a public review). Anything else is denied by `bash-guard.hook.ts`.
 *   - **`disallowedTools`** — belt-and-braces explicit denials of the
 *     write/spawn tools even if a future baseline `allowedTools` widens.
 *   - **`allowedDirs`** — SCRATCH ONLY (the caller passes the per-review scratch
 *     dir). The reviewer cannot read or write outside it, so it cannot reach the
 *     principal's config, other repos, or secrets on disk.
 *   - **`groveChannel`** — set to the agent id so `bash-guard.hook.ts`'s Gate-1
 *     engagement precondition is met (without a channel the guard pass()es
 *     through on every Bash command — the same disengagement the dev-consumer
 *     boot fixed). A locked allowlist with a disengaged guard is no lock at all.
 *   - **`settingsIsolation`** (`CORTEX_CC_SETTINGS_ISOLATION`) — ON, so ambient
 *     principal hooks/settings/secrets are stripped from the session env: the
 *     reviewer runs in a clean settings sandbox, not the principal's own.
 *
 * ## Scope gradient (defenses scale with offer-scope)
 *
 *   - `local`   — trusted; the caller uses the baseline opts UNCHANGED
 *                 (byte-identical). This module is never invoked for local.
 *   - `federated` — partial trust (registry-known peer); M1 + M2 apply.
 *   - `public`  — zero trust; M1 + M2 (+ M3/M4/M6) ALL apply.
 *
 * The accept-policy (CO-1) independently bounds the REQUEST to the offered
 * capability — a public requester can ask for `code-review`, never a sibling —
 * so M2's job is the SESSION-interior privilege bound, complementing that
 * request-level bound.
 *
 * Pure + total — unit-tested in `__tests__/review-session-lockdown.test.ts`.
 *
 * Anchors: docs/design-capability-offering.md §6 (M2) · ADR-0008 DD-CO-6 ·
 *          CONTEXT.md §Capability offering.
 */

import type { OfferScope } from "../common/types/offering";
import type { CCSessionOpts } from "./cc-session";

/** The session-opts shape this module hardens — the projection
 *  `buildReviewSessionOpts` produces (no `prompt`). */
export type ReviewSessionOpts = Partial<Omit<CCSessionOpts, "prompt">>;

/**
 * The MINIMAL tool allow-set for a locked-down review: read-family tools only.
 * No `Edit`/`Write`/`NotebookEdit` (file mutation), no `Task` (sub-agent /
 * sibling-capability spawn). The forge post happens through `Bash` gated by the
 * {@link LOCKED_REVIEW_BASH_ALLOWLIST}, so `Bash` is included but tightly
 * bash-allowlisted rather than excluded (a review must be able to `gh pr review`).
 */
export const LOCKED_REVIEW_ALLOWED_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
];

/**
 * Tools EXPLICITLY denied on a locked review session — defense-in-depth even if
 * a future baseline widens `allowedTools`. Mutation + spawn + notebook editing
 * have no place in an untrusted review.
 */
export const LOCKED_REVIEW_DISALLOWED_TOOLS: readonly string[] = [
  "Edit",
  "Write",
  "NotebookEdit",
  "Task",
];

/**
 * The TIGHT bash allowlist for a locked review session (`bash-guard.hook.ts`
 * shape). Read-only inspection + the forge review post ONLY. Deliberately
 * NARROWER than the dev path's `DEFAULT_DEV_BASH_ALLOWLIST` (which allows broad
 * `git`/`gh`/`bun` for a HIGHER-authority push session) — a public reviewer
 * gets neither arbitrary `git` (no `push`/`config`/`remote`) nor arbitrary `gh`
 * (only the review subcommands), nor `bun`/build tooling.
 *
 * `repos: []` — the reviewer legitimately reads whatever repo the PR addresses;
 * the gh-review subcommands are the bound, not a repo allowlist.
 */
export const LOCKED_REVIEW_BASH_ALLOWLIST: {
  rules: { pattern: string; repos?: string[] }[];
  repos: string[];
} = {
  rules: [
    // Read-only git inspection of the diff under review. NO push/config/remote/
    // checkout-write — the `( |$)` anchors prevent `git showcommit-and-push`
    // style smuggling.
    { pattern: "^git (show|diff|log|status|blame|cat-file)( |$)" },
    // Forge review post + read (GitHub). `gh pr review|diff|view|checkout` only;
    // NO `gh repo`, `gh secret`, `gh api`, `gh auth`, etc.
    { pattern: "^gh pr (review|diff|view|checkout|comment)( |$)" },
    // Forge review post + read (GitLab).
    { pattern: "^glab mr (note|diff|view|approve)( |$)" },
    // Read-only filesystem inspection within the scratch dir.
    { pattern: "^(ls|cat|head|tail|rg|grep|find|pwd|echo|test|true|wc)( |$)" },
  ],
  repos: [],
};

/** Inputs to {@link lockdownReviewSessionOpts}. */
export interface LockdownInput {
  /** The baseline review session opts (from `buildReviewSessionOpts`). */
  baseline: ReviewSessionOpts;
  /** The offer-scope the review arrived at. `local` ⇒ no lockdown (passthrough). */
  scope: OfferScope;
  /** The reviewing agent id — used for the bash-guard engagement channel. */
  agentId: string;
  /**
   * The per-review SCRATCH directory the locked session is confined to. The
   * caller (boot / consumer) owns its creation; M2 only sets `allowedDirs` to
   * exactly `[scratchDir]`. When omitted, `allowedDirs` is set to an EMPTY
   * array (no read/write dirs granted) — the most restrictive fail-closed
   * default, never the principal's cwd.
   */
  scratchDir?: string;
}

/**
 * Apply the M2 least-privilege lockdown to a review session's opts, scaled by
 * offer-scope.
 *
 *   - `local`  → returns `baseline` UNCHANGED (byte-identical; M2 does not apply
 *                to trusted local work).
 *   - `federated` / `public` → returns a NEW opts object with the locked
 *                profile: minimal `allowedTools`, explicit `disallowedTools`,
 *                tight `bashAllowlist`, scratch-only `allowedDirs`, the
 *                bash-guard engagement channel, and settings-isolation ON.
 *
 * Never mutates `baseline` (returns a fresh object for the wider-scope case).
 * Pure + total: no I/O, no throw.
 */
export function lockdownReviewSessionOpts(input: LockdownInput): ReviewSessionOpts {
  if (input.scope === "local") {
    // Trusted local work — no lockdown. Byte-identical to today.
    return input.baseline;
  }

  // Wider scope (federated/public) — replace the permissive guardrails with the
  // locked, allow-list-only profile. Spread the baseline first so non-security
  // fields (agentName, timeoutMs, additionalArgs, cwd) survive, then OVERRIDE
  // the security-relevant ones.
  return {
    ...input.baseline,
    agentId: input.agentId,
    // bash-guard Gate-1 engagement — without a channel the guard disengages on
    // every Bash command (a locked allowlist with a disengaged guard is no lock).
    groveChannel: input.agentId,
    // Minimal tool set + explicit write/spawn denials.
    allowedTools: [...LOCKED_REVIEW_ALLOWED_TOOLS],
    disallowedTools: [...LOCKED_REVIEW_DISALLOWED_TOOLS],
    // Tight bash allowlist (read + forge-review only). This ALSO sets
    // CORTEX_BASH_GUARD so the session can't slip the Gate-2 CLI-bypass.
    bashAllowlist: LOCKED_REVIEW_BASH_ALLOWLIST,
    // Scratch-only. An absent scratch dir fails CLOSED to "no dirs granted"
    // (the empty array), never the principal's cwd — so a mis-wired caller can
    // never accidentally grant the whole working tree to an untrusted review.
    allowedDirs: input.scratchDir !== undefined ? [input.scratchDir] : [],
    // Strip ambient principal hooks/settings/secrets — clean settings sandbox.
    settingsIsolation: true,
  };
}
