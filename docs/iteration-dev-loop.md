# Iteration plan — dev-loop (the agentic dev pipeline on the IoAW bus)

**Epic:** [cortex#835](https://github.com/the-metafactory/cortex/issues/835)
**Design:** [`docs/design-agentic-dev-pipeline.md`](design-agentic-dev-pipeline.md) (9 decisions locked) · framing contract [`docs/design-event-driven-review-loop.md`](design-event-driven-review-loop.md)
**Started:** 2026-06-10 · **Components released:** v5.6.0 (2026-06-10)

The repo-side iteration artifact for the dev-loop epic. The GitHub epic (#835) +
its phase sub-issues (#865–#870, wave-5 #887/#924–#929) are the trackable mirror;
this file is the agent-readable plan. **Sync rule:** a checkbox completed here is
also ticked on its GitHub issue, and vice-versa (per CLAUDE.md §Implementation Workflow).

Built **dogfood-by-construction**: each component is driven in its home repo as a
separately-framed workstream, coordinated only through the shared fabric — the
way we build the dev-loop is the dev-loop.

## Phase status — components SHIPPED + RELEASED (v5.6.0)

Every component is built, adversarially reviewed, merged, and released in
cortex **v5.6.0** — live but **dormant-by-default** (activates when a stack
declares the capabilities; see Wave 5 / #925).

| Phase | What | Home | Issue | State |
|---|---|---|---|---|
| **F-1** | event-driven review loop (verdict block · `pilot watch` reactor · merge→next-pick · stack-scope/federation) | pilot, arc-skill-code-review, agents | umbrella [pilot#153](https://github.com/the-metafactory/pilot/issues/153) | ✅ complete (4/4), merged |
| **F-2** | dev agent — `dev.implement` consumer (dormant; warm sessions) + DEV_IMPLEMENT stream | cortex | [#865](https://github.com/the-metafactory/cortex/issues/865) | ✅ merged (cortex#853, #875) |
| **F-3** | loop-as-pulse-process + approver-bot | pulse, pilot | [#866](https://github.com/the-metafactory/cortex/issues/866) | ✅ F-3.0/.1/.2 merged (pilot#159, pulse#20, pilot#161); F-3.3 → W5.0 |
| **F-4** | release agent — `release.cut` consumer (principal-gated) | cortex, compass | [#867](https://github.com/the-metafactory/cortex/issues/867) | ✅ F-4.1 merged (cortex#874); F-4.2 executor → W5.2 |
| **F-5** | brain/hands seam — ExecutionBackend wiring | cortex | [#868](https://github.com/the-metafactory/cortex/issues/868) | ⏸ F-5a → W5.3; F-5b (remote sandbox) deferred |
| **F-6** | packaging — ship as a meta-factory blueprint | arc, meta-factory, cortex | [#869](https://github.com/the-metafactory/cortex/issues/869) | ✅ a–e merged (cortex#876→main parallel, arc#230/231/233/234, mf#551); blueprint assembly → W5.4 |
| **F-7** | mining loop — process self-improvement | pulse | [#870](https://github.com/the-metafactory/cortex/issues/870) | ⬜ queued (post-wave-5) |

## Wave 5 — turn the shipped components into a running, self-driving loop

Umbrella [#887](https://github.com/the-metafactory/cortex/issues/887). The
"fully delivered" line: the components are released but inert until a stack opts
in and the loop runs end-to-end with no human conductor.

| Slice | What | Issue | State |
|---|---|---|---|
| **W5.0** | merge policy ('review-loop-passed + CI-green → auto-approve & merge') + approver identity + signed commits | [#924](https://github.com/the-metafactory/cortex/issues/924) | ✅ pilot#164 (gate + trust model) + cortex#994 (signing); #924 closed. Approver fail-closes until `APPROVER_GH_TOKEN` is set → [#995](https://github.com/the-metafactory/cortex/issues/995). |
| **W5.1** | stack enablement — opt a stack into the dev-loop. **Re-pointed onto the capability-offering model (CO-6, [#945](https://github.com/the-metafactory/cortex/issues/945)):** enabling = declaring the dev-loop capabilities as `local` offerings (`cortex offer dev.implement/release.cut/code-review.* --scope local`), not a bespoke capabilities+streams+approver recipe. The offering mechanism (CO-1/2/3) already ships; W5.1 is now the documented SOP ([`docs/sop-enable-dev-loop.md`](sop-enable-dev-loop.md)). **BLOCKED on [#1009](https://github.com/the-metafactory/cortex/issues/1009):** a stack can't declare the dev-loop capabilities until the bundle's `dev`/`release`/`approver` agents are real `agents[]` entries (verified — the config-merge dry-run on meta-factory fails `CortexConfigSchema` on unresolved `provided_by`). Two-step: (1) merge capabilities + role; (2) `cortex offer set --scope local` (offerings are post-merge per DD-CO-7, NOT in the fragment). | [#925](https://github.com/the-metafactory/cortex/issues/925) → [#945](https://github.com/the-metafactory/cortex/issues/945) | ⬜ blocked on #1009 |
| **W5.2** | F-4.2 production ReleaseExecutor (real git/gh seam behind release.cut) | [#926](https://github.com/the-metafactory/cortex/issues/926) | ⬜ |
| **W5.3** | F-5a ExecutionBackend wiring (local; sandbox-ready seam) | [#927](https://github.com/the-metafactory/cortex/issues/927) | ⬜ |
| **W5.4** | assemble the installable `dev-loop` blueprint (`arc install dev-loop`) | [#928](https://github.com/the-metafactory/cortex/issues/928) | ✅ bundle assembled per §6.1 + `the-metafactory/dev-loop` repo created (private; flip public for the marketplace once hardened). Agents ship **scaffolded** → deployable-hardening tracked [#1009](https://github.com/the-metafactory/cortex/issues/1009). |
| **W5.5** | first live dogfood run — the loop drives a real PR with no human conductor | [#929](https://github.com/the-metafactory/cortex/issues/929) | ⬜ blocked on #1009 (deployable agents) + W5.1 (enable). First run **holds at merge** until #995 (approver credential); a human casts the final merge. |
| **W5.1a** | **harden the scaffolded dev/release agent packages into deployable agents** (the verified W5.1/W5.5 prerequisite) | [#1009](https://github.com/the-metafactory/cortex/issues/1009) | ⬜ **next** |

**Two learnings from the v5.6.0 drive that shaped wave-5:**
1. *Dormant-by-default is safe but inert* → W5.1 makes enabling a stack first-class. **Re-pointed (CO-6):** dormant-by-default is the *correct* default of the capability-offering model (default-deny → `local`); enabling = `cortex offer … --scope local` (`docs/sop-enable-dev-loop.md`), a clean instance of the general model rather than a bespoke dev-loop path.
2. *"Review-loop-passed is sufficient to merge"* (principal's call landing v5.6.0) → W5.0 encodes that as the autonomous merge gate, with signed commits + a resolved approver-identity trust model. The admin-bypass used to land v5.6.0 was principal-authorized + one-off; the autonomous loop must never self-approve as author.

## Cross-cutting

- **Marketplace building-block gaps** (flag-don't-work-around, principal directive): skill-drift detection · agent-manifest persistent-subscription trigger type · `agents` repo missing from `compass/ecosystem/repos.yaml` · token/cost-accounting (BudgetCheck seam stubbed) · pulse engine gaps G1–G4 (pulse#21–24) · pulse CI (pulse#25).
- **Deploy tooling:** `arc upgrade --check` stale-read ([arc#236](https://github.com/the-metafactory/arc/issues/236)) — fix before W5.2's release automation relies on a trustworthy upgrade check.

## Build order (dependency-sequenced)

**Done:** F-1 → F-2/F-3/F-4.1/F-6{a–e} (built, reviewed, merged) → released v5.6.0 + deployed. **W5.0** (merge gate + signing) ✅ + **W5.4** (bundle + `the-metafactory/dev-loop` repo) ✅ — both landed; the Capability Offering epic (#939, the offer/enablement mechanism) shipped in v5.9.0.

**Remaining (verified sequence, 2026-06-16):** the loop is built + released but **not enabled on any stack** (meta-factory/work have 0 dev-loop capabilities) and **not running**. The make-it-live path:
1. **W5.1a / #1009 — harden `dev`+`release` agents into deployable packages** (the consumer runtime exists; package = persona + manifest + AgentState + nkey identity). **The current critical path.** `approver` stays dormant until #995.
2. **W5.1 / #925 — enable on an isolated `cortex stack create dev-loop`** (contained blast radius — recommended over live Luna for a first autonomous run): config-merge capabilities+role → `cortex offer set --scope local` → restart → verify on the bus.
3. **W5.5 / #929 — first live dogfood**: dispatch a real task → implement → review → fix → **HOLD at merge** (human casts it, approver dormant). Expect to surface wiring gaps.
4. **#995 — provision the approver credential** (principal action) → the loop closes the merge itself; W5.5 becomes truly no-conductor.

W5.2/W5.3 (production ReleaseExecutor / sandbox backend) + F-7 (mining) follow. **A redeploy** also closes the current daemon drift (deployed v5.12.0 vs main v5.16.0 — unrelated observability work, not the loop).
