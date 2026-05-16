# Pilot Restructure — Capability-Dispatch Alignment

**Status:** Draft — design spec for an aggressive structural refactor of `the-metafactory/pilot` aligning the review-cycle CLI with myelin's capability-dispatch pattern.
**Date:** 2026-05-16
**Driver:** Andreas
**Related docs (load-bearing):**

- `docs/design-pi-dev-review-agent.md` — §4 + §8: the canonical capability-dispatch envelope shapes (`local.{org}.tasks.code-review.<flavor>`, `local.{org}.review.verdict.{approved,changes-requested,commented}`, `dispatch.task.*`). This document is the architectural anchor; this spec is its caller-side redux from pilot's perspective.
- `docs/design-internet-of-agentic-work.md` — §3.4 (multi-network: network-as-scope, NOT per-peer capability scoping — Q4 lock-in); §6 (phased roadmap, capability registration in Phase D).
- `docs/architecture.md` — §3 (four subject classes, hot/cold path), §7 (capability-driven dispatch, three distribution modes, nak taxonomy, sovereignty modes).
- `docs/plan-internet-of-agentic-work.md` — Phase D §D.4 (capability registry / federation handshake).
- Reverted source (still readable in git history) — `git show 3a88dd8:src/cli/cortex/commands/wait-for-review.ts` (the cortex#234 CLI; PR #236 reverts it). The new `pilot wait-for-review` CLI lifts shape from here.
- Source under restructure — `~/.config/metafactory/pkg/repos/pilot/` (the pilot repo, root commit `ff2fe2a` extracted from `the-metafactory/meta-factory` on 2026-04-24).

**Tracking issues:** cortex#232 (umbrella — review-bundle migration to pilot), cortex#237 (Echo's bus-side consumer: subscribe to `tasks.code-review.*`, emit `review.verdict.*`).

---

## §1 — Driver and scope

### §1.1 What changed

Three forces converge:

1. **The capability-dispatch wire format has stabilised.** `docs/design-pi-dev-review-agent.md` §4 pins the subject grammar (`local.{org}.tasks.code-review.<flavor>` request, `local.{org}.review.verdict.{approved,changes-requested,commented}` verdict, `dispatch.task.{started,progress,completed,failed,aborted}` lifecycle). Pilot already publishes `tasks.code-review.*` envelopes onto the cortex bus from `src/nats-publish.ts` (closed pilot#86), and the request side is wire-stable.
2. **The cortex#234 wait-for-review CLI was reverted (PR #236).** Cohesion of the review bundle wins: pilot owns the CLI + the skill + the workflow logic. The reverted source is the template for `pilot wait-for-review` (github.* fallback, identical exit-code grammar) and `pilot wait-for-verdict` (the capability-dispatch successor; same shape, different subject pattern).
3. **Pilot's internal layout no longer reflects its concerns.** 50 files in a flat `src/` directory mix four distinct subsystems (bus transport, review workflow, forge integration, persistent state) into one namespace. Test files mirror src 1:1; cross-concern imports tangle. The `LUNA_DISCORD_ID` hardcode and twin "ping" code paths (`ping.ts` → Discord post; `forge-ping.ts` → GitLab MR note; `dispatch.ts` → Discord ping at re-review) are the visible symptom.

### §1.2 Decisions locked in

These are inputs to this spec, NOT open for re-litigation:

1. **Aggressive full restructure.** Target subtree layout is `bus/` + `workflow/` + `forge/` + `persistence/`. ~50% file moves expected.
2. **Capability-dispatch transport on the new path.** Request side emits `local.{org}.tasks.code-review.<flavor>` (already shipped). Verdict side **subscribes** to `local.{org}.review.verdict.>` (new) and `local.{org}.dispatch.task.completed` (new). **No hardcoded reviewer Discord IDs.** `REVIEWERS.luna.discordId` and friends retire from the load-bearing review-path on the new wire; they survive in a transition-fallback registry (see §4.5).
3. **Three new CLIs.** `pilot request-review`, `pilot wait-for-verdict`, `pilot wait-for-review`. Designed in §5.
4. **Cortex internals as dependency.** `NatsLink`, `MyelinSubscriber`, `Envelope`, `validateEnvelope`, `loadConfigWithAgents` are imported from cortex. Mechanism + trade-offs in §7.
5. **Lockstep with cortex#237.** Pilot CLIs ship dormant if cortex#237 hasn't landed. The github.* fallback (`pilot wait-for-review`) keeps reviews working during the transition window.

### §1.3 Out of scope (explicitly)

- Hooks / lifecycle migration. Pilot's `claim.*`, `implement.*`, `review.*`, `merge.*` AgentState events stay where they are. The restructure moves files; it does not redesign Phase 2/3 of the claim loop.
- Persistence schema migration. `errands.sqlite` (`db.ts`) and `state.sqlite` (`agent-state.ts`) stay on their current schemas. The restructure groups them under `persistence/`; it does not flip storage backends.
- GitLab-backend changes beyond the structural move into `forge/`. The `glab`-based `GitLabBackend` ships as-is into `forge/gitlab-backend.ts`; no behavioural changes.
- The pi.dev review agent itself. That is cortex#237's scope (Echo subscribes to `tasks.code-review.*`, emits `review.verdict.*`). This spec is pilot's caller-side.
- Multi-network federation. Pilot publishes on `local.{org}.*` only; `federated.*` arrives in Phase D and is out of scope here. The CLIs accept a `--network` flag with the existing `local` default; multi-network handling defers.
- Renaming the pilot binary or repository.

---

## §2 — Current-state survey

### §2.1 Top-level layout

```
~/.config/metafactory/pkg/repos/pilot/
├── arc-manifest.yaml            # skill manifest (`pilot-review-loop` v0.3.0)
├── package.json                 # bun package, ships `~/bin/pilot`
├── bun.lock
├── agent/                       # AgentManifest (Pilot as proactive agent, Phase 1)
├── bin/                         # `bin/pilot` entrypoint shim
├── skill/                       # the `pilot-review-loop` skill markdown
├── specs/                       # 4 design specs (0001-0004) — see §2.4
├── research/                    # research docs (rung-0.5 framing, etc.)
├── scripts/
├── src/                         # 50 .ts files (this spec's target)
└── tests/                       # 47 .test.ts files mirroring src/ 1:1
```

`src/tsconfig.json` is local to the src tree. Production binary is `bun src/cli.ts` shipped via `arc upgrade Pilot` (per `arc-manifest.yaml`).

### §2.2 Per-file inventory of `src/` — concern grouping

Below: every file, one-line responsibility, line count, primary concern.

**LEGEND** — concern column maps each file to its target subtree (§3):
- **B** = `bus/` (transport + envelope I/O)
- **W** = `workflow/` (review-cycle orchestration + business logic)
- **F** = `forge/` (GitHub + GitLab CLI integration)
- **P** = `persistence/` (SQLite + filesystem state)
- **C** = `cli/` (kept at `src/cli.ts`; the entrypoint stays where it is — see §3.6)
- **S** = `shared/` (small cross-cutting helpers)

| File | LoC | Concern | Responsibility |
|------|----:|:-------:|---|
| `agent-state.ts` | 1241 | P | `AgentStateStore` — SQLite-backed work-item + event log (Phase 2/3 source of truth). Persistence + atomic transitions. |
| `apply.ts` | 228 | W | `pilot apply` — shells `claude -p` in target worktree to code each `fix` decision; commits per-cycle. |
| `auto-triage.ts` | 258 | W | `pilot auto-triage` — batch findings through `claude -p`; writes triage file. |
| `blueprint.ts` | 251 | F+S | `blueprint update` shell wrapper + feature-ref parse + branch-protection detect. Forge-adjacent (calls `gh api`); split: pure helpers → S, side-effecting → F. |
| `caps.ts` | 41 | P | Rate-limit + circuit-breaker counters; reads `db.ts`. |
| `claim-loop.ts` | 279 | W | `blueprint ready --json` parser + feature prioritisation; pure + `scanRepo` side-effect. |
| `cleanup.ts` | 167 | W+F | Post-merge cleanup: blueprint flip + worktree remove + branch delete + issue comment. Hybrid — split per call (W for orchestration, F for `gh`/`git` shell). |
| `cleanup-sequence.ts` | 125 | W | Cleanup orchestrator: composes `cleanup.ts` actions with AgentState transitions. |
| `cli.ts` | 2451 | C | The dispatch table — `pilot <verb>` routes to module entry-points. Stays in place during restructure (§3.6). |
| `config.ts` | 194 | W | `validateClaimLoopConfig` (identity-collapse guard) + `loadRepoCommandConfigs` (per-repo install/test env). Pure. |
| `dashboard.ts` | 66 | P | Renders `~/.metafactory/agents/pilot/dashboard.md` from `db.ts` errands. |
| `db.ts` | 456 | P | SQLite errand + finding store; the `pilot fetch`/`triage`/`dispatch` persistence backbone. |
| `discord.ts` | 64 | B (transition) | `channelForRepo` + `threadNameForPR` + `postMessage` shelling `~/bin/discord`. Lives at `bus/legacy/discord.ts` post-restructure — the bot-mention transport that retires when cortex#237 ships. |
| `discord-veto.ts` | 382 | B (transition) | Discord REST API client for the claim-veto window: announce → reactions → defensive-veto. Same transition shell as `discord.ts`. |
| `dispatch.ts` | 321 | W | `pilot dispatch` — parses triage, applies decisions, posts re-review request + ping. Touches discord + gh. |
| `drive-review.ts` | 120 | W | `driveReview` — pure outer loop over `runReviewCycle` with fix-and-push + escalation. |
| `fetch.ts` | 132 | W | `pilot fetch` — pulls PR + reviews + comments via `gh`, upserts findings; bumps cycle on new review. |
| `forge.ts` | 92 | F | `ForgeBackend` interface + types (`MergeRequest`, `ReviewEntry`, `InlineComment`, etc.). |
| `forge-detect.ts` | 63 | F | Auto-detect github/gitlab from `git remote.origin.url`. |
| `forge-fetch.ts` | 41 | F | Forge-agnostic fetcher delegating to a `ForgeBackend`. |
| `forge-ping.ts` | 66 | F+B | GitLab path posts MR note; GitHub path delegates to `pingCommand` (which uses Discord). Split: GitLab → F; GitHub delegation lives in W where `ping.ts` lands. |
| `gh.ts` | 23 | F | Back-compat re-export shim of `github-backend.ts`. Stays as compatibility surface during restructure; deletable after MIG-3. |
| `github-backend.ts` | 346 | F | `GitHubBackend` implementation of `ForgeBackend` via `gh` CLI. |
| `gitlab-backend.ts` | 394 | F | `GitLabBackend` implementation via `glab api`. |
| `gitlab-monitor.ts` | 99 | F | Stopgap polling of GitLab issues by label. |
| `implement.ts` | 258 | W | Worktree creation + branch naming; `ShellExec` type. |
| `interrupt.ts` | 76 | W | `decidePause` + `decideAbort` pure decision helpers. |
| `llm-loop.ts` | 237 | W | `runImplementLoop` — read issue → `claude -p` → test → push → retry. |
| `mention-dispatch.ts` | 61 | B (transition) | Parses `<@bot> verb args` from Discord messages and dispatches to known verbs. Looks unwired — see §2.5. |
| `merge.ts` | 353 | W | Verdict-token parse + reviewer-identity check + Discord-fallback parse + merge-decision pure helpers. |
| `merge-orchestrator.ts` | 133 | W | `runMergeOrchestrator` — pre-merge veto window + merge gate. |
| `nats-publish.ts` | 365 | B | **The new request side.** `publishReviewRequested` → `local.{org}.tasks.code-review.<specialization>` envelopes. The capability-dispatch publisher. |
| `nats-review-io.ts` | 187 | B | NATS-backed `ReviewCycleIO` — subscribes `mf.{network}.review.completed`. **Legacy subject namespace** — the `mf.*` prefix is pre-namespace-reconciliation (architecture §3.5); pre-IoAW. Retires when `wait-for-verdict` ships against the canonical `local.{org}.*`. |
| `next-pick.ts` | 253 | W | Cross-ecosystem work-item scanner — operational triage, not feature claiming. |
| `open-pr.ts` | 367 | W+F | `gh pr create` orchestration + body/title formatting; comments on linked issue. Pure formatting → W; shell calls → F. |
| `operator.ts` | 410 | W | `decideResume` + `decideRelease` + `executeReleaseVetoedTransition` — operator-unblock decision layer. |
| `parse-review.ts` | 268 | W | Review-body parsing: lens + severity extraction; `GhReviewComment` → `PrFinding`. |
| `path-utils.ts` | 56 | S | `normalizeRelativeUp` + `shellEscape` — pure path helpers. |
| `paths.ts` | 14 | P | `AGENT_HOME` / `DB_PATH` / `DASHBOARD_PATH` / `triagePath`. |
| `ping.ts` | 169 | W | `pingCommand` — publish bus envelope + post Discord message (with thread fallback) + GH fallback. The current "post a ping" entry-point. |
| `replay.ts` | 249 | W | Crash-recovery dispatcher — pure decision over `AgentStateStore` work-items + events. |
| `review.ts` | 220 | W | `decideReviewEvent` — review-loop phase boundaries (requested/changes-requested/approved/cap-hit). |
| `review-cycle-io.ts` | 76 | W | `buildReviewCycleIO` from a `ForgeBackend` — ping + counters + latest review. |
| `review-loop.ts` | 143 | W | `runReviewCycle` + `classifyVerdict` + `detectTrigger` — pure inner poll loop. |
| `reviewers.ts` | 178 | B (transition) | `REVIEWERS` registry — Luna/Echo/Ivy/Holly/Fern with hardcoded `discordId`s. The `LUNA_DISCORD_ID`-shaped fragility. |
| `shell-exec.ts` | 29 | S | `makeBunShellExec` — production `ShellExec` via `Bun.$`. |
| `sync.ts` | 44 | W | `pilot sync` — refresh active errand statuses; mark done/abandoned. |
| `tick.ts` | 880 | W | The Phase 2 orchestrator — scan → announce → veto-resolve → blueprint-flip → worktree → implementing. |
| `tiers.ts` | 77 | W | Trust-tier table (`auto`/`notify`/`ask`) for pilot actions. |
| `triage.ts` | 237 | W | `triageCommand` — write `.triage/pr-N-cycle-C.md` from errand state. |
| `watch.ts` | 87 | W+F | Generic poll loop over forge-supplied `WatchIO`. |

**Totals:** 50 files, ~14,500 LoC (rough sum). Tests mirror these 1:1 at ~13,000 LoC; combined ~27,500.

### §2.3 Hardcoded `LUNA_DISCORD_ID` and friends — every site

Despite the task framing referring to `LUNA_DISCORD_ID`, the codebase does **not** carry that env var. Instead `src/reviewers.ts:46` hardcodes `discordId: "1487180524542890144"` in the `REVIEWERS.luna` record. The same pattern hardcodes Echo, Ivy, Holly. Fern (GitLab-only) has no `discordId`.

The fragility is the **registry of Discord IDs**, not a single var. Every site:

| File:line | Reference | Use |
|---|---|---|
| `src/reviewers.ts:46-72` | `REVIEWERS.{luna,echo,ivy,holly}.discordId` | Source: literal snowflakes. |
| `src/reviewers.ts:134-137` | `reviewerMention(reviewer)` | Returns `<@${discordId}>` for posting to Discord. |
| `src/reviewers.ts:161-163` | `reviewerMentionOrName(reviewer)` | Mention with displayName fallback. |
| `src/ping.ts:71` | `reviewerMentionOrName(reviewer)` | Embedded in the message body of `pingCommand`. |
| `src/dispatch.ts:283` | `reviewerMentionOrName(dispatchReviewer)` | Re-review ping body in `dispatchCommand`. |
| `src/tick.ts:177` | `reviewerMentionOrName(reviewerInfo)` | Claim-announcement body in `buildClaimContext` (inert per docstring — `allowedUserIds: []`). |
| `src/cli.ts:41` | `import { REVIEWERS, reviewerMentionOrName }` | Used in `pilot release` claim-re-announcement flow. |
| `src/merge-orchestrator.ts:64-77` | `validateReviewerIdentity(prState.reviews, config.reviewerInfo)` | Reviewer-identity check; reads `reviewer.githubLogin`, NOT `discordId`, but couples the bot-identity model to a static registry. |
| `src/agent-state.ts:142-148` | `claim.requested-by-mention` event payload carries reviewer identity through the work-item event log | Soft coupling — not a literal `discordId`, but a reviewer-name field whose semantics derive from the static `REVIEWERS` registry. Phase D's "retire LUNA_DISCORD_ID" deliverable retires this too. (Echo cortex#238 round 1 suggestion.) |
| `tests/discord.test.ts:53-54` | `expect(REVIEWERS.luna.discordId).toBe("1487180524542890144")` | Test pins the literal snowflake. |

**Why the registry is a fragility:** every reviewer addition is a source change. Adding a sixth reviewer (e.g. Sage when sage subscribes to `tasks.code-review.generic`) requires editing `reviewers.ts`, updating tests, redeploying. Replacing the static registry with capability-dispatch retires this: pilot publishes a task, the bus dispatches to whatever agent claims the capability. The reviewer's Discord ID becomes a presence detail, not a routing key.

### §2.4 Specs (`specs/`)

| Spec | Topic |
|---|---|
| `0001-pilot-as-agent.md` | Pilot-as-agent (Phase 1) — identity, install, persona, Discord bot. |
| `0002-pilot-claim-loop.md` | Phase 2 claim loop — `blueprint ready` scan, veto window, two-of-two merge gate. |
| `0003-pilot-autonomous-mention-loop.md` | Phase 3 — `@pilot pick`/`pause`/`abort` mention-dispatch verbs. |
| `0004-forge-abstraction-gitlab.md` | Forge abstraction enabling GitLab. |

The restructure does NOT alter spec scope. Spec 0002's two-of-two model, spec 0003's mention dispatch, spec 0004's forge abstraction all carry through with file moves only.

### §2.5 Dead / experimental / overlapping files

These bear special attention during the move (decide retire-vs-keep):

| File | Status | Recommendation |
|---|---|---|
| `mention-dispatch.ts` | Spec 0003 surface; tests exist; no `cli.ts` import references it as of 2026-05-16. **Looks unwired.** | Keep — Phase 3 §F-9 wires it (audited in `agent-state.ts:142-148`'s `claim.requested-by-mention` event). Move into `workflow/mention/` and document the wiring gap as a known-TODO. |
| `discord.ts` + `discord-veto.ts` + `reviewers.ts` | Three Discord-coupled files. `discord-veto.ts` talks Discord REST directly (bypasses `~/bin/discord` CLI). `discord.ts` shells the CLI. `reviewers.ts` hardcodes IDs. | Cluster into `bus/legacy/` — see §3.2. Retires module-by-module as cortex#237 lands. |
| `nats-review-io.ts` | Subscribes to `mf.{network}.review.completed` — **legacy subject namespace**. | Retire when `wait-for-verdict` ships. Keep in `bus/legacy/` until the cutover (Phase C in the migration plan). |
| `nats-publish.ts` | Publishes to `local.{org}.tasks.code-review.<specialization>` — **canonical subject**. | Promote to `bus/publish-review-request.ts` (renamed for clarity; legacy name preserved as re-export). |
| `gh.ts` | Re-export shim of `github-backend.ts`. Comment says "back-compat." | Keep across MIG-1; delete after MIG-3 once all importers consume `forge/github-backend.ts` directly. |
| `forge-ping.ts` | Hybrid file: GitLab path posts via `glab` (forge), GitHub path delegates to `pingCommand` which posts to Discord. The "ping" verb is overloaded. | Split: GitLab logic into `forge/gitlab-ping.ts`; GitHub delegation into `workflow/review/ping.ts`. |
| `watch.ts` | Generic poll loop. Used by `pilot watch` for labeled-issue scanning. | Stays — move to `workflow/watch/` or `forge/watch/`. Decision: `workflow/` (it's an operator-facing review-loop primitive). |
| `gitlab-monitor.ts` | "Stopgap until cue system exists." | Stays — move to `forge/gitlab-monitor.ts`. |
| `next-pick.ts` | Cross-ecosystem triage; separate from claim-loop. | Stays — move to `workflow/next-pick.ts`. |

### §2.6 Test files (`tests/`)

47 test files, 1:1 with src files for the most part. The pattern is consistent — `src/X.ts` ↔ `tests/X.test.ts`. Some files split (`agent-state.test.ts` + `agent-state-operator-cols.test.ts` + `agent-state-transition.test.ts` + `agent-state-work-items.test.ts`).

**`tests/discord.test.ts:53-54`** is the test that pins `REVIEWERS.luna.discordId === "1487180524542890144"`. This test moves with `reviewers.ts` into `bus/legacy/` and survives unchanged across the restructure; it retires alongside the legacy registry post-cutover.

**Test moves track source moves 1:1.** Tests live in `tests/` rather than co-located. The restructure does NOT change that — tests stay flat. Test file paths get a path prefix update on imports (`./fetch` → `../workflow/review/fetch`) but no test rewrites.

### §2.7 Internal import graph (high level)

```
cli.ts ──► (everything below — 50 modules)
   │
   ├─► db.ts ◄── caps, dashboard, dispatch, fetch, ping, sync, triage, etc.
   │       (15+ importers — the persistence centre)
   │
   ├─► reviewers.ts ◄── dispatch, merge-orch, ping, review-cycle-io, tick, cli
   │       (the Discord-ID registry — the hardcode hub)
   │
   ├─► nats-publish.ts ◄── ping, nats-review-io
   │       (the request-side bus client)
   │
   ├─► nats-review-io.ts ◄── (nobody imports it today — wire-up gap, see §2.5)
   │
   ├─► forge.ts (interface) ◄── github-backend, gitlab-backend, forge-fetch, forge-ping, forge-detect, review-cycle-io
   │       (the forge abstraction)
   │
   ├─► discord.ts + discord-veto.ts ◄── ping, dispatch, cli
   │       (the Discord transport)
   │
   └─► agent-state.ts ◄── tick, replay, operator, interrupt, cli, cleanup-sequence
           (the Phase 2/3 work-item store)
```

**Key observation:** the import graph is already roughly four-clustered (persistence cluster around `db.ts`/`agent-state.ts`; forge cluster around `forge.ts`; bus cluster around `nats-publish.ts`; workflow cluster — everything else). The restructure makes this latent structure explicit.

---

## §3 — Target architecture

### §3.1 Four-subtree layout

```
src/
├── cli.ts                            # entrypoint dispatch table (stays put; §3.6)
├── bus/                              # M2-M3 transport + envelopes
│   ├── publish-review-request.ts     # (was nats-publish.ts) — capability-dispatch publisher
│   ├── subscribe-verdict.ts          # NEW — local.{org}.review.verdict.> + dispatch.task.completed
│   ├── subscribe-github.ts           # NEW — local.{org}.github.> (transition fallback)
│   ├── envelope.ts                   # re-exports from @the-metafactory/cortex (Envelope, validateEnvelope)
│   ├── nats-link.ts                  # re-exports cortex NatsLink + connection config helpers
│   ├── matchers/                     # pure envelope-shape matchers (no I/O)
│   │   ├── verdict.ts                # match review.verdict.* by (repo, pr_number, correlation_id)
│   │   └── github-review.ts          # match local.{org}.github.> for (repo, pr_number, reviewer login)
│   └── legacy/                       # retires post-cortex#237
│       ├── discord.ts                # (was src/discord.ts) ~/bin/discord shell
│       ├── discord-veto.ts           # (was src/discord-veto.ts) claim-veto window
│       ├── reviewers.ts              # (was src/reviewers.ts) — REVIEWERS registry
│       ├── mention-dispatch.ts       # (was src/mention-dispatch.ts) — @pilot verb dispatch
│       └── nats-review-io.ts         # (was src/nats-review-io.ts) — mf.{network}.review.completed
├── workflow/                         # the review-cycle business logic
│   ├── review/
│   │   ├── fetch.ts                  # (was src/fetch.ts)
│   │   ├── triage.ts                 # (was src/triage.ts)
│   │   ├── auto-triage.ts            # (was src/auto-triage.ts)
│   │   ├── parse-review.ts           # (was src/parse-review.ts)
│   │   ├── dispatch.ts               # (was src/dispatch.ts)
│   │   ├── apply.ts                  # (was src/apply.ts)
│   │   ├── ping.ts                   # (was src/ping.ts; GitHub-Discord delegation)
│   │   ├── drive-review.ts           # (was src/drive-review.ts)
│   │   ├── review-cycle-io.ts        # (was src/review-cycle-io.ts)
│   │   ├── review-loop.ts            # (was src/review-loop.ts)
│   │   ├── review.ts                 # (was src/review.ts)
│   │   ├── tiers.ts                  # (was src/tiers.ts)
│   │   └── sync.ts                   # (was src/sync.ts)
│   ├── claim/
│   │   ├── tick.ts                   # (was src/tick.ts)
│   │   ├── claim-loop.ts             # (was src/claim-loop.ts)
│   │   ├── next-pick.ts              # (was src/next-pick.ts)
│   │   ├── config.ts                 # (was src/config.ts)
│   │   ├── replay.ts                 # (was src/replay.ts)
│   │   ├── operator.ts               # (was src/operator.ts)
│   │   ├── interrupt.ts              # (was src/interrupt.ts)
│   │   └── blueprint.ts              # (was src/blueprint.ts; pure helpers stay here, gh-api calls into forge/)
│   ├── implement/
│   │   ├── implement.ts              # (was src/implement.ts)
│   │   ├── llm-loop.ts               # (was src/llm-loop.ts)
│   │   ├── open-pr.ts                # (was src/open-pr.ts; formatting helpers — gh-create call uses forge/)
│   │   ├── merge.ts                  # (was src/merge.ts)
│   │   ├── merge-orchestrator.ts     # (was src/merge-orchestrator.ts)
│   │   ├── cleanup.ts                # (was src/cleanup.ts)
│   │   └── cleanup-sequence.ts       # (was src/cleanup-sequence.ts)
│   └── watch/
│       └── watch.ts                  # (was src/watch.ts)
├── forge/                            # platform (GitHub / GitLab) integrations
│   ├── forge.ts                      # (was src/forge.ts) interface + types
│   ├── forge-detect.ts               # (was src/forge-detect.ts) auto-detect
│   ├── forge-fetch.ts                # (was src/forge-fetch.ts) forge-agnostic fetcher
│   ├── gh.ts                         # (was src/gh.ts) — re-export shim, deletable post-MIG-3
│   ├── github-backend.ts             # (was src/github-backend.ts)
│   ├── gitlab-backend.ts             # (was src/gitlab-backend.ts)
│   ├── gitlab-monitor.ts             # (was src/gitlab-monitor.ts)
│   ├── gitlab-ping.ts                # NEW — extracted from src/forge-ping.ts (GitLab path)
│   └── gh-api/                       # raw `gh api`-shaped helpers used by workflow/
│       └── branch-protection.ts      # extracted from blueprint.ts (detectBranchProtectionMode)
├── persistence/                      # SQLite + filesystem state
│   ├── db.ts                         # (was src/db.ts) — pr_errands / pr_findings
│   ├── agent-state.ts                # (was src/agent-state.ts) — work_items + events
│   ├── caps.ts                       # (was src/caps.ts) — counters
│   ├── dashboard.ts                  # (was src/dashboard.ts) — markdown render
│   └── paths.ts                      # (was src/paths.ts) — DB_PATH / AGENT_HOME
└── shared/                           # cross-cutting helpers
    ├── path-utils.ts                 # (was src/path-utils.ts)
    └── shell-exec.ts                 # (was src/shell-exec.ts)
```

### §3.2 Per-subtree responsibility + entry-point shape

**`bus/`** — every byte that crosses a NATS or Discord wire.

- *Entry points:* `publishReviewRequest({ repo, pr, capability, ... }) → Promise<PublishResult>`, `subscribeVerdict({ correlationId | (repo, pr), timeoutMs }) → Promise<VerdictMatch | null>`, `subscribeGitHub({ repo, pr, reviewer, timeoutMs }) → Promise<GitHubMatch | null>`.
- *Imports from:* `@the-metafactory/cortex` (NatsLink, MyelinSubscriber, Envelope, validateEnvelope, loadConfigWithAgents) — see §7 for the dependency setup.
- *Imports from `workflow/`:* never. Bus is a leaf — workflow imports bus, not the other way around.
- *Imports from `persistence/`:* never (the bus is a wire; persistence is a side-effect at the workflow layer).
- *Imports from `forge/`:* never.
- *`bus/legacy/`:* the bot-mention transport. Survives until cortex#237's verdict-side ships AND the new wait-for-verdict has burned in for at least one iteration cycle. Then deletable.

**`workflow/`** — the review-cycle orchestration layer.

- *Entry points:* `pingCommand`, `fetchCommand`, `triageCommand`, `autoTriageCommand`, `applyCommand`, `dispatchCommand`, `syncCommand`, `runReviewCycle`, `driveReview`, `runTick`, `runClaimAnnounce`, `runClaimResolve`, `runImplementLoop`, `runMergeOrchestrator`, `runCleanupSequence`, `runWatch`. The dispatch table in `cli.ts` calls into these.
- *Imports from `bus/`:* yes — publishes envelopes, subscribes to verdict streams, posts Discord pings (during transition).
- *Imports from `forge/`:* yes — every shell call to `gh`/`glab` rides through a `ForgeBackend`.
- *Imports from `persistence/`:* yes — errands, work-items, events.
- *Imports from `shared/`:* yes.
- *Sub-clusters:*
  - `workflow/review/` — the existing fetch/triage/dispatch/apply pipeline.
  - `workflow/claim/` — Phase 2/3 claim loop.
  - `workflow/implement/` — Phase 3 implement → PR → merge → cleanup.
  - `workflow/watch/` — the labeled-issue poll loop.

**`forge/`** — every shell call to `gh`/`glab` and the `ForgeBackend` interface.

- *Entry points:* `GitHubBackend`, `GitLabBackend`, `resolveForgeBackend({ cwd })`, `detectForgeFromRemote(url)`, `forgeFetch(...)`, `gitlabPing(...)`, plus the raw `gh-api/branch-protection.ts` helper.
- *Imports from:* `bun:$`, `node:os/path/fs`. NEVER from `bus/` or `persistence/`.
- *Imports from `workflow/`:* never.
- *Imports from `shared/`:* yes (path-utils, shell-exec).
- The `forge.ts` interface is the contract — workflow consumers depend on `ForgeBackend`, not on `GitHubBackend` directly. This is already the pattern; the restructure preserves it.

**`persistence/`** — SQLite + filesystem state.

- *Entry points:* the `db()` singleton, `AgentStateStore` class, `regenerateDashboard()`, `triagePath(pr, cycle)`, the rate-limit counter functions.
- *Imports from:* `bun:sqlite`, `node:fs/os/path`. NEVER from `bus/`, `forge/`, or `workflow/`.
- *Schemas:* `pr_errands` + `pr_findings` (`db.ts`); `work_items` + `events` (`agent-state.ts`). Unchanged.

**`shared/`** — small pure helpers crossing all four subtrees.

- *Entry points:* `normalizeRelativeUp`, `shellEscape`, `makeBunShellExec`.
- *Imports from:* nothing internal (zero internal deps).

### §3.3 Cross-subtree contracts

| Importer | Importee | What flows |
|---|---|---|
| `workflow/` | `bus/` | Function calls: publish envelope, subscribe-and-wait for verdict. |
| `workflow/` | `forge/` | `ForgeBackend` interface; concrete backends behind it. |
| `workflow/` | `persistence/` | CRUD on errands, findings, work-items, events; dashboard render. |
| `workflow/` | `shared/` | Path normalisation, shell execution. |
| `bus/` | `shared/` | Shell execution (only the `legacy/discord.ts` shim — direct NATS path uses Bun fetch). |
| `bus/` | `@the-metafactory/cortex` | Transport primitives (`NatsLink`, `MyelinSubscriber`, `Envelope`, `validateEnvelope`, `loadConfigWithAgents`). |
| `forge/` | `shared/` | Shell execution, path utilities. |
| `persistence/` | `shared/` | (none — kept clean.) |
| `cli.ts` | all of the above | Dispatch table. |

**Forbidden directions** (enforced mechanically by ESLint `no-restricted-imports` zone config in PR-A.7 — Echo cortex#238 round 1 warning rejected the original "enforced by review" stance; layer discipline must not depend on contributor diligence):

- `bus/ → workflow/` — bus must stay a leaf.
- `forge/ → workflow/` or `forge/ → bus/` — forge is platform-neutral.
- `persistence/ → bus/` or `persistence/ → forge/` or `persistence/ → workflow/` — persistence is a leaf.
- `shared/ → anything internal` — shared is the bottom of the graph.

PR-A.7 ships the rule alongside the moves. The CI gate fails any new import that violates a forbidden direction. See §6.2.

### §3.4 Where the `LUNA_DISCORD_ID` registry goes

The fragility moves to `bus/legacy/reviewers.ts`. It becomes the **transition-fallback identity map** — the `pilot wait-for-review` CLI consumes it to resolve a reviewer name to a GitHub login (for the github.* matcher) and a Discord ID (for the bot-mention transition fallback). It is **not** consumed by the capability-dispatch path: `pilot request-review` + `pilot wait-for-verdict` use only capability tokens (`code-review.typescript`, `code-review.generic`, etc.) and correlation IDs.

Retirement schedule:
- **Phase A (this restructure):** moved to `bus/legacy/reviewers.ts`; consumers updated to import from the new path.
- **Phase B (new primitives ship dormant):** new path doesn't touch it.
- **Phase C (cortex#237 lands; cutover):** primary path uses capability dispatch; `bus/legacy/reviewers.ts` is consulted only when `pilot wait-for-review` (the transition CLI) is invoked.
- **Phase D (retirement):** delete `bus/legacy/reviewers.ts` along with `bus/legacy/discord*.ts`. The reviewer name → GitHub-login mapping moves to cortex's agent registry (consumed via `loadConfigWithAgents`), or to a small static map in pilot's own config if absolutely required for skill ergonomics.

### §3.5 What `bus/` looks like internally

The `bus/` subtree is intentionally thin — pilot is a **client** of cortex's transport, not a re-implementation of it. The directory contains:

```
bus/
├── publish-review-request.ts   # ~365 LoC (lifted from nats-publish.ts, renamed)
├── subscribe-verdict.ts        # ~250 LoC (NEW — pattern from cortex#234)
├── subscribe-github.ts         # ~250 LoC (NEW — github.* matcher for transition fallback)
├── envelope.ts                 # ~30 LoC — re-exports + pilot-local type aliases
├── nats-link.ts                # ~40 LoC — config-loading helpers around cortex.NatsLink
├── matchers/
│   ├── verdict.ts              # ~120 LoC — pure (envelope, filter) → match | null
│   └── github-review.ts        # ~140 LoC — pure github.* matcher (lifted from cortex#234)
└── legacy/                     # ~700 LoC total — bot-mention transport, retires post-cutover
    ├── discord.ts
    ├── discord-veto.ts
    ├── reviewers.ts
    ├── mention-dispatch.ts
    └── nats-review-io.ts
```

`bus/matchers/` is pure (no I/O). The side-effecting `subscribe-*.ts` files are thin: they wrap `NatsLink.connect` + `MyelinSubscriber.start`, race the subscription against a timeout, and delegate envelope-shape decisions to the matchers. Same shape as the reverted cortex#234 CLI, repackaged as a pilot module.

### §3.6 Why `cli.ts` stays where it is

`cli.ts` is 2451 LoC and contains the verb dispatch table. Two options:

- **Option A — split CLI.** Move each verb-handler into a `cli/verbs/<verb>.ts` file. ~30 new files. Clean per-verb cohesion.
- **Option B — keep flat.** `cli.ts` stays at `src/cli.ts`; only its imports change to the new subtree paths.

**Picked: B.** Reasoning (Echo cortex#238 round 1 suggestion — strengthen vs original "tractable" hand-wave):

1. **Each verb branch is independent.** No shared state between branches, no fall-through. Cyclomatic complexity per verb stays flat at the verb-handler boundary; the file's overall complexity is the SUM of independent branches, not a multiplicative function of their interactions. A 3000-LoC dispatch table is qualitatively different from a 3000-LoC monolith.
2. **Grep-ability is O(1) on verb names.** A reviewer chasing "what does `pilot triage` do?" finds the answer with `grep -n "case \"triage\"" cli.ts` — one hit, one location. Splitting into `cli/verbs/triage.ts` adds an extra indirection (grep filename, open file) without reducing cognitive load.
3. **`cli.ts` is the onboarding surface for new contributors.** It's the ONE file where a newcomer lands to learn pilot's verb surface and the shape of each entry-point call. Splitting pessimises onboarding — newcomers would have to discover 30 verb files plus a registry.
4. **Restructure payoff is in `workflow/` ↔ `bus/` ↔ `forge/` separation.** Adding `cli/verbs/<verb>.ts` muddies that — a per-verb file adds a layer of indirection between the dispatch table and the workflow entry-points without contributing to the layer-separation goal.
5. **PR churn asymmetry.** Splitting `cli.ts` doubles the file-count churn in a PR that's already heavy on file moves. Option A adds significant review surface without reducing risk in the load-bearing changes (the subtree moves).
6. **Reversibility.** If `cli.ts` becomes painful to navigate at 3000+ LoC, splitting it is a clean follow-up that touches no other files — the dispatch-table shape (each verb a single `if/else if` block, no shared state) makes that split mechanical.

Trade-off acknowledged: `cli.ts` remains the longest file in the repo post-restructure. The properties above make that tractable rather than painful.

### §3.7 Total file movement

Approximate counts:

| Category | Files |
|---|---:|
| Files moved into `bus/` (incl. legacy/) | 7 |
| Files moved into `workflow/` | 26 |
| Files moved into `forge/` | 9 |
| Files moved into `persistence/` | 5 |
| Files moved into `shared/` | 2 |
| Stays at `src/cli.ts` | 1 |
| **Total** | **50** |

50 of 50 src files move (49 into subtrees, 1 import-rewrite only). All 47 test files get import-path rewrites; no test logic changes.

---

## §4 — Capability-dispatch contract — pilot's caller perspective

> **Anchor doc:** `docs/design-pi-dev-review-agent.md` §4 and §7 — that file is the source of truth for the subject grammar and lifecycle. **The envelope-shape JSON in this §4 is a pilot-side proposal, not a ratified contract.** What this section adds is pilot's caller-side view: which subjects pilot publishes to, which it subscribes to, the correlation_id contract, and the proposed payload shapes pilot's consumers will read. Where the anchor doc and this section diverge, the anchor doc wins after the cortex-side PRs in §6.2 Phase A (the cortex prerequisites) land.

**Contract maturity (2026-05-16):**

| Sub-section | Status | Source of truth |
|---|---|---|
| §4.1 Request envelope | **Shipped.** Wire-stable since `nats-publish.ts:87-104`. | Existing code + anchor doc §4.1. |
| §4.2 Verdict envelope payload | **Shipped — ratified at cortex#248.** The JSON payload (`github_review_id`, `github_review_url`, `submitted_at`, `commit_id`, `findings`, `inline_comments`) is now the canonical contract. Pilot's verdict subscriber (pilot#102) and cortex#237's emitter (pending) both target this shape. | Anchor doc §4.2 + cortex#248 (payload ratification). |
| §4.3 Lifecycle envelopes | **Shipped — cortex#249.** Subject grammar (`dispatch.task.*`) was already in cortex `src/bus/dispatch-events.ts`; the four-way nak taxonomy in §4.4 is now wired via the extended `DispatchTaskFailedReason` discriminated union (`cant_do`, `wont_do`, `not_now`, `compliance_block` alongside the original `policy_denied`). | Anchor doc §4.2 + cortex `src/bus/dispatch-events.ts` (post-cortex#249). |
| §4.4 Nak taxonomy | **Shipped — cortex#249.** Architecture `docs/architecture.md` §7.3's four-way taxonomy (`cant_do` / `wont_do` / `not_now` / `compliance_block`) is implemented in cortex's `DispatchTaskFailedReason`. Pilot's nak-handling subscriber (pilot#102) consumes the new discriminators. | Architecture §7.3 + cortex `src/bus/dispatch-events.ts` (post-cortex#249). |
| §4.5 Github.* fallback | **Shipped.** Producer is the existing `gh-webhook-receiver`. | Existing code. |


### §4.1 Request envelope (pilot → bus)

Already shipped in `src/nats-publish.ts`; this is its specification, repeated for clarity.

**Subject:** `local.{org}.tasks.code-review.<flavor>` where `<flavor>` is one of:

| Flavor | Routes to |
|---|---|
| `generic` | any reviewer claiming `code-review` capability |
| `typescript` | TypeScript-specialised reviewer (Echo) |
| `python`, `rust`, `go`, `sql`, `docs` | language-specialised reviewers (future) |
| `security` | security-focused reviewer (cross-cutting; orthogonal to language) |

(`KNOWN_SPECIALIZATIONS` enum in `nats-publish.ts:87-104`.)

**Envelope payload:**

```json
{
  "id": "01HZQ8N3K7P5V4F2WX9YBM6E0R",
  "type": "tasks.code-review.typescript",
  "source": "metafactory.pilot.local",
  "timestamp": "2026-05-16T09:42:11Z",
  "sovereignty": {
    "classification": "local",
    "data_residency": "CH",
    "max_hop": 0,
    "frontier_ok": true,
    "model_class": "any"
  },
  "payload": {
    "repo": "the-metafactory/cortex",
    "pr": 229,
    "reviewer": "echo",
    "feature": "C-237",
    "title": "feat(bus): Echo subscribes to tasks.code-review.*",
    "cycle": 1,
    "note": ""
  },
  "extensions": {
    "network_id": "local",
    "actor": { "type": "agent", "id": "pilot" }
  }
}
```

`extensions.actor.id` is hardcoded `"pilot"` today (`nats-publish.ts:198`). Post-restructure, this is fine — pilot publishes as itself.

**Correlation:** the consumer (Echo) MUST echo `envelope.id` as the verdict envelope's `correlation_id` field. Pilot's `subscribe-verdict.ts` filters on that ID. (See §4.2.)

### §4.2 Verdict envelope (bus → pilot)

**Subjects:**

- `local.{org}.review.verdict.approved`
- `local.{org}.review.verdict.changes-requested`
- `local.{org}.review.verdict.commented`

Pilot subscribes on `local.{org}.review.verdict.>` and filters by `correlation_id`.

**Envelope payload:**

```json
{
  "id": "01HZQ8R1A9X7T2K3W4P5VYNB8M",
  "type": "review.verdict.changes-requested",
  "source": "metafactory.echo.local",
  "timestamp": "2026-05-16T09:51:33Z",
  "correlation_id": "01HZQ8N3K7P5V4F2WX9YBM6E0R",
  "sovereignty": { "classification": "local", "...": "..." },
  "payload": {
    "repo": "the-metafactory/cortex",
    "pr": 229,
    "reviewer": "echo",
    "verdict": "changes-requested",
    "summary": "verdict: blockers=0 majors=2 nits=3 — recommend: request-changes",
    "github_review_id": 2459183744,
    "github_review_url": "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459183744",
    "submitted_at": "2026-05-16T09:51:30Z",
    "commit_id": "abc123def456789",
    "findings": { "blockers": 0, "majors": 2, "nits": 3 },
    "inline_comments": 5
  },
  "extensions": {
    "network_id": "local",
    "actor": { "type": "agent", "id": "echo" }
  }
}
```

The payload shape mirrors `nats-review-io.ts:18-31`'s `ReviewCompletedPayload` (the legacy `mf.{network}.review.completed` shape). The capability-dispatch verdict envelope deliberately preserves payload-shape compatibility so workflow-side consumers (the existing `runReviewCycle` ReviewCycleIO) don't need behavioural changes — only the subject and the `correlation_id` are new.

### §4.3 Lifecycle envelopes (bus → pilot, optional)

Per `docs/design-pi-dev-review-agent.md` §4.2 + architecture §7.3, Echo emits the full `dispatch.task.*` lifecycle:

- `local.{org}.dispatch.task.started` — Echo began review.
- `local.{org}.dispatch.task.progress` — after each lens.
- `local.{org}.dispatch.task.completed` — fired alongside `review.verdict.*`.
- `local.{org}.dispatch.task.failed` — error / crash.
- `local.{org}.dispatch.task.aborted` — operator cancellation.

Pilot's **base case** is to wait for `review.verdict.*` (terminal). The `dispatch.task.*` lifecycle is **optional progress** for Tier-2 visibility on the cortex dashboard (architecture §3.6). Pilot's `subscribe-verdict.ts` may consume `dispatch.task.completed` as a co-terminal signal for crash-resilience: if Echo posts `dispatch.task.completed` with no preceding `review.verdict.*`, pilot treats it as `commented` with a "verdict not emitted" warning.

`dispatch.task.failed` with one of the four nak reasons (`cant_do`, `wont_do`, `not_now`, `compliance_block` — per architecture §7.3) MUST be surfaced to the caller. `pilot request-review --wait` exits non-zero with the reason embedded in the JSON envelope.

### §4.4 Nak handling

> **✅ Cortex-side prerequisite landed — cortex#249.** The four-way nak taxonomy below is wired into cortex's `DispatchTaskFailedReason` (`src/bus/dispatch-events.ts`) as sibling discriminators to the original `policy_denied`. Pilot's nak handling shipped at pilot#102 against the extended union.

When Echo (or any code-review-capable agent) naks a task, pilot's `subscribe-verdict.ts` receives a `dispatch.task.failed` envelope with `payload.reason.kind` in `{cant_do, wont_do, not_now, compliance_block}`.

| Reason | Pilot interpretation | CLI exit |
|---|---|---|
| `cant_do` | No agent matches the capability. Likely the `<flavor>` doesn't have a registered consumer. | exit 3, JSON `{ ok: false, reason: "no-capability-match" }` |
| `wont_do` | Sovereignty policy refused. Persistent — operator action needed. | exit 3, JSON `{ ok: false, reason: "sovereignty-refused" }` |
| `not_now` | Backpressure. Try again later — capability is registered, just busy. | exit 4, JSON `{ ok: false, reason: "backpressure" }` (operator-facing retry semantics) |
| `compliance_block` | Agent's compliance attestation forbids it. | exit 3, JSON `{ ok: false, reason: "compliance-block" }` |

Exit 3 = "permanent failure, retrying won't help"; exit 4 = "transient, retry safe."

### §4.5 The transition fallback — github.* matcher

`pilot wait-for-review` (see §5.3) subscribes to `local.{org}.github.>` and matches on (repo, pr_number, reviewer login). The producer side is the existing cortex `gh-webhook-receiver` (`~/Developer/cortex/src/taps/gh-webhook/`). This path is the **bridge** during the transition:

- Pilot publishes `request-review` envelope on the canonical capability-dispatch subject.
- IF cortex#237's Echo-side consumer has landed: Echo claims, reviews, posts `review.verdict.*` → pilot's `wait-for-verdict` returns the verdict envelope.
- IF cortex#237 hasn't landed (or any code-review consumer is offline): pilot's `wait-for-review` subscribes to github.* and matches on the GitHub-side review event (Echo's reviewer bot still posts the GitHub PR review even when the bus consumer is offline, because the legacy bot-mention path remains active until cortex#237 cutover).

`wait-for-review` retires when the §6.4 Phase C quantitative cutover gate passes (≥5 consecutive cycles over ≥48h on the capability-dispatch path). Retirement is by deleting the CLI subcommand — the underlying github.* matcher in `bus/matchers/github-review.ts` stays as a generic primitive (small, pure, useful for future github-event-driven workflows).

### §4.6 What pilot's verdict subscriber does NOT do

- **No retry.** A single `dispatch.task.completed` or `review.verdict.*` envelope matching the correlation_id terminates the subscription. If the operator wants retry-with-backoff, they wrap `pilot request-review --wait` in a shell loop.
- **No multi-agent quorum.** First matching verdict wins. If the capability-dispatch routing accidentally fans out to multiple consumers (a capability-registry misconfiguration), pilot returns the first verdict and ignores the rest. Surfaces a warning to stderr.
- **No persistence of verdicts.** The verdict envelope is rendered to stdout (JSON or text) and pilot exits. State-coupling (e.g. "remember this verdict in errands.sqlite") is workflow-layer business and lives in `workflow/review/` consumers — not in `bus/`.

---

## §5 — Three new CLI subcommands — detailed contract

Each CLI follows the cortex#234 conventions (still readable at `git show 3a88dd8:src/cli/cortex/commands/wait-for-review.ts`):

- **Exit codes:** `0` (match), `124` (timeout, matches `timeout(1)` convention), `2` (usage error), `1` (runtime error).
- **JSON envelope:** the `CliJsonEnvelope<T>` shape — `{ ok: true, items: [...], metadata: {...} }` or `{ ok: false, reason: "...", metadata: {...} }`. JSON gated behind `--json`; text default for shell ergonomics.
- **Test seams:** dependency-injection via a `Deps` interface (`connect`, `subscriberStart`, `loadConfig`, etc.) so integration tests don't need a live `nats-server`.
- **Help:** universal `--help` / `-h` flag prints subcommand help and exits 0.

### §5.1 `pilot request-review`

**Synopsis:**

```
pilot request-review --pr <owner/repo#N> --capability code-review.<flavor>
                     [--reviewer <login>]
                     [--feature <id>] [--cycle <N>] [--note "..."]
                     [--wait] [--timeout 30m]
                     [--config <path>] [--json]
```

**Behaviour:**

1. Validate args (PR ref, capability grammar — `code-review.<segment>` matching `VALID_SPECIALIZATION`).
2. Load cortex config (`~/.config/cortex/cortex.yaml` by default, `--config` override). Required: `nats.url`, `agent.operatorId` (becomes `<org>`). Optional: `nats.token` / `nats.credsPath`.
3. Build and publish the capability-dispatch envelope via `bus/publish-review-request.ts`. **Always publishes** — bus publish is fire-and-forget, independent of `--wait`.
4. If `--wait`:
   a. Subscribe to `local.{org}.review.verdict.>` AND `local.{org}.dispatch.task.completed` AND `local.{org}.dispatch.task.failed`.
   b. Filter by `correlation_id == <published envelope.id>`.
   c. Race subscription against `--timeout` (default `30m`).
   d. On match: render verdict JSON, exit 0.
   e. On timeout: exit 124.
   f. On `dispatch.task.failed`: render nak reason, exit 3 or 4 per §4.4.
5. If NOT `--wait`: print correlation_id and exit 0 immediately (operator can use `pilot wait-for-verdict --correlation-id ...` later, or another workflow).

**Args:**

| Flag | Type | Required | Notes |
|---|---|:-:|---|
| `--pr` | `owner/repo#N` | yes | Parsed via `parsePrRef` (regex `^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*#\d+$`). |
| `--capability` | string | yes | Must start `code-review.` — the trailing `<flavor>` segment validated against `VALID_SPECIALIZATION`. |
| `--reviewer` | string | no | Optional reviewer name for the envelope payload (back-compat with the legacy reviewer-targeted post). Capability-dispatch routes by capability, not by reviewer; this is **informational**. |
| `--feature` | string | no | Feature ID (e.g. `C-237`) for cross-reference. |
| `--cycle` | int | no | Review cycle counter (defaults to `1`). |
| `--note` | string | no | Free-form note in envelope payload. |
| `--wait` | bool | no | Block until verdict, lifecycle-completed, or timeout. |
| `--timeout` | duration | no | `<n>(s\|m\|h)`. Default `30m`. Only used with `--wait`. |
| `--config` | path | no | cortex.yaml path. Default `~/.config/cortex/cortex.yaml`. |
| `--json` | bool | no | Emit `CliJsonEnvelope<RequestResult>` on stdout. Default: text. |

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Publish succeeded (no `--wait`), OR publish + verdict received (with `--wait`). |
| `1` | Runtime error (NATS connect failed, config load failed, etc.). |
| `2` | Usage error (bad flags, malformed PR ref, invalid capability grammar). |
| `3` | Permanent dispatch failure: `cant_do`, `wont_do`, or `compliance_block` nak. |
| `4` | Transient dispatch failure: `not_now` nak (backpressure). |
| `124` | `--wait` timeout elapsed without a verdict. |

**JSON output shape (--json --wait, success):**

```json
{
  "ok": true,
  "items": [{
    "correlation_id": "01HZQ8N3K7P5V4F2WX9YBM6E0R",
    "verdict": "changes-requested",
    "repo": "the-metafactory/cortex",
    "pr": 229,
    "reviewer": "echo",
    "summary": "verdict: blockers=0 majors=2 nits=3 — recommend: request-changes",
    "findings": { "blockers": 0, "majors": 2, "nits": 3 },
    "github_review_url": "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459183744",
    "envelope_id": "01HZQ8R1A9X7T2K3W4P5VYNB8M",
    "envelope_timestamp": "2026-05-16T09:51:33Z"
  }],
  "metadata": { "subject_pattern": "local.metafactory.review.verdict.>" }
}
```

**JSON output shape (--json, no --wait):**

```json
{
  "ok": true,
  "items": [{
    "correlation_id": "01HZQ8N3K7P5V4F2WX9YBM6E0R",
    "subject": "local.metafactory.tasks.code-review.typescript",
    "published_at": "2026-05-16T09:42:11Z"
  }],
  "metadata": { "wait": false }
}
```

**Test coverage requirements:**

| Test | Method |
|---|---|
| `parseRequestReviewArgs` rejects malformed `--pr`, `--capability`, `--timeout` | Unit, fixture-based |
| Publish-only path: no `--wait`, only publish fires, correlation_id returned | Integration with stub publish |
| Publish-and-wait happy path: publish + verdict match → exit 0 | Integration with stub publish + stub subscriber |
| Wait timeout: no envelope on the wire → exit 124 | Integration with stub subscriber |
| Nak path: `dispatch.task.failed` with each of the four reasons → exits 3 or 4 | Integration with stub subscriber |
| Multiple matching verdicts: first wins, second logged-and-dropped | Integration with stub feeding two envelopes |
| Config load failure: clean exit 1 with operator-readable error | Unit |
| `--json` mode renders the documented shape | Unit, fixture compared |

### §5.2 `pilot wait-for-verdict`

**Synopsis:**

```
pilot wait-for-verdict --correlation-id <uuid> [--timeout 30m]
                       [--config <path>] [--json]
```

**Behaviour:** the **bare wait** primitive — pairs with `pilot request-review --no-wait`. Subscribes to `local.{org}.review.verdict.>` + `local.{org}.dispatch.task.completed` + `local.{org}.dispatch.task.failed`, filters by correlation_id, races timeout. Identical match-and-render logic as `request-review --wait`'s wait step.

**Args:**

| Flag | Type | Required | Notes |
|---|---|:-:|---|
| `--correlation-id` | string | yes | The envelope.id returned by a prior `request-review`. Validated as a non-empty string (ULID/UUID grammar not enforced — pilot accepts whatever shape cortex publishes, which today is ULIDs). |
| `--timeout` | duration | no | Default `30m`. |
| `--config` | path | no | cortex.yaml path. |
| `--json` | bool | no | JSON output. |

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Verdict received. |
| `1` | Runtime error. |
| `2` | Usage error (missing --correlation-id, malformed --timeout). |
| `3` / `4` | Nak per §4.4. |
| `124` | Timeout. |

**JSON output shape:** identical to `request-review --wait` success/failure shapes.

**Diff against `request-review --wait`:**

- No publish step. The CLI assumes the request envelope was already published.
- Correlation-ID is required and explicit; not derived from a fresh publish.
- Useful in batch / async workflows where the operator wants to request many reviews up front and gather verdicts later.

**Test coverage requirements:** subset of `request-review --wait` tests, with correlation-id passed explicitly instead of derived from publish.

### §5.3 `pilot wait-for-review` — transition fallback

**Synopsis:**

```
pilot wait-for-review --pr <owner/repo#N> --reviewer <login> [--timeout 30m]
                      [--require approved|changes_requested|commented|any]
                      [--config <path>] [--json]
```

**Behaviour:** subscribes to `local.{org}.github.>` and matches on (repo, pr_number, reviewer login, optional review state). This is **the same CLI as cortex#234**, lifted into pilot. The producer is cortex's `gh-webhook-receiver`; the consumer is pilot. The match-payload shape, exit codes, JSON envelope, and timeout grammar are **identical to cortex#234**.

**Why the duplication of shape:** the reverted CLI's source is the proven shape. Lifting it verbatim (with `pilot wait-for-review` as the new binary name) means zero behavioural change for the skill that consumed it via `cortex wait-for-review`. The skill update is a one-line rename.

**Args:** identical to cortex#234's `--pr` / `--reviewer` / `--timeout` / `--require` / `--config` / `--json`.

**Exit codes:** identical (`0` / `1` / `2` / `124`).

**JSON output shape:** identical to cortex#234's `ReviewMatch` payload — `kind`, `action`, `repo`, `pr`, `reviewer`, `state`, `body_summary`, `envelope_id`, `envelope_timestamp`, `delivery_id`.

**Diff against `wait-for-verdict`:**

| Axis | `wait-for-verdict` | `wait-for-review` |
|---|---|---|
| Subscribes to | `local.{org}.review.verdict.>` + lifecycle | `local.{org}.github.>` |
| Producer | Capability-dispatch consumer (Echo via cortex#237) | cortex `gh-webhook-receiver` |
| Filter key | `correlation_id` | `(repo, pr_number, reviewer)` |
| When to use | After `request-review --no-wait` | When cortex#237 hasn't shipped yet, OR as a defensive fallback if the capability-dispatch path silently drops |
| Retires when | Never — this is the canonical primitive | cortex#237 ships AND has burned in ≥1 review cycle |

**Documentation must call out the fallback nature.** The `pilot wait-for-review --help` text explicitly says: "Transition fallback for the bot-mention → capability-dispatch migration. Once cortex#237 has shipped and stabilised, use `pilot wait-for-verdict` instead. This CLI retires per the pilot restructure migration plan."

**Test coverage requirements:** lifted verbatim from `tests/wait-for-review.test.ts` in cortex#234 (38 tests). Match-payload assertions; exit-code assertions; JSON-envelope assertions; subscriber lifecycle (start + stop on match + stop on timeout + close NATS link).

### §5.4 CLI grouping in `cli.ts`

The three new CLIs slot into the existing `cli.ts` dispatch table as new `else if (cmd === ...)` branches alongside `fetch`, `triage`, `dispatch`, etc. They live next to `ping` (which they spiritually replace) at line ~436. No reorganisation of `cli.ts` beyond the new branches and imports from `bus/`.

---

## §6 — Migration plan

The plan is **phase-by-phase**, each phase shipping a discrete PR (or PR cluster) with explicit start/end conditions and a test bar.

### §6.1 Phase boundaries

| Phase | Scope | Cortex#237 dependency |
|---|---|:-:|
| **A — Survey + new bus primitives ship dormant** | This spec merges; new bus primitives land but are not yet wired into cli.ts dispatch. | No |
| **B — Workflow rewrite consumes new primitives** | `workflow/review/` and `workflow/claim/` consume `bus/subscribe-verdict.ts` for cycle terminations. cli.ts gets `request-review` + `wait-for-verdict` + `wait-for-review` verbs. The new path is OPT-IN behind a flag or env var. | No (operates dormant — `wait-for-verdict` returns nothing until consumer exists) |
| **C — cortex#237 ships + cutover** | cortex#237 lands: Echo subscribes to `tasks.code-review.*` and emits `review.verdict.*`. Pilot flips the default review path from bot-mention to capability dispatch. | YES |
| **D — Retire bot-mention path + LUNA_DISCORD_ID** | `bus/legacy/{discord*,reviewers,nats-review-io,mention-dispatch}.ts` deleted. Skill rewritten to use new primitives only. | YES (operationally proven for ≥1 cycle) |

### §6.2 Phase A — Survey + new bus primitives ship dormant

**Goal:** the four-subtree layout is in place; new bus primitives exist and are unit-tested; nothing in production behaviour changes.

**Cortex-side prerequisite PRs (A.0 cluster — block all pilot-side work in this phase):**

| PR | Repo | Scope | Blocks |
|---|---|---|---|
| **PR-A.0a** | cortex | Extend `DispatchTaskFailedReason` (`src/bus/dispatch-events.ts:267-284`) with the four nak kinds named in `docs/architecture.md` §7.3: `cant_do` / `wont_do` / `not_now` / `compliance_block`. Each is a sibling discriminator to today's `policy_denied`. Tests cover the new builder paths. **Resolves** the warning flagged in this spec's §4.4. | A.5 (pilot's `bus/subscribe-verdict.ts` cannot consume nak envelopes that cortex doesn't yet emit). |
| **PR-A.0b** | cortex | Add `exports` map to cortex's `package.json` exposing named entry points: `@the-metafactory/cortex/bus` (NatsLink + MyelinSubscriber + envelope-validator), `@the-metafactory/cortex/config-loader` (`loadConfigWithAgents`). Cortex's `"private": true` flag stays — exports map is independent of npm-publication. **Resolves** §8.1. | A.6 (pilot's `package.json` cortex dep can't resolve deep imports without this — see §7.3 caveat). |
| **PR-A.0c** | cortex | Ratify the `review.verdict.*` envelope payload shape per §4.2 of this spec, either as an update to `docs/design-pi-dev-review-agent.md` §4 or as a sibling `docs/design-review-verdict-envelope.md`. **Resolves** the warning flagged in this spec's §4.2 (today the payload is pilot-proposed; once this lands, it's the canonical contract). | A.5 + cortex#237's Echo emitter — both consumers/producers need the ratified shape. |

**Pilot-side PR cluster (gated on the A.0 cluster above):**

1. **PR-A.1** — this spec. Merges into cortex (per the design-docs-in-cortex precedent set by `design-pi-dev-review-agent.md`). Title: `docs(design): pilot restructure spec — capability-dispatch alignment (refs cortex#232, cortex#237)`. **Not gated on A.0** — this is the design landing first.
2. **PR-A.2 (pilot) — file moves, split per subtree.** Four sub-PRs land in order, each a clean `git mv` cluster with import-path rewrites. Each is independently CI-green so reviewers can diff per-cluster without rubber-stamping a 50-file mega-commit (Echo cortex#238 round 1 warning):
   - **A.2.1** — `persistence/` moves (`db.ts`, `agent-state.ts`, `dashboard.ts`). Smallest cluster; first to land because nothing else moves before it (it's a graph leaf).
   - **A.2.2** — `forge/` moves (`forge.ts`, `forge-detect.ts`, `forge-fetch.ts`, `forge-ping.ts`, `github-backend.ts`, `gitlab-backend.ts`, `gitlab-monitor.ts`, `gh.ts`).
   - **A.2.3** — `bus/` moves (`nats-publish.ts` → `bus/publish-review-request.ts`; legacy files into `bus/legacy/`).
   - **A.2.4** — `workflow/` moves (everything remaining: `review-loop.ts`, `claim-loop.ts`, `tick.ts`, `ping.ts`, `dispatch.ts`, `triage.ts`, `apply.ts`, `merge.ts`, `implement.ts`, `interrupt.ts`, `cleanup*.ts`, `next-pick.ts`, `open-pr.ts`, `parse-review.ts`, `replay.ts`, `review*.ts`, `tiers.ts`, `watch.ts`, `sync.ts`, `llm-loop.ts`, `mention-dispatch.ts`). `cli.ts` import-path rewrites land in the same PR.
   - CI gate on each: `bun test` green, `bunx tsc --noEmit -p src/tsconfig.json` clean. Runtime behaviour byte-identical.
3. **PR-A.3 (pilot)** — `bus/matchers/verdict.ts` lands as pure code with unit tests (no subscriber wiring yet).
4. **PR-A.4 (pilot)** — `bus/matchers/github-review.ts` lands as pure code with unit tests (lifted verbatim from cortex#234's matcher).
5. **PR-A.5 (pilot) — gated on A.0a + A.0c.** `bus/subscribe-verdict.ts` and `bus/subscribe-github.ts` land as full implementations with stub-based integration tests. Nothing in `cli.ts` calls them yet. The verdict subscriber consumes the ratified payload shape from A.0c; the nak path consumes the extended `DispatchTaskFailedReason` from A.0a.
6. **PR-A.6 (pilot) — gated on A.0b.** `package.json` adds the cortex dependency (mechanism per §7). `bus/envelope.ts` and `bus/nats-link.ts` re-export the cortex internals via the exports map A.0b just landed. `tsc` clean.
7. **PR-A.7 (pilot) — layer enforcement.** Add ESLint `no-restricted-imports` (or equivalent `tsconfig.json` `paths` zone config) that enforces the forbidden import directions in §3.3 mechanically. Without this, layer discipline degrades the moment a contributor doesn't read the spec (Echo cortex#238 round 1 warning). Ships alongside A.2.4 (after all subtree moves are in place so the rule has something to enforce).

**Acceptance criteria for Phase A:**

- All A.0 cortex-side prerequisites merged.
- All 50 src files live under the four subtrees.
- `bun test` green (test count: unchanged from pre-restructure; should be 47 test files green).
- `bunx tsc --noEmit` clean.
- `bun run lint` clean against the new `no-restricted-imports` rule from PR-A.7 — confirms no cross-subtree forbidden imports slipped in during A.2.*.
- `pilot --help` shows the existing verb list (no new verbs yet).
- The pilot binary's runtime behaviour is **byte-identical** to pre-restructure (the only difference is internal file paths).
- New bus primitives have ≥80% unit-test coverage of pure logic (matchers) and ≥80% integration coverage (subscribers) via stubs.

**What stays compatible vs what breaks:**

- **Compatible:** all CLI verbs, all skill invocations, all internal entry-points called by the skill.
- **Breaks:** internal imports — any external consumer of pilot's internal modules (none known) would need import-path updates.

**Tests that must pass:**

- All 47 existing test files (with updated import paths).
- New unit tests for `bus/matchers/{verdict,github-review}.ts`.
- New integration tests for `bus/subscribe-{verdict,github}.ts`.
- ESLint `no-restricted-imports` rule (PR-A.7) — green on the post-A.2.4 tree.

### §6.3 Phase B — Workflow rewrite consumes new primitives

**Goal:** the new CLIs ship and work end-to-end (publish + wait), with the verdict path **dormant** awaiting cortex#237. The github.* fallback works immediately.

**PR cluster:**

1. **PR-B.1 (pilot)** — `pilot wait-for-review` CLI lands. Wired into `cli.ts`. Help text marks it as transition fallback. Tests: lift 38 tests from cortex#234.
2. **PR-B.2 (pilot)** — `pilot request-review` CLI lands (publish-only path; --wait stubbed to error until B.3). Wired into `cli.ts`. Tests: publish path + arg-parsing.
3. **PR-B.3 (pilot)** — `pilot wait-for-verdict` CLI lands. `request-review --wait` activates by delegating to the same logic. Tests cover both, including nak handling. **Note:** these will return `124` (timeout) until cortex#237 ships, because no consumer is producing verdict envelopes on `local.{org}.review.verdict.*`. The CLIs are operationally complete; they just have nobody to talk to yet.
4. **PR-B.4 (pilot)** — skill `~/.claude/skills/pilot-review-loop/SKILL.md` learns about the new verbs. Documents the fallback chain (`wait-for-verdict` first, fall through to `wait-for-review` on timeout). Skill markdown only — no pilot CLI changes.
5. **PR-B.5 (pilot)** — `workflow/review/ping.ts` (the renamed `ping.ts`) gains an opt-in `PILOT_BUS_VERDICT_WAIT=1` env-var path. When set, `pingCommand` follows the new flow (publish capability envelope, return correlation_id, optionally wait). Default OFF — preserves bot-mention behaviour for ops not yet ready to flip.

**Acceptance criteria for Phase B:**

- `pilot request-review --pr foo/bar#1 --capability code-review.typescript` publishes a valid envelope to NATS (observable via `nats sub local.metafactory.tasks.code-review.>`).
- `pilot wait-for-verdict --correlation-id <id>` subscribes and waits; times out cleanly at the specified timeout.
- `pilot wait-for-review --pr foo/bar#1 --reviewer echo` matches github.* envelopes from cortex's gh-webhook-receiver (real bus, real webhook, real GitHub).
- The skill's documented fallback chain works in operator hands.

**Tests that must pass:**

- All Phase A tests.
- 38 lifted `wait-for-review` tests, repurposed as `pilot wait-for-review` tests.
- New `request-review` tests (~20 tests covering arg parsing, publish, wait, nak).
- New `wait-for-verdict` tests (~10 tests covering arg parsing, subscription, match, timeout).
- Skill integration test: a stub-skill invocation that drives `request-review` → `wait-for-verdict` → falls through to `wait-for-review` → succeeds.

**What stays compatible vs what breaks:**

- **Compatible:** existing skill invocations (`pilot ping`, `pilot fetch`, `pilot triage`, `pilot dispatch`, etc.) all work unchanged.
- **Breaks:** nothing yet — new CLIs are additive.

### §6.4 Phase C — cortex#237 ships + cutover

**Goal:** Echo subscribes to `tasks.code-review.*` and emits `review.verdict.*`. Pilot flips to the capability-dispatch path as the **default**.

**Cortex#237 deliverable** (out of pilot's scope; see [cortex#237](https://github.com/the-metafactory/cortex/issues/237) for the authoritative work list — Echo's bus-consumer subscription, lifecycle emission, and verdict emission. This spec does not restate the deliverable to avoid drift with #237's acceptance criteria. Echo cortex#238 round 1 suggestion).

**PR cluster (in pilot):**

1. **PR-C.1 (pilot)** — `workflow/review/ping.ts` flips defaults: `PILOT_BUS_VERDICT_WAIT` removed; the new path is **always** the verdict-wait path. Bot-mention Discord post is kept as a defensive secondary signal (post and forget — does not gate the verdict wait).
2. **PR-C.2 (pilot)** — skill rewritten to use `pilot request-review --wait` directly. The fallback chain (`wait-for-verdict` then `wait-for-review`) shrinks to a single primary call. The fallback CLI is documented but not used unless the primary times out.
3. **PR-C.3 (cortex docs)** — update `docs/design-pi-dev-review-agent.md` and this spec to mark cutover-complete. Tick the relevant checkboxes in the migration plan.
4. **PR-C.4 (pilot)** — observability: `pilot request-review --wait` emits OTLP spans (Tier 3 visibility) covering publish → first-progress-envelope → verdict. Consumer chain on architecture §3.6 Tier 3.

**Acceptance criteria for Phase C** (tightened to gate-able bars per Echo cortex#238 round 1 warning — "≥1 review cycle" was observational, not measurable):

- A `pilot request-review --pr the-metafactory/cortex#X --capability code-review.typescript --wait` invocation receives an Echo-published `review.verdict.*` envelope and exits 0 with the documented JSON payload, end-to-end against the live cortex bus.
- The pilot-review-loop skill drives a full PR through review using the new path: open PR → `pilot request-review --wait` → Echo reviews → `review.verdict.changes-requested` → operator/agent fixes → `pilot request-review --wait` (cycle 2) → `review.verdict.approved` → merge.
- The bot-mention path remains as a **secondary signal** but no longer gates the loop.
- **Quantitative cutover gate (replaces "≥1 review cycle"):** ≥5 consecutive real review cycles across ≥2 PRs over ≥48 hours of wall-clock time, with all five satisfying:
  - exit 0 from `pilot request-review --wait` (no timeouts).
  - zero invocations of the github.* fallback recorded in pilot's stderr log (i.e. the capability-dispatch path was the actual transport on every cycle, not just nominally enabled).
  - verdict correlation_id matches the request envelope.id on every cycle (no silent miscorrelations).
  - `dispatch.task.completed` arrives within 60s of `review.verdict.*` on every cycle (lifecycle envelopes co-emitted as §4.3 specifies).
  - If any one of the five cycles fails any of these checks, the 48h window restarts. Phase D does not open until five consecutive cycles pass.

**Tests that must pass:**

- All Phase B tests.
- A real-bus integration test (against a local nats-server or a CI-hosted bus) that drives a stub Echo consumer + a stub PR webhook stream through the full happy path.

**What stays compatible vs what breaks:**

- **Compatible:** all existing verbs; `wait-for-review` (the github.* fallback) still works.
- **Breaks:** if cortex#237 has not landed, `pilot request-review --wait` will time out at 30m. Operators get a clear error message and a hint to invoke `pilot wait-for-review` as fallback.

### §6.5 Phase D — Retire bot-mention path + LUNA_DISCORD_ID

**Goal:** the transition is complete. Bot-mention Discord transport retires from the pilot review path. The static reviewer registry retires.

**PR cluster (in pilot):**

1. **PR-D.1 (pilot)** — delete `bus/legacy/{discord.ts,discord-veto.ts,reviewers.ts,nats-review-io.ts}` AND their test files. Anywhere these were imported in `workflow/` gets a final cleanup (most call sites already migrated in Phase C).
2. **PR-D.2 (pilot)** — `mention-dispatch.ts` audit: if Phase 3 §F-9 wiring landed in the interim, the file moves to `workflow/mention/` permanently. If not, delete it.
3. **PR-D.3 (pilot)** — `arc-manifest.yaml` updates: remove Discord from `capabilities.network` (the new path uses NATS only). Bump major version (`0.2.0` → `1.0.0`) to mark the breaking-change boundary.
4. **PR-D.4 (pilot)** — `workflow/review/ping.ts` renamed to `workflow/review/request.ts` and reduced to a thin wrapper around `bus/publish-review-request.ts` (no Discord at all). The CLI `pilot ping` becomes an alias for `pilot request-review` (or retires entirely with a clean error pointing to the new verb).

**Acceptance criteria for Phase D:**

- `grep -r "REVIEWERS\|discordId\|LUNA_DISCORD_ID" src/` returns zero load-bearing hits. (Maybe a stray comment or a fixture file; load-bearing imports are gone.)
- `bus/legacy/` directory is empty (or deleted).
- The pilot binary's NATS connection is its only outbound network dependency for the review path. `gh` and `glab` calls remain for forge integration (unchanged).
- Test suite green; tsc clean.
- Skill markdown documents the new path only.

**Tests that must pass:**

- All Phase C tests.
- Removed: `tests/discord.test.ts`, `tests/discord-veto.test.ts`, `tests/reviewers.test.ts`, `tests/mention-dispatch.test.ts` (or whichever survived from D.2), `tests/nats-review-io.test.ts`.

**What stays compatible vs what breaks:**

- **Compatible:** the new path is byte-for-byte the same as Phase C; no operator-visible changes from C to D except the legacy fallback no longer exists.
- **Breaks:** if any external consumer of pilot's API still expects `REVIEWERS` to be importable from pilot, that breaks. None known.

### §6.6 Cross-cutting concerns

| Concern | Resolution |
|---|---|
| **Schema versioning** | The envelope shape is myelin-defined; pilot pins to `@the-metafactory/cortex@<sha>` (see §7) which transitively pins myelin. Any schema-flip is a coordinated update across cortex + pilot. |
| **OTLP spans** | Phase C.4 adds them. Pre-Phase C, pilot emits no traces — only stderr logs. |
| **Operator config** | `pilot request-review` reads cortex.yaml. The skill's `--config` defaults to `~/.config/cortex/cortex.yaml`. No new operator-visible config file in pilot. |
| **Rollback** | Each phase is reversible: Phase B can be reverted to A by removing the new verbs; Phase C can be reverted to B by reinstating the env-var gate; Phase D is a deletion phase — reverting it requires recovering the legacy files from git history. By Phase D the new path is proven, so rollback is not anticipated. |

---

## §7 — Cortex dependency setup

Pilot's `bus/` subtree imports `NatsLink`, `MyelinSubscriber`, `Envelope`, `validateEnvelope`, `loadConfigWithAgents` from cortex. Two viable mechanisms; pick one.

### §7.1 Option A — `"file:../cortex"` local-path dependency

```json
{
  "dependencies": {
    "@the-metafactory/cortex": "file:../cortex"
  }
}
```

**Pros:**

- Zero network. `bun install` resolves locally.
- Fast iteration: edit cortex source, rebuild, pilot picks it up automatically.
- No version-pinning ambiguity during active co-development.

**Cons:**

- Assumes cortex repo is at `../cortex` relative to pilot checkout. **False for the standard `~/Developer/cortex` + `~/.config/metafactory/pkg/repos/pilot` layout.** Operators would have to manually symlink.
- CI configuration would need to clone cortex before `bun install`.
- arc-manifest distribution (the `arc upgrade Pilot` story): `arc` does NOT install path-relative deps. The pilot binary at `~/bin/pilot` would silently break on operator machines that don't have cortex checked out alongside.

### §7.2 Option B — Git-URL with pinned ref

```json
{
  "dependencies": {
    "@the-metafactory/cortex": "https://github.com/the-metafactory/cortex.git#<sha-or-tag>"
  }
}
```

**Pros:**

- Same pattern pilot already uses for myelin: `"@the-metafactory/myelin": "https://github.com/the-metafactory/myelin.git#2a58668"`.
- `bun install` works from any checkout location.
- Explicit version pinning via sha or tag.
- `arc upgrade Pilot` works unchanged — the dependency is fetched at install time on the operator's machine.
- CI compatible.

**Cons:**

- Each cortex-side change to bus internals requires a coordinated pilot bump: update sha in pilot's `package.json`, push, `arc upgrade Pilot`. During heavy co-development, this adds friction.
- The cortex repo is private. Bun needs auth. Already handled for myelin (which is also private) via the operator's git credentials.

### §7.3 Decision — Option B (gated on PR-A.0b)

**Pick: Option B (git URL with pinned sha) — conditional on cortex shipping an `exports` map first** (PR-A.0b in §6.2 — Echo cortex#238 round 1 warning resolution). Cortex is `"private": true` and has no `exports` field today; without one, `bun install <git-url>` resolves but pilot's deep imports (`@the-metafactory/cortex/src/bus/...`) become fragile to cortex's internal restructuring. Option B is the right destination; PR-A.0b is the precondition that makes it correct.

Justification:

1. **Matches the existing pattern.** Myelin already lives in `package.json` as `"https://github.com/the-metafactory/myelin.git#2a58668"`. Cortex slots in identically once A.0b's exports map ships. Operators know how to update sha-pinned deps.
2. **arc-upgrade-friendly.** The `arc upgrade Pilot` distribution story is load-bearing — pilot ships to operator machines via arc, not via a co-checkout assumption. Option A breaks this.
3. **Pinning matters during the cortex#237 lockstep.** Phase C explicitly requires cortex#237 to have shipped. Pinning pilot's cortex dep to a sha AT OR AFTER cortex#237's merge commit is the natural way to encode that dependency. Operators updating cortex+pilot together get a coordinated upgrade.
4. **The cost (sha-bump friction during co-dev) is bounded.** During active development, an operator can:
   - Temporarily switch to Option A with a `bun install file:../cortex --no-save` flag, OR
   - Use bun's `link` feature for local development without modifying `package.json`.
   The default `package.json` ships Option B for everyone else.

**Concrete `package.json` addition** (lands in PR-A.6, after A.0b's exports map merges):

```json
{
  "dependencies": {
    "@nats-io/jetstream": "^3.3.1",
    "@nats-io/transport-node": "^3.3.1",
    "@the-metafactory/cortex": "https://github.com/the-metafactory/cortex.git#<sha-of-A.0b-or-later>",
    "@the-metafactory/myelin": "https://github.com/the-metafactory/myelin.git#2a58668"
  }
}
```

`<sha>` lands at the head of cortex's main branch at or after A.0b's merge — pinning earlier would resurrect the deep-imports-without-exports-map problem. Subsequent bumps follow the same pattern as myelin (manual sha updates in `package.json`).

**Fallback if A.0b slips:** if PR-A.0b doesn't land before pilot Phase A.6 is ready to ship, pilot temporarily uses deep imports (`@the-metafactory/cortex/src/bus/nats/connection`) with an inline TODO comment per import site pointing at PR-A.0b. Pilot's `bus/envelope.ts` consolidates the deep-import surface to a single file so the fan-out is one edit when A.0b lands. This is explicitly a **Plan B**; the Plan A path (A.0b → A.6) is preferred.

### §7.4 What gets imported

From `@the-metafactory/cortex`, pilot's `bus/` directory imports:

| Symbol | From | Used in |
|---|---|---|
| `NatsLink` | `src/bus/nats/connection.ts` | `bus/nats-link.ts` (wrapped), `bus/subscribe-*.ts` |
| `MyelinSubscriber` | `src/bus/myelin/subscriber.ts` | `bus/subscribe-*.ts` |
| `Envelope` (type) | `src/bus/myelin/envelope-validator.ts` | All `bus/` files |
| `validateEnvelope` | `src/bus/myelin/envelope-validator.ts` | `bus/publish-review-request.ts` |
| `loadConfigWithAgents` | `src/common/config/loader.ts` | `bus/nats-link.ts` (config bootstrap) |

Plus the ancillary handler / stamp / classification types the subscribers need at typed wiring sites: `EnvelopeHandler`, `EnvelopeErrorHandler`, `InvalidEnvelopeHandler`, `InvalidEnvelopeReason`, `MyelinSubscriberOptions`, `NatsLinkOptions` (option/handler shapes), `SignedBy`/`SignedByEd25519`/`SignedByHubStamp` (stamp chain typing), `Classification`, `ValidationResult`, `getSignedByChain` (chain helper). Surfaced via the same `@the-metafactory/cortex/bus` entry — see `src/bus/index.ts` in cortex (post PR-A.0b at cortex#250). Cortex's barrel keeps the surface intentionally narrow — internal symbols (`tryParseEnvelope`, `deriveNatsSubject`, etc.) stay internal.

Cortex's `package.json` exposes these via its `exports` field (PR-A.0b shipped at cortex#250). Cortex remains `"private": true`; the exports map is an independent surface that doesn't require npm publication.

**Reverse: what does cortex import from pilot?** Nothing. The dependency is one-way: pilot → cortex.

### §7.5 Trade-off acknowledgement

The cortex dependency makes pilot's tests slower and its install more network-dependent. Net judgement: worth it. Pilot was already importing myelin (same pattern); adding cortex is incremental.

The alternative — vendoring the bus client into pilot — has been considered and rejected. Vendoring loses the lockstep guarantee with cortex's bus-internal evolution (envelope schema, namespace conventions, validator rules); pilot's bus client would silently diverge.

---

## §8 — Open questions

These are genuine ambiguities NOT resolved from the design-doc set as of 2026-05-16. Surface for Andreas + Echo (cortex#237 driver) to decide before Phase A merges.

### §8.1 — Cortex's public export surface for bus primitives — **RESOLVED**

Originally an open question; resolved by Echo cortex#238 round 1 review (warning flagged that §7.3 picked Option B as if this were already answered). **Decision:** cortex adds an `exports` map as a Phase A blocker, tracked as PR-A.0b in §6.2. Pilot's deep imports become named entry points (`@the-metafactory/cortex/bus`, `@the-metafactory/cortex/config-loader`); A.6 ships against the new surface.

Fallback path (deep imports with TODO comments) documented in §7.3 in case A.0b slips beyond Phase A.6.

### §8.2 — Capability-registry semantics for the `code-review.<flavor>` taxonomy

Per architecture §7.2 the capability registry lives at `local.{org}.agents.capabilities`. As of 2026-05-16, pilot publishes `tasks.code-review.<flavor>` but **does NOT consult the registry** before publishing. Two consequences:

- Publishing `tasks.code-review.elm` when no consumer claims that capability silently drops the envelope (or sits in JetStream until the retention window expires).
- A misconfigured `<flavor>` (e.g. a typo) produces no error.

Should `pilot request-review` query the capability registry pre-publish and refuse if no consumer is registered for the capability? The cleaner behaviour is yes (fail-fast). The simpler behaviour is no (publish-and-wait-for-timeout). cortex#237's consumer side will at minimum register the capabilities Echo claims; until then, pre-publish registry checks have nothing to check against.

Recommendation: in Phase B, `pilot request-review` warns to stderr if the capability registry has zero consumers for `<flavor>`. Does not refuse. In Phase C (post-cortex#237 cutover), upgrade the warning to a usage error (exit 2) by default, with a `--no-registry-check` override for operator flexibility.

### §8.3 — Multi-network handling

The IoAW Phase D federation work introduces `federated.*` namespaces and potentially multi-network bridge stacks (per IoAW §3.4 — network-as-scope, NOT per-peer capability scoping; Q4 lock-in). `pilot request-review` today implicitly assumes single-network: it reads `agent.operatorId` from cortex.yaml to form `local.{<org>}.*` and that's that.

Two options for multi-network handling:

- **CLI accepts `--network <id>` flag.** Defaults to `local`. When set, swaps the subject prefix to `federated.{network}.*`. The operator picks the destination network.
- **Pilot federates the request automatically** based on the PR's repo → network mapping (a config table somewhere). More magic, less explicit.

Recommendation: defer to Phase D's federation lift. Phase A/B/C of this restructure ship with implicit `local` only. The `--network` flag arrives in a follow-up PR after Phase D in IoAW lands.

### §8.4 — The Sage / multi-agent claim race

If multiple consumers register for `tasks.code-review.generic` (e.g. Echo and a future Sage), and pilot publishes one envelope, both agents may claim it. NATS pull consumer groups guarantee competing-consumer fairness — only one of them gets the message. But what if the operator wants **both** to review? (Unlikely in v1, but the bus contract permits it.)

Open: should `pilot request-review` support `--multi-claim N` to publish N copies, one per intended reviewer? Out of scope for this restructure; raise as a follow-up.

### §8.5 — `dispatch.task.completed` without preceding `review.verdict.*`

§4.3 notes that pilot treats this as `commented` with a warning. Echo's implementation MAY always emit both — open whether pilot's tolerance is needed or just defensive. Defer to cortex#237 implementation decisions; pilot's tolerance is a cheap defensive layer either way.

### §8.6 — Skill update timing for the github.* fallback rename

The `pilot-review-loop` skill currently uses (or referred to) `cortex wait-for-review`. PR #236 reverts the cortex CLI; the skill needs to be updated to use `pilot wait-for-review` instead. Open: does the skill update land alongside Phase B.1, or as a separate skill-only PR? Recommendation: same PR, since the skill is in `~/.claude/skills/pilot-review-loop/SKILL.md` and the change is mechanical (`s/cortex wait-for-review/pilot wait-for-review/g`).

### §8.7 — Test infrastructure for the bus integration tests

Phase A.5 lands integration tests for `bus/subscribe-{verdict,github}.ts`. Today's pilot test suite uses Bun's test runner without a live NATS server. Two options:

- **Stub-based tests** (cortex#234's pattern): inject `NatsLink.connect` and `MyelinSubscriber.start` via a Deps interface; tests provide stubs that resolve at the right moments. Fast, deterministic.
- **Live nats-server tests** (Bun spawns a server in `beforeAll`): higher fidelity, slower, ~250ms per test.

Recommendation: stub-based primary; one or two live-server "smoke" tests in CI to catch obvious wiring regressions. Same pattern as cortex#234.

---

## §9 — Acceptance criteria summary

The full restructure is complete when:

- [x] Phase A merged: file moves done; new bus primitives unit-tested; tsc + tests green. **Shipped — Wave 1 (cortex#248, cortex#249, cortex#250; pilot#94-#102, #105).**
- [x] Phase B merged: three new CLIs ship; skill knows about them; capability-dispatch publish path works against real bus; verdict-wait times out cleanly until cortex#237. **Shipped — Wave 2 (pilot#104, #106-#109).** Note: pilot#109 ships the `pingCommand` opt-in path behind `PILOT_BUS_VERDICT_WAIT=1`; retirement of the env-var gate is Wave 3 C.1.
- [ ] Phase C merged (lockstep with cortex#237): default review path uses capability dispatch; bot-mention transport demoted to secondary signal.
- [ ] Phase D merged: legacy Discord transport deleted; `REVIEWERS` registry deleted; `arc-manifest.yaml` cleaned of Discord deps.
- [ ] Skill rewritten to use `pilot request-review --wait` as the primary verb.
- [ ] The pilot binary is one major version newer (1.0.0).

cortex#232 is closed when Phase A merges (the design lands as a tracked artefact). cortex#237 owns Phase C's lockstep partner work and is closed by Echo's bus-consumer cutover.

---

## §10 — References

- `~/Developer/cortex/docs/design-pi-dev-review-agent.md` — capability-dispatch envelope shapes (load-bearing).
- `~/Developer/cortex/docs/design-internet-of-agentic-work.md` — multi-network framing (Phase D context).
- `~/Developer/cortex/docs/architecture.md` — §3, §7 (bus structure, capability dispatch).
- `~/Developer/cortex/docs/plan-internet-of-agentic-work.md` — Phase D detail (out of this spec's immediate scope).
- `~/.config/metafactory/pkg/repos/pilot/` — source under restructure.
- `git show 3a88dd8:src/cli/cortex/commands/wait-for-review.ts` — reverted CLI; the shape template for §5's three new CLIs.
- cortex PR #236 — reverts the cortex#234 CLI; surfaces this restructure as the follow-up.
- cortex#232 — review-bundle migration umbrella.
- cortex#237 — Echo's bus-consumer cutover (Phase C lockstep partner).

---

*This spec is the design contract for the pilot restructure. Implementation follows the phased plan in §6.*
