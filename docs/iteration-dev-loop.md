# Iteration plan — dev-loop (the agentic dev pipeline on the IoAW bus)

**Epic:** [cortex#835](https://github.com/the-metafactory/cortex/issues/835)
**Design:** [`docs/design-agentic-dev-pipeline.md`](design-agentic-dev-pipeline.md) (9 decisions locked) · framing contract [`docs/design-event-driven-review-loop.md`](design-event-driven-review-loop.md)
**Started:** 2026-06-10

The repo-side iteration artifact for the dev-loop epic. The GitHub epic (#835) +
its phase sub-issues (#865–#870) are the trackable mirror; this file is the
agent-readable plan. **Sync rule:** a checkbox completed here is also ticked on
its GitHub issue, and vice-versa (per CLAUDE.md §Implementation Workflow).

Built **dogfood-by-construction**: each component is driven in its home repo as a
separately-framed workstream, coordinated only through the shared fabric — the
way we build the dev-loop is the dev-loop.

## Phase status

| Phase | What | Home | Issue | State |
|---|---|---|---|---|
| **F-1** | event-driven review loop (verdict block · `pilot watch` reactor · merge→next-pick · stack-scope/federation) | pilot, arc-skill-code-review, agents | umbrella [pilot#153](https://github.com/the-metafactory/pilot/issues/153) | ✅ **complete** (4/4) |
| **F-2** | dev agent — `dev.implement` consumer (dormant; warm sessions) | cortex | [#865](https://github.com/the-metafactory/cortex/issues/865) | 🔄 F-2.1 PR #853 review-passed, awaiting approver merge |
| **F-3** | loop-as-pulse-process + approver-bot | pulse, pilot | [#866](https://github.com/the-metafactory/cortex/issues/866) | 🔄 F-3.0 done (pilot#159); F-3.1/.2 PRs in flight; F-3.3 principal-gated |
| **F-4** | release agent — `release.cut` consumer (principal-gated) | cortex, compass | [#867](https://github.com/the-metafactory/cortex/issues/867) | 🔄 F-4.1 PR in flight |
| **F-5** | brain/hands seam — ExecutionBackend wiring | cortex | [#868](https://github.com/the-metafactory/cortex/issues/868) | ⏸ F-5a sequenced after F-2.1 merges (same files); F-5b deferred |
| **F-6** | packaging — ship as a meta-factory blueprint | arc, meta-factory, cortex | [#869](https://github.com/the-metafactory/cortex/issues/869) | 🔄 specs filed (a–e); a/c/d PRs in flight |
| **F-7** | mining loop — process self-improvement | pulse | [#870](https://github.com/the-metafactory/cortex/issues/870) | ⬜ queued |

## Cross-cutting

- **Marketplace building-block gaps** (flag-don't-work-around, principal directive): skill-drift detection · agent-manifest persistent-subscription trigger type · `agents` repo missing from `compass/ecosystem/repos.yaml` · JetStream verdict-stream (REVIEW_LIFECYCLE, cortex#851) · pilot CI (done, pilot#155) · token/cost-accounting (BudgetCheck seam stubbed) · the F-6a–e set.
- **The approving key** (`metafactory-approver` account + PAT) is the current human-gated dependency: it unblocks every cortex PR sitting behind the REVIEW_REQUIRED ruleset and is itself F-3.3.

## Build order (dependency-sequenced)

1. F-1 ✅ → 2. F-2.1 + F-3.0 + F-4.1 + F-6{a,c,d} (parallel, worktree-isolated) → 3. approver provisioning (F-3.3) unblocks cortex merges → 4. F-5a (after F-2.1) + F-3.1/.2 + F-6{b,e} → 5. F-7.
