---
task: "Cortex ideal state: every fire reaches a process, every goal-job failure reaches its principal, the backlog follows this file"
slug: cortex-product-vsa
effort: E3
phase: observe
started: 2026-11-16T00:00:00.000Z
updated: 2026-11-16T00:00:00.000Z
---

## Problem

Cortex is busy, and the goals its principals hand it barely move. Evidence read on 2026-11-16 (read-only, from the repo and public GitHub data):

- 421 issues are open; 348 were created before 2026-08-18 (older than 90 days), and none of the 421 cites an ISC (`gh issue list --state open`, body grep `ISC-`).
- In the last 30 days 676 issues were opened, 772 closed and 473 PRs merged. Of 271 commits on `main`, 186 are Desk work and 8 mention Vigil (`git log --since=2026-10-17`). There is no root `VSA.md` that says which of that work matters.
- Vigil texts only `goal` and `goal-sensor` subjects; every other worse transition goes to the digest (`src/vigil/routing.ts:6-10`). A job run whose subject carries no goal id is digested, however often it fails.
- A second failure in a row writes no transition, because Vigil only records a change of value (`src/vigil/ingest.ts:123`). Seven straight failures of a goal job therefore produce at most one event.
- A text that comes due between 22:00 and 07:00 local is held and later folded into the digest (`src/vigil/budget.ts:38-41`, `src/vigil/flush.ts:50-53`, `src/vigil/digest.ts:55`). A goal sensor that runs at night never texts.
- Cortex records the fire, not the outcome. A process that starts a downstream job is `succeeded` as soon as it fires, even when that job then fails.
- A Reflex activation whose target has no route is acked with a `_failed` system event and reaches no person (`src/bus/reflex-activation-listener.ts:596-599`). Targets are read once at boot (`src/cortex.ts:4098`, `:4141`), while process specs are read fresh on each fire (`src/cortex.ts:4113-4128`), so a new spec without a route and a restart drops its fires. Nothing checks that specs and routes agree.

## Vision

- **Level 1 — Life outcome.** A principal's scheduled agent work runs without anyone watching it. When a job that serves one of their goals stops, or a gate has waited on them too long, they get one text within a day that says what stopped. Otherwise cortex stays quiet, and no maintainer reads the issue list to find out what matters.
- **Level 2 — System behavior.** Every scheduled fire reaches a process or produces a text. Every run lands in the ledger with its real outcome and the goal it serves. Vigil texts goal-job failures and long gate waits, and digests the rest. The open backlog holds only issues that cite a failing criterion in this file, and every PR is reviewed by Sage before it merges.
- **Level 3 — Mechanism.** Reflex fires, the activation bridge resolves the target, and the process runner runs the spec. A route-parity check fails when a spec and its route disagree. Run envelopes carry `serves.goal` and the downstream job's outcome. Vigil counts consecutive failures, tracks gate age, and sends held texts after quiet hours. Sage runs in-process through the ReviewConsumer. Ranger claims only nodes that cite an ISC here.

Euphoric surprise: a week where the open-issue count is lower on Sunday than on Monday, and the only messages from cortex were two texts that each named a failed goal job and how to rerun it.

## Out of Scope

- Federation, network join and hub work, unless an ISC here needs it.
- New Desk surfaces and adapters that serve no ISC in this file.
- Any one principal's stack: its jobs, goals, schedules and routes live in that principal's configuration, not in this repo.
- Replacing Reflex, ranger or Sage. Cortex carries their fires and results; it does not take over their jobs.

## Principles

- An outcome counts, a fire does not. A run is healthy only when the work it started succeeded.
- Silence is a failure mode. Anything that drops work must say so to a person.
- One text beats ten digest lines. Texts are scarce and reserved for goals and gates.
- Throughput is not progress. Only an ISC flipping from failing to passing counts.

## Constraints

- TypeScript and Bun. Each change lands as its own PR in `the-metafactory/cortex`, reviewed by Sage.
- Deploys, money, deletes, publishing and outbound messages keep needing the principal's yes. Nothing here loosens the principal-only gate or the policy engine.
- The repo is public (AGPL-3.0) and shared. This file and any issue citing it name goals by ID only; goal wording stays in each principal's private home.
- Backlog bankruptcy closes issues as not-planned. It never deletes an issue.
- Vigil keeps its daily text budget (`VIGIL_DAILY_TEXT_LIMIT = 3`, `src/vigil/budget.ts:4`).

## Goal

Every Reflex fire either reaches its process or texts the principal, and two failures in a row of a goal job reach the principal by text within a day. Within the bankruptcy scope, the open backlog contains no issue older than 90 days that cites no ISC from this file.

## Checkpoints

### Gate
- [x] ISC-1: The maintainers confirm Levels 1 and 2 of this Vision, recorded with a date in Decisions.

### Fires reach a process
- [ ] ISC-2: A route-parity check exits non-zero on a spec without a route or a route without a spec, and `arc upgrade cortex` runs it.
- [ ] ISC-3: An activation that resolves to `unknown_target` produces a Vigil text that names the target.
- [ ] ISC-4: A check reports when the running daemon's target list differs from `cortex reflex targets` for the same config.

### Outcomes, not fires
- [ ] ISC-5: Every ledger run of a job that declares a goal carries `serves.goal`, and its Vigil subject has a non-null `goal_id`.
- [ ] ISC-6: A goal process run is recorded as `succeeded` only when the job it started succeeded.

### Vigil reaches the principal
- [ ] ISC-7: Two failures in a row of a goal-tagged job produce a Vigil text, not a digest line.
- [ ] ISC-8: A text held in quiet hours is sent after 07:00 local the same morning instead of being digested.
- [ ] ISC-9: A gate that has waited on its principal for more than 48 hours produces a Vigil text.

### Backlog follows this file
- [ ] ISC-10: No open issue older than 90 days within the bankruptcy scope (see Decisions) lacks a reference to an ISC in this file.
- [ ] ISC-11: Every issue opened in cortex by an agent account in the last 30 days cites an ISC from this file.
- [ ] ISC-12: Ranger refuses to claim a cortex node whose body cites no ISC from this file, and journals the refusal.

### Review
- [ ] ISC-13: Every PR merged to `main` in the last 7 days has a Sage review.
- [ ] ISC-14: Sage marks a worker PR as needing changes when it does not flip its targeted ISC in this file.

### Health
- [x] ISC-15: The latest CI run on `main` concluded `success`.

### Anti-criteria
- [ ] ISC-16: Anti: No change removes or loosens a yes-gate on deploy, money, delete, publish or outbound message.
- [ ] ISC-17: Anti: No issue closed in the bankruptcy is deleted or referenced by an open PR.
- [ ] ISC-18: Anti: Vigil never sends more than 3 texts on one budget day.
- [ ] ISC-19: Anti: This file and the issues citing it contain no private goal wording, and the confidentiality gate passes on the PR that adds it.

## Test Strategy

| ISC | Probe |
| --- | --- |
| 1 | `grep -n "confirmed: levels 1-2" VSA.md`, dated. |
| 2 | Run the check on a fixture with an unrouted spec (exit 1) and on a routed fixture (exit 0); `grep` the arc upgrade hook for it. |
| 3 | Listener unit test: an unknown target yields a text-routed Vigil event; one live fire of a planted target. |
| 4 | Add a target to a temp config copy; the check reports the drift until restart. |
| 5, 6 | Ledger test with a goal-tagged job fixture; then `sqlite3 -readonly` over the stack's `vigil_subjects` for `goal_id` and paired process and job outcomes. |
| 7, 8, 9 | Vigil unit tests with a two-failure fixture, a 23:00 text fixture and a 49-hour gate fixture, then one live observation each. |
| 10 | `gh issue list --state open --limit 5000 --json createdAt,body,author`, filtered to issues older than 90 days within the bankruptcy scope, with a body grep for `ISC-`. |
| 11 | `gh issue list --state all --limit 5000 --search "created:>=<today-30d>" --json author,body`, filtered to agent authors (not to the bankruptcy scope), with a body grep for `ISC-`. |
| 17 | For each issue the bankruptcy closed, `gh issue view` shows it still exists, and `gh pr list --state open --search "<number>"` returns nothing. |
| 12 | Ranger journal row from a planted cortex node with no ISC. |
| 13, 14 | `gh pr view --json reviews` for merged PRs; a Sage fixture PR that leaves its ISC unflipped. |
| 15 | `gh run list --branch main --limit 1`. |
| 16 | Diff the policy and permission rules before and after each PR; no removals from ask or deny. |
| 18 | Budget unit test that offers a fourth text on one budget day; then `sqlite3` over `vigil_text_receipts` grouped by `budget_day`, max count at most 3. |
| 19 | Confidentiality-gate CI result on the PR; a grep for goal wording returns nothing. |

## Features

| Feature | Satisfies | Repo |
| --- | --- | --- |
| F-routes: route-parity check, unknown-target text, boot drift check | ISC-2–4 | cortex |
| F-outcomes: `serves.goal` on job runs, process health from job outcome | ISC-5, 6 | cortex, ranger |
| F-vigil: consecutive-failure rule, quiet-hours carry-over, gate-age rule | ISC-7–9, 18 | cortex |
| F-bankruptcy: close old uncited issues in scope, agent issues cite ISCs | ISC-10, 11, 17 | cortex |
| F-claims: ranger claim gate and Sage ISC lens for cortex | ISC-12–14 | ranger, sage |

Order: F-vigil first (goal jobs fail silently today), then F-routes, then F-bankruptcy once ISC-1 is confirmed and its scope is decided.

## Decisions

- 2026-11-16: Drafted read-only from the cortex repo and public `gh` counts. ISC-15 passes on that evidence; the rest are unverified or failing.
- 2026-11-16: The bankruptcy scope is undecided: which authors' and labels' issues may be closed is open for the maintainers. ISC-10 and ISC-17 apply only within the scope once it is recorded here.
- 2026-11-16: confirmed: levels 1-2 (jcfischer). Level 3 stays the builders' to change.
- 2026-11-16: Goal IDs only, because the repo is public (`gh repo view`: PUBLIC) and goal wording stays in each principal's private home.
