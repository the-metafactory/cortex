# Iteration — Layer-7 Collaboration Surface (G-1100..G-1110)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-collaboration-surface.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Status:** complete · 2026-05-08 (G-1100 ladder done; G-1101 + G-1102 next)
**Driver:** Andreas
**Design:** [`docs/design-collaboration-surface.md`](design-collaboration-surface.md) (PR #58)
**Umbrella issue:** [#59](https://github.com/the-metafactory/grove-v2/issues/59)
**Process:** one PR per sub-feature, pilot loop with Holly primary / Echo fallback, blueprint sequenced

---

## G-1100 — Myelin subscriber in grove-bot

Goal: add `src/bot/lib/myelin-subscriber.ts` that subscribes to NATS subjects under `local.{org}.>`, validates inbound envelopes against the myelin envelope schema, and fans typed envelopes into a callback. Opt-in (gracefully no-op if no NATS configured). Per design doc §8 + §9 coupling rules.

**Sub-features (sequenced via `blueprint.yaml`):**

- [x] **G-1100.A** — NATS client dep + connection primitive · issue #61 · PR #67 (merged 2026-05-08) · branch `feat/g-1100a-nats-client`
  - `nats@2.x` added to `package.json`
  - `src/bot/lib/nats-connection.ts` (`NatsLink` class with connect/close/tagged console logging)
  - `src/bot/lib/__tests__/nats-connection.test.ts` (9/9 green)
  - Echo round-2 verdict: 0 blockers, 0 majors, 0 nits. Round-1 deferrals tracked in #69 (pre-existing dashboard-api WS flake) and #70 (subject allowlist before envelope publishing in G-1100.D).
- [x] **G-1100.B** — Vendor myelin schema + envelope validator · issue #62 · PR #71 (merged 2026-05-08) · _parallelizable with G-1100.A_
  - Vendored `myelin/schemas/envelope.schema.json` into `src/bot/lib/myelin/`, pinned at upstream commit `96b14ea`.
  - Ajv2020-backed `validateEnvelope()` + `tryParseEnvelope()` + typed `Envelope` interface.
  - 15 tests using the real upstream fixtures + signed_by failure-mode coverage.
  - Echo round-2 verdict: 0 blockers, 0 majors, 0 nits. Round-1 caught schema/type drift on `signed_by` — fixed by adding `SignedByEd25519` and `SignedByHubStamp` interfaces.
- [x] **G-1100.C** — Subject-pattern subscription primitive · issue #63 · PR #72 (merged 2026-05-08) · depends G-1100.A
  - `src/bot/lib/nats-subscription.ts` — pattern subscribe, raw bytes, reconnect-aware (drains old sub before opening new one).
  - 11/11 tests including orphan/new-sub delivery and subscribe-throws-on-reconnect.
  - Echo round-5 verdict: 0 blockers, 0 majors, 0 nits. Five rounds caught: misleading "re-subscribed" log on subscribe failure, unbounded `consumeLoops` growth, redundant TOCTOU guard in single-threaded JS, dead `statusLoop` field. All fixed.
  - Deferred follow-ups: #73 (N+1 status iterators on single NatsLink), #74 (wrap nats.js `SubscriptionOptions` in a Grove-owned type).
- [x] **G-1100.D** — Myelin subscriber compose · issue #64 · PR #75 (merged 2026-05-08) · depends G-1100.B + G-1100.C
  - `src/bot/lib/myelin-subscriber.ts` — composes validator + subscription primitive.
  - Discriminated `InvalidEnvelopeReason` union (`json-parse` vs `schema`); full Ajv error array forwarded; default sink redacts payload behind `logRawSnippet` opt-in; subject + reason string sanitised against log injection (CR/LF strip).
  - 11 tests covering happy path, schema failures (multi-error), JSON parse failures, default-sink-no-leak, opt-in snippet path, CRLF-in-subject, CRLF-via-Ajv-instancePath, and full-errors-forwarding.
  - Three review rounds. Round-1 (deployed Echo): 4 majors + 5 nits. Round-2 (JC drove a parallel fix via clawbox): mostly clean, but in-session sub-agent (Engineer subagent_type, replacing the unreliable Echo bot for cycle 3) caught a residual log-injection vector via Ajv's `instancePath` echoing attacker-controlled JSON keys — fixed before merge.
- [x] **G-1100.E** — Wire into grove-bot + structured logging · issue #65 · PR #76 (merged 2026-05-08) · depends G-1100.D
  - Opt-in startup hook in `src/bot/grove-bot.ts` via `startMyelinRuntime()`. Wired into the canonical `shutdown()` with a `shuttingDown` guard against double-signal races.
  - Logs received envelopes (subject + envelope.id + type + correlation_id when present); `nats.url` user-info redacted before logging.
  - No fan-out to existing handlers in this PR — that's G-1101+.
  - Three review rounds. Round-1 (deployed Echo): 1 critical (duplicate SIGTERM handlers racing `process.exit(0)`) + 3 warnings. Round-2 (JC + clawbox): all round-1 closed; in-session sub-agent caught loose `connectImpl: (opts: unknown) => …` type + non-idempotent `shutdown()` — fixed before merge.
- [x] **G-1100.F** — Iteration plan + retro · issue #66 · this commit
  - Plan file shipped in PR #68; retro section is below.

## Retro

**Cycle time** — first commit (G-1100.A initial) to G-1100 parent done: ~10h on 2026-05-08, single operator session driving five sub-features through 1-5 review rounds each.

**Throughput** — 5 sub-features merged + 1 design doc + 1 stocktake + 1 blueprint setup. Eight PRs from this iteration on `main`; ten review rounds across them.

**What worked**
- **Sub-features sized for one PR each.** Every sub-feature was ~150-450 LOC including tests. Reviewers stayed sharp; nothing got rubber-stamped.
- **Worktree-per-feature.** No branch-switching mid-flight. When G-1100.D needed a rebase after G-1100.A merged, the other worktrees were unaffected.
- **Echo's `allErrors: true` + discriminated unions.** Round-1 of G-1100.D forced an API redesign that turned out to be the right shape. Pilot loop earned its keep there.
- **Closing the cross-repo blueprint G-NNN naming clash early.** Shifting from G-500.x to G-1100.x in PR #58 cost one rename; not catching it would have collided with the deployed `grove` repo's myelin-migration G-1100.

**What didn't**
- **Echo dispatch reliability degraded mid-iteration.** Two rounds aborted silently because Echo's persona used `Task` (subagent dispatch) for `/review-pr` and the `agent-restricted` role had `Task` blocked. Diagnosed via session-event tracing; resolved by removing `Task` from `agent-restricted.disallowedTools` (after considering tightening the persona instead).
- **Repo short-name collision.** First Echo ping resolved `grove` → `the-metafactory/grove` instead of `grove-v2#67`. Echo dutifully reviewed the wrong PR. Lost ~30 min until the actual repo trace surfaced. Memory entry filed (`reviewer-discord-ids.md`) so it doesn't recur.
- **Branch base accidents.** PR #68 was cut from G-1100.A's branch instead of `main`; PR #76 needed a rebase past two intermediate squashes. Both resolved cleanly via `git rebase --skip` + force-push, but worth flagging as a worktree discipline improvement: always `git worktree add … origin/main` explicitly when starting a fresh sub-feature.
- **Force-push hook block.** Each rebase needed an out-of-loop hand-off because PAI's SecurityValidator hook blocks `git push --force[-with-lease]`. Two cycles, two hand-offs. Acceptable for solo-driver loops; would need automation if running headless.

**Pivot to in-session sub-agent reviews (cycle 3 onward)**
- Echo ack'd review pings via Discord but produced 16-22s sessions with zero tool calls — sub-agent dispatch failure under the new role, but undiagnosed at the time.
- Switched to `Agent(subagent_type: Engineer, …)` with Echo's persona-equivalent prompt. Two cycles ran this way (#75 round-3, #76 round-3); both caught real issues that round-1 Echo missed.
- Tradeoff: in-session reviews are faster and don't depend on a deployed bot, but the review transcripts live only in the PR thread + this session, not in the `mf.local.review.>` NATS stream.

**Numbers (rough)**
- 5 sub-feature PRs + 3 admin PRs (design, blueprint setup, stocktake) = 8 PRs.
- 10 review rounds total (1 round on .A, .B, .E; 5 rounds on .C; 3 rounds on .D, .E).
- 53 unit tests on `main` for the G-1100 ladder (envelope-validator: 15 · nats-connection: 9 · nats-subscription: 11 · myelin-subscriber: 11 · myelin-runtime: 7).
- 0 production smoke yet — `grove install signal`-style integration with a real `nats-server` is the first ticked item for G-1101.

**Follow-up issues filed during the iteration**
- #69 — pre-existing dashboard-api WebSocket test flake on `origin/main` (unrelated; tracked).
- #70 — subject allowlist before any envelope publishing path lands (precondition for G-1101+).
- #73 — N+1 status iterators per `NatsLink` (architecture, refactor when N>2 subscribers in flight).
- #74 — wrap nats.js `SubscriptionOptions` in a Grove-owned type before G-1100.D's option surface gets used.

**Next** — first follow-on iteration is G-1101 + G-1102 (parallelizable, both depend only on G-1100). G-1101 is the first concrete card source on the surface (pilot errand projection); G-1102 is signal alert ingestion. After both: G-1103 generalised inbox.

## Future iterations (sketched, not yet sequenced)

- **G-1101** Pilot errand projection
- **G-1102** Signal alert ingestion
- **G-1103** Generalised inbox (replaces F-7 attention view's single-source data path)
- **G-1104** Blueprint state-change ingestion
- **G-1105** Artifact-aware drill-down
- **G-1106** OTLP+CloudEvent timeline join
- **G-1107** Universal operator-input return path
- **G-1108** Cross-repo blueprint badge
- **G-1109** Triggered-by-schedule cards
- **G-1110** Sovereignty render

**First follow-on iteration:** **G-1101 + G-1102** (both depend only on G-1100). G-1103 (generalised inbox) depends on G-1101 + G-1102 per the dependency graph and lands in the *second* follow-on iteration. Design §8's narrative bundle of "G-1101 + G-1103" was a sketch from before the dep graph was sequenced; the graph in `blueprint.yaml` is the source of truth.

