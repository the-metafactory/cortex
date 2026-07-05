# Plan — Architecture deepening (8 candidates, 10 slices)

**Provenance:** architecture review 2026-07-04 (two-agent exploration of the full repo; findings verified against source). Vocabulary per the review: *module, interface, seam, adapter, depth, leverage, locality*.
**Goal:** work through the 8 review candidates as small, behavior-preserving refactor slices, ordered so each slice is independently shippable and the executing agent never needs the whole repo in context.
**Executor profile:** written for a smaller model. Every slice has a bounded read-list, a template to imitate, mechanical steps, and grep-verifiable done-checks. When a slice says ESCALATE, stop and ask the principal — do not improvise.

---

## 0. Ground rules (read once, apply to every slice)

1. **Behavior-preserving.** These are refactors. No output string, wire subject, envelope field, SQL effect, or HTTP header may change unless the slice explicitly says so. If you notice an unrelated bug: file an issue, do not fix it in the slice (repo rule: no drive-by fixes).
2. **One slice = one worktree = one PR.**
   ```bash
   git worktree add ../Cortex-<slug> -b refactor/arch-<slice>-<slug> origin/main
   cd ../Cortex-<slug> && bun install   # REQUIRED: fresh worktrees fail the smoke typecheck without it
   ```
3. **One `cortex.ts` slice in flight at a time.** S7–S9 all edit `src/cortex.ts`; they must land serially, each rebased on the previous merge. All other slices touch disjoint files and may run in any order or in parallel.
4. **Read only the read-list.** Each packet lists files and line ranges. Do not read all 7,204 lines of `cortex.ts` or all 4,639 of `network.ts` — the ranges are the slice.
5. **GitHub hygiene** (repo standard): create one issue per slice (labels: `infrastructure` + `next`), comment when starting, PR body ends with `Closes #N`, PR title `refactor(<scope>): <slice-id> — <summary>`. Pre-flag intentional gaps in an "Out of scope" section of the PR body.
6. **Verification gates — every slice, in order:**
   ```bash
   bunx tsc --noEmit                    # zero errors (fix ALL, even pre-existing ones you surface)
   bun test <paths from the packet>     # scoped suites green
   bun test                             # full suite; some integration suites need a local nats-server —
                                        # a suite red ONLY for "connect ECONNREFUSED 4222" with no bus running
                                        # is an environment gap: note it in the PR, don't chase it
   bun run lint:errors                  # zero errors
   ```
   plus the slice's own **no-stragglers grep** (must return empty / expected count).
7. **Review loop:** request review per the repo's PR-review SOP. On approve with zero blockers/majors → merge (squash), tick the slice in §3, close the issue.
8. **ESCALATE triggers (stop, post findings on the issue, ask):**
   - a step would change bytes on the wire (subject, source string, header, signed payload);
   - a test fails and the cause isn't obviously your edit;
   - the packet's stated line anchors are gone (file changed since 2026-07-04) **and** you can't relocate the construct by the grep given in the packet;
   - the diff grows past ~600 changed lines on a slice marked small.

---

## 1. Execution order and why

| Phase | Slices | Rationale |
|---|---|---|
| Warm-up (small, mechanical, teaches the codebase) | S1 source-string · S2 slug authority · S3 admin signing | Pure duplicated-knowledge consolidation. Small diffs, grep-verifiable, builds familiarity with bus + CLI layout before the big files. |
| Mid (bounded god-file surgery, existing template to copy) | S4 MC db writes · S5 network-admit triplet · S6 snapshot contract | Each has an in-repo pattern to imitate; no invention needed. |
| Main event (serial) | S7 review lane · S8 brain+release lanes · S9 adapter lane | `startCortex` extraction, one lane at a time, template = `dev-consumer-boot.ts`. Serial: same file. |
| Decision-gated | S10 sink collapse | Speculative in the review. Default = write an ADR instead of code. |

Do not reorder S7→S9. Everything else: any order.

---

## 2. Work packets

### S1 — One owner for the envelope source-string grammar  *(candidate 4 · Strong · small)*

**Goal:** exactly one implementation of the `{principal}.{agent}.{instance}` source string; delete the five copies.

**Read-list:**
- `src/bus/envelope-builder.ts` (whole file, 95 ln — note the header comment "NOT a source-string builder — domains have different segment defaults"; your change must respect that: the helper is *additive*, per-domain segment defaults stay with the domains)
- `src/bus/system-events.ts:80–100` (the exported `buildSource`, line ~90)
- the five private copies: `github-events.ts:75`, `dev-events.ts:58`, `review-events.ts:88`, `dispatch-events.ts:135`, `capability-registry.ts:253`
- `src/bus/brain-consumer.ts:80–95` (already imports the shared one — the pattern to spread)

**Steps:**
1. Move/keep one exported `buildSource(src: SystemEventSource): string` — preferred home: `envelope-builder.ts` (update its "NOT a source-string builder" comment to say it owns the *source string* but not per-domain defaults) or keep it in `system-events.ts`; pick whichever keeps import cycles clean (`bunx tsc --noEmit` will tell you).
2. Delete the five private copies; import the shared one.
3. **DO NOT TOUCH** the two drifted sites — `src/bus/agent-network/builders.ts:85` (`principal.stack.instance`) and `src/bus/probe-responder.ts:413` (different order) — changing them changes wire bytes (ESCALATE trigger). Instead: file one follow-up issue titled "source-string drift: agent-network/builders + probe-responder vs myelin#185 3-segment grammar", quoting both lines, and link it in the PR body under Out of scope.

**No-stragglers grep** (expect exactly 1 defining site + the 2 documented drifted sites):
```bash
grep -rn "principal}\.\${.*\.agent}\.\${.*instance}\|function buildSource" src/bus --include="*.ts" | grep -v __tests__
```
**Scoped tests:** `bun test src/bus`
**Done when:** 1 definition, 5 copies gone, drift issue filed, gates green.

---

### S2 — Embody ADR-0004: one `stackSlugFromStackId`  *(candidate 6 · small)*

**Goal:** a single TS function is the slug-derivation authority; the three re-implementations call it.

**Read-list:**
- `docs/adr/0004-stack-slug-authority.md` (context only — this slice implements *with* the ADR, changes nothing it decided)
- `src/cli/cortex/commands/stack-lib.ts:55–115` (`stackIdTrailingSlug` ~:105 and the "Replica of extract_stack_id_slug… byte-for-byte" comment ~:63)
- `src/cli/cortex/commands/network-doctor-lib.ts:140–160` (`stackSlugFromStackId` ~:148)
- `src/cli/cortex/commands/daemon-locator.ts:1–30` (inline `split("/")[1]` ~:8)
- `src/cli/cortex/commands/network-ping-signer.ts:90–110`

**Steps:**
1. Create `src/common/stack-id.ts` exporting `stackSlugFromStackId(stackId: string): string` — lift the most defensive of the existing implementations (the one mirroring `extract_stack_id_slug` semantics, including its edge cases: no `/`, trailing `/`, empty).
2. Port the byte-for-byte-replica comment onto it and state the mirroring direction: *shell (`scripts/lib/plist-render.sh` `extract_stack_id_slug`) mirrors THIS function*.
3. Replace the four call-side implementations with imports. Do not edit the shell script.
4. Add a small unit test (`src/common/__tests__/stack-id.test.ts`) covering: `jc/default → default`, `andreas/meta-factory → meta-factory`, bare `foo`, empty string — asserting whatever the lifted implementation actually did for the degenerate cases (behavior-preserving, not "improved").

**No-stragglers grep** (expect only the new module + shell mention in comments):
```bash
grep -rn "split(\"/\")\[1\]\|TrailingSlug\|SlugFromStackId" src/cli src/common --include="*.ts" | grep -v __tests__ | grep -v stack-id.ts
```
**Scoped tests:** `bun test src/common src/cli/cortex/commands`
**Done when:** one authority function + test, four call sites import it, gates green.

---

### S3 — Client-side seam for admin-request signing  *(candidate 5 · Strong · small, security-sensitive)*

**Goal:** one `signAdminRequest` helper owns the PoP-sign + `x-admin-signed` wire contract; 8 hand-built copies deleted.

**Read-list:**
- `src/common/registry/signing.ts` (whole — currently verify-half only)
- `src/services/network-registry/src/validate.ts` (the server-side parser — the contract you must match byte-for-byte; read the `x-admin-signed` handling)
- call sites: `network-secret-adapters.ts:320–390, 500–520` · `network-authorize-adapters.ts:65–115` · `network.ts:2490–2540`

**Steps:**
1. Add to `src/common/registry/signing.ts` (next to its verifier):
   `signAdminRequest(material, claim): { headerName: "x-admin-signed", headerValue: string }` (or `{header, body}` — match what the call sites actually put on the request; inspect two before deciding). Internally: `canonicalJSON(claim)` → encode → `signClaimWithSeed` → `JSON.stringify({ claim, signature })`.
2. Route all 8 sites through it. The produced header value must be **byte-identical** for identical inputs — add a unit test that fixes a seed + claim and asserts the exact serialized output, then verify it round-trips through the same verify function `validate.ts` uses.
3. No behavior change to *which* claims are built where — only the signing/serialization moves.

**No-stragglers grep** (expect 1 site: the new helper):
```bash
grep -rn "x-admin-signed" src/cli src/common --include="*.ts" | grep -v __tests__ | grep -v signing.ts
```
**Scoped tests:** `bun test src/common/registry src/cli/cortex/commands`
**Done when:** helper + round-trip test in place, 8 sites routed, gates green.

---

### S4 — Give Mission Control's db modules their write half  *(candidate 2 · Strong · medium)*

**Goal:** all ~48 inline SQL mutations in `handlers.ts` move behind `db/` functions; handlers stop knowing column names and status enums.

**Read-list:**
- `src/surface/mc/db/tasks.ts` + `db/assignments.ts` + `db/sessions.ts` (whole — the read-side style to imitate: function-per-query, injected db handle)
- `src/surface/mc/api/handlers.ts` — **only the mutation regions**; find them with:
  ```bash
  grep -n "INSERT INTO\|UPDATE \|DELETE FROM" src/surface/mc/api/handlers.ts
  ```
  Known anchors: cancel-task UPDATE at :1557 **and** :2246 (same invariant twice) · assignment INSERT :734/:740/:1712 · assignment DELETE :792/:852/:1738 · tasks INSERT :734/:2077/:2823.

**Steps (iterate per table, commit per table if you like):**
1. For each mutation cluster add a named function to the matching db module: `createTask`, `cancelTask`, `createAssignment`, `removeAssignment`, `requeueAssignment`, … Name by domain intent (what the handler means), not by SQL verb.
2. Where the same invariant exists twice (cancel-task), both handlers call the **one** new function. If the two inline copies differ in any way beyond whitespace, ESCALATE (that's a live bug, not a refactor).
3. Handlers keep request parsing/validation/response shaping; db modules own SQL + `unixepoch()` timestamps + status-enum strings.
4. Unit-test the new write functions against a temp SQLite db, same style as existing db tests (check `src/surface/mc/**/__tests__/` for the fixture pattern before writing your own).

**No-stragglers grep** (expect 0 in handlers.ts):
```bash
grep -n "INSERT INTO\|UPDATE \|DELETE FROM" src/surface/mc/api/handlers.ts
```
**Scoped tests:** `bun test src/surface/mc`
**Done when:** grep returns nothing, invariants exist once, gates green.

---

### S5 — Extract `network-admit` into the lib/ports/adapters triplet  *(candidate 3 · Strong · medium)*

**Goal:** admit/reject/seal/Discord-role logic leaves `network.ts` (~900 ln) as a triplet matching every sibling subcommand; the `__set*ForTests` mutable singletons are deleted.

**Read-list:**
- template: `network-authorize-lib.ts` + `network-authorize-ports.ts` + `network-authorize-adapters.ts` (the smallest complete triplet — read all three to internalize the split: *lib = pure decisions, ports = interface, adapters = live + dry-run implementations*)
- `src/cli/cortex/commands/network.ts:2364–2400` (test-setter singletons), `:2435–2548` (Discord role + admission header/body builders), `:2549–2718` (pending table), `:2753–3065` (`runAdmit`), `:3065–3232` (`runReject`), `:3283–3382` (`sealAdmittedMember`)
- the existing admit tests (find with `grep -rln "runAdmit\|__setDiscordAdmitClient" src/cli --include="*.test.ts"`) — they define current behavior; they must keep passing, rewritten to inject ports instead of setting singletons.

**Steps:**
1. Create `network-admit-ports.ts`: an `AdmitPorts` interface covering the three effect families — registry admission write, Discord fleet-role add/remove, member sealing (payload-key crypto). Follow the sibling ports' naming/shape.
2. Create `network-admit-adapters.ts`: live adapter (move the fetch/Discord/seal code from `network.ts`) + dry-run adapter (print-only, mirroring how `buildDryRunPorts` siblings do it). S3's `signAdminRequest` should already be what the registry calls go through — if S3 hasn't merged yet, keep the inline signing and note it.
3. Create `network-admit-lib.ts`: pure functions — decision assembly, `buildAdmissionReadHeader`/`buildAdmissionDecisionBody`, pending-table rendering. No I/O, no `Bun.spawn`, no fetch.
4. `network.ts` keeps only the commander wiring: parse flags → build ports (live or dry-run) → call lib.
5. Delete `__setDiscordAdmitClientForTests`, `__setDiscordRemoveClientForTests`, `__setJoinLeafSecretFetcherForTests` and migrate their tests to injected ports.

**No-stragglers grep** (expect 0):
```bash
grep -n "__set.*ForTests" src/cli/cortex/commands/network.ts
```
**Scoped tests:** `bun test src/cli/cortex/commands`
**Done when:** triplet exists, `network.ts` shrank by roughly the cluster size, singletons gone, gates green.
**Trap:** the sealing crypto (`sealAdmittedMember`) is wire-sensitive (ADR-0018/0019 path). Move it verbatim — if you feel any urge to "clean it up", ESCALATE instead.

---

### S6 — Worker-scoped `DashboardSnapshot` contract  *(candidate 7 · medium-small · RETARGETED, see #1520)*

**Original goal (superseded):** "the local bun:sqlite API and the CF Worker D1 projection conform to one exported type." **This premise didn't hold.** The read-list's own suggested grep for the local snapshot assembly (`grep -rn "snapshot" src/surface/mc/server.ts src/surface/mc/api/handlers.ts | grep -i "state\|dashboard"`) returns nothing, because there is no local combined-snapshot endpoint to conform to: cortex's local dashboard serves granular REST (`/api/agents`, `/api/working-agents`, `/api/tasks`, …) plus incremental WS projections; it never regained a `/api/state`-equivalent after the mc-v3 lift. `state.ts`'s `:3` comment ("same DashboardSnapshot shape as the local API") is a grove-v2 holdover — grove-v2's monolithic `dashboard-state.ts` (MIG-2.3) was folded into the distributed `api/*.ts` + `db/*.ts` split for CRUD, but no snapshot-assembly function was ever ported in the combined shape the comment describes. Full diagnosis: the escalation comment on [#1520](https://github.com/the-metafactory/cortex/issues/1520).

**Retargeted goal:** the worker's own producer↔consumer pair — `buildSnapshot()` and the routes that read its cached output back — are typed against one exported `DashboardSnapshot`, so a shape change on one side is a compile error on the other. Plus the real prize: an allow-list SHAPE guard for the public `/api/state` projection, pinning both the D1 schema's column set and the DTO's key set as enforced invariants (not a deny-list — see step 3).

**Read-list:**
- `src/surface/mc/worker/src/routes/state.ts` (the `DashboardSnapshot` type + `buildSnapshot()` + the `/api/state` route's `JSON.parse` re-hydration of `getCachedSnapshot`'s cache — the one real internal type-erasure gap)
- `docs/adr/0005-mission-control-integration-architecture.md` + `CONTEXT.md`'s "Session interior" entry (tool calls, prompts, file edits, skill invocations, sub-agent spawns — always `local` scope)

**Steps:**
1. Declare `DashboardSnapshot` (plus its nested section types) directly in `state.ts`, exported. Type `buildSnapshot()`'s return, and the `/api/state` route's `JSON.parse(json) as CombinedDashboardPayload` re-hydration of the cache, against it.
2. Reword the stale `:3` comment to the corrected premise (no local shape exists to mirror; the worker's D1 projection is populated independently via `routes/ingest.ts`).
3. Add an ADR-0005 allow-list SHAPE guard, not a deny-list — a deny-list of interior-sounding names (`tool_input`, `arguments`, `diff`, `messages`, …) can never be complete (e.g. `tool_result`, `raw_diff`, `content`, `body` all slip past a fixed pattern). Instead: (a) a schema-column allow-list, reading `schema.sql` directly, listing every legitimate column on each of the 4 tables `buildSnapshot()` reads; (b) a per-section DTO key allow-list, walked recursively over a snapshot built from a seeded in-memory bun:sqlite D1 fixture (same shim pattern as `state-session-tree.test.ts`), asserting every object's keys are a subset of that section's known-safe set. `sessions.description` and `SessionActivityEntry.detail` (G-410's pre-sanitized, truncated previews) are consciously included in the allow-list — known, accepted, pre-existing exceptions, out of scope to change here. The guard checks key SHAPE only, not values, and DTO-level coverage holds only for branches the fixture actually exercises (schema-level coverage is unconditional).

**Scoped tests:** `bun test src/surface/mc/worker`
**Done when:** worker producer/consumer typed by the shared contract, allow-list guard green (schema + DTO), stale comment corrected, gates green.

---

### S7 — `startCortex` lane 1: `wireReviewConsumers`  *(candidate 1 · Strong · the template slice)*

**Goal:** the ~475-line inline review-consumer boot closure becomes `src/runner/review-consumer-boot.ts`, shaped exactly like `dev-consumer-boot.ts`.

**Read-list:**
- template: `src/runner/dev-consumer-boot.ts` (whole, 705 — study `WireDevConsumersOpts`, the return shape `WiredDevConsumer[]`, and how `cortex.ts` calls it: `grep -n "wireDevConsumers" src/cortex.ts`)
- `src/cortex.ts:2111–2586` (`startReviewConsumersForAgent`) **plus** every outer `let`/const it captures — find them by listing each free identifier in the closure and locating its declaration (most live in `cortex.ts:827–1000`)
- `src/__tests__/cortex.test.ts:1–120` (the fake-runtime injection seam your new unit test will reuse)

**Steps:**
1. Create `src/runner/review-consumer-boot.ts` exporting `wireReviewConsumers(opts: WireReviewConsumersOpts)`. The opts interface = exactly the outer values the closure captures (runtime, registry, config slices, loggers…). Return `{ consumers, stop }` (mirror the dev-boot return convention).
2. Replace the inline closure in `cortex.ts` with a call; the returned handles join the existing teardown where the old closure's state was torn down.
3. Mutable-capture check: if the closure *reassigns* any outer `let` (rather than just reading), that variable must be passed as an explicit getter/setter pair in opts or returned — never a hidden shared binding. List every such variable in the PR body.
4. Unit test: boot the lane against the recording fake runtime (reuse `cortex.test.ts`'s fake), assert the subjects subscribed and consumer wiring — the assertions the current inline code never had.

**No-stragglers grep:** `grep -n "startReviewConsumersForAgent" src/cortex.ts` → expect 0.
**Scoped tests:** `bun test src/runner src/__tests__/cortex.test.ts`
**Done when:** lane extracted, `cortex.ts` net-shrinks ~450+, new lane test green, full `startCortex` fake-runtime test still green.
**Trap:** behavior-preserving means same subjects, same consumer options, same ordering relative to other boot steps. Keep the call at the same position in `startCortex`'s sequence.

---

### S8 — `startCortex` lanes 2+3: `wireBrainConsumers` + `wireReleaseConsumers`

Same recipe as S7 (S7's merged PR is now your *second* template — imitate its opts/return/test shape).
- Brain closure: `src/cortex.ts:2780–2986` (~200 ln) → `src/runner/brain-consumer-boot.ts`
- Release closure: `src/cortex.ts:3038–3480` (~440 ln) → `src/runner/release-consumer-boot.ts`
- (Line anchors will have shifted after S7 — relocate with `grep -n "startBrainConsumersForAgent\|ReleaseConsumer" src/cortex.ts`.)
- Two lanes, one PR is fine (same mechanical move); separate commits.
**No-stragglers grep:** `grep -n "startBrainConsumersForAgent" src/cortex.ts` → 0.
**Scoped tests / done:** as S7.

---

### S9 — `startCortex` lane 4: `wireSurfaceAdapters` through `GatewayAdapterFactory`

**Goal:** the ~600 lines of inline Discord/Mattermost/Slack construction in `startCortex` route through the already-existing `GatewayAdapterFactory` seam, so exactly one module knows how to build a platform adapter.

**Read-list:**
- `src/gateway/gateway-adapters.ts` (whole, 347 — `GatewayAdapterFactory` at :122, `defaultGatewayAdapterFactory`)
- `src/cortex.ts` inline constructions — relocate with `grep -n "new DiscordAdapter\|new MattermostAdapter\|new SlackAdapter" src/cortex.ts` (pre-S7 anchors: :3857/:4051/:4146)
- compare option-by-option what the inline path sets vs what the factory sets. **This diff is the whole slice.**

**Steps:**
1. Build the per-platform option diff first and paste it in the issue. If the factory is missing options the main path needs, extend the factory (additive).
2. Create `wireSurfaceAdapters(opts)` (in `src/gateway/` or `src/runner/` — match where its dependencies live) that: builds adapters via the factory, registers with the surface-router, wires trust-resolver + presence — the three per-platform repetitions collapsed to one loop.
3. Replace the three inline blocks; teardown handles as in S7.
4. Unit test with the mock adapter/fake runtime: adapters registered, router bindings present.

**No-stragglers grep:** `grep -n "new DiscordAdapter\|new MattermostAdapter\|new SlackAdapter" src/cortex.ts` → 0 (constructions live behind the factory only).
**Scoped tests:** `bun test src/gateway src/runner src/__tests__/cortex.test.ts` — plus a manual boot smoke: `bun src/cortex.ts --help` (or the repo's standard dry boot) to catch wiring-order regressions typecheck can't.
**Trap:** adapter boot ORDER and router-registration order can be load-bearing (presence + trust wiring). Preserve the sequence; note it in the module's header comment.

---

### S10 — DispatchSink/ReviewSink collapse  *(candidate 8 · Speculative · decision-gated)*

**Default action: no code.** Write `docs/adr/00XX-outbound-sink-shape.md` (next free number) recording: the twin modules (`src/adapters/dispatch-sink.ts:106` ≡ `review-sink.ts:117` interfaces), the partial extraction (`response-routing-delivery.ts`), and the decision rule — *collapse onto one `OutboundSink` + pluggable target-resolver only when a third sink variant is actually planned; until then the twins stand.* This stops future architecture reviews from re-proposing it.
Only implement the collapse if the principal explicitly says a third variant is coming. If so: model on S5's ports discipline; the routing-resolution step (snowflake vs logical triple) is the adapter.

---

## 3. Status

Umbrella epic: **#1514**.

| Slice | Issue | Candidate | Size | Depends on | Status |
|---|---|---|---|---|---|
| S1 source-string owner | #1515 | C4 | S | — | ☑ merged (#1530) |
| S2 slug authority | #1516 | C6 | S | — | ☑ merged (#1531) |
| S3 admin-request signing | #1517 | C5 | S | — | ☑ merged (#1532) |
| S4 MC db write half | #1518 | C2 | M | — | ☑ merged (#1535) |
| S5 network-admit triplet | #1519 | C3 | M | S3 (soft) | ☐ held (network.ts in-flight) |
| S6 DashboardSnapshot contract | #1520 | C7 | M | — | ☑ merged (#1537) — **retargeted worker-scoped** |
| S7 review lane | #1521 | C1 | M | — | ☑ merged (#1542) — cortex.ts 7204→6736 |
| S8 brain + release lanes | #1522 | C1 | M | S7 | ☑ merged (#1545) — →6390 |
| S9 adapter lane | #1523 | C1 | M | S8 | ☑ merged (#1547) — →5937 (via GatewayAdapterFactory in src/runner/) |
| S10 sink ADR | #1524 | C8 | S (ADR) | — | ☐ |

Tick here AND close the slice's GitHub issue on merge (repo sync rule).

**S6 note (retarget, 2026-07-05):** candidate 7's premise was stale — cortex has no local `/api/state` snapshot assembly to unify with the worker (the worker route's "same shape as the local API" is a grove-v2 holdover; the local dashboard uses granular REST + incremental WS). S6 was retargeted worker-scoped: one explicit `DashboardSnapshot` type + a two-layer allow-list SHAPE guard (schema columns + per-section DTO keys) for the public `/api/state` projection. Follow-up #1538 filed: the MC worker `tsc` is outside CI, so the type contract isn't CI-enforced yet.
