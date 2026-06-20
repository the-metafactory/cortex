# F-6 Reflex activation bridge — HANDOFF (resume here)

_Last updated: 2026-06-20. Branch: `spec/F-6-reflex-activation-bridge` (cortex)._

## North star

GitHub issue opened → Discord post (per-repo channel), **laptop-free**, with
**reflex kept pure** (decide-only). Realized as:

```
GitHub issue ──webhook(HMAC)──▶ reflex-edge (CF)
   └─ fires Activation Event: local.jc.default.reflex.activation.fired  (persisted in REFLEX JetStream stream)
        └─▶ [F-6] cortex ReflexActivationListener (Clawbox, always-on)
               └─ resolve target → capability → re-emit tasks.{capability}
                    └─▶ cortex existing executor → Discord-notify capability (per-repo webhook URL)
```

Pulse/cortex run **always-on on Clawbox** (not laptop) → laptop-free. (We
ruled out Pulse-on-CF: spawn runs nodes not the Pulse engine; big unbuilt epic.)

## DONE (shipped this session)

- **reflex#24 (merged, main 38f44cd):** `github_hmac` HTTP impulse source on reflex-edge — GitHub webhooks fire reflex directly (HMAC-verified, `where` filter, per-repo via `where:{repository}`, delivery-id in payload). Bearer path unchanged.
- **reflex#26 (merged, main b6d4ed4):** reflex-edge provisions the **REFLEX JetStream stream** on DO startup (`ensureReflexStream` in `consumer-do.ts`). Stream `REFLEX` (subjects `local.jc.default.reflex.>`, File storage) is the prerequisite for F-6's durable consumer. NOTE (HonestOracle): the prior-session claim that the stream is "live on the hub" and that a real fire was observed persisting is an **external prerequisite recorded from that session — NOT re-verified in this PR**. Confirm against the running hub before relying on it (e.g. `nats stream info REFLEX` with the `reflex-edge.creds`, see GOTCHAS).
- **cortex#1177:** the F-6 issue.
- **F-6 spec/plan/tasks:** authored (this dir). (Prior-session note said "validated"; no `specflow validate` output is captured in this PR — re-run `specflow validate F-6` to confirm phase state if you depend on it.)

## BUILT (2026-06-20) — bridge implemented, suite green

The F-6 bridge is implemented on this branch. Files:
- `src/bus/reflex-activation-listener.ts` — `ReflexActivationListener` + pure helpers (`resolveReflexTarget`, `parseFiredEnvelope`, `buildReflexDispatch`, `reflexActivationFilterSubject`, `inMemoryReflexDedup`).
- `src/bus/__tests__/reflex-activation-listener.test.ts` — 19 tests (parse/resolve/build/handleFired/lifecycle).
- `src/bus/system-events.ts` — `system.bus.reflex_activation_dispatched` + `_failed` visibility constructors.
- `src/bus/jetstream/provision.ts` — `provisionReviewConsumer` extended with additive `deliverPolicy?` (defaults All; bridge passes `New`).
- `src/common/types/cortex-config.ts` — `reflex_activation` block (`ReflexActivationConfigSchema`, `ReflexTargetSchema`).
- `src/common/config/loader.ts` — carries `reflexActivation` through `LoadedConfig`.
- `src/cortex.ts` — mounts the listener config-gated after `dispatchListener.start()`; drains it at shutdown.

**Resolved open questions:**
1. **Stream ownership:** REFLEX stream is owned by reflex-edge (`local.{p}.{s}.reflex.>`). Cortex does NOT provision an overlapping stream — it binds a durable consumer (filter `local.{p}.{s}.reflex.activation.fired`, exact subject; target is opaque, rides in payload — NOT a subject token, correcting the north-star diagram). **DeliverPolicy.New** so a fresh durable doesn't replay the limits-retained stream's history (in-memory dedup is empty on boot).
2. **Map location:** `reflex_activation.targets[]` in cortex.yaml (`{target, capability, assistant, prompt}`), plus an optional `stack` for the fired-subject source segment. **Same-principal only (v1):** no `principal` override — the bridge consumes + re-emits under the cortex principal; bridging another principal's `local.` subject would breach the principal boundary (that's a `federated.` path, out of scope).
3. **Dedup store:** injected `{seen,mark}` iface; `inMemoryReflexDedup()` default v1 (JetStream ack-floor + DeliverPolicy.New cover cross-restart; persistent D1/KV is a drop-in if needed).
4. **Re-emit shape:** focused producer (NOT chat publisher) — `buildBaseEnvelope` `type: tasks.{capability}`, subject via `directTaskSubject` + capability, `distribution_mode: direct`, `target_assistant: did:mf:{assistant}`, originator `{did:mf:reflex, delegated}`. Executor requires non-empty `prompt` (dispatch-listener parsePayload) → config `prompt` is the trusted task; the untrusted activation payload is appended inside a breakout-neutralised `<untrusted-content>` fence (`common/untrusted-fence`, CO-7 M1 pattern), never interpolated into the instruction text.

Verification (reproduce locally — not captured in this PR artifact): `bunx tsc --noEmit` and `bun test src/bus/__tests__/reflex-activation-listener.test.ts` (F-6 unit/integration suite). Full `bun test` was green at authoring time apart from one environment-dependent network-registry test (`leaf-state fetch ECONNREFUSED`) that passes on re-run; CI on this PR is the authoritative signal.

## (original) NEXT: build the F-6 bridge (the large remaining piece)

A new `ReflexActivationListener` in cortex. Concrete seams (already scouted):

1. **Subscribe (durable):** JetStream **durable pull consumer** on `local.jc.default.reflex.activation.fired` against the now-live `REFLEX` stream. Mirror `src/runner/dev-consumer-boot.ts` + `src/bus/jetstream/provision.ts` (the stream EXISTS now; just bind a durable consumer — ackPolicy explicit, deliverPolicy new). Survives Clawbox restart.
2. **New file:** `src/bus/reflex-activation-listener.ts`, sibling of `src/bus/bus-dispatch-listener.ts` (mirror its ctor opts / lifecycle / visibility-emit / stop discipline). NOTE bus-dispatch-listener uses ephemeral `onEnvelope`; we want the **durable** path (dev-consumer pattern) instead.
3. **Re-emit — DO NOT reuse `publishInboundChatDispatchEnvelope`** (`src/bus/dispatch-source-publisher.ts`): it is **chat-specific** (needs `msg: InboundMessage`, `prompt`, human-author originator resolution via PolicyEngine `(platform, authorId)`). A reflex activation has none of that. Build a **focused producer**: construct the `tasks.@{assistant}.{capability}` envelope directly via `directTaskSubject(principal, targetDid, stack)` (from `@the-metafactory/myelin/subjects`) + `runtime.publishOnSubject(envelope, subject)` (what the chat publisher calls internally at line ~282). Originator = the reflex daemon/system identity, not a human. Preserve classification + correlation_id + provenance (reflex Decision id + original target).
4. **Resolve target → capability:** config map (`@jc/notify-discord` → capability like `notify.discord`). DECISION OPEN: where the map lives (cortex.yaml extension vs dedicated config). See open questions.
5. **No re-gate:** reflex already applied policy + guards (auto/approval, cooldown, run-lock). A `fired` event = cleared-to-run. The bridge executes; it does not re-evaluate. (cortex publish-time PolicyEngine is the egress/sovereignty check, compatible — not re-approval.)
6. **Idempotency:** dedup on the reflex **Decision id** (stable across JetStream redelivery) + explicit ack. DECISION OPEN: dedup store (reuse an existing cortex idempotency surface vs dedicated KV/D1).
7. **Honor `classification`** from the fired envelope (sovereignty); preserve it on the re-emit. Local principal only v1 (drop foreign subjects).
8. **Failure:** unknown target / publish fail → typed failure (`dispatch.task.failed` shape) + visibility event + **ack** (no poison loop). Success → `system.bus.reflex_activation_dispatched` visibility (BusDispatchListener parity).
9. **Mount:** construct + start in `src/cortex.ts` boot (alongside other listeners), **config-gated** (no target map → not mounted → zero behavior change). Stop on shutdown.
10. **Tests:** mirror `bus-dispatch-listener` tests — resolve/dedup/failure units + integration (synthetic fired envelope → asserted `tasks.{capability}` re-emit; redelivery dedup; unknown-target failure). Full `bun test` + `tsc` clean.

Tasks T-1.1..T-4.1 in `tasks.md`. Execution order there.

## Open questions to resolve during build

1. **target→capability map location** — cortex.yaml extension (e.g. `reflex_targets: [{target, capability, assistant?}]`) vs dedicated config. Check how cortex.yaml is loaded.
2. **Dedup store** — reuse an existing cortex idempotency surface, or a small KV/D1 keyed on Decision id?
3. **Exact re-emit subject/type** — `directTaskSubject` `tasks.@{assistant}.{capability}` vs a `dispatch.task.dispatched` envelope. Align with how existing producers (e.g. `sage dispatch`) emit so the executor consumes it unchanged. Read `src/runner/dispatch-listener.ts` for the exact shape the executor expects (originator, target_assistant, capability, payload).

## DOWNSTREAM (after F-6 lands — separate work)

- **Discord-notify capability** (the `target`'s capability): posts to a **per-repo Discord webhook URL** from a config map (`repo → webhook_url`; URL embeds the channel → per-repo channel, no bot token). Registered like any cortex capability (`cortex.yaml` `provided_by`).
- **reflex `github-issue-opened` blueprint** (trivial KV add): `when.http.auth: {mode: github_hmac, secret_env: GITHUB_WEBHOOK_SECRET}`, `where: {github_event: issues, action: opened}`, `target: @jc/notify-discord`, `policy: auto`. One secret + one blueprint per event type (decided). Then `wrangler secret put GITHUB_WEBHOOK_SECRET` + add the GitHub webhook → `https://reflex-edge.jens-christian-66c.workers.dev/impulse/github-issue-opened`.

## Verification target for F-6

Synthetic `reflex.activation.fired` envelope on `local.jc.default.reflex.activation.fired` → cortex consumes (durable) → resolves target → re-emits `tasks.{capability}` the existing executor runs → visibility event. Restart-durable (ack floor), idempotent on redelivery, classification honored, typed failure on unknown target. End-to-end later: real GitHub issue → Discord, laptop offline.

## GOTCHAS (from this session)

- **specflow `specify`/`tasks` run headless (`claude -p`) and FAIL/rate-limit** → write `spec.md`/`plan.md`/`tasks.md` MANUALLY, then advance the phase directly: `sqlite3 .specflow/features.db "UPDATE features SET phase='plan' WHERE id='F-6';"` (values: specify→plan→tasks). `specflow edit --spec-path` does NOT advance phase; `--batch` needs enrich. `specflow validate F-6` to confirm.
- **Sage review (pilot-review-loop):** `SAGE_STACK=default sage dispatch the-metafactory/cortex#<PR> --org jc --post --wait 300`. `--org jc` (NOT metafactory). Verdict in `result_summary`; commented/0-blockers = effective pass. Pre-flight: `tail ~/.config/cortex/logs/cortex-meta-factory.log | grep 'review consumer ready'`.
- **Sage is sharp on doc/PR-text overclaims** (HonestOracle) — back every verification claim with embedded command+output; don't cite external issues without evidence; don't mark unrun gates "confirmed".
- **Sage self-authored PRs** surface as COMMENTED (can't APPROVE own); `reviewDecision` empty is fine; merge gate CLEAN is the signal.
- This branch's F-6 specflow docs (spec/plan/tasks/HANDOFF) are committed here — `git checkout spec/F-6-reflex-activation-bridge` in cortex to resume.
- CF account is at the **5-cron-trigger cap** (unrelated, but noted): reflex uses 0 crons now (DO-alarm scheduler, F-002).
- nsc creds: `~/.local/share/nats/nsc/keys/creds/metafactory/OP_JC/reflex-edge.creds` (scoped `local.jc.>`); SYS creds for `server report connections`.
