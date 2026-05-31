# Plan — Direction A Implementation (re-grounded)

**Status:** Active campaign. Re-grounded 2026-05-23 after audit of `origin/main` revealed Direction A is ~75% done already — earlier plan treated the work as if starting from zero, which was wrong.
**Date opened:** 2026-05-23 (re-grounded; supersedes the closed PR #415 plan)
**Driver:** Andreas (orchestrator); main session drives stage-by-stage; in-session sub-agent code-review per `review-pr` skill.

**Refs:**
- `docs/design-platform-adapter-dispatch-publishing.md` — the design spec
- `docs/design-myelin-osi-scenarios.md` — OSI scenarios, framing corrections, locked answers (PR #414)
- `docs/design-internet-of-agentic-work.md` + `docs/plan-internet-of-agentic-work.md` — federation baseline
- cortex#405 umbrella; #406–#412 stage sub-issues; #413 channel-topology; #414 design corrections PR; #417 adapter payload sanitisation; myelin#180 enum rename; myelin#181 chat capability

---

## TL;DR

Direction A is ~75% done on main. The earlier plan (closed PR #415) treated MIG-3b as a keystone — that branch was months stale and didn't reflect what main actually grew. Audit of main shows:

| Stage | Sub-issue | Status |
|---|---|---|
| 1 — adapter agent identity flip | #406 | **DONE** (no `AgentConfig.agent.{discord,mattermost,slack}` refs anywhere in src) |
| 2 — myelin chat capability + spec wiring | #407 | **Partial** (myelin#181 open for chat capability; cortex-side wiring done) |
| 3 — `EnvelopePublishingAdapterBase` + `AgentTeamHarness` | #408 | **Partial** (`surfaceConfig`+`renderEnvelope` done on all three adapters; no `AgentTeamHarness` SessionHarness wrapping the existing `src/runner/agent-team.ts`; no shared base class) |
| 4 — Discord adapter publishes inbound dispatch envelopes | #409 | **NOT DONE** — substantive work. Adapter currently routes user messages via `onMessage` callback → `src/bus/dispatch-handler.ts` (1291 LOC in-process path). Stage 4 = flip that to publish a bus envelope instead. |
| 5 — Discord dispatch-sink | #410 | **DONE** (`surfaceConfig.render = (envelope) => this.renderEnvelope(envelope)` already implements sink semantics across all three adapters) |
| 6 — Mattermost + Slack flip | #411 | **Partial for sink** (all three adapters have surfaceConfig); blocked on Stage 4 for source-side parity |
| 7 — Delete `dispatch-handler.ts` + cutover legacy | #412 | **NOT DONE** — depends on Stage 4 + AgentTeamHarness (Stage 3). Will delete 1291 LOC + remove legacy `dispatch.task.received` subscription + update IAW Phase D integration test |

The real outstanding implementation is **Stage 3 (`AgentTeamHarness` only — `EnvelopePublishingAdapterBase` is optional)**, **Stage 4 (adapter publishes envelopes)**, and **Stage 7 (cutover)**. Stages 1, 5, 6 are done or trivially done.

---

## §1 — Three tracks

### Track 1 — Direction A migration (cortex#405)

```
   PR #414 (design corrections) ── Andreas review ── merge
                                                      │
   Stage 1 ───────────────────── DONE on main ────────┤
   Stage 2 (cortex) ─────────── DONE on main          │
   Stage 2 (myelin) — myelin#181 ── merge ────────────┤
                                                      ▼
                            ┌──────────────────────────────────────┐
                            │ Stage 3 (#408) — AgentTeamHarness    │
                            │ • SessionHarness wrapping AgentTeam  │
                            │ • HarnessId = "agent-team" enum val  │
                            └────────────────┬─────────────────────┘
                                             ▼
                            ┌──────────────────────────────────────┐
                            │ Stage 4 (#409) — adapter publishes   │
                            │ • Discord onMessage callback flips:  │
                            │   dispatch-handler.handleMessage()   │
                            │   → publish envelope to bus          │
                            │ • Same for Mattermost + Slack        │
                            │ • Behind CORTEX_ADAPTER_ENVELOPE_MODE │
                            │   feature flag                       │
                            └────────────────┬─────────────────────┘
                                             ▼
                            ┌──────────────────────────────────────┐
                            │ Stage 5/6 — verify sink + parity     │
                            │ (mostly done; verify behind flag)    │
                            └────────────────┬─────────────────────┘
                                             ▼
                            ┌──────────────────────────────────────┐
                            │ Stage 7 (#412) — cutover             │
                            │ • Delete dispatch-handler.ts (1291)  │
                            │ • Remove `dispatch.task.received`    │
                            │   subscription in dispatch-listener  │
                            │ • Update IAW Phase D integration     │
                            │   test + cortex.test.ts subjects     │
                            └──────────────────────────────────────┘
                                             │
                                             ▼
                                   cortex#405 closes
```

### Track 2 — IoAW federation (cortex#110)

Phases A–E owned by `docs/plan-internet-of-agentic-work.md`. cortex#117 Phase E (multi-network bridges + delegation) unblocks cross-principal traffic. Direction A model B (Scenario 4) opt-in for cross-principal channels depends on Phase E being operational.

### Track 3 — Boundary / UX cleanup

- **myelin#180** — `DistributionMode 'broadcast' → 'offer'` rename. cortex wraps at boundary; not blocking.
- **cortex#413** — Channel-topology config for Scenario 4 model B. Pre-req for cross-principal Stage 4 opt-in.
- **cortex#417** — Adapter payload sanitisation (filed during the abortive autonomous sweep). Worth keeping as a follow-up under #405.

---

## §2 — Outstanding work (the actual to-do list)

### Critical path

| # | Step | Status | Effort |
|---|------|--------|--------|
| 0 | Audit + replan (this doc) | IN PROGRESS | small |
| 1 | PR #414 — Andreas review + merge | OPEN | small (review) |
| 2 | myelin#181 — review + merge | OPEN | small |
| 3 | Stage 3 (#408) — `AgentTeamHarness` SessionHarness wrapper + `HarnessId = "agent-team"` | NOT STARTED | medium |
| 4 | Stage 4 (#409) — Discord adapter publishes inbound envelopes (behind feature flag) | NOT STARTED | medium-large |
| 5 | Stage 4 parity tests | NOT STARTED | medium |
| 6 | Stage 6 (#411) — Mattermost + Slack source-side parity | NOT STARTED | small (pattern follows Stage 4) |
| 7 | Stage 7 (#412) — Cutover: delete `dispatch-handler.ts`, remove legacy subscription, update IAW Phase D tests + cortex.test.ts | NOT STARTED | medium |

### Optional / deferred

- `EnvelopePublishingAdapterBase` shared base class — not needed if Stage 4 work is inlined per-adapter (per-adapter is current pattern on main; refactor to base class is optional)
- Stage 5 (#410) — already done via `surfaceConfig.render`; close as done
- cortex#413 channel-topology — pre-req only for cross-principal model B opt-in, which is post-cutover work

---

## §3 — Per-stage SOP

Same SOP as before: worktree → branch → PR → in-session sub-agent code-review → fix small / defer big → merge. Pilot-loop skill (external Discord-mediated review) is NOT used — reviews are in-session via fresh-context sub-agent per `review-pr` skill.

### 3.1 Per-stage workflow

```
1. Read the stage's sub-issue body (#408 / #409 / #411 / #412).
2. Worktree:
     git worktree add ../cortex-c-{N}-{slug} -b feat/c-{N}-{slug} origin/main
3. Implement against the acceptance criteria.
4. Push branch; open PR with body:
     - cite umbrella #405 + stage sub-issue (Closes #4xx)
     - reference design doc sections
     - acceptance checklist
5. /review-pr {N} — spawn fresh-context sub-agent with CodeReview skill (FullReview workflow).
6. Orchestrate from main session:
     - Read sub-agent's findings + verify them against the actual diff (sub-agents have been wrong before — see PR #416 lessons below)
     - Fix small in-place; defer big to follow-up issues under #405
     - Re-push; /review-pr --sweep {N} (or another /review-pr) for re-review
     - Repeat until clean
7. Merge (squash). Sub-issue auto-closes via "Closes #4xx".
8. Tick the stage's row in §2 above.
9. Discord update to #cortex.
10. Move to next stage.
```

### 3.2 Lessons from PR #416 (closed) — verification discipline

The abortive autonomous loop on PR #416 surfaced critical lessons:

- **Sub-agent claims need verification.** The FullReview sub-agent reported "8 files / +1204 / -0 — legitimate cleanup" against a PR whose actual diff was 457 files / +2288 / -104,804. The orchestrator (main session) must independently check `git diff --stat` and `git diff --name-only` against `origin/main` before trusting a verdict.
- **Branch staleness check.** Before treating a branch as a candidate for merge, run `git rev-list --count HEAD..origin/main`. Anything >100 commits behind warrants a per-file audit, not a code review. PR #416's branch was -179 to -257 across files.
- **"Cleanup-by-deletion" claims must enumerate what's being deleted.** The sub-agent called the diff "legitimate cleanup". The actual deletions included F-1..F-4 specs, `gh-webhook-receiver` (~1000 LOC), the Slack adapter, and the current CONTEXT.md — none of which the sub-agent named.
- **TypeScript check claims must be re-run.** The sweep sub-agent claimed `bunx tsc --noEmit` was clean. IDE diagnostics post-commit showed real unused-var + bad-await issues. Run `bunx tsc --noEmit 2>&1` in the worktree yourself before merge.

---

## §4 — Current state map

### Done

- Design layer: `docs/design-platform-adapter-dispatch-publishing.md` + `docs/design-myelin-osi-scenarios.md` + `CONTEXT.md` corrections (PR #414, awaiting review)
- Stage 1 (#406): adapter agent identity — `agent: Agent` constructor signature, no legacy `AgentConfig.agent[]` reads
- Stage 5 (#410): dispatch-sink via `surfaceConfig.render` — all three adapters
- Stage 6 sink parity (#411 partial): all three adapters have matching surfaceConfig shape
- Existing infrastructure on main: `src/adapters/{discord,mattermost,slack}/`, `src/adapters/types.ts`, `src/adapters/envelope-renderer.ts`, `src/bus/surface-router.ts`, `src/runner/agent-team.ts`, `HarnessId` enum at `src/common/substrates/types.ts:116`

### In-flight (open PRs / issues)

- **cortex#414** — Direction A OSI corrections (design layer)
- **myelin#181** — `chat` capability extension (Stage 2 myelin side)
- **cortex#417** — Adapter payload sanitisation (follow-up filed during the abortive autonomous sweep — Stage 4 trust model)

### Not started

- Stage 3 (#408) — `AgentTeamHarness` wrapping `src/runner/agent-team.ts` as a `SessionHarness`; add `'agent-team'` to `HarnessId` enum
- Stage 4 (#409) — Discord adapter publishes inbound dispatch envelopes (flip the `onMessage` callback from `dispatch-handler.handleMessage()` to bus publish)
- Stage 6 source-side (#411) — Mattermost + Slack source-side parity to Stage 4
- Stage 7 (#412) — delete `dispatch-handler.ts`, remove legacy subscription, update IAW Phase D integration test

### Blocked

- Stage 4 model B (cross-principal channel opt-in): blocked on Track 2 Phase E + #413
- Scenario 5 cross-principal bot-to-bot: blocked on Track 2 Phase E

---

## §5 — Risks + open seams

### Risk 1 — `dispatch-handler.ts` is 1291 LOC of legacy behaviour

Stage 4 + Stage 7 retire it together. Risk: undocumented behaviours in `dispatch-handler.ts` (worklog formatting, agent-team orchestration, security preamble, prompt building, attachment handling, etc.) that the adapter→bus→listener path doesn't yet replicate. Mitigation:

- Read `dispatch-handler.ts` end-to-end before Stage 4; enumerate every code path
- Each enumerated behaviour gets either (a) a Stage 4 implementation, (b) a Stage 4 follow-up issue, or (c) an explicit "this is dead code on main, safe to drop" note
- Feature-flag the cutover (`CORTEX_ADAPTER_ENVELOPE_MODE`) so the legacy path stays operational during validation

### Risk 2 — IAW Phase D integration test is load-bearing on legacy subjects

`src/__tests__/iaw-phase-d-integration.test.ts` builds federated envelopes on `dispatch.task.received` (20+ references). Stage 7 must flip these to canonical `tasks.@{did}.{capability}` subjects. Mitigation: do this as part of Stage 7, not a separate cleanup PR.

### Risk 3 — Sub-agent reviewers have failed before

PR #416 sub-agent reviewer missed massive staleness + falsely claimed tsc clean. Mitigation: §3.2 verification discipline. Orchestrator independently runs `git diff --stat origin/main`, `bunx tsc --noEmit`, and `bun test src/adapters/` on every stage PR before trusting a verdict.

### Risk 4 — myelin#181 + cortex#414 may need rebase before merge

Both PRs were authored against `origin/main` snapshots. If main moves before they merge, rebase needed. Mitigation: rebase early, fast-track the design PRs ahead of implementation work.

### Open seams (deferred — file as follow-up issues, do NOT block stages 3–7)

- **myelin `DistributionMode` rename** (myelin#180) — cortex wraps at boundary in the meantime
- **Channel-topology config** (cortex#413) — pre-req only for cross-principal Stage 4 model B
- **IoAW Phase E** (cortex#117) — separate track; cross-principal traffic deferred to its readiness
- **Adapter payload sanitisation** (cortex#417) — Stage 4 trust model work, deferred to Stage 4 itself

---

## §6 — Operating notes for the main-session-as-orchestrator

The main session is the **orchestrator**, not the implementer in the strict sense. It:

1. Opens PRs (worktree → branch → push → `gh pr create`)
2. Spawns `/review-pr` for each PR (fresh-context sub-agent runs CodeReview skill)
3. **VERIFIES the sub-agent's verdict against actual state** (see §3.2 lessons)
4. Acts on verified findings: fix small / defer big / surface blockers
5. Re-runs review (sweep mode for fixes; full mode for fresh look)
6. Merges when verifiably clean (tsc clean, tests pass, diff matches intent)
7. Moves to next stage

The main session does NOT:
- Trust sub-agent verdicts without checking diff stats, tsc, and tests itself
- Block on long reviews (in-session sub-agent reviews are seconds-to-minutes, not hours)
- Make design decisions autonomously (those escalate to Andreas)
- Open issues that the user already filed (checks first per repo CLAUDE.md)

**Discord cadence:** post to #cortex on (a) opening a PR, (b) sub-agent review verdict + verification result, (c) merge or escalation, (d) significant findings worth surfacing mid-loop. Discord is for visibility, not control.

---

## §7 — Done definition

Track 1 is done when:

- PR #414 (design corrections) merged
- myelin#181 (chat capability) merged
- Stage 3 (#408 narrowed to AgentTeamHarness) closed via merged PR
- Stage 4 (#409) closed via merged PR — adapters publish inbound dispatch envelopes
- Stage 6 (#411 source-side) closed — Mattermost + Slack source parity
- Stage 7 (#412) closed — `dispatch-handler.ts` deleted, legacy subscription removed, IAW Phase D test flipped
- `git grep "dispatch.task.received"` returns zero hits in `src/`
- `git grep "dispatch-handler"` returns zero hits in active code (test fixtures may keep references for archival)
- Production cortex stable on envelope-mode for one release cycle
- `docs/architecture.md` + `CONTEXT.md` reflect post-Direction-A state
- Release notes call out the wire-grammar change for any external bus subscriber

Cross-principal Direct/Delegate (model B opt-in) and bot-to-bot direct chat (Scenario 5) become operational when Track 2 Phase E + Track 3 #413 land — those are separate done-definitions outside Track 1.
