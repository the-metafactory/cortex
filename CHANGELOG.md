# Cortex — Changelog

## 6.3.0 — 2026-07-07 — Federation payload swap (epic #1595)

The operator-mode federation credential path — epic #1595's payload swap — is
code-complete. On a network whose verified descriptor attests `hub_mode:
operator`, admit now seals a subject-scoped per-member NSC `.creds` credential
instead of a shared inline-leaf PSK (which is structurally illegal on an operator
hub). The whole path — mint → seal → member install → rotate → revoke — was
validated end-to-end against a real operator hub with a full nats resolver: the
scoped creds bind a real leaf, rotate re-keys, revoke cuts at runtime, and the
hub never restarts. Production go-live is gated only on the hub-resolver
migration (#1626) + this deploy.

### Added

- **Operator-mode admit: scoped mint + v2 seal** (C-1598, #1610) — a network
  attesting `hub_mode: operator` mints a subject-scoped user via `arc nats
  add-federated-user` (least privilege as code: `federated.{{name()}}.>`) and
  seals its `.creds` in a v2 envelope; ZERO hub-config writes. Two fail-fast
  guards: the shared-string/PSK path is refused on an operator network (Guard A),
  and the mint is refused unless the network attests a push-capable resolver
  (`resolver_mode: nats`, Guard B). Probe-then-stamp of `hub_authorized_at` —
  the account must be visible on the hub resolver before authorization is
  stamped, never blind.
- **Operator-mode rotate + revoke** (C-1599, #1619) — rotate re-mints fresh
  scoped material (`arc nats reissue-federated-user`: revoke+push old key,
  re-mint under the same scoped key) and re-seals v2; revoke cuts the member's
  leaf at runtime (`arc nats revoke-federated-user`: nsc revocations + push) —
  no hub restart. Hub-first, fail-closed ordering: any revoke failure aborts
  before the registry mark, so a REVOKED row never sits over a possibly-live
  credential; an ambiguous `USER_NOT_FOUND` is not treated as a cut.
- **`hub_mode` / `resolver_mode` attestation** (C-1598, #1610) — carried on the
  registry `NetworkRecord` + the signed `NetworkDescriptor`; set via `cortex
  network create --hub-mode operator --resolver-mode nats`. Changing the
  attestation requires GLOBAL-admin authority (an operator→simple downgrade is a
  hub-crash vector).

### Fixed

- **Admit resolves the operator-mode attestation** (C-1652, #1653) — `network
  create --apply` now best-effort seeds the admin's verified descriptor cache, so
  a subsequent `admit` on the same machine reads `hub_mode` off the verified
  descriptor rather than silently falling back to the simple/PSK path. Failures
  are surfaced (stderr + `--json descriptor_cached`), never silent.

## 6.2.1 — 2026-07-06 — Architecture deepening (epic #1514)

Ten behavior-preserving refactor slices completed the architecture-deepening
epic (#1514). No new features, no breaking changes, no runtime behavior change —
each slice was proven by its existing integration tests staying green unchanged,
with new unit coverage added for the extracted seams.

### Refactor

- **`startCortex` split into four boot lanes** — the ~1,270-line inline
  consumer/adapter boot in `src/cortex.ts` (7,204 → 5,937 lines) extracted into
  focused `src/runner/*-boot.ts` modules: `wireReviewConsumers` (S7, #1542),
  `wireBrainConsumers` + `wireReleaseConsumers` (S8, #1545), and
  `wireSurfaceAdapters` routed through the existing `GatewayAdapterFactory` (S9,
  #1547). New unit coverage for boot wiring, registration order, and (S9)
  guild-allowlist scoping + credential redaction.
- **`network-admit` extracted into a lib/ports/adapters triplet** (S5, #1586) —
  `network.ts` 4,630 → 4,243; the `__set*ForTests` admit singleton retired in
  favour of injected ports (the two shared with `network secret`/`join` kept
  intentionally).
- **Duplicated knowledge collapsed to single owners:** one envelope
  source-string builder (S1, #1530), one `stackSlugFromStackId` slug authority
  embodying ADR-0004 (S2, #1531), one `signAdminRequest` admin-signing seam with
  its import cycle broken (S3, #1532), and Mission Control's inline SQL mutations
  moved behind db-module functions (S4, #1535).
- **Worker `DashboardSnapshot` contract** (S6, #1537) — one explicit type for the
  CF Worker `/api/state` producer↔consumer, with an allow-list shape guard for
  the ADR-0005 no-interiors invariant on the public endpoint.

### Docs

- **ADR-0021 — outbound sink shape** (S10, #1553): the `DispatchSink`/`ReviewSink`
  twins stand; collapse only when a third variant is planned.

### Follow-ups filed

#1529, #1538, #1543, #1548, #1552 (repo-wide guild-ID confidentiality sweep),
#1587.

> **Note:** the `## Unreleased` section below is stale — its entries shipped in
> v3.1–v6.2 but were never moved out. Curation is tracked as a follow-up.

## Unreleased

### Breaking

- **arc package renamed `Cortex` → `cortex`** (#1337) — the arc package name now
  matches the binary/CLI (`~/bin/cortex`, `cortex …`) and the sibling packages
  (`arc`, `metafactory-discord`). arc is **case-sensitive** (correct on Linux,
  where `Cortex` and `cortex` are distinct paths), so this is a real rename, not
  a case-fold. **One-time migration for existing installs** (anyone already on
  `Cortex`): run **`arc uninstall Cortex && arc install cortex`** once — the same
  idiom as the Grove→Cortex rename. Configs under `~/.config/cortex/` are
  untouched. New installs just use `arc install cortex` / `arc upgrade cortex`.

### Non-breaking

- **F-6 reflex bridge — generic `process` code handler (config-driven command
  runner).** A new code-handler channel (`handler: "process"` on a
  `reflex_activation.targets[]` entry, with a sibling `process: "<name>"`),
  alongside `discord-webhook`. Ships ONCE; new automated processes are added as
  DATA — a spec file dropped into the processes directory
  (`$CORTEX_PROCESSES_DIR`, else `<config-dir>/processes`, else
  `~/.config/cortex/processes/*.yaml`) — with **no cortex code change and no
  re-release**. Each spec declares `cwd`, `argv` (with typed `{param}` tokens),
  `timeout_ms`, and `params`. The handler reads the spec FRESH per fire (a new
  file is picked up with no restart), fills `{param}` tokens from the activation
  payload (type-validated against the declared `params`), and spawns argv with
  **no shell**. Trust: the spec NAME comes from the trusted `target.process`
  (never the payload), `cwd`/`argv` come only from the on-disk spec, and a param
  value is always a single argv element. So with NO shell there is no
  word-splitting and no shell-command injection; and the COMMAND (`cwd`/`argv`/
  the spec name) comes from spec/target config, never the payload, so a payload
  can't pick what runs or traverse the processes dir (name is `[a-z0-9-]`). The
  remaining surface is per-arg: a `string` param is `enum`-constrained by default
  (an enum value can't be an arbitrary flag), and an unconstrained value is only
  possible via explicit `freeform: true` — which IS a single arbitrary arg the
  child may read as a flag (that is exactly why it is opt-in, not the default). Param defaults are type/enum-validated at load. Each spec may
  declare an `env` allow-list; omitting it inherits cortex's full env (handy for
  a trusted spec, but it then sees every cortex secret — prefer an allow-list).
  The handler logs the un-substituted argv TEMPLATE, never resolved param values. `timeout_ms` is
  capped under the JetStream `ack_wait` so the watchdog's "kills before
  redelivery" guarantee is enforced by the schema, not just asserted. A 15-minute (spec-`timeout_ms`) watchdog kills a hung run (under
  the 20-minute JetStream `ack_wait`); deterministic misconfig (no name / bad
  spec / param violation) emits `system.bus.process{failed}` and RETURNS, while
  a runtime failure (non-zero exit / spawn error / timeout) emits `failed` and
  THROWS to leave the Decision re-fireable. The watchdog escalates **SIGTERM →
  SIGKILL** (after a grace) so a child that traps SIGTERM can't park the handler
  on `proc.exited` forever. Specs that run for minutes set **`detach: true`**:
  the handler spawns + emits `started` + RETURNS so the run does NOT block the
  single, serial reflex bridge pull loop (other activations — issue→Discord,
  PR→sage — keep flowing); a detached run reports `completed`/`failed` via
  visibility only (it cannot re-fire — fine for an idempotent scheduled job).
  Covered by `process-runner.test.ts`. First user: the weekly public build
  journal — `examples/processes/build-journal.yaml` (`detach: true`; operator
  copies it in), fired by reflex's `build-journal-weekly` schedule; the
  blueprint and the operator runbook (`docs/deploy-build-journal-weekly.md`)
  live in the **reflex** repo (reflex#30), not here.

- **Review consumers no longer fan out + double-post (cortex#1186).** Each
  per-agent review durable (local + federated-offer + federated-direct) is now
  provisioned with a `filterSubject` matching the subject pattern its consumer
  binds — previously omitted, so every durable had `filter_subject: ""` and
  claimed EVERY message on the CODE_REVIEW stream. An agent with >1 scope
  consumer therefore processed (and `--post`ed) the SAME review N times — a real
  PR (the-metafactory/arc#241) got 3 identical sage reviews. Filters are now
  disjoint by scope, so a `local.…` request reaches exactly the local durable —
  proven in `review-filter-disjoint.test.ts` (a `local.…` subject matches only
  the local pattern; `local.`/`federated.` never both match).
  `provisionReviewConsumer` also gains a **filter-drift migration**:
  `filter_subject` is immutable on a JetStream durable, so a drift (e.g. a
  pre-fix `""`-filter durable) is reconciled by **delete + recreate** on the next
  boot — no manual `nats consumer rm`. The recreated durable is forced to
  `DeliverPolicy.New` so the migration does NOT replay the backlog (no mass
  re-review/re-post); a message in-flight at migration is dropped (re-fireable —
  the safe direction). Provisioning runs at boot before the consumer pulls, so
  there is no concurrently-processing delivery to race. NOTE: the
  CODE_REVIEW stream subjects must include the `federated.…` patterns for the
  federated filters to bind (already in `reviewStreamSubjects` when federation is
  configured; a drifted live stream needs its subjects updated).

- **F-6 reflex bridge — review-consumer dispatch (`review: true`)**. A new
  fulfilment channel on `reflex_activation.targets[]`, alongside `prompt` (CC
  agent-session) and `handler` (code responder). With `review: true` +
  `capability: code-review.<flavor>`, the bridge no longer addresses an agent
  session on `tasks.@{did}.{capability}`; it emits a **`tasks.code-review.<flavor>`
  REVIEW REQUEST** (`{repo, pr, post:true, forge:"github"}`, adapted from the
  GitHub PR event in the activation payload) on `local.{p}.{s}.tasks.code-review.
  <flavor>` — the capability subject cortex's `engine: sage` ReviewConsumer binds
  (verified producer-side here; the consumer claim path is covered by the existing
  ReviewConsumer suite). This closes the gap where a review target's `@{did}`
  subject previously fell onto the claude-session dispatch-listener instead of the
  review consumer. Mirrors how the public-surface `translatePrOpenedToOffer`
  builds a `tasks.code-review.<flavor>` request from a PR event — but on the
  LOCAL bus and without that path's public-Offer admission / surface-predicate
  gating (this is a trusted internal reflex activation, not a public Offer).
  `skip_authors` runs first: a trusted author — identified by GitHub login
  (`pull_request.user.login` → `issue.user.login` → `sender.login`) — is
  skipped before any review publish. The gate fails OPEN by design: a payload
  with no extractable author is reviewed, not silently skipped (for reflex's
  GitHub-PR webhooks the login is always present). Schema enforces exactly one of
  prompt|handler|review and a flavored `code-review.*` capability for review
  targets. Pure helpers `reviewFlavorOf` / `extractReviewRequest` +
  `buildReflexReviewDispatch` are exported and unit-tested. Ordering: a trusted
  `skip_authors` author is skipped first (regardless of payload); otherwise a
  non-reviewable payload (no repo / non-positive PR number) is an honest
  `_failed` (re-firing won't fix), and a publish error stays re-fireable. Drives
  reflex `@jc/sage-pr-review` (the-metafactory/reflex#28).

- **F-6 reflex bridge — configurable author trust gate (`skip_authors`)**.
  `reflex_activation.targets[].skip_authors` (optional `string[]`) lets a
  target deterministically DROP a fired activation when its GitHub author is
  trusted, BEFORE any Claude session or code handler runs. The author login is
  read in code from the payload —
  `pull_request.user.login` → `issue.user.login` → `sender.login`,
  case-insensitive. Because it is a code comparison, not an LLM instruction, it
  cannot be subverted by prompt-injection CONTENT in the PR (the failure mode an
  LLM "please skip" prompt has). Scope of the guarantee: the gate is only as
  trustworthy as the author field it reads — that field's integrity rests on
  reflex's upstream HMAC verification of the GitHub delivery (reflex#24), NOT on
  anything in this PR. The bridge trusts the already-verified fired payload; it
  does not re-authenticate it. A spoofed author on an unverified delivery is an
  upstream concern, out of scope here. A trusted-author drop is an honest policy
  SKIP, not a failure: it emits the new `system.bus.reflex-activation-skipped`
  visibility event (reason `author_trusted`, with the matched `author`) and
  marks the Decision id so a redelivery re-skips silently. Empty/absent list =
  no gate (dispatch everyone). Drives reflex's `@jc/sage-pr-review` target
  (the-metafactory/reflex#28): review any PR whose author is NOT on the
  maintained `skip_authors` login list, skip the rest. It is a literal login
  list, not org-membership or external-contributor detection — "trusted" means
  exactly "a login you put in this list"; you keep it current in config, no
  code or blueprint change.
- **`migrate-config` now produces Stage-4/5-complete output** (cortex#428,
  PR-B of cortex#426 follow-up). The migrator's emitted `cortex.yaml`
  runs Stage 4-A end-to-end on v3.0.x without manual editing. Three
  syntheses land on every agent:
  - `agent.runtime.capabilities[]` — defaults to `["chat"]` (the
    canonical conversational capability per myelin#181). A persona
    heuristic optionally adds `code-review.typescript` when the persona
    body matches `/code[- ]review|reviewer|reviewing/i` ≥2 times — the
    occurrence floor separates actual reviewers from agents that
    deflect review work ("Code review — that's Echo's job, redirect").
  - `presence.<platform>.surfaceSubjects[]` — defaults to
    `local.{principal}.{stack}.dispatch.task.*` derived via
    `deriveStackId` so the surface-router matches the adapter for the
    canonical Stage-4 dispatch-sink subjects per
    `docs/design-platform-adapter-dispatch-publishing.md` §5.
  - Transient `agent.operatorId: <principal.id>` — back-compat for
    v3.0.0–v3.0.3 deployments that still read `agent.operatorId`
    directly (pre-cortex#427 behaviour). PR-C / cortex#429 drops this
    synthesis when the v3.0.x deployed window closes.

  The top-level `capabilities[]` catalog is automatically augmented
  with every synthesised capability id so the cortex#314
  cross-validator passes. Existing catalog entries are preserved
  verbatim; only the `provided_by` list is unioned. The `--check`
  report surfaces every synthesised field.

  Fixed a pre-existing bug while in the file:
  `buildAgentsFromCortexShape` did not carry the agent's `runtime`
  block through on the cortex.yaml-shape input branch — operators
  re-running migrate-config on a v3.0.x config would silently lose
  their runtime declarations.

## 3.0.0 — 2026-05-21 — Vocabulary migration BREAKING

Cortex v3.0.0 completes the metafactory vocabulary migration 2026-05
(cortex#388, manifest at `docs/migrations/0001-vocabulary-grilled-2026-05.md`).
The v2.x transition-release back-compat shims are removed. Wire-level
envelope changes were already in place on v2.x via Luna's myelin
PR-1..PR-13 (myelin#165..#176) — what changes at v3 is the
deployment-config + env-var + TS-type surface.

### BREAKING

- **`cortex.yaml` top-level key renamed `operator:` → `principal:`** — <!-- historical: legacy config key name -->
  per R3 of the vocabulary migration. Principals upgrading from v2.x MUST
  run `cortex migrate-config <your-config.yaml>` to rewrite their config
  before installing v3. The transition-release dual-block reader
  (`DualBlockConflictError`) that accepted both keys on v2.x is removed
  — a config carrying the legacy `operator:` key is treated as <!-- historical: legacy config key name -->
  bot.yaml-shape and falls through to the legacy reader, which steers
  the principal at `cortex migrate-config`.
- **`CORTEX_OPERATOR*` env-var fallback removed** — the v2.x compat shim
  that resolved `CORTEX_OPERATOR*` with a deprecation warning is gone.
  Operators running those vars rename them to `CORTEX_PRINCIPAL*` before
  installing v3. `GROVE_OPERATOR*` (the pre-cortex tier) is still
  accepted — its removal is owned by the separate `GROVE_*` → `CORTEX_*`
  namespace migration that retires at MIG-8.
- **`OperatorSchema` / `Operator` deprecated TypeScript aliases removed** <!-- historical: removed symbol names -->
  from `src/common/types/cortex-config.ts`. External importers update to
  `PrincipalConfigSchema` / `PrincipalConfig`.
- **`DeriveStackIdInput.operator?` renamed to `.principal?`** — <!-- historical: removed field name -->

  the input shape `deriveStackId(…)` consumes. Cortex's internal
  call-sites (`src/cortex.ts:325`) updated in lockstep. External
  importers (rare — this is a boot-time resolver) update to the new
  field name.

### Non-breaking (v3 cleanup)

- `arc-manifest.yaml` bumped `2.0.10` → `3.0.0`.
- Internal documentation in the affected files reframed from
  "transition release" to "v3.0.0 BREAKING — removed at manifest PR-11"
  so the migration provenance stays self-documenting.
- **Dashboard `operatorName` display now falls back to the resolved
  principal id instead of the agent `displayName`** when neither
  `agent.operatorName` nor a v3 `principal:` block declares a name.
  The pre-PR fallback chain inside `src/cortex.ts` was
  `operatorName ?? operatorId ?? displayName`; post-PR (cortex#427)
  it is `operatorName ?? principalId`. The `displayName` branch is
  unreachable in v3 because `resolvePrincipalId` throws when neither
  `principal.id` nor `operatorId` is set, so the boot path can never
  reach the dashboard wiring with both display fields missing. The
  surfaced label only changes for the synthetic edge case of a legacy
  bot.yaml that declared `displayName` but neither `operatorName` nor
  `operatorId` — a configuration that no longer boots in v3 regardless.
  Documenting here for migration completeness (cortex#430 review
  Major-1, sweep-pass 1).

### Migration path for v2.x operators

```bash
# 1. Convert your cortex.yaml from the legacy `operator:` shape to  <!-- historical: legacy config key name -->
#    `principal:`. The CLI is idempotent — running it twice produces
#    the same output.
cortex migrate-config ~/.config/cortex/cortex.yaml \
  --out ~/.config/cortex/cortex.yaml.new

# 2. Review the diff and swap the file in.
diff ~/.config/cortex/cortex.yaml ~/.config/cortex/cortex.yaml.new
mv ~/.config/cortex/cortex.yaml.new ~/.config/cortex/cortex.yaml

# 3. Rename env vars (in your shell rc, systemd unit, launchd plist,
#    etc.) — every `CORTEX_OPERATOR*` → `CORTEX_PRINCIPAL*`.
#    For example:
#      CORTEX_OPERATOR_ID=andreas    →    CORTEX_PRINCIPAL_ID=andreas

# 4. Upgrade.
arc upgrade cortex
```

### What is NOT changed

- The wire bytes — `signed_by[].identity`, `originator.identity`,
  `target_assistant`, `distribution_mode: "offer"`, `source` grammar
  `{principal}.{stack}.{assistant}` — were already shipped in v2.x via
  Luna's myelin PR-6..PR-13 + cortex#396..#398 consumer cascades. v3
  doesn't move bytes; it removes the back-compat shims around the
  already-renamed wire.
- The migrate-config CLI continues to READ legacy `operator:`-shaped <!-- historical: legacy config key name -->
  bot.yaml + cortex.yaml input (historical record per the manifest's
  completion-signal allow-list). It just emits `principal:`-shaped
  output now.
- JetStream-replayed envelopes from any retention window continue to
  verify and route through cortex unchanged — the wire-bytes
  dual-schema reader contract from myelin PR-6 #169 is unaffected.

### Cross-references

- Migration manifest: `docs/migrations/0001-vocabulary-grilled-2026-05.md`
- Vocab alignment plan: `~/.claude/PAI/MEMORY/WORK/vocab-alignment/PLAN-CONTINUATION.md`
- Companion releases: myelin v0.3.0 (post-PR-13), pilot v0.3.0 (post-PR-1)
- Tracking issue: cortex#388
