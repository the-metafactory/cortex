# Cortex — Changelog

## Unreleased

### Non-breaking

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
  SKIP, not a failure: it emits the new `system.bus.reflex_activation_skipped`
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
arc upgrade Cortex
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
