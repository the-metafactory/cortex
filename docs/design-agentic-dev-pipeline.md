**Status: Draft — for principal review**

**Refs:** cortex#110 (IoAW umbrella) · `docs/design-internet-of-agentic-work.md` + `docs/plan-internet-of-agentic-work.md` (phase ladder) · `docs/design-event-driven-review-loop.md` (the `pilot watch` reactor) · `docs/design-pilot-restructure.md` · `docs/design-delegation-primitives.md` (E.3 / D4) · pilot specs 0001–0003 (agent, claim loop, mention dispatch) · pulse#15 (P-600/P-601 `agent:` step, merged 2026-06-09) · Spawn DD-63 (`spawn/design/spawn-concept.md`) · compass SOPs (`sops/*.md`) · the-metafactory/agents + agent-state · meta-factory DD-47/48/49/85 (process/graph/blueprint artifact types) · `CONTEXT.md` (vocabulary contract)

> **Provenance.** Synthesized from a 9-lane deep-dive (2026-06-10) across pilot, pulse, Spawn, cortex, compass, agents/agent-state, recall, and meta-factory packaging. The headline finding: the target architecture is ~80% built, distributed across five convergent efforts that have not yet been composed. This design is a **convergence plan**, not an invention.

---

## 1. The problem — the loop works; the orchestrator is the bottleneck

The dev pipeline that ships everything in this ecosystem is well-proven:

```
research → design (draft PR) → umbrella issue + sub-issues + PR plan
  → per-slice: worktree → dev → gates (tsc/lint/test/vocab) → PR
  → adversarial review → disposition (fix small / defer big) → merge
  → version → release → deploy → announce → retro
```

It runs today **inside one Claude Code session**: a principal-attended orchestrator drives fresh-context sub-agents for dev and review, verifies the tree itself, and walks every slice through the gates. A single overnight run shipped 10 reviewed gateway slices (cortex#536→#597). The process is *good*. Its container is the problem:

1. **Session-bound state.** The plan lives in the orchestrator's context + a task list. Compaction, crash, or session end loses the thread; another agent cannot pick it up mid-flight.
2. **Token concentration.** One brain re-reads the world on every turn — the "manager re-ingests the state of the system to decide the next step" pattern. The sub-agent fan-out helps (briefs are intent + refs, not context dumps), but the hub still pays quadratic coordination cost as the plan grows.
3. **One machine, one principal.** Everything executes on the principal's personal machine with the principal's ambient authority. No horizontal scale, no isolation, and the principal must keep the session alive.
4. **The repetition is unencoded.** The loop's procedure exists as prose SOPs and in-session habit. Every session re-derives it; none of it is installable by anyone else.

The fix is **not a bigger manager context**. It is the move the IoAW substrate was built for: replace the in-session hub with **decentralized, event-driven agents coordinating through capability dispatch and a persistent state fabric** — and package the result so any principal can `arc install` it.

## 2. Design principles

- **DD-P1 — Capability mesh, not super-brain.** Pipeline stages are **capabilities** (`dev.implement`, `code-review.*`, `merge.approve`, `release.cut`) claimed by whichever agent offers them — Offer-mode queue-group semantics, exactly how Echo claims `code-review.*` today. The center dispatches *intent*; competence lives at the edges (*dispatch, don't dictate*). No component holds global context.
- **DD-P2 — The plan lives with the accountable agent.** Per the D4 decision (E.3, CONTEXT.md §Layer discipline): the bus does **not** model the plan or delegation trees. The loop-driver agent owns its errand tree **durably and locally** (pilot's errand store / agent-state — the existing instance of the pattern). The bus routes envelopes and carries `correlation_id`; it stays dumb.
- **DD-P3 — State fabric over context payloads.** Coordination state lives in three tiers (§3.2), and **briefs carry intent + references into the fabric, never context bundles**. A worker pulls exactly the slice it needs (the repo, the issue, the design §) with its own tools. This is the article's token-trap counter, and it is already the loop's observed practice.
- **DD-P4 — Memory becomes context only through reviewable artifacts.** Procedural learning (retros, recall, miner traces) surfaces as **PRs against SOPs, process definitions, and CONTEXT.md** — never as silent prompt injection. The principal stays in control of what enters context. The "experience cache" compounds in git, where it is reviewable, versioned, and installable.
- **DD-P5 — Brain decoupled from hands.** Agent reasoning (where the loop runs) and code execution (where `claude -p` mutates a worktree) meet at one seam: cortex's `ExecutionBackend`. Local subprocess today; remote sandboxes (the Anthropic + Cloudflare pattern, E2B, SSH) later — **the seam ships now, the remote backends don't**. Horizontal scale and getting off the principal's personal machine are backend swaps, not redesigns (Spawn DD-63's SPAWN→PROVISION→RUN→RECLAIM lifecycle).
- **DD-P6 — Ships as a meta-factory blueprint.** The whole loop is a **graph** artifact (DD-49): a process definition + the agents that serve it + their state bundles + governance gates, installable via arc and listed on meta-factory. Dogfooding this packaging is itself a deliverable (it forces the DD-47/48/49 process/graph schemas to become real). *Terminology: "blueprint" here is the DD-85 collective noun for an installable metafactory component — distinct from `blueprint.yaml`, the cross-repo feature-dependency graph referenced in §3.4.*

## 3. Architecture

### 3.1 Actors

| Actor | Role | Capability / trigger | Exists today |
|---|---|---|---|
| **Pilot** (loop-driver) | Owns the errand tree (plan → slices → states); reacts to events; emits the next unblocked stage as a dispatch; never carries worker context | event-driven reactor on `review.verdict.*`, `dispatch.task.*`, `github.*`; cron `tick` for the claim loop | pilot specs 0001–0002: errand store, agent-state lifecycle (`pending→claimed→implementing→pr-open→reviewing→approved→merged→done`), `tick`, `replay`; the reactor (`pilot watch`) is designed (`design-event-driven-review-loop.md`), not built |
| **Dev agent** | Claims an implement task: worktree → CC session against the brief → run gates → open PR → emit completed with PR ref | `dev.implement` (Offer) | **the missing capability consumer** — but every part exists: pilot `implement.ts`/`llm-loop.ts`, cortex `ClaudeCodeHarness` (`src/substrates/claude-code/harness.ts`) + `runner/cc-session.ts`, worktree SOP, bash-guard |
| **Reviewer(s)** | Claim review tasks, run multi-lens review, emit verdict envelopes | `code-review.<flavor>` (Offer) | **live** — Echo's review-consumer (cortex#237, 8/9 PRs), incl. cross-principal (ADR-0002, cortex#686 + pilot#149) |
| **Approver-bot** (Ivy) | Independent merge gate: CI green, MERGEABLE, reviewer-identity, base-branch, head-SHA freshness → squash-merge | `merge.approve` | designed (spec 0001 AC#20 / 0002 §Step 7–8, two-of-two gate); not implemented |
| **Release agent** | Version bump, `gh release`, deploy per SOP, announce | `release.cut` (gated) | SOPs only (versioning/deployment/release-checklist); no consumer |
| **Surfaces** | Human visibility + control: worklog threads, MC dashboard, gateway → Discord; gates surface as approvals | dispatch sinks | live (worklog-manager, MC, shared surface gateway) |
| **Principal** | Sets intent; holds the gates (§3.5); reviews retro→SOP PRs | gate reactions / `pilot resume·release` | — |

The driver stays an *agent* (not a hidden service) deliberately: it is addressable (`@Pilot pause`), inspectable (dashboard from its state), and accountable (its envelopes are signed by its stack). What makes this not-a-super-brain is **what it holds**: state machine + errand rows — never repo context, never worker transcripts.

### 3.2 The state fabric — three tiers, all existing substrates

| Tier (article) | Holds | Substrate | Access pattern |
|---|---|---|---|
| **Episodic** — per-errand, volatile | slice state, review cycle counts, head SHA, veto windows, lifecycle events | pilot errand store (`errands.sqlite`) + agent-state (`work_items` + append-only `events`, replay-on-restart) + worklog threads + `correlation_id` chains | owned by the driver (DD-P2); workers see only their brief |
| **Semantic** — durable domain truth | issues, PRs, code, design docs, blueprint.yaml dependency graph, CONTEXT.md | **GitHub + git** (the data plane — already the rule) | workers pull by reference; humans read it natively |
| **Procedural** — how we work | SOPs, process definitions, review lenses, retro learnings, recall observations, miner traces | compass SOPs → **pulse process definitions** (executable) + recall + `retros/` | enters context only via reviewable artifacts (DD-P4); miner closes the loop (§3.8) |

Nothing new is invented here — the design *assigns* existing substrates to tiers and forbids cross-tier leakage (e.g. worker transcripts do not enter the driver; plan state does not ride the bus).

### 3.3 The pipeline as an installable process

The procedural tier's executable form is a **pulse process definition** — pulse#15 (merged) provides exactly the needed vocabulary, mapping the SOP stages onto D/A/H steps:

```yaml
# dev-loop.process.yaml (sketch — per-slice segment)
- agent:   { capability: dev.implement }        # A: worktree + CC + gates + PR
- agent:   { capability: code-review.typescript } # A: claimed by Echo/Holly/…
- action:  A_DISPOSITION                          # D: classify findings fix-small/defer-big
- agent:   { capability: dev.implement }          # A: fix cycle (cap: 5, then waiting_human)
- action:  A_MERGE_PRECHECK                       # D: CI green, MERGEABLE, staleness
- agent:   { capability: merge.approve }          # A: approver-bot five-check + squash
- gate:    release-decision                       # H: principal
- agent:   { capability: release.cut }            # A: version/release/deploy/announce
```

Pulse's `MyelinAgentProvider` already publishes these `agent:` steps as task envelopes on `local.{principal}.{stack}.tasks.{capability}` and resolves on `dispatch.task.completed|failed` by `correlation_id` — the precise contract cortex's dispatch listener and lifecycle publisher speak. Spawn's DD-63 26-node pipeline (19 autonomous, 7 human gates) is the fuller enumeration the v1 definition grows toward.

Pilot **hosts** the process run per errand and keeps the run's state in its errand store; pulse contributes the process *engine and vocabulary*, not a second state owner.

### 3.4 One slice, end to end (event walk)

1. Pilot `tick`: errand tree has slice C-NNN.X unblocked (`blueprint ready`) → announce + veto window → publish **Offer** `local.andreas.work.tasks.dev.implement` (brief: issue ref, design §, branch name, gate list — ~1–2k tokens of intent + refs).
2. A dev agent claims (queue-group) → emits `dispatch.task.started` → worktree from `origin/main` → CC session via `ExecutionBackend` → gates → push → `gh pr create` → emits `dispatch.task.completed {pr: N}`. Worklog envelopes stream to the slice's thread throughout.
3. Pilot's reactor advances the errand (`implementing → pr-open`) and publishes `tasks.code-review.typescript {pr: N}` (cycle 1).
4. Echo claims, reviews, posts findings to GitHub (data plane), emits `review.verdict.changes-requested` with the verdict block.
5. Reactor: cycle < cap → dispatch fix (`dev.implement` with the findings refs) → re-review … `review.verdict.approved`.
6. Reactor publishes `tasks.merge.approve`; Ivy runs the five checks → squash-merge → `dispatch.task.completed`. GH tap's `github.*` envelopes confirm merge independently.
7. Errand → `merged`; next unblocked slice dispatches (back to 1). Iteration exhausted → **H-gate** `release-decision` surfaces to the principal via the gateway; on approval, `release.cut` runs the versioning/deployment SOPs and announces per the control-plane rule.

No blocking waits anywhere: every arrow is an envelope; every actor is restart-safe from its own store (`ReplayPending`); the principal can watch any of it on the dashboard or the Discord threads, or ignore it until a gate pings them.

### 3.5 Human gates — the autonomy dial

Gates are **data, not code** — per-repo/per-risk configuration in the process definition:

| Gate | Default | Source |
|---|---|---|
| claim veto (60s) | on | spec 0002 |
| design approval | always-human | design-process SOP |
| merge | two-of-two: principal-silence **and** approver-bot pass | spec 0001/0002 |
| pre-merge veto (30s) | on | spec 0002 |
| release/deploy | always-human (prod); auto-allowed for dev-env | deployment SOP |
| retro→SOP change | always-human (it edits the procedural tier) | DD-P4 |
| review-cycle cap | 5 per PR → `waiting_human` | spec 0002 |
| **fleet concurrency cap** | max N concurrent `dev.implement` claims fleet-wide (v1 default: 3) — a **cost** cap, not a serialization rule: parallel claims in one repo are fine (worktree isolation), and overlap is managed at merge time by the staleness/rebase gate *(resolved 2026-06-10)* | new |
| **cost budget** | per-errand + per-run token/cost budget; hard stop → `waiting_human` | new |
| **dead-man's switch** | N consecutive failed/aborted slices (default 2) → pause the whole run + escalate | new |

The last three rows are the **runaway protection** an unattended self-feeding loop must carry: §3.4's "next unblocked slice dispatches" never proceeds past a tripped cap, and a tripped cap is an escalation, not a retry. Escalations (`cant_do`, cycle-cap, budget-stop, `waiting_human`, gate timeout) surface through the gateway to Discord with deep links; `pilot resume`/`release` remain the principal's unblock levers.

### 3.5b Authority model for `dev.implement`

The dev agent writes code and pushes branches — its authority must be explicit, not ambient:

- **Its own forge identity.** Pushes and PRs use a dedicated scoped credential (machine-user PAT or GitHub App installation token, repo-scoped, no admin), never the principal's PAT — mirroring how Pilot's manifest already separates `PILOT_GITHUB_LOGIN` and denies `gh pr merge` in its bashAllowlist. Merge authority stays with the approver-bot + branch protection: even a compromised dev agent can only open PRs that the two-of-two gate still guards.
- **Guardrails from the agent manifest.** `allowedDirs` (its worktrees), `disallowedTools`, and a bash allowlist enforced by the existing bash-guard hook; secrets reach the CC session via environment injection, never via the brief.
- **The honest F-2 caveat:** until F-5b sandboxing lands, `dev.implement` executes on a local machine, so OS-level ambient authority is bounded only by the guardrails above plus the caps in §3.5. That residual risk is accepted for v1 on the principal's own stacks (it is identical to today's in-session posture) and is precisely what F-5b's sandbox backends retire — credentials injected per-execution into an isolated runtime and revoked on reclaim (Spawn's `globalOutbound` pattern).

### 3.6 Execution substrate — the brain/hands seam (sandbox-ready)

`src/runner/execution-backend.ts` already defines `ExecutionBackend` + `LocalBackend` + `BackendRegistry`, and `ExecutionConfigSchema` exists in cortex.yaml — but `CCSession` hardcodes `Bun.spawn` and the registry is unwired. The design requires only that the seam become real:

- **Now (F-5a):** route all CC spawning through the registry; backend selected per task class (Spawn's insight: D-nodes → cheap/fast backends; A-nodes → full CC provisioning).
- **Later (F-5b, explicitly deferred):** `CloudflareBackend` / `E2BBackend` implementing the same `spawn(opts) → {write, on(stdout|stderr), kill}` contract — the Anthropic + Cloudflare sandbox pattern, with `globalOutbound`-style credential injection (secrets enter the sandbox's environment, never the agent's prompt; scoped per-execution, revoked on reclaim).

This is what makes "stop running the fleet on my personal machine" and "scale dev agents horizontally" config changes instead of projects.

### 3.6b Session continuity — warm sessions per errand

Cortex's dispatch path today is **single-shot**: every dispatch spawns a fresh CC session, so each fix cycle re-reads the world — the flaw behind the old loop's 270s cache-window fragility. The dev-loop makes session continuity first-class: the dev agent keeps a **warm session per errand** — a fix cycle *resumes* the session that implemented the slice (the session-manager `--resume` pattern chat threads already use, applied to dispatch), and **agent-state durably maps errand → session id** so a restarted agent resumes rather than restarts. Cache economics become a session-reuse policy (prefer resume inside the TTL; rehydrate from the errand's worklog when cold) instead of a sleep-cadence constraint. This fixes a general cortex gap, not just a loop concern: dispatch consumers should be able to declare **session affinity per correlation chain** — an F-2 deliverable with its own cortex slice. *(Resolved 2026-06-10.)*

### 3.7 Federation — the IoAW payoff

Because every stage is a capability, cross-principal participation is the **same mechanism**, not a feature: a federated Offer (`federated.…tasks.code-review.typescript`) lets JC's Holly claim a review of an Andreas-stack PR — already proven end-to-end by the ADR-0002 cross-principal review loop (cortex#686 + pilot#149). The same generalizes to `dev.implement` later, gated by the PolicyEngine + per-network capability announcement (Phase E.2). The wire grammar never changes.

### 3.8 Observability + process mining — the compounding loop

- Every actor emits lifecycle + worklog envelopes → signal + MC dashboard + Discord threads (deterministic rendering; no LLM tokens on lifecycle paths).
- Each errand closes with an agent-state **retro**; pulse emits execution traces (P-302) for **miner**; recall captures cross-session observations.
- Mining output lands as **PRs**: SOP amendments, process-definition tweaks, new carve-outs, new skills (the retrospective SOP's 5-level decomposition decides where each learning belongs). That reviewed-artifact loop *is* the proprietary experience cache — versioned, auditable, and installable by every stack that installs the blueprint.

**Agent memory: agent-state first; recall as consultation, not fabric.** Each agent carries its own state and memory — the Kniberg model agent-state was built on: work items, append-only events, replayable history, per-instance retros. recall is deliberately **not** wired in as an automatic memory layer for agents — that would reintroduce silent context injection (DD-P4) and recall's retrieval side is by design principal-curated. Instead, F-7 exposes recall to agents as a **pull tool at two defined moments**: triage ("have we seen this failure/finding pattern before?") and retro ("what did prior retros conclude?"). If those consultations prove their value, promoting recall to a shared fleet experience-cache is a v2 decision taken deliberately — not a default. *(Resolved 2026-06-10.)*

## 4. What exists vs. what's new

| Piece | Status | Where |
|---|---|---|
| Capability dispatch, Offer/claim, lifecycle envelopes, typed failures | ✅ live | cortex (review-consumer is the reference) |
| Review loop on the bus (incl. cross-principal verdict-back) | ✅ live (8/9 PRs; e2e rig pending) | cortex#237, #686 · pilot#149 |
| Errand store + agent-state lifecycle + replay + caps + two-of-two merge design | ✅ built / 📝 spec'd | pilot specs 0001–0002 |
| Event-driven reactor (`pilot watch`) | 📝 designed only | `design-event-driven-review-loop.md` (P1: verdict-block emission; P2: reactor) |
| Process engine with `agent:` bus steps (D/A/H) | ✅ merged | pulse#15 (P-600/601) |
| CC execution substrate (harness, worklogs, bash-guard, prompt-builder) | ✅ live | cortex runner |
| `dev.implement` capability consumer | ❌ **the biggest new piece** | composes pilot `implement`/`llm-loop` + ClaudeCodeHarness + worktree SOP |
| Approver-bot (`merge.approve`) | 📝 spec'd (5 checks) | spec 0001/0002; not implemented |
| `release.cut` consumer | ❌ new | encodes versioning/deployment/release-checklist SOPs |
| ExecutionBackend seam wired | 🟡 dormant interface | `execution-backend.ts` exists; CCSession hardcodes Bun.spawn |
| Agent packaging (manifest/persona/guardrails) + state bundle | ✅ contract live / 🟡 per-agent hook wiring pending (host-runs-hooks landed; Luna/Echo not yet wired to AgentState) | agents + agent-state |
| Blueprint **process/graph** manifest types | ❌ named, no schema | meta-factory DD-47/48/49 |
| arc multi-package compose (config merge, identity provisioning, startup order) | ❌ gaps enumerated in §6; tracker to be filed (arc / meta-factory) | arc |

## 5. Build phases (each independently valuable; slice-first throughout)

- **F-1 — Close the review loop on the bus.** Verdict-block emission by the reviewer (P1) + the `pilot watch` durable reactor (P2). Retires Discord polling, phantom stalls, and baseline-counter skew. *Mostly pilot + a small Echo persona change; design already written.*
- **F-2 — `dev.implement` capability.** A consumer that claims an implement Offer, runs worktree → ClaudeCodeHarness → gates → PR, emits lifecycle + worklog. Brief schema = intent + refs (DD-P3). First on the driver's own stack; horizontal later via F-5.
- **F-3 — The loop as a process.** Express the per-slice pipeline as the pulse process definition (§3.3); pilot hosts the run per errand; approver-bot (`merge.approve`, the five checks) lands here. The in-session loop keeps working throughout — it becomes one *participant* (kick off, observe, intervene) rather than the engine. **Coexistence rule:** exactly one driver per errand — `pilot watch` only advances errands it owns (the agent-state UNIQUE active-claim pattern), and an in-session orchestrator only drives errands pilot is not tracking; a session that wants to intervene on a pilot-owned errand goes through `@Pilot pause` rather than reacting to the same `review.verdict.*` events in parallel.
- **F-4 — `release.cut` + announce.** Encode versioning/deployment/release-checklist SOPs as a gated consumer; announcements via the gateway per control-plane rules.
- **F-5 — Execution backends.** (a) Wire `BackendRegistry` through CCSession/dispatch — the seam becomes real, local-only. (b) *Deferred:* first remote sandbox backend (Cloudflare/E2B) behind the same contract.
- **F-6 — The blueprint.** Package the whole thing: process definition + pilot/dev/approver/release agent packages + agent-state bundles + gate config, as a meta-factory **graph** blueprint installable by arc. Drives the DD-47/48/49 schema work + the arc compose gaps (§6) with a real consumer.
- **F-7 — Mining loop.** pulse traces (P-302) → miner; errand retros → SOP/process PRs; recall observations surfaced into retro context (pull, not push — DD-P4).

Ordering note: F-1→F-3 produce a working bus-native loop on the current single-machine deployment; F-5/F-6 make it scalable and installable. Dogfood from F-1 onward — the loop builds itself.

## 6. Packaging — the `dev-loop` blueprint (F-6 contract)

*(Name resolved 2026-06-10: the marketplace artifact is **`dev-loop`**.)*

### 6.1 The bundle

v1 ships `dev-loop` as an arc **library** (DD-59/60 — the one multi-artifact transport that exists today), each artifact carrying its own `arc-manifest.yaml`:

```
the-metafactory/dev-loop/
├── arc-manifest.yaml            # type: library, artifacts[] below
├── process/                     # the pipeline definition (pulse flow YAML + gate
│   └── …                        #   config). Interim type: component; flips to
│                                #   type: process when the DD-47 schema lands (F-6d)
├── agents/
│   ├── pilot/                   # type: agent — loop-driver (manifest + persona +
│   │                            #   guardrails + state: {blueprint: AgentState})
│   ├── dev/                     # type: agent — dev.implement consumer
│   ├── approver/                # type: agent — merge.approve (five-check gate)
│   └── release/                 # type: agent — release.cut (gated)
├── skill/                       # operator surface: kick off / status / pause / resume
└── docs/                        # the SOP set the process encodes
# depends_on: agent-state (state bundle), pulse (engine), cortex (IoAW substrate ≥ vX)
```

v2 wraps the same contents as a single `type: graph` artifact (DD-49) once that schema exists — the library is the transport until then.

### 6.2 Install lifecycle (`arc install dev-loop` on a stack)

1. **Fetch + verify** — R2 content-addressed tarball, SHA-256 verified (the arc#51 model); artifacts installed in `depends_on` order *(gap: library installs lack ordering + atomic rollback — F-6c)*.
2. **Per agent: identity + state** — provision NKey seed + DID, scaffold instance state via `AgentState/ScaffoldFolders` → `~/.config/cortex/agents/<name>/{state.sqlite,dashboard.md,retros/}`, copy persona *(gap: identity provisioning is manual today — F-6b; precedent: `cortex stack create`'s born-aligned provisioning)*.
3. **Config composition** — merge each agent's capability declarations + policy entries into the stack's config-split layers (`stacks/*.yaml` capabilities catalog, policy roles) *(gap: no composer API — needs a `cortex config merge` verb or an arc→cortex install hook; F-6a files the tracker)*.
4. **Service provisioning** — render + bootstrap the launchd/systemd unit for the loop-driver (tick cron + reactor), reusing the cortex plist template pattern; daemon restart/hot-reload registers the new capabilities on the bus.
5. **Secrets** — prompt for + inject the scoped forge credentials (dev agent's machine-user token, approver token) into per-agent env, never into briefs *(gap: arc secret provisioning — F-6e)*.
6. **Verify** — `dev-loop status` smoke: capabilities registered, agents announced, a no-op errand round-trips.

### 6.3 Publish + distribution through meta-factory

`arc publish` from the dev-loop repo → manifest validation → tarball (bundle.exclude) → **R2, content-addressed by SHA-256, versions immutable** → meta-factory intake (README-first, steward-published per HL-3/HL-5) → listed on the marketplace as a blueprint. The release-checklist trust gates apply directly: Gate 1 (package verified — SHA pinning) and Gate 2 (publisher known) are mechanical; **Gate 4 ("Dogfood Pipeline") is satisfied by this very blueprint** — the dev-loop is both the product and the pipeline that ships it.

### 6.4 Gap-closure slices

| Slice | Gap | Repo |
|---|---|---|
| F-6a | config composition: package-declared capabilities/policy merged into config-split layers (file the tracker; design the `cortex config merge` verb or install hook) | cortex + arc |
| F-6b | agent identity provisioning at install (NKey/DID + state scaffold) | arc + cortex |
| F-6c | library install ordering + atomic multi-artifact rollback | arc |
| F-6d | `type: process` manifest schema (DD-47) — promote the interim component | meta-factory + arc |
| F-6e | secret provisioning at install | arc |

## 7. Decisions — LOCKED (principal, 2026-06-10)

1. **Loop-driver identity** — ✅ evolve **Pilot** (specs 0001–0003) into the loop-driver.
2. **Pulse as the process engine** — ✅ pulse process definitions are the executable form of the pipeline.
3. **Doc home + epic** — ✅ cortex (IoAW home); build tracked as a new epic under #110, cross-repo slices in their repos.
4. **F-1 first** — ✅ start with the review-loop closure; dogfood immediately.
5. **Autonomy defaults** — ✅ gate table (§3.5) confirmed: merge stays two-of-two, release stays always-human; runaway caps as specified.
6. **Dev-agent concurrency** — ✅ parallel claims allowed (worktree isolation); overlap managed at merge time (staleness/rebase gate). The fleet cap is cost-motivated only.
7. **Warm sessions** — ✅ session continuity per errand is an F-2 deliverable; agent-state owns the errand→session map. Fixes cortex's single-shot dispatch flaw generally.
8. **Agent memory** — ✅ agent-state (the Kniberg carry-your-own-state model) is the agents' memory for v1; recall is a pull-based consultation tool at triage/retro (F-7), never auto-injected. Fleet-level recall = deliberate v2 decision.
9. **Name** — ✅ the marketplace artifact is **`dev-loop`**.

## 8. Open questions

1. Does the approver-bot run as Ivy (JC-owned persona) or as a principal-local `merge.approve` consumer with the Ivy persona as one deployment of it?
2. Mention-dispatch (`@Pilot pause/pick/abort`, spec 0003) — wire in F-1 or F-3?
