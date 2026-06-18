# Design: Slice Activity Convergence — one slice, one thread, one card

Status: **Draft** (2026-06-19, slice-activity-thread grilling Q1–Q5)
Decision record: [`docs/adr/0016-slice-grouping-key-is-the-issue.md`](adr/0016-slice-grouping-key-is-the-issue.md)
Glossary: `CONTEXT.md` → **Slice**, **Orchestrator**, **Dispatch**, **Dispatch sink**, **Session interior**

## Problem

A **slice** (one issue's worth of dev-loop work) is driven by several mutually-anonymous
capability-workers — the implementing worker (`dev.implement`), the reviewer (`code-review`),
the merge worker (`merge.approve`) — coordinated by the **orchestrator** (loop-driver role,
instance-named per stack; `vega` here). A principal watching that work today sees it **scattered
across up to four places**, with no surface gathering "the whole story":

| Producer | Lands today | Evidence |
|---|---|---|
| Worker interior worklog | `#worklog` channel, one thread **per session** | `src/runner/worklog-manager.ts:3,33` (keyed by `session_id`; owns a direct `discord.js` client) |
| Review one-liner | `{repo}/pr/N` thread via logical routing | `src/adapters/review-sink.ts`; `src/adapters/response-routing-delivery.ts:21` |
| Orchestrator lifecycle (slice/review/merge) | **nowhere on Discord** | no loop-driver→surface hook |
| Dispatch lifecycle | MC dashboard, **one card per dispatch** | `src/surface/mc/projection/anchor.ts:22` (`anchorTaskId(correlationId)`) |

Root causes:

1. **Two grains conflated.** `correlation_id` joins **one dispatch** (`dev-consumer.ts` sets
   `correlationId: envelope.id` at lines 365/457/652/698/726). A slice spans *several* dispatches,
   each with its own `correlation_id`. Nothing carries a **slice-level** key across them.
2. **The slice address isn't propagated.** `dev-consumer.ts` has zero `response_routing` — it emits
   `dispatch.task.completed {pr, issue?}` (lines 138, 143) but forwards no logical thread address.
3. **The worklog surface predates the contract.** `worklog-manager` dumps the full **session
   interior** (tool-by-tool) keyed by `session_id`, bypassing both the surface-router and the
   logical `{repo}/issue/N` address.

## Desired state

**One slice → one Discord thread + one MC card, both fed from the same bus envelopes, joined by the
slice's issue.**

```
#cortex
 └─ cortex/issue/872            ◄── the slice (thread created at first dispatch)
      • slice opened (#872)
      • building…                (narrative beats from dispatch.task.* + progress)
      • opened PR #1140          ◄── PR linked in (artifact reference)
      • review: 2 findings       (one-liner; full review on GH PR #1140)
      • fixing → re-review: clean
      • merged → closes #872

Mission Control                 ◄── the complementary pane (same slice)
 └─ slice card #872  ▸ dispatch: implement ▸ dispatch: review ▸ dispatch: merge
      (per-dispatch anchor-tasks rolled up under the issue; interior one click in)
```

- The **issue** (`{repo}/issue/N`) is the slice key (ADR-0016). It exists from the first dispatch,
  so the thread/card have a home before any PR exists.
- The slice thread shows the **lifecycle narrative**; the full **session interior** stays in MC
  (CONTEXT.md interior↔MC / narrative↔chat split, ADR-0005). The PR is an artifact the slice
  *references*; the full GitHub review stays PR-scoped (data plane), the one-liner routes to the
  issue thread (control plane).
- Both surfaces are **projections of bus envelopes** — Discord is swappable for Slack/Mattermost/a
  web surface via the surface-router; nothing is hard-wired to Discord.

## Mechanism — reuse the source→echo→sink contract (no new primitive)

The existing **Dispatch source → runner echo → Dispatch sink** contract (CONTEXT.md) already does
this for chat replies. A slice uses it unchanged, with the **issue address** as the routing:

1. **Orchestrator stamps** (dispatch source). On every dispatch it mints for the slice — implement,
   review, merge, fixes — the orchestrator sets
   `payload.response_routing = { surface, channel, thread: "{repo}/issue/N" }`. It is the sole
   namer; workers never see who dispatched them.
   - **`channel`** follows the existing convention (the channel-routing SOP, `channel-context.ts`):
     the **repo-named channel** (`#<repo-short>`, matched against `github.repos`) by **default**, or
     a **session-specified channel** override when the loop was started with one (the
     `CORTEX_CHANNEL`-style per-session label). This is not new — the review wire already resolves
     `channel` as a repo short name (`src/adapters/discord/index.ts:1019`).
   - **`thread`** is the slice's `{repo}/issue/N`, created/resolved under that channel via
     `findOrCreateThreadByName` (`src/adapters/discord/index.ts:946`). So the address is *whole*:
     "repos get channels, the slice's issue gets a thread under it."
2. **Workers echo** (runner). Each capability-worker echoes the inbound `response_routing` onto its
   `dispatch.task.*` lifecycle envelopes (`dispatch-events.ts` builders already accept
   `responseRouting`, line 230 — `dev-consumer` simply never sets it today).
3. **Sinks group** (dispatch sink). The Discord adapter resolves the logical address to a real
   thread via `findOrCreateThreadByName` (`src/adapters/discord/index.ts:946`) and posts; MC reads
   `response_routing.thread` as a slice grouping axis over its per-dispatch anchor-tasks.

`correlation_id` is retained as the **per-dispatch (exchange) join** so a renderer can show "the
review run" as a coherent block inside the slice thread.

## Work items (v1 — one-shot, both panes converge)

This is a **cross-repo** change. Items marked **[pilot]** live in the orchestrator (loop-driver)
repo; the rest are cortex.

### A. Propagate the slice address
- **A1 [pilot]** — orchestrator stamps `response_routing = {surface, channel, thread: "{repo}/issue/N"}`
  on **every** dispatch it issues for a slice (implement, review, merge, fix re-dispatch), derived
  from the slice's issue. (Today it stamps, at most, the implement dispatch.)
- **A2** — `src/runner/dev-consumer.ts` reads inbound `payload.response_routing` and passes it to the
  `createDispatchTask{Started,Completed,Failed,Aborted}` builders, so every dev lifecycle envelope
  carries the slice address. (Pure echo; no new routing logic in the worker.)
- **A3** — confirm the review path (`review-sink` / verdict envelopes) and merge path echo the same
  inbound address (review-sink already routes by logical address — verify it inherits the issue
  thread, not a `pr/N` thread).

### B. Render the slice thread (narrative) + retire the interior dump
- **B1** — a slice renderer: a **thin `SurfaceAdapter`** (`src/bus/surface-router.ts`), not a new
  rendering stack. It consumes `dispatch.task.{started|post|completed|failed|aborted}` +
  `review.verdict.*`, groups by `response_routing.{channel,thread}`, formats each beat through the
  **existing** `envelope-renderer.ts` (`formatDispatchLifecycle` :60, `formatReviewVerdict` :128 — one
  formatter family, no reinvented copy), and posts to the slice thread via the discord adapter's
  `resolveChannel` + `findOrCreateThreadByName`.
  - **Milestone beats** ("opened PR #N", "review: 2 findings → fixing", "merged") ride the existing
    **`dispatch.task.post`** beat (envelope-renderer :69), **emitted by the orchestrator** (it drives
    the slice and knows the transitions), with workers free to emit a `post` at their own meaningful
    moments. No new beat type.
  - **No in-thread coalescing.** A slice thread is an opt-in, dedicated space where every beat is
    signal — show them all, in order (exact-duplicate dedup only). Coalesce/throttle stays in the
    F-11 notification sink that fans to shared channels/DMs (`discord-sink.ts`), where anti-spam
    matters — it does not apply to the slice thread.
- **B2** — **retire** `worklog-manager`'s session-keyed `#worklog` interior dump and its direct
  `discord.js` client. **Safe by construction:** `worklog-manager` does **zero DB writes** — it is
  purely a Discord sink — while MC's interior is fed by a *separate* path (`src/surface/mc/hooks/ingestor.ts`
  + `poller.ts` → `insertEvent` / `db/sessions.ts`). So retiring it removes only the Discord interior
  dump; the cc-events → MC interior feed is **untouched**. The narrative now comes from
  lifecycle/progress envelopes routed by the slice address; the full interior stays MC's job (C3).
- **B3** — "opened PR #N" beat: on the implement dispatch's `completed {pr, issue}`, the slice
  renderer posts the PR link into the slice thread and cross-links (thread ↔ PR).

### C. MC slice-rollup — the slice *is* the issue's `work_item`
- **C1** — when MC ingests a dispatch envelope carrying `response_routing.thread = {repo}/issue/N`,
  resolve the issue's **`work_item`** and link the per-dispatch anchor `task` to it. This is the
  minimal "anchor-join" schema change `anchor.ts` anticipated — a `work_item` reference on the
  anchor task — keeping the existing `correlation_id` anchor intact.
- **C2** — resolution is **upsert-by-issue-key**: upsert a `work_item` keyed by
  (`provider = github`, `external_id = issue#`, repo) via the existing `upsertWorkItem`
  (`src/surface/mc/db/work-items.ts:46`). It lazy-creates a stub when no prior sync covered the
  issue, and the existing GitHub ingest (`src/surface/mc/adapters/github/ingest.ts`) enriches the
  **same row** later (same key) — no race, no parallel entity, no new sync to build.
- **C3** — the **slice card = the `work_item` view**, which already gathers (via existing FKs) the
  issue's `pull_requests`, `reviews`, `checks`, and now its dispatch anchor-tasks → assignments →
  `sessions` → interiors. The interior stays MC-local; a **federated** dispatch's anchor-task shows
  lifecycle only (no interior — the peer's sovereign local).

Net: the Discord slice thread and the MC slice card are two projections of the **same issue
`work_item`** — the thread renders its *narrative*, the card renders its *full structure*. The slice
address (`{repo}/issue/N`) does double duty: thread name on Discord, `work_item` resolution key in MC.

## Acceptance criteria

- [ ] A slice's implement, review, fix, and merge activity all land in **one** `{repo}/issue/N`
      Discord thread — created at the **first** dispatch, before the PR exists.
- [ ] The slice thread shows the **narrative** (slice opened → building → PR opened → review verdict
      → fixing → merged), not the tool-by-tool interior.
- [ ] The full session interior is reachable in **MC**, not posted to Discord.
- [ ] MC shows **one slice card** per issue — the issue's `work_item`, with its dispatches (anchor
      tasks → sessions), `pull_requests`, `reviews`, and `checks` rolled up under it; upsert-by-issue-key
      so the slice projection and GitHub ingest converge on one row.
- [ ] No activity lands in the legacy `#worklog` channel (worklog-manager interior dump retired).
- [ ] Capability-workers carry **no** orchestrator/sibling names — they only echo inbound routing
      (grep: no worker references `vega`/the orchestrator by name).
- [ ] Swapping the Discord adapter for another surface needs **no** change to A1–A3 (routing is
      logical; the adapter resolves it).

## Federated slices — a peer principal's reviewer (the IoAW case)

A slice's `code-review` (or any capability) dispatch can be claimed by a capability-worker on a
**peer principal's stack** — e.g. JC's reviewer assistant reviewing Andreas's code. This falls out
of the design with **no new convergence machinery**, because the slice key is logical and travels on
the federated envelope. The cross-principal case is actually *cleaner* on the slice surface, not
harder.

- **Routing already exists.** cortex subscribes to `federated.{me}.{stack}.tasks.code-review.>` and
  routes the verdict back to the requester (`src/cortex.ts:1550-1648`). The orchestrator offers
  `code-review` at **`federated` offer-scope** to the network; the peer claims it via its own
  offering. Capability-routed and **assistant-anonymous** — the federated accept-policy names
  **principals/networks, not assistants** (CONTEXT.md → Capability offering), so the requester trusts
  "peer stack on network X," not a reviewer by name.
- **Convergence holds.** The orchestrator stamps `response_routing = {repo}/issue/N` on the federated
  review dispatch (work item A1); the peer echoes it on the verdict; the verdict routes home carrying
  the slice address → lands in the **same slice thread**. Attribution renders as **principal +
  capability** (the verdict's `signed_by` chain identifies the peer stack).
- **Sovereignty is preserved, and aligns with the Q4 grain.** The peer reviewer's **interior never
  crosses** the principal boundary — wire-grammar-enforced, not redaction (CONTEXT.md → Session
  interior; ADR-0005). The requester receives **lifecycle + verdict**, which is exactly the narrative
  grain the slice thread already shows. A federated reviewer is **indistinguishable in the thread**
  from a local one; only the "drill into the reviewer's interior" affordance is absent — correctly,
  because that interior is the peer's sovereign local.

**Decisions**

- **D1 — the federated reviewer posts the full inline review to the requester's GitHub PR directly**
  (current behaviour: reviewer posts via `gh pr review`, emits the structured verdict on the bus —
  `review-prompt.ts:68-75`). Rationale: a reviewer **cannot review without gh read-access to the
  diff**, so write-back is the same credential — not an added burden. The bus carries the structured
  verdict; GitHub carries the full inline review. Verdict payload unchanged. (We explicitly did *not*
  take the "verdict carries all inline findings, requester re-posts" route — simpler wins.)
- **D2 — a federated verdict satisfies the merge gate.** A verdict signed by an accepted principal on
  an accepted network counts toward "all findings addressed → merge," via the requester's
  **accept-policy** — principal-level trust, assistant-anonymous, riding the completed signing +
  cross-op-verify trust track.

**Work (layers on local v1; routing mostly built)**

- **F1 [pilot]** — orchestrator offers `code-review` at `federated` offer-scope to the network and
  dispatches the slice's review there (vs a local reviewer) per its policy.
- **F2** — verify the federated verdict echoes the slice `response_routing` (same A-items, federated
  subject) so it lands in the requester's slice thread.
- **F3** — the merge gate accepts a federated verdict per accept-policy (D2).

Sequence after local convergence lands; builds on the existing federated code-review subscription.

**Acceptance (federated)**

- [ ] A peer principal's reviewer can claim a slice's `code-review`; its verdict lands in the
      requester's slice thread, attributed by **principal + capability**.
- [ ] The peer reviewer's **interior never appears** on the requester's surfaces (lifecycle + verdict
      only).
- [ ] A federated verdict counts toward the merge gate per accept-policy.

## Open questions / later phases

1. **No-issue fallback.** ADR-0016's trip-wire: a slice with no backing issue has no `{repo}/issue/N`
   anchor. v1 assumes issue-backed slices. If ad-hoc (issue-less) slices become common, revisit the
   bus-native slice-id alternative.
2. **`#worklog` deprecation mechanics.** In-flight sessions during cutover, and whether `#worklog`
   is removed or left dormant. (Migration detail, not a design fork.)
3. **Multiple PRs per issue.** A slice that opens more than one PR — all PR links land in the one
   issue thread (the issue is the anchor); confirm the renderer handles N PR-links cleanly.

## References

- ADR: `docs/adr/0016-slice-grouping-key-is-the-issue.md`
- Glossary: `CONTEXT.md` → Slice, Orchestrator, Dispatch, Dispatch sink, Session interior
- Code: `src/runner/worklog-manager.ts` (retire), `src/runner/dev-consumer.ts` (echo),
  `src/bus/dispatch-events.ts` (`responseRouting` builders), `src/adapters/response-routing-delivery.ts`
  (`WireLogicalRouting`), `src/adapters/review-sink.ts`, `src/adapters/discord/index.ts`
  (`findOrCreateThreadByName`), `src/bus/surface-router.ts` (`SurfaceAdapter`),
  `src/surface/mc/projection/anchor.ts` (slice-rollup axis)
- Related: `docs/design-mc-f11-discord-notifications.md`, `docs/sop-discord-channel-routing.md`
