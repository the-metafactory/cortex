# Cortex Migration Plan — Deterministic Ground Truth

**Status:** Working document. Single source of truth for the grove-v2 → cortex migration only. Every PR in the migration cites a phase + checklist item from this doc. **For "what cortex IS" (architecture, M1–M7 stack, agent + renderer model, event architecture, M7 app principles, internal componentisation), see the static design doc `docs/design-cortex.md`.** This plan covers only the migration itself: why now, what moves where, in what order. When this doc and reality disagree, this doc wins (or is updated, never silently). When this doc and `design-cortex.md` disagree on architecture, `design-cortex.md` wins.
**Date opened:** 2026-05-09
**Driver:** Andreas
**Retires when:** MIG-8 closes (legacy grove + grove-v2 archived).

**Related docs (load-bearing):**
- **`docs/design-cortex.md`** — the static architecture spec. What cortex IS. Reference this for any "how is the system structured" question; only reference *this* doc for migration mechanics.
- `docs/design-collaboration-surface.md` — the layer-7 framing + flybridge-cockpit + event architecture diagram (Andreas, 2026-05-08, PRs #58 + #83).
- `docs/design-event-taxonomy.md` — G-1111 event vocabulary, including §3.5 `system.*` operational domain + §4.6 fail-safe subscription rule (Andreas, 2026-05-09, on `feat/g-1111-event-taxonomy`).
- `docs/iteration-collaboration-surface.md` — G-1100 ladder retro (2026-05-08, PR #79).
- `~/Developer/myelin/README.md` + `~/Developer/myelin/specs/namespace.md` + myelin#7 — the canonical M1–M7 stack model.
- `~/Developer/myelin/docs/design-agent-task-routing.md` (currently myelin PR #36) — the M7 task routing pattern cortex's dispatch will implement: three distribution modes (Broadcast / Direct / Delegate), explicit M7 stratification, event-driven lifecycle subjects + structured nak reasons.
- `~/Developer/signal/README.md` — sibling observability bundle.
- `~/Developer/compass/sops/new-repo-pattern.md` — the 7-step bootstrap procedure.
- This repo's stale `docs/v1-to-v2-cutover.md` — describes a *different* (intra-repo, branch-based) cutover; superseded by the present doc.

---

## 1. Why this migration now

### 1.1 Three operational symptoms — manifestations of the same root

Three concerns collide today, all downstream of the layering pressure described in §1.2. The cleanest resolution is a fresh repo:

1. **Naming confusion.** Three names for one concept — `grove` (legacy production, v0.29.0), `grove-v2` (active dev, v0.22.1, but lower version because it's a soft restart), and "Grove Bot" (the deployed binary) — make every operator instruction ambiguous. The 2026-05-09 outage burned 8.4 h partly because shard logs said `shard 0 reconnecting` for any of three Discord adapters in one process and operators couldn't tell which.
2. **Conflated layers.** Today's `src/bot/` is simultaneously the L7 surface adapter (Discord I/O), the L4 coordination runtime (myelin subscriber, message router), and the workflow runner (CC orchestration, worklog state). The seven-layer model says these are three independent concerns. Restructuring them in place inside grove-v2 inherits the brand confusion.
3. **G-1100 ladder is in the wrong home.** G-1100.A through G-1100.E shipped a real, tested NATS+myelin runtime — but the implementation lives at `src/bot/lib/myelin-{runtime,subscriber}.ts`, called from `grove-bot.ts`. Per the layered model the bus runtime is L4 coordination, structurally separate from L7 surface. The work is correct; the home is wrong.

Cortex is the new repo. It IS an **M7 application** — the conscious processing surface that consumes the M2–M6 bus stack and presents activity to humans. Cortex is one M7 app among several (alongside pilot, signal-collector, future apps); it does not own M1–M6, it consumes their contracts. The legacy `grove` repo retires; `grove-v2` retires; the production bot rebrands as `cortex` once cortex reaches feature parity. Nothing the operator currently does goes away — the same Discord channels, the same personas, the same pilot loop, the same dashboard, the same Mattermost paths all survive. The plumbing underneath is what changes, and it changes to match the M1–M7 stack that was always implicitly there.

### 1.2 Why now — the myelin architecture is already paying off

The G-1100 ladder retro (`docs/iteration-collaboration-surface.md`, 2026-05-08) is the empirical data point: in ~10 hours, single-operator session, the team shipped five sub-features (NATS connection primitive → vendored myelin schema + envelope validator → subject-pattern subscription → myelin subscriber compose → wire-into-bot startup) through 1–5 review rounds each, with 53 unit tests on `main` and zero post-merge bugs. That throughput came from the architecture itself, not from heroics:

- **Layer boundaries forced cleaner abstractions during review.** Round-1 of G-1100.D pushed back on the subscriber's API surface (single-error vs. all-errors return shape, undiscriminated reason union); the redesign that fell out is the right shape because the layer it lives in (L4 coordination) has clear consumers (L7 surface adapters) with clear needs.
- **The vendored envelope schema gave a free contract test.** G-1100.B used the real upstream `myelin/examples/` fixtures, including the deliberately-broken `invalid-missing-sovereignty.json`. Anyone touching the validator can't quietly drift from the spec.
- **Reconnect-aware subscription primitive (G-1100.C) pre-solved a class of outage** that today's `src/bot/`-coupled NATS code couldn't have addressed without dragging the whole bot's state with it. The 8.4 h Echo outage on 2026-05-09 was at a different layer (Discord gateway), but the pattern of "the layer's runtime owns its reconnect, surfaces just see Up/Down" is exactly what fix PR #82 ports to the Discord adapter.
- **The naming conventions hold across repos.** myelin's `local.{org}.{domain}.{entity}.{action}` grammar shows up identically in cortex's bus subscriber, in pilot's planned errand emission (P-220), in signal's trace subjects, in compass's gate-crossing events. No translation layer; one grammar everywhere.
- **G-1111 falls naturally out of the same model.** The event-taxonomy doc (drafted in parallel during this session) didn't have to invent a vocabulary structure — it inherited subject form, payload conventions, and sovereignty semantics from myelin without modification, and added a `system.*` operational domain that fits cleanly alongside `review.*`, `dispatch.*`, `attention.*`. The same envelope, more verbs.

Cortex is the move that lets every layer behave like this, not just the bus. Today the L7 surface and the L4 dispatch and the workflow runner all share one src tree; tomorrow each lives in its own folder with its own contract, and improvements to one don't drag the others. The operational benefit we're already seeing from NATS — clean contracts, fast iteration, fewer regressions — generalises one folder at a time as the migration phases land.

This is the affirmative case for cortex. The §1.1 symptoms are real, but the load-bearing reason is §1.2: the myelin architecture is working, and committing to it cleanly is how we get more of what's already working.

### 1.3 Non-goals of this migration

- **Not a re-architecture.** Every component that exists today has a target home in cortex. Few are rewritten; most are moved + renamed.
- **Not a behavior change.** Same Discord bot behavior, same Mission Control dashboard, same NATS+myelin wiring. Module structure changes; tests stay green.
- **Not a Mission Control v3 redesign.** mc-v3 is mid-flight (F-13..F-20.F shipped, F-21+ planned); it lifts to cortex unchanged.
- **Not a sibling-repo refactor.** Myelin, signal, pilot, blueprint, compass are not touched.
- **Not in-scope: grove-auth.** Lives separately; folded in only if we decide to (out of scope here — separate decision).

---

## 2. Current state inventory

### 2.1 grove-v2 (`the-metafactory/grove-v2`, v0.22.1) — the source of truth

**Inventory snapshot taken 2026-05-09.** Source-of-truth state is grove-v2 `main` plus this PR's own `design-cortex.md` companion plus PR #82 (Discord outage resilience, OPEN at snapshot). Files marked "post-#82" do not exist on grove-v2 main yet — MIG-3 explicitly blocks on PR #82 merging first. LOC counts are from `wc -l` at snapshot time; sizes >1500 are reported in thousands. Everything below is moving — some refactor, none get rewritten in this migration. The "Architectural role" column references roles defined in `design-cortex.md` §8 (M-layer / cortex-internal module).

| Path | Lines (`wc -l`) | Architectural role | Target in cortex | Notes |
|------|----------------|--------------------|------------------|-------|
| `src/bot/grove-bot.ts` | 545 | wiring (entrypoint) | `src/cortex.ts` (renamed) | Top-level binary; rewires to use `bus/`, `runner/`, `adapters/`, etc. instead of inline |
| `src/bot/commands/` | ~200 | CLI commands | `src/cli/cortex/commands/` | `cloud` subcommand etc. |
| `src/bot/hooks/` | ~150 | bot-side CC hooks | `src/runner/hooks/` | bot-internal, runner-scoped |
| `src/bot/lib/adapters/discord.ts` | 491 | surface adapter | `src/adapters/discord/index.ts` | The big one. Most of fix PR #82 lives here. |
| `src/bot/lib/adapters/mattermost.ts` | — | surface adapter | `src/adapters/mattermost/index.ts` | |
| `src/bot/lib/adapters/mock.ts` | — | adapter (test) | `src/adapters/mock.ts` | Mock platform adapter for tests |
| `src/bot/lib/adapters/types.ts` | — | adapter interface | `src/adapters/types.ts` (shared) | The common `PlatformAdapter` interface |
| `src/bot/lib/discord-client.ts` | 103 | surface adapter | `src/adapters/discord/client.ts` | Post-#82 grows to ~190 with the degraded-timer addition |
| `src/bot/lib/response-poster.ts` | 90 | surface adapter | `src/adapters/discord/response-poster.ts` | Post-#82 grows to ~120 with retry-with-backoff |
| `src/bot/lib/role-resolver.ts` | — | adapter helper | `src/adapters/discord/role-resolver.ts` | Discord-specific (Discord IDs, roles) |
| `src/bot/lib/security-preamble.ts` | — | runner concern | `src/runner/security-preamble.ts` | Injected into CC prompts |
| `src/bot/lib/context-fetcher.ts` | — | adapter helper | `src/adapters/discord/context-fetcher.ts` | Discord channel history |
| `src/bot/lib/attachment-handler.ts` | 373 | adapter helper | `src/adapters/discord/attachments.ts` | Post-#82: uses `fetchWithTimeout` |
| `src/bot/lib/cc-session.ts` | 341 | workflow runner | `src/runner/cc-session.ts` | Largest piece of runner |
| `src/bot/lib/session-manager.ts` | 76 | workflow runner | `src/runner/session-manager.ts` | Per-thread CC session persistence |
| `src/bot/lib/stream-parser.ts` | 129 | workflow runner | `src/runner/stream-parser.ts` | Parses CC stream-json output |
| `src/bot/lib/claude-invoker.ts` | 130 | workflow runner | `src/runner/claude-invoker.ts` | Builds CLI args; some dead code (per cutover doc §7) |
| `src/bot/lib/agent-team.ts` | 328 | workflow runner | `src/runner/agent-team.ts` | Multi-agent moderator pattern |
| `src/bot/lib/task-tracker.ts` | — | workflow runner | `src/runner/task-tracker.ts` | In-flight async task tracking |
| `src/bot/lib/execution-backend.ts` | — | workflow runner | `src/runner/execution-backend.ts` | Local/remote backend abstraction |
| `src/bot/lib/worklog-manager.ts` | 238 | workflow runner | `src/runner/worklog-manager.ts` | Discord worklog threads |
| `src/bot/lib/message-router.ts` | 729 | bus / dispatch handler | `src/bus/dispatch-handler.ts` | The dispatch handler that takes inbound and routes to runner |
| `src/bot/lib/myelin-runtime.ts` | 146 | bus (M2-M6 client) | `src/bus/myelin/runtime.ts` | G-1100.E target — moved out of bot |
| `src/bot/lib/myelin-subscriber.ts` | 182 | bus (M2-M6 client) | `src/bus/myelin/subscriber.ts` | G-1100.D |
| `src/bot/lib/myelin/envelope.schema.json` + `__fixtures__/` + `__tests__/` | — | M3 envelope (vendored) | `src/bus/myelin/vendor/` | Vendored upstream schema + test fixtures, pinned at upstream commit `96b14ea`. **Schema-and-fixtures only; the validator is a separate row below.** |
| `src/bot/lib/myelin/envelope-validator.ts` | — | bus (M3) | `src/bus/myelin/envelope-validator.ts` | Cortex-side Ajv2020 wrapper that consumes `vendor/envelope.schema.json` (G-1100.B). Lives at `bus/myelin/`, NOT under `vendor/`. |
| `src/bot/lib/nats-connection.ts` | 153 | M2 transport | `src/bus/nats/connection.ts` | G-1100.A |
| `src/bot/lib/nats-subscription.ts` | 286 | M2 transport | `src/bus/nats/subscription.ts` | G-1100.C |
| `src/bot/lib/cloud-publisher.ts` | 255 | tap | `src/taps/cc-events/cloud-publisher.ts` | Publishes events to cloud Worker projection |
| `src/bot/lib/event-formatter.ts` | — | adapter helper | `src/adapters/discord/event-formatter.ts` | Formats events for Discord render |
| `src/hooks/lib/event-taxonomy.ts` | 74 | tap (in-process taxonomy) | `src/taps/cc-events/event-taxonomy.ts` | **Lives at `src/hooks/lib/`, not `src/bot/lib/` — corrected from earlier draft.** Maps CC hook payloads → internal event-type strings (per G-1111 §7.4). Moves as part of `src/hooks/` mass-move in MIG-5. |
| `src/bot/lib/network-resolver.ts` | — | infra | `src/bus/network-resolver.ts` | G-501 multi-network resolver |
| `src/bot/lib/dashboard-api.ts` | — | surface backend | `src/surface/mc/api/index.ts` | Hono REST API for dashboard |
| `src/bot/lib/dashboard-state.ts` | — | surface state | `src/surface/mc/state.ts` | |
| `src/bot/lib/dashboard-db.ts` | 880 | surface persistence | `src/surface/mc/db.ts` | SQLite. **Sizable file** — budget review accordingly. |
| `src/bot/lib/config-loader.ts` | — | infra | `src/common/config/loader.ts` | bot.yaml loader |
| `src/bot/lib/config-watcher.ts` | — | infra | `src/common/config/watcher.ts` | Hot-reload safe fields |
| `src/bot/lib/usage-monitor.ts` | 190 | infra | `src/common/usage/monitor.ts` | Token/quota monitor |
| `src/bot/lib/learning-store.ts` | — | runner concern | `src/runner/learning-store.ts` | |
| `src/bot/lib/channel-context.ts` | — | adapter helper | `src/adapters/discord/channel-context.ts` | Discord channel→repo mapping (per CLAUDE.md routing SOP) |
| `src/bot/lib/db-utils.ts` | — | infra | `src/common/db-utils.ts` | DB helpers shared across surface + dispatch state |
| `src/bot/lib/event-utils.ts` | — | runner / surface helper | `src/common/event-utils.ts` | Event-formatting helpers used across runner + surface |
| `src/bot/lib/github-sync.ts` | — | tap (GitHub) | `src/taps/gh-webhook/sync.ts` | GitHub state sync after webhook delivery |
| `src/bot/lib/github-webhook.ts` | — | tap (GitHub) | `src/taps/gh-webhook/handler.ts` | In-bot GitHub webhook handler (distinct from src/webhook-proxy CF Worker) |
| `src/bot/lib/mattermost-context.ts` | — | adapter helper | `src/adapters/mattermost/context.ts` | Mattermost channel context fetch |
| `src/bot/lib/mattermost-poller.ts` | — | adapter (Mattermost) | `src/adapters/mattermost/poller.ts` | Mattermost poll-driven inbound (no gateway) |
| `src/bot/lib/mattermost-server.ts` | — | adapter (Mattermost) | `src/adapters/mattermost/server.ts` | Mattermost server-side response posting |
| `src/bot/lib/message-parser.ts` | — | runner / dispatch | `src/runner/message-parser.ts` | Inbound message parsing (mode keywords, attachments, mentions) |
| `src/bot/lib/prompt-builder.ts` | — | runner | `src/runner/prompt-builder.ts` | Builds CC prompts from inbound + persona + context |
| `src/bot/lib/prompt-filter.ts` | — | runner | `src/runner/prompt-filter.ts` | Content-policy filter pre-CC-spawn |
| `src/bot/lib/worklog-formatter.ts` | — | runner | `src/runner/worklog-formatter.ts` | Formats lifecycle events for worklog thread |
| `src/bot/lib/attachment-types.ts` | — | adapter helper | `src/adapters/discord/attachment-types.ts` | Type definitions used by attachment-handler |
| `src/bot/lib/retry.ts` | ~100 | adapter helper (post-#82) | `src/adapters/discord/retry.ts` | **New in PR #82 (OPEN at snapshot).** Does not exist on grove-v2 main yet — MIG-3 blocks on #82 merge. |
| `src/bot/lib/timeout.ts` | ~110 | infra (post-#82) | `src/common/timeout.ts` | **New in PR #82 (OPEN at snapshot).** Used by multiple components after merge. |
| `src/bot/lib/__tests__/` | — | tests | tests stay alongside the file moved | |
| `src/bot/types/config.ts` | 510 | infra | `src/common/types/config.ts` | The big shared config schema |
| `src/cli/discord.ts` | 266 | operator CLI | `src/cli/discord/index.ts` | The `~/bin/discord` binary |
| `src/cli/lib/` | — | CLI helpers | `src/cli/discord/lib/` | |
| `src/cli/skill/` | — | skill packaging | `src/cli/discord/skill/` | The Discord agent skill. Preserves the `skill/` subpath under `cli/discord/`. |
| `src/cli/cldyo-live` *(single bash script, not a directory)* | — | operator CLI | `src/cli/cldyo-live` (preserve as single file) | The CC instrumentation wrapper. **Bash script, not TypeScript.** Optional follow-on: rewrite as `src/cli/cldyo-live/index.ts` post-MIG-7. |
| `src/dashboard/` (entire tree, 28 files) | ~5,300 | surface (legacy mc-v2) | **RETIRE** at cutover; replaced by `src/surface/mc/` | This is mc-v2; mc-v3 is `src/mission-control/` and is canonical. |
| `src/mission-control/` (entire tree, 149 files) | ~22,500 | surface (canonical mc-v3) | `src/surface/mc/` | The mc-v3 work (F-13..F-20.F). **Large** — single biggest move; budget MIG-2 accordingly. |
| `src/relay/` (entire tree) | ~1,400 | tap (CC hooks) | `src/taps/cc-events/` | CC hook events → NATS publisher |
| `src/hooks/` (entire tree) | ~745 | tap (CC hook scripts) | `src/taps/cc-events/hooks/` | The actual hook scripts (`EventLogger.hook.ts`, `GroveContext.hook.ts`, etc.). Includes `src/hooks/lib/event-taxonomy.ts` per row above. |
| `src/webhook-proxy/` | ~475 | tap (GitHub) | `src/taps/gh-webhook/` | CF Worker; HMAC-validated GitHub webhook → forward |
| `src/shared/format-utils.ts` | — | infra | `src/common/format-utils.ts` | The single file in `src/shared/`. |
| `src/common/` (5 files: agent-detection, event-processor, event-utils, github-events, types) | — | shared types | `src/common/` | Stays at top level. |
| `src/services/com.grove.bot.plist` + `com.grove.relay.plist` | — | deployment templates | `src/services/com.cortex.bot.plist` (renamed) + `com.cortex.relay.plist` | macOS launchd plist templates rendered into `~/Library/LaunchAgents/` by `arc upgrade Cortex`. Renamed at MIG-7.8 to match the new `com.cortex.*` identifiers; relay template kept for now (relay still in cortex's tap layer per MIG-5). |
| `src/settings/grove-hooks.json` | — | deployment template | `src/settings/cortex-hooks.json` (renamed) | Claude Code hooks-config template installed by `arc upgrade Cortex` into `~/.claude/`. The `grove-` prefix renames to `cortex-` at MIG-7. |
| `src/worker/` (CF Worker REST API) | ~2,300 | surface backend | `src/surface/mc/worker/` | The Cloudflare Worker for `grove.meta-factory.ai` |
| `arc-manifest.yaml` | — | infra | rewrite as cortex's | `name: Cortex, version: 0.1.0` |
| `blueprint.yaml` | — | infra | new file in cortex with C-1xxx IDs | grove-v2's blueprint stays in grove-v2 (archived) |
| `agents-md.yaml` | — | infra | rewrite for cortex | |
| `docs/design-*.md` | — | designs | move all to cortex `docs/` | Stale ones get archived |
| `docs/iteration-*.md` | — | iterations | move to cortex `docs/` | |
| `tests/` (top-level) | — | integration | `tests/` | |
| `package.json` | — | infra | rewrite for cortex | |
| `tsconfig.json` | — | infra | mostly copy | |
| `bun.lock` | — | lockfile | regenerate | |
| `THIRD-PARTY-NOTICES.md` | — | attribution | preserve in cortex | |
| `LICENSE` | — | license | preserve | |

### 2.2 Legacy `the-metafactory/grove` v0.29.0 — what we're abandoning

The deployed production bot. **Status (verified 2026-05-09):** *not abandoned, in maintenance mode for security work.* Last commit `fc4bd63` (2026-05-07, "chore: bump to v0.29.0"). The 10 prior commits (within the last week) are JC's security / AAA infrastructure on the legacy parallel NATS path — T-9 unified trust model (#329), T-10 per-bot AAA Phase 1 (#330), T-11 mandatory AAA Phase 2-3 (#331), bot-level identity design (#325), NATS credentials wiring (#326, #327), Myelin envelope verification into NATS subscribers (#328). Compare: grove-v2 has 350 commits in the same 6-week window — orders-of-magnitude more product work.

**Operational implication for the migration:** legacy grove is **frozen for product features** but **actively receiving security commits**. Any commit landing on legacy grove between today and the cortex MIG-7 cutover needs explicit triage:

- If it targets the parallel-NATS work (per §2.2.2 below) — it's landing on code being abandoned. The forward-port path is myelin (canonical home for identity/AAA per the layered model — myelin#7, myelin#8 / MY-400, myelin#36) rather than port-sideways into grove-v2.
- If it's a tactical bugfix — port-sideways into grove-v2 if relevant before cortex MIG-7.
- Recommended (defer to JC + Andreas): freeze legacy grove at v0.29.0 once cortex MIG-7 cutover begins, file any pending JC security work as cortex follow-on issues.

**Migration policy**: nothing from legacy grove is imported into cortex; cortex inherits from grove-v2 only. **Any feature legacy-grove has and grove-v2 doesn't is a regression** unless we explicitly accept it. The deep-dive of 2026-05-09 surfaced that the gap is materially larger than this section's first draft acknowledged — **legacy grove has ~5,597 LOC of agent / persona / AAA infrastructure, and ~849 LOC of parallel NATS / review-events work, neither of which exists in grove-v2.** Cortex starts narrower than the deployed legacy bot.

#### 2.2.1 Agent + persona + AAA infrastructure (legacy-only, ~5,597 LOC)

Legacy grove built a substantial agent-management subsystem that grove-v2 does not have. Cortex inheriting from grove-v2 means cortex starts without these capabilities. Each is a regression to acknowledge or re-implement:

| Legacy file | LOC | What it does | v1 cortex decision |
|-------------|-----|--------------|--------------------|
| `src/bot/lib/agent-installer.ts` | 1302 | Installs agent packages (persona files, configs, hooks) — the agent-side of `arc upgrade <agent>` | **Accept regression — but framed honestly:** grove-v2 already has no agent-installer, so cortex inheriting "no agent-installer" matches grove-v2's current state. The regression is *vs. legacy grove*, not *vs. grove-v2*. Operators manage persona files manually (copy to `personas/` directory, reference from `agents[].persona`), identical to grove-v2 today. Re-port if/when multi-agent self-install becomes a real operational need. |
| `src/bot/lib/agent-uninstaller.ts` | 426 | Inverse of installer | Accept regression; deferred. |
| `src/bot/lib/agent-manifest.ts` | 515 | Per-agent manifest schema + validation | Accept regression; the §9 (design-cortex.md) `agents[]` config + arc-manifest cover the v1 needs. |
| `src/bot/lib/agent-export.ts` | 204 | Export agent state for backup/migration | Accept regression; out of scope for v1. |
| `src/bot/lib/agent-instance-persona.ts` | 174 | Per-instance persona overrides | Accept regression; design-cortex.md §9.3 explicitly forbids per-presence persona overrides. |
| `src/bot/lib/agent-naming.ts` | 69 | Agent naming conventions | Accept regression; cortex uses logical agent IDs. |
| `src/bot/lib/agent-persona-resolver.ts` | 275 | Resolves persona from chain (instance → agent → default) | Accept regression; cortex agents own their persona directly per design-cortex.md §9.1. |
| `src/bot/lib/agent-registry-resolver.ts` | 197 | Resolves agent registry references | Accept regression; cortex's static `agents[]` registry covers v1. |
| `src/bot/lib/agent-state-scaffold.ts` | 247 | Scaffolds per-agent state directories | Accept regression for v1; per-agent state lives in the runner's session-manager. |
| `src/bot/lib/persona-install.ts` | 99 | Installs persona files | Accept regression; persona files copied via arc-manifest provides. |
| `src/bot/lib/persona-loader.ts` | 64 | Loads persona at runtime | Accept regression; cortex's agent registry loads persona once at startup. |
| `src/bot/lib/persona-merge.ts` | 160 | Merges persona overlays | Accept regression; v1 cortex personas are flat per agent, no overlay system. |
| `src/bot/lib/identity-verification.ts` | 185 | Cross-bot identity verification | **Partial coverage in cortex.** §9.3 trust resolver provides the runtime `(platformId → agentId)` map; full cryptographic verification is M4-IDENTITY territory (myelin#8 / MY-400) and lands when myelin#36's signed-publish work lands in cortex. |
| `src/bot/lib/trusted-bot-audit.ts` | 155 | Audit log for trusted-bot mention acceptance | **Partial coverage.** Today's `trusted-agent mention accepted from bot=...` log line in grove-v2's discord-client.ts covers the operational essential; full audit subsystem deferred. |
| `src/bot/lib/message-rate-limiter.ts` | 118 | Per-author rate limiting | **Accept regression for v1.** Single-operator deployments don't need it; flag for re-implementation when multi-operator lands. |
| `src/bot/lib/distill-instruction.ts` | 109 | Distills operator instruction into actionable form | Accept regression; cortex's prompt-builder handles this. |
| `src/bot/lib/workflow-log.ts` | 202 | Per-workflow audit log | Accept regression; cortex's worklog-manager + dispatch event stream cover the operational equivalent. |
| `src/bot/lib/redact-stderr.ts` | 36 | Redacts secrets from stderr before forwarding | **Accept regression with TODO.** Worth re-porting before cortex handles secrets at scale. |
| `src/bot/lib/atomic-write.ts` | 118 | Atomic file write helper | Accept regression; replace with grove-v2 equivalents or library. |
| `src/bot/lib/result-decision.ts` | 67 | Result-evaluation decision logic | Accept regression; cortex's runner makes per-task decisions inline. |
| `src/bot/lib/inbound-queue.ts` | 346 | Per grove#231 — queue rows for replay across crashes | **Accept regression for v1** with caveat — cortex relies on JetStream durability per design §3.3 ("lost event ≠ lost state"). **Falsifiable re-evaluation trigger**: if any post-MIG-7 incident's RCA cites lost events crossing a cortex restart boundary, file a follow-on issue to port `inbound-queue.ts` from legacy. **Cross-cutting concern**: JetStream stream config ownership (subjects, retention, max-msgs) is open question §6.11 — without retention long enough, the replay story breaks before insufficient-replay can even be detected. |
| `src/bot/lib/usage-fetcher.ts` | 196 | Anthropic usage API fetcher | **Accept regression for v1.** Cortex's `usage-monitor` covers cache-file polling; the API fallback path can be re-ported when needed. |

**Total legacy-only agent + persona + AAA infra: ~5,597 LOC**, none of which migrates. Cortex's v1 surface is narrower than legacy grove's; the mc-v3 dashboard + the bus-driven event model compensate via different mechanisms (e.g., the visibility three-tier model in design-cortex.md §3.6 obviates much of what `workflow-log.ts` did via Discord-side lifecycle threads).

#### 2.2.2 Parallel NATS / review-events work (legacy-only, ~849 LOC)

Independently of grove-v2's G-1100 ladder, legacy grove went down its own NATS+review-events path. **None of this code migrates** — it's superseded by grove-v2's G-1100 (vendored myelin schema + nats-connection + nats-subscription + myelin-runtime + myelin-subscriber) which is what cortex inherits.

| Legacy file | LOC | What it did (legacy) | v1 cortex equivalent |
|-------------|-----|----------------------|----------------------|
| `src/bot/lib/nats-outbound.ts` | 129 | NATS outbound publish helper | grove-v2's `myelin-runtime.ts` + `nats-connection.ts` (G-1100.A + G-1100.E) |
| `src/bot/lib/nats-review-inbound.ts` | 202 | NATS inbound for review events | Will be cortex's `dispatch-handler.ts` subscribing to `local.{org}.review.*` per design-cortex.md §6.1 inbound contract |
| `src/common/transport/cloud-events.ts` | 39 | CloudEvents envelope helpers | grove-v2's vendored myelin envelope schema (G-1100.B) |
| `src/common/transport/review-events.ts` | 73 | Review-event payload schemas | Will live in cortex's `docs/api/` envelope contract docs (per design-cortex.md §6.1; see open question 10) |
| `src/common/transport/sovereignty-defaults.ts` | 9 | Sovereignty defaults helper | grove-v2's myelin envelope schema enforces sovereignty fields directly |
| `src/hooks/lib/nats-publisher.ts` | 146 | CC hook → NATS publisher | Will be cortex's `taps/cc-events/` per MIG-5 |
| `src/hooks/lib/review-parser.ts` | 34 | Parses review events from CC output | Replaced by cortex's structured-event approach (envelope publish from runner) |
| `src/hooks/ReviewPublisher.hook.ts` | 81 | Hook script for review-event publishing | Replaced by cortex's runner emitting `review.*` envelopes |
| `src/relay/lib/nats-relay.ts` | 136 | Relay-side NATS forwarder | grove-v2's `cloud-publisher.ts` + relay-via-NATS path; cortex's `taps/cc-events/cloud-publisher.ts` |

**Total legacy-only NATS/review-events: ~849 LOC**, none of which migrates. The architectural choice is clear — grove-v2's G-1100 ladder is the inheritance path because it's vendored against the canonical myelin schema + cleanly separated into M2/M3 primitives. Legacy grove's NATS work is a parallel evolution that doesn't fit the M1–M7 stratification.

#### 2.2.3 Other legacy-only

| Legacy item | LOC / scope | v1 cortex decision |
|-------------|-------------|--------------------|
| `bots.d/` Apache-style per-bot config overlays (PR #333) | config schema | Accept regression for v1; single-instance config matches grove-v2 shape. |
| T-10 AAA Phase 1 — per-bot AAA (PR #330) | wraps several agent-* / identity files above | Accept regression for v1; multi-operator authz lands when needed. |
| `src/bot/lib/adapters/discord-attachments.ts` | adapter helper | grove-v2 covers via `attachment-handler.ts`; superseded. |
| `src/bot/lib/command-dispatch.ts` | command routing | grove-v2 covers via `message-router.ts`; superseded. |
| `src/cli/grove.ts` | operator CLI | The `grove` CLI is renamed `cortex` per MIG-7.7; legacy command set re-implemented as needed. |
| `src/cli/nats-review.ts` | review CLI | Re-implement via cortex's bus-driven review surface (post-MIG-7). |
| `src/spikes/keygen.ts`, `nats-identity-test.ts` | spikes | Don't migrate. |
| `src/bot/hooks/skill-guard.hook.ts` | hook script | Re-port if needed; not v1-critical. |
| `src/statusline/` | empty in both repos | n/a |
| `infra/nats-hub/` | NATS hub deployment infra | **Out of scope for cortex repo.** NATS hub deployment is operator infrastructure, lives wherever operator ops lives. |
| `migration-aaa-phase1.md` / `migration-aaa-phase23.md` docs | Markdown | Archive for reference; not migrated. |

#### 2.2.4 Honest summary

Cortex v1 is **narrower than legacy grove** by ~6,500 LOC of agent-management, persona-resolution, AAA, and bespoke NATS/review-events infrastructure. This is a deliberate trade-off: grove-v2's cleaner separation + the M1–M7 stack + the design-cortex.md model of agent bundles gives cortex a more architectural foundation, even though it lacks some of legacy grove's specific operational features.

Re-implementations to track explicitly:
1. **Cross-bot identity verification** (legacy `identity-verification.ts`, 185 LOC) — partial coverage via §9.3 trust resolver; full cryptographic verification arrives via myelin#8 / MY-400.
2. **Per-author rate limiting** (legacy `message-rate-limiter.ts`, 118 LOC) — needed before multi-operator.
3. **Stderr secret redaction** (legacy `redact-stderr.ts`, 36 LOC) — worth re-porting before cortex handles secrets at scale.

Filed as cortex follow-on issues post-MIG-7 (TBD during MIG-0 issue setup).

### 2.3 Sibling repos — context only

Not migrating. They inform cortex's contracts (per `design-cortex.md` §3 + §5):

| Repo | Role | Cortex's contract |
|------|------|-------------------|
| `the-metafactory/myelin` | Owns M2–M6 of the stack | Cortex's bus/myelin/vendor/ pins to a myelin commit; updates happen via vendor bumps in cortex |
| `the-metafactory/signal` | M7 telemetry tap (sibling) | Cortex eventually subscribes to `mf.net-*.trace.>` (drill-down feature) |
| `the-metafactory/pilot` | M7 review-loop coordinator (sibling) | Cortex projects pilot's errand state via myelin envelopes |
| `the-metafactory/blueprint` | Knowledge artefact (graph) | Cortex registers in blueprint.yaml; reads `blueprint ready` for surface card sources |
| `the-metafactory/compass` | Knowledge artefact (SOPs / governance) | Cortex's CLAUDE.md generated via `arc upgrade compass`; cortex follows compass SOPs |
| `the-metafactory/grove-auth` | Auth/identity | Out of scope here. Possible future fold-in. |

---

## 3. Migration matrix — single source of file movements

This is the master table. Phase numbers reference §4 below. Every file in §2.1 must appear here; if it doesn't, it doesn't move (and that's a decision, recorded).

(See §2.1 for the full per-file table. The matrix below summarizes by component group — finer granularity lives in §2.1 + the per-phase issue task lists.)

**Files in §2.1 that don't appear in this matrix because they don't move as standalone entries:**

- `src/bot/lib/__tests__/` — moves alongside the file under test, per §5.4 test discipline.
- `tests/` (top-level) — moves to `cortex/tests/` as a single directory at MIG-7 alongside the wiring (no separate phase keying needed).
- `src/cli/skill/` — preserves the `skill/` subpath under `src/cli/discord/skill/` per §2.1 row; rolled up into MIG-6.1.

If a §2.1 row is missing from this matrix, it's a bug — file an issue.

| Source group (in grove-v2) | Cortex destination | Phase | Action |
|-----------------------------|---------------------|-------|--------|
| `src/bot/lib/nats-*.ts` + `myelin-*.ts` + `myelin/` (vendored) | `src/bus/nats/`, `src/bus/myelin/` | MIG-1 | Move + rewire imports |
| `src/bot/lib/message-router.ts` | `src/bus/dispatch-handler.ts` | MIG-1 | Move + rename internal class; surface-router (G-1111.A) lands as new code in MIG-1. **No `inbound-queue.ts` to move** — that file is legacy-grove-only (per §2.2.1); cortex relies on JetStream durability instead. |
| `src/mission-control/` (entire tree) | `src/surface/mc/` | MIG-2 | Move; mc-v2 (`src/dashboard/`) retires |
| `src/worker/` | `src/surface/mc/worker/` | MIG-2 | Move |
| `src/dashboard/` (legacy mc-v2) | **retire** | MIG-2 | Delete; mc-v3 already supersedes per the existing v1-to-v2-cutover doc |
| `src/bot/lib/dashboard-api.ts` + related | `src/surface/mc/api/` | MIG-2 | Move |
| `src/bot/lib/adapters/discord.ts` + `discord-client.ts` + `response-poster.ts` + `retry.ts` + `role-resolver.ts` + `context-fetcher.ts` + `attachment-handler.ts` + `event-formatter.ts` | `src/adapters/discord/` | MIG-3 | Move; PR #82 lands here pre-move and follows |
| `src/bot/lib/adapters/mattermost.ts` | `src/adapters/mattermost/` | MIG-3 | Move |
| `src/bot/lib/adapters/types.ts` | `src/adapters/types.ts` | MIG-3 | Move (shared interface) |
| `src/bot/lib/cc-session.ts` + `session-manager.ts` + `stream-parser.ts` + `claude-invoker.ts` + `agent-team.ts` + `task-tracker.ts` + `execution-backend.ts` + `worklog-manager.ts` + `learning-store.ts` + `security-preamble.ts` | `src/runner/` | MIG-4 | Move |
| `src/hooks/lib/event-taxonomy.ts` | `src/taps/cc-events/event-taxonomy.ts` | MIG-5 | Move alongside the rest of `src/hooks/`. **Path correction** — file lives at `src/hooks/lib/`, not `src/bot/lib/`, so it's a tap concern (the hook is the tap), not runner. |
| `src/bot/hooks/` | `src/runner/hooks/` | MIG-4 | Move |
| `src/bot/commands/` | `src/cli/cortex/commands/` | MIG-4 | Move |
| `src/relay/` + `src/hooks/` | `src/taps/cc-events/` + `src/taps/cc-events/hooks/` | MIG-5 | Move |
| `src/bot/lib/cloud-publisher.ts` | `src/taps/cc-events/cloud-publisher.ts` | MIG-5 | Move |
| `src/webhook-proxy/` | `src/taps/gh-webhook/` | MIG-5 | Move |
| `src/cli/discord.ts` + `src/cli/lib/` + `src/cli/skill/` | `src/cli/discord/` | MIG-6 | Move |
| `src/cli/cldyo-live` (single bash script) | `src/cli/cldyo-live` (single bash script — no trailing slash) | MIG-6 | Move file; preserve as a single executable script, do NOT create a directory. |
| `src/bot/grove-bot.ts` | `src/cortex.ts` | MIG-7 | Rewrite imports + rename |
| `src/bot/types/config.ts` + `src/bot/lib/config-{loader,watcher}.ts` + `src/common/` (5 files) + `src/shared/format-utils.ts` + `src/bot/lib/usage-monitor.ts` + `src/bot/lib/timeout.ts` (post-#82) + `src/bot/lib/network-resolver.ts` | `src/common/` | MIG-7 | Move + minor reorg. **No `usage-fetcher.ts`** — legacy-grove-only per §2.2. |
| `src/services/*.plist` + `src/settings/grove-hooks.json` | `src/services/com.cortex.*.plist` + `src/settings/cortex-hooks.json` | MIG-7 | Rename templates at cutover (grove-prefix → cortex-prefix); content unchanged except for binary path inside the plist. Rendered by `arc upgrade Cortex` into `~/Library/LaunchAgents/` and `~/.claude/`. |
| `arc-manifest.yaml` | rewrite as cortex's | MIG-7 | Replaces `name: Grove` with `name: Cortex` |
| `package.json` + `bun.lock` + `tsconfig.json` | rewrite | MIG-7 | New cortex shell |
| `docs/design-*.md` + `docs/iteration-*.md` | `docs/` | MIG-7 | Move; archive stale ones |
| `blueprint.yaml` | new file with C-1xxx IDs | MIG-7 | Old grove-v2 blueprint archived |
| `agents-md.yaml` + `CLAUDE.md` | regenerate via `arc upgrade compass` | MIG-7 | |
| (no `src/spikes/` to retire) | — | — | Removed: legacy grove has `src/spikes/{keygen.ts, nats-identity-test.ts}` but grove-v2 doesn't. Decision moot for cortex inheritance. |

---

## 4. Phase-by-phase plan

Each phase = one umbrella issue with a task-list checklist + one or more PRs. Pilot loop (Echo for code review) drives each PR. Phases run sequentially unless explicitly marked parallel-safe.

### MIG-0 — Cortex repo bootstrap

**Goal:** A minimal cortex repo that passes compass validators.

**Issue:** `cortex#1 — Bootstrap cortex repo (compass-core 7-step pattern)`

**Steps (deterministic checklist):**

- [ ] **0.1** `gh repo create the-metafactory/cortex --private --clone` (private at first; toggle public when content stabilises). Operator action — agent surfaces but does not execute.
- [ ] **0.2** Clone locally to `~/Developer/cortex/`.
- [ ] **0.3** Apply compass-core label set: `bun ~/Developer/compass/standards/scripts/sync-labels.ts --owner the-metafactory --repo cortex`.
- [ ] **0.4** `cp ~/Developer/compass/templates/CLAUDE.md.template CLAUDE.md`. Fill placeholders for the cortex-specific architecture summary (one-paragraph version of `design-cortex.md` §1).
- [ ] **0.5** `cp ~/Developer/compass/templates/arc-manifest.template.yaml arc-manifest.yaml`. Fill: `name: Cortex`, `version: 0.1.0`, `description: "Layer-7 collaboration surface for the metafactory ecosystem"`, author Andreas. `provides:` empty for now (binaries land in MIG-7).
- [ ] **0.6** Run compass validators: `bun ~/Developer/compass/engine/ci/run-all.ts --owner the-metafactory --repo cortex`. Surface any failures.
- [ ] **0.7** Add a `.github/workflows/ci.yml` that runs the same validators in CI.
- [ ] **0.8** Register cortex in the metafactory ecosystem registry (if compass overlay maintains one — defer if unclear).
- [ ] **0.9** Create initial `blueprint.yaml` with stub `C-100` umbrella feature ("Cortex platform — migration from grove-v2"). Sub-features (`C-101` through `C-1xx`) are filed per phase below.
- [ ] **0.10** Copy `docs/design-cortex.md` from grove-v2's `docs/cortex-spawn` branch into cortex as `docs/architecture.md` (or keep `design-cortex.md` — naming TBD). This is the static architecture spec.
- [ ] **0.11** Copy this migration plan (`docs/plan-cortex-migration.md`) into cortex from grove-v2's `docs/cortex-spawn` branch.
- [ ] **0.12** Initial commit + initial PR to `main` (since main was created with the README from `gh repo create`).

**Acceptance:**
- Repo exists, validators pass, design-cortex.md + this migration plan committed.
- No source code yet.

**PR:** `cortex#PR-1 — Bootstrap (compass 7-step pattern)`

---

### MIG-1 — Bus runtime (M2–M6 client + dispatch handler + surface-router)

**Goal:** The NATS+myelin runtime lives in cortex and is the canonical bus implementation. Move (don't rewrite) the G-1100 ladder out of `src/bot/`. Per `design-cortex.md` §8, this is `cortex/src/bus/` — the M2–M6 client code plus cortex's internal surface-router.

**Issue:** `cortex#2 — MIG-1: Bus runtime (NATS + myelin + dispatch-handler + surface-router)`

**Steps:**

- [x] **1.1** Copy from grove-v2: `src/bot/lib/nats-connection.ts` → `cortex/src/bus/nats/connection.ts`. Tests alongside. *(cortex#11, merged 2026-05-09 — MIG-1.1 NATS connection primitive)*
- [x] **1.2** Copy from grove-v2: `src/bot/lib/nats-subscription.ts` → `cortex/src/bus/nats/subscription.ts`. Tests alongside. *(cortex#11, merged 2026-05-09 — MIG-1.2 NATS subscription primitive)*
- [x] **1.3** Copy from grove-v2: `src/bot/lib/myelin/` (vendored schema) → `cortex/src/bus/myelin/vendor/`. *(cortex#12, merged 2026-05-09 — MIG-1.3 vendored myelin schema + fixtures)*
- [x] **1.4** Copy from grove-v2: `src/bot/lib/myelin-subscriber.ts` → `cortex/src/bus/myelin/subscriber.ts`. Tests alongside. *(cortex#12, merged 2026-05-09 — MIG-1.4 myelin subscriber)*
- [x] **1.5** Copy from grove-v2: `src/bot/lib/myelin-runtime.ts` → `cortex/src/bus/myelin/runtime.ts`. Tests alongside. *(cortex#22, merged 2026-05-09 — closes cortex#13. 4 import rewrites + 7/7 tests forward. The keystone unlock — releases MIG-3b/4b/5b/MIG-7.1 from the strict-block deferrals.)*
- [x] **1.6** Copy from grove-v2: `src/bot/lib/message-router.ts` → `cortex/src/bus/dispatch-handler.ts`. **Rename** internal class `MessageRouter` → `DispatchHandler`. *(cortex#24, merged 2026-05-09 — MIG-1.6 DispatchHandler class rename, message-router → dispatch-handler)*
- [ ] **1.7** *(no copy — `inbound-queue.ts` is legacy-grove-only per §2.2.1, not in grove-v2; cortex relies on JetStream durability per design-cortex.md §3.3 "lost event ≠ lost state". Falsifiable re-evaluation trigger: if any post-MIG-7 incident's RCA cites lost events crossing a cortex restart boundary, file a follow-on issue to port `inbound-queue.ts` from legacy.)*
- [x] **1.8** Copy from grove-v2: `src/bot/lib/network-resolver.ts` → `cortex/src/bus/network-resolver.ts`.
- [x] **1.9** Implement `cortex/src/bus/surface-router.ts` — the G-1111.A target. Surface adapters register; surface-router subscribes to NATS via `MyelinRuntime` and fans envelopes to registered adapters by subject pattern + payload filter. New code, not a port; tests new. *(cortex#25 + #27, merged 2026-05-09 — MIG-1.12 surface-router primitive + runtime wiring)*
- [ ] **1.10** Add the G-1111 §4.6 fail-safe rule check at config-load: `~/.config/cortex/cortex.yaml` `renderers[]` must provide ≥2 distinct platform classes covering `local.{org}.system.>`. Refuse to start otherwise. *(Platform classes are defined in `docs/design-event-taxonomy.md` §4.6.1: `chat-gateway` / `webhook-out` / `paging` / `local-projection` — match against that set at load time.)*
- [x] **1.11** All cross-imports rewritten: no reference to `../bot/...` or `../../bot/...`. Local imports only within `bus/` plus from `common/`. *(cortex#24, merged 2026-05-09 — MIG-1.11 cross-imports rewritten)*
- [x] **1.12** `bunx tsc --noEmit` clean. *(cortex#24, merged 2026-05-09 — MIG-1.11 tsc clean across bus/)*
- [x] **1.13** Test suite: all moved tests + new surface-router tests green. *(cortex#27, merged 2026-05-09 — MIG-1.13 bus tests green per recent PRs)*

**Acceptance:**
- `bus/` is self-contained: passes type-check + tests with no other `src/` directory present.
- A trivial integration test: starting `MyelinRuntime`, registering one fake adapter with the surface-router, publishing one envelope, asserting the adapter received it.

**PR(s):** Likely 2–3 PRs (transport / myelin / surface-router separately) to keep diff sizes reviewable.

**Parallel-safe with MIG-2 once MIG-1.1–.5 land** (mc-v3 doesn't depend on the surface-router yet).

---

### MIG-2 — Surface — Mission Control v3

**Goal:** mc-v3 lifted to cortex unchanged in behaviour. Legacy mc-v2 (`src/dashboard/`) deleted.

**Issue:** `cortex#3 — MIG-2: Surface (Mission Control v3)`

**Steps:**

- [x] **2.1** Copy from grove-v2: `src/mission-control/` (entire tree) → `cortex/src/surface/mc/`. *(149 files lifted in cortex#14, merged 2026-05-09 as 786914b)*
- [x] **2.2** Copy from grove-v2: `src/worker/` → `cortex/src/surface/mc/worker/`. *(11 files; import paths rewritten to `../../../../../common/*` and `file:../../../../../grove-auth` for the deeper nesting; cortex#14)*
- [x] **2.3** Copy from grove-v2: `src/bot/lib/dashboard-api.ts` + `dashboard-state.ts` + `dashboard-db.ts` → `cortex/src/surface/mc/{api,state,db}.ts`. *(landed as part of `src/surface/mc/` lift; the F-13..F-20.F dashboard's API/state/db tree)*
- [x] **2.4** Update React build config (Bun.build) to point at new paths. *(metrics-panel.tsx import fixed to `../../../../shared/format-utils` for new depth; cortex#14)*
- [x] **2.5** Update CF Worker `wrangler.toml` to deploy from `cortex/src/surface/mc/worker/` (or `dist/worker/`). *(file lifted in cortex#14; deploy path lives at the new location)*
- [ ] **2.6** Update WebSocket client URLs to point at the deployed Worker URL — `grove.meta-factory.ai` is the host *for now*. **DNS rename to `cortex.meta-factory.ai` is OUT OF SCOPE for v1 cortex** — the operator-facing brand name (`Cortex`) and the legacy DNS host (`grove.meta-factory.ai`) can legitimately differ; renaming DNS is a separate phase post-MIG-8 if/when desired. Track as a follow-on issue. *(deferred to MIG-7 cutover — Worker URL flip happens with the rebrand, not the lift)*
- [ ] **2.7** Confirm dashboard renders: `bun build src/surface/mc/index.html --outdir=dist/dashboard` then `bunx wrangler pages dev dist/dashboard`. Manual smoke test. *(deferred to MIG-7 — single env-dependent test for React shell remains gated on `bun build`; tsc green on both root + worker, 1137/1138 surface tests pass)*
- [x] **2.8** **Do not** delete legacy `src/dashboard/` from grove-v2 yet. mc-v2 retirement happens in MIG-8 once cortex is the deployment target. *(observed — grove-v2 untouched)*
- [x] **2.9** All test suites green. *(`bun test src/surface/` 1137/1138; root + worker `bunx tsc --noEmit` exit 0; 5 `src/common/*.ts` files pulled forward from MIG-7.6 for worker `../../../../../common/` imports — explicitly noted in commit 5a3b414)*

**Acceptance:**
- Mission Control loads in browser pointed at cortex's local server.
- All existing mc-v3 tests pass (the F-13..F-20.F suite).

**PR:** `cortex#PR-3 — Surface: Mission Control v3 lifted`

---

### MIG-3 — Adapters — Discord (and Mattermost)

**Goal:** The Discord adapter (with PR #82's resilience improvements) and Mattermost adapter live in `src/adapters/`, register with the surface-router, do not directly subscribe to NATS.

**Issue:** `cortex#4 — MIG-3: Adapters (Discord, Mattermost)`

**Pre-requisite:** PR #82 (grove-v2) merged. The fix lands in grove-v2 first; cortex inherits the fixed version.

**Steps:**

- [x] **3.1** Copy from grove-v2 (post-#82 merge): full Discord stack per §2.1 inventory rows 109–116 — `adapters/discord.ts` + `discord-client.ts` + `response-poster.ts` + `retry.ts` + `role-resolver.ts` + `context-fetcher.ts` + `attachment-handler.ts` + `attachment-types.ts` + `event-formatter.ts` → `cortex/src/adapters/discord/`. Plus `src/bot/lib/timeout.ts` → `cortex/src/common/timeout.ts` (cross-cutting; pulled forward from §4 MIG-7.5 to avoid an adapter→common reshuffle later — same pattern as MIG-7.6 partial pull-forward in MIG-2/MIG-3a). *(cortex#18, merged 2026-05-09 — MIG-3a)*
- [x] **3.2** Copy from grove-v2: full Mattermost stack — `src/bot/lib/adapters/mattermost.ts` + `mattermost-server.ts` + `mattermost-context.ts` + `mattermost-poller.ts` → `cortex/src/adapters/mattermost/{index,server,context,poller}.ts`. *(cortex#18 — `resolveRole` cross-stack import preserved unchanged from grove-v2; revisit at MIG-3.4)*
- [x] **3.3** Copy from grove-v2: `src/bot/lib/adapters/types.ts` → `cortex/src/adapters/types.ts`. Plus `src/bot/lib/adapters/mock.ts` → `cortex/src/adapters/mock.ts` (test-only platform adapter). *(cortex#18)*
- [x] **3.4** Refactor each adapter to **register with the surface-router** instead of being instantiated directly. The adapter's `start(onMessage, surfaceRouter)` registers `subjects + filter + render(envelope)` with the router. *(cortex#28, merged 2026-05-09 — MIG-3b adapters expose surfaceConfig)*
- [x] **3.5** Adapter no longer owns its inbound NATS subscription (it only owns its platform-side connection — Discord gateway, Mattermost websocket). *(cortex#18, merged 2026-05-09 — MIG-3a acknowledged: adapter never owned NATS sub in cortex)*
- [x] **3.6** All tests moved + green. Add new test: surface-router registers the Discord adapter, publishes an envelope, asserts adapter renders. *(cortex#28, merged 2026-05-09 — MIG-3b surface-integration test exists)*
- [x] **3.7** Wire `system.adapter.{disconnected,degraded,recovered}` event emission per G-1111 §3.5. The `onDegraded` callback (added in PR #82) now publishes via the bus instead of console.error. *(cortex#29, merged 2026-05-09 — MIG-3b-ii system.adapter.* envelopes emitted)*
- [ ] **3.8** Same for `system.dispatch.aborted` — `TimeoutSourceError` (PR #82) becomes a structured envelope. *(deferred to MIG-7 cortex.ts wiring — adapter-side `TimeoutSourceError` → `system.dispatch.aborted` envelope conversion lands when DispatchHandler is wired into cortex.ts; runner-side `dispatch.task.aborted` already published via dispatch-listener.ts L380)*
- [x] **3.9** All test suites green. *(cortex#28 + #29, merged 2026-05-09 — MIG-3b tests green)*

**Acceptance:**
- Discord adapter responds to a manual smoke test message via cortex.
- A simulated shard disconnect emits `system.adapter.degraded` after threshold; the dashboard renderer (mandatory subscriber per G-1111 §4.6) renders the degraded state.

**PR:** `cortex#PR-4 — Adapters: Discord + Mattermost via surface-router`

---

### MIG-4 — Runner — Workflow runner (CC orchestration)

**Goal:** CC session spawning + worklog + agent-team patterns live in `src/runner/`. Subscribes to `dispatch.task.received` envelopes; emits `dispatch.task.{started,progress,completed,failed,aborted}` on the bus.

**Issue:** `cortex#5 — MIG-4: Runner (CC orchestration)`

**Steps:**

- [x] **4.1** Copy from grove-v2: `src/bot/lib/cc-session.ts` + `session-manager.ts` + `stream-parser.ts` + `claude-invoker.ts` + `agent-team.ts` + `task-tracker.ts` + `execution-backend.ts` + `worklog-manager.ts` + `learning-store.ts` + `security-preamble.ts` → `cortex/src/runner/`. *(cortex#19, merged 2026-05-09 — MIG-4a)*
- [ ] **4.2** *(deleted — `src/hooks/lib/event-taxonomy.ts` moves with the rest of `src/hooks/` in MIG-5.2; was double-counted in earlier draft)*
- [x] **4.3** Copy from grove-v2: `src/bot/hooks/` → `cortex/src/runner/hooks/`. *(cortex#19 — bash-guard.hook.ts)*
- [x] **4.4** Copy from grove-v2: `src/bot/commands/` → `cortex/src/cli/cortex/commands/` (these are CLI subcommands, not runner code; placement reflects that). *(cortex#19 — cloud.ts + tests)*
- [x] **4.5** Refactor: runner subscribes to `local.{org}.dispatch.task.received` via the surface-router (same registration mechanism as adapters). On envelope, spawns CC. *(cortex#30, merged 2026-05-09 — MIG-4b dispatch-listener subscribes via surface-router)*
- [x] **4.6** Runner emits lifecycle envelopes per G-1111 §3.4 (`dispatch.task.{started,completed,failed,aborted}`). *(cortex#30, merged 2026-05-09 — MIG-4b dispatch.task.* lifecycle envelopes emitted)*
- [x] **4.7** Worklog manager subscribes to `dispatch.task.*` envelopes and projects to the worklog Discord thread. (No longer called directly from message-router — it's a sibling consumer of the bus.) *(cortex#30, merged 2026-05-09 — MIG-4b worklog-manager.surfaceConfig sibling consumer)*
- [x] **4.8** Retire `claude-invoker.ts:invokeClaudeCode()` dead code per existing v1-to-v2-cutover doc §7. *(cortex#30, merged 2026-05-09 — MIG-4b invokeClaudeCode retired)*
- [x] **4.9** Tests moved + green. *(cortex#19 — 118/118 src/runner/ + 19/19 src/cli/cortex/commands/; round-1 review caught 9 missed tests in tests/bot/lib/, all lifted in same PR; +64 tests added)*

**Acceptance:**
- A manual dispatch via Discord adapter → dispatch-handler emits `dispatch.task.received` → runner picks up → spawns CC → emits lifecycle events → worklog thread renders.

**PR:** `cortex#PR-5 — Runner: CC orchestration via bus`

---

### MIG-5 — Taps — GH webhook + CC events

**Goal:** External event sources publish onto the bus from `src/taps/`.

**Issue:** `cortex#6 — MIG-5: Taps (GH webhook, CC events)`

**Steps:**

- [x] **5.1** Copy from grove-v2: `src/relay/` → `cortex/src/taps/cc-events/`. *(cortex#17, merged 2026-05-09 — MIG-5a)*
- [x] **5.2** Copy from grove-v2: `src/hooks/` → `cortex/src/taps/cc-events/hooks/`. *(cortex#17 — hooks subtree placed INSIDE cc-events/; 5 import-path rewrites mechanical)*
- [x] **5.3** Copy from grove-v2: `src/bot/lib/cloud-publisher.ts` → `cortex/src/taps/cc-events/cloud-publisher.ts`. *(MIG-5b — lifted with import path rewrites: `../../hooks/lib/event-types` → `./hooks/lib/event-types`, `../types/config` → `../../../common/types/config`, `./timeout` → `../../common/timeout`; existing 16-test suite landed alongside)*
- [x] **5.4** Copy from grove-v2: `src/webhook-proxy/` → `cortex/src/taps/gh-webhook/`. *(cortex#17 — own package preserved; bun.lock regenerated, forward-compatible)*
- [x] **5.5** Update CC hook publishing path: hooks publish CloudEvents to NATS via `MyelinRuntime`, not just to JSONL files. *(MIG-5b — implemented relay-side per G-1111 §7.4 ("Some in-process events MAY be lifted to the bus by grove-relay"). Hooks themselves remain JSONL-only because they're spawned-per-event Bun processes that must NOT open per-event NATS connections. The relay daemon (long-lived, in-process) holds a single NatsLink and publishes filtered events via a new `onPublished` hook on `EventProcessor`; envelopes built by `createCcEventEnvelope` in `src/taps/cc-events/cc-events.ts` carry the existing internal taxonomy verbatim into `envelope.type`. Subject form `local.{org}.{type}` symmetric with `MyelinRuntime.publish`. CLI flags `--nats-url` / `--nats-token` / `--org` (env var fallbacks `NATS_URL` / `NATS_TOKEN` / `GROVE_OPERATOR`); absence of `--nats-url` keeps the relay JSONL-only, preserving the project-wide rule that grove stays installable without NATS.)*
- [ ] **5.6** Update GitHub webhook proxy: HMAC-validated webhook → publishes `local.{org}.github.{event}.{action}` envelopes onto the bus. *(MIG-5b — DEFERRED with architectural analysis. The proxy is a Cloudflare Worker; CF Workers have no NATS client SDK, no persistent TCP, no JetStream-WS gateway is configured. Service Binding currently goes Worker → grove-api (also a Worker, same constraints). To publish onto NATS, one of three architectural moves is required: (a) introduce a NATS WebSocket gateway and adopt a Worker-compatible NATS-WS client, (b) refactor the path so the bot exposes an HTTP receiver and the proxy forwards over Service Binding to it before continuing to grove-api, or (c) wait until the bot itself becomes the receiver in MIG-7 and add NATS publish at that boundary. Option (c) aligns naturally with the migration order and avoids new public surfaces; recommend folding 5.6 into MIG-7 / cortex.ts wiring rather than landing it inside the proxy now. Tracking issue follow-up.)*
- [x] **5.7** Tests moved + green. *(cortex#17 — 84/84 cc-events + 15/15 gh-webhook = 99 tests; MIG-5b adds 16 cloud-publisher tests + 23 cc-events helper tests + 4 onPublished hook tests on top, total 127/127 cc-events + 15/15 gh-webhook = 142 green)*

**Acceptance:**
- A simulated PR-merged GitHub webhook → tap publishes `local.{org}.github.pr.merged` → dashboard renderer renders the event.
- A live CC session emits hook events that arrive on the bus and project into the dashboard timeline.

**PR:** `cortex#PR-6 — Taps: GitHub webhook + CC events`

**Parallel-safe with MIG-3 and MIG-4** once MIG-1 lands.

---

### MIG-6 — CLIs (operator tools)

**Goal:** `~/bin/discord` and `~/bin/cldyo-live` distribute from cortex.

**Issue:** `cortex#7 — MIG-6: Operator CLIs (discord, cldyo-live)`

**Steps:**

- [x] **6.1** Copy from grove-v2: `src/cli/discord.ts` + `src/cli/lib/` + `src/cli/skill/` → `cortex/src/cli/discord/`. *(cortex#15, merged 2026-05-09 as 81aa0ce; 5 byte-identical lifts)*
- [x] **6.2** Copy from grove-v2: `src/cli/cldyo-live` (single bash script) → `cortex/src/cli/cldyo-live` (no trailing slash; single file). Verify with `file cortex/src/cli/cldyo-live` returning "Bourne-Again shell script". Do NOT create `cortex/src/cli/cldyo-live/` as a directory. *(verified live; Echo round-1 also caught architecture.md §8 line 586 trailing-slash inconsistency, fixed in same PR)*
- [x] **6.3** Update `arc-manifest.yaml` `provides:` block to install `~/bin/discord` and `~/bin/cldyo-live` from cortex. *(cortex#15; provides.files block + hooks.postupgrade pointing at scripts/postupgrade.sh; explicitly scoped to MIG-6 deliverables, MIG-7 expands)*
- [x] **6.4** Update `~/.claude/skills/Discord/` source path to cortex. *(cortex#15 scripts/postupgrade.sh — `ln -sf "${CORTEX_DIR}/src/cli/discord/skill" "${PAI_DIR}/skills/Discord"`; idempotent on every arc upgrade)*
- [x] **6.5** Manual smoke: `discord post --channel cortex "MIG-6 sanity"` works. *(cortex#15 — `bun src/cli/discord/discord.ts post --channel cortex "MIG-6 sanity smoke from cortex worktree HEAD ~55ec0ac"` returned "Posted to #cortex"; live message visible at 03:18 PM in #cortex; reading from existing ~/.config/grove/cli.yaml per plan §1.3 parity)*
- [ ] **6.6** Tests moved + green. *(deferred-with-justification — no CLI tests exist in grove-v2 either; tsc green + `--help` smoke + live channel post are the parity baseline; new test work is post-migration follow-up, not migration scope)*

**Acceptance:**
- `discord` and `cldyo-live` work post-`arc upgrade Cortex` (which becomes real in MIG-7).

**PR:** `cortex#PR-7 — CLIs: discord + cldyo-live`

---

### MIG-7 — Top-level wiring + arc cutover

**Goal:** Cortex is installable via `arc upgrade Cortex`, runs the bot, replaces the deployed Grove bot. The agent-bundle config schema flips to first-class `agents:` + `renderers:` per `design-cortex.md` §9.

**Issue:** `cortex#8 — MIG-7: Top-level wiring + arc package switchover`

**Steps:**

- [ ] **7.1** Create `cortex/src/cortex.ts` — the entrypoint binary. Wires bus + runner + adapters + taps. (Equivalent of `grove-v2/src/bot/grove-bot.ts` but with the new module layout.)
- [ ] **7.2** Move `src/bot/types/config.ts` → `cortex/src/common/types/config.ts`. Add new `nats.identity` schema (per JC's E2E NATS work). **Refactor schema per `design-cortex.md` §9.1 flipped model**: `operator:`, `agents[]` (each with own `persona`, `roles`, `trust`, `presence.<platform>`), `renderers[]` for non-agent-bound surfaces (dashboard, pagerduty, cli-tail). Replaces today's `agent:` + `discord:` + `mattermost:` + `trustedAgentBots:`.
- [ ] **7.2a** Implement `cortex/src/common/agents/registry.ts` — given the parsed config, builds an `Agent` registry keyed by `id`. Each `Agent` exposes `{ id, displayName, persona, roles, trust, presence }`. Used by presence-adapter constructors and by the runner.
- [ ] **7.2b** Implement `cortex/src/common/agents/trust-resolver.ts` — process-wide `(platformId → agentId)` map. Each presence adapter, on connect, fetches its own platform user id (e.g. `client.user.id` for Discord) and registers it. Inbound messages look up the source agent by platform id. Replaces today's hand-maintained `trustedAgentBots` list.
- [ ] **7.2c** Refactor presence adapters to `new DiscordPresenceAdapter(agent: Agent, presence: DiscordPresence)` shape — the adapter holds a reference to its parent agent rather than re-reading the persona from a file path inside its own config.
- [ ] **7.2d** Implement `Renderer` interface + dashboard renderer + pagerduty renderer (the G-1111 §4.6 fail-safe rule's recommended pair). cli-tail renderer optional for v1.
- [ ] **7.2e** Write a one-shot migration helper `bun src/cli/cortex/commands/migrate-config.ts` that reads a grove-v2-shaped `bot.yaml` and emits a cortex-shaped `cortex.yaml`. Validation: every old `discord[].instanceId` maps to exactly one new `agents[id=X].presence.discord` block; every old `personaFile` resolves to a present file under `personas/`; every old `trustedAgentBots` entry resolves to a known agent (by Discord user id at the time of migration; logged as a one-time fixup).
- [x] **7.3** Move `src/bot/lib/config-{loader,watcher}.ts` → `cortex/src/common/config/`. *(cortex#20, merged 2026-05-09 — config-loader.ts → loader.ts + config-watcher.ts → watcher.ts + 4 tests; 4 import rewrites)*
- [x] **7.4** Move `src/bot/lib/usage-monitor.ts` → `cortex/src/common/usage/monitor.ts`. (No `usage-fetcher.ts` to move — that's legacy-grove-only per §2.2.1; the API-fallback path is an accepted regression.) *(cortex#20 — usage-monitor.ts lifted; AccountUsage type extracted from legacy `src/dashboard/types.ts` to new `src/common/types/usage.ts` since dashboard/ retires at MIG-8)*
- [x] **7.5** Move `src/bot/lib/timeout.ts` → `cortex/src/common/timeout.ts`. *(cortex#18 MIG-3a partial pull-forward — timeout.ts cross-cutting; pulled forward to its eventual MIG-7.5 home)*
- [x] **7.6** Move all of `src/common/` (5 files: agent-detection.ts, event-processor.ts, event-utils.ts, github-events.ts, types.ts) + `src/shared/format-utils.ts` into `cortex/src/common/`. *(cortex#14 round-1 partial pull-forward — 5 src/common/* files lifted to cortex/src/common/; format-utils.ts deferred — only `src/surface/mc/dashboard-v2/components/metrics-panel.tsx` consumes it via `../../../../shared/format-utils`. types/config.ts + types/context.ts pulled forward in cortex#18 MIG-3a; AccountUsage in cortex#20)*
- [x] **7.6a** Migrate deployment templates: copy `src/services/com.grove.bot.plist` → `cortex/src/services/com.cortex.bot.plist` (rename in filename + update `Label` + `ProgramArguments` paths inside to point at `~/bin/cortex`). Same for `com.grove.relay.plist` → `com.cortex.relay.plist`. And `src/settings/grove-hooks.json` → `src/settings/cortex-hooks.json` (rename only — JSON content is hook config, not bot-name-specific). *(cortex#20 — bot plist Label `com.grove.bot` → `com.cortex.bot` + ProgramArguments[0] `~/bin/grove-bot` → `~/bin/cortex`; relay plist same pattern + script path corrected to cortex's MIG-5a location `src/taps/cc-events/grove-relay.ts`; hooks.json byte-identical rename. Operator-side path tokens — `__GROVE_DIR__`, `__HOME__/.config/grove/`, `GROVE_CHANNEL` — kept until MIG-7.7/7.9 cutover.)*
- [ ] **7.6b** Rename `src/taps/cc-events/grove-relay.ts` → `src/taps/cc-events/relay.ts` (or similar cortex-internal name). The file was lifted unchanged at MIG-5a per plan §1.3 "no behaviour change" so operators upgrading still see familiar `grove-relay: …` log lines and `~/bin/grove-relay` symlink. MIG-7.6b updates: filename, Commander program name (`.name("grove-relay")`), 9 user-visible log strings (`"grove-relay: …"`), and the postupgrade.sh symlink target. Coordinated with 7.6a deployment rename and 7.7 arc-manifest provides update so that `~/bin/grove-relay` and `~/bin/relay` (or whatever the new binary is named) co-exist briefly during cutover. (Echo round-1 m2 on cortex#17 flagged the deferral; this checkbox closes the loop.)
- [ ] **7.7** Update `arc-manifest.yaml`:
  - `name: Cortex`
  - `version: 0.1.0`
  - `provides:` lists `cortex` binary + `discord` + `cldyo-live` + hooks + relay
  - **Pre-flight**: verify legacy grove is uninstalled (`arc list | grep -i grove` returns nothing) before MIG-7. If legacy grove is still installed, the symlink at `~/bin/grove-bot` is owned by legacy's manifest; running `arc upgrade Cortex` does NOT touch it. Sequence: `arc uninstall Grove` (legacy) → `arc upgrade Cortex` → verify `~/bin/cortex` resolves and `~/bin/grove-bot` no longer exists.
  - **Deprecation shim**: separately, install a one-line `~/bin/grove-bot` shim that prints "use `cortex` instead" and execs `~/bin/cortex "$@"`. Manual operator step, not part of the manifest. Removed in MIG-8.4.
  - **Rollback**: `arc uninstall Cortex` + `arc upgrade Grove` (re-installs legacy at v0.29.0). Both `arc upgrade` commands are idempotent.
- [ ] **7.8** Update launchd plist `~/Library/LaunchAgents/com.grove.bot.plist` → `com.cortex.bot.plist`.
  - **Pre-flight**: confirm bot is idle (no in-flight CC sessions) before unloading the old plist. Run `cortex queue --pending` (or equivalent post-MIG-7 command) — should be 0.
  - **Sequence (atomic-ish)**:
    1. `launchctl unload ~/Library/LaunchAgents/com.grove.bot.plist` (stops legacy)
    2. Verify the old bot is stopped (`pgrep -f grove-bot` returns nothing)
    3. `cp` the rendered new plist to `~/Library/LaunchAgents/com.cortex.bot.plist`
    4. `launchctl load -w ~/Library/LaunchAgents/com.cortex.bot.plist`
    5. Verify cortex started (`pgrep -f 'cortex start'` returns a PID; tail `~/.config/cortex/logs/cortex.log` for "shard ready" lines)
    6. Only after verification: `rm ~/Library/LaunchAgents/com.grove.bot.plist`
  - **Rollback**: if step 4 or 5 fails: `launchctl unload ~/Library/LaunchAgents/com.cortex.bot.plist`, `launchctl load ~/Library/LaunchAgents/com.grove.bot.plist`. The old plist still works because we didn't delete it until step 6.
- [ ] **7.9** Migrate `~/.config/grove/bot.yaml` → `~/.config/cortex/cortex.yaml`.
  - **Note**: this is a **schema transformation** (per §9 / `migrate-config.ts` from step 7.2e), not just a path rename. The new file has different top-level keys (`agents:` + `renderers:` instead of `discord:` + `mattermost:` + `trustedAgentBots:`).
  - **Sequence**:
    1. `mkdir -p ~/.config/cortex/`
    2. `bun cortex/src/cli/cortex/commands/migrate-config.ts ~/.config/grove/bot.yaml > ~/.config/cortex/cortex.yaml` — emits transformed config.
    3. `cortex start --config ~/.config/cortex/cortex.yaml --dry-run` — validates schema + agent registry resolution; refuses to start if `agents[]` references a missing persona file or trust resolution fails.
    4. Only after dry-run passes: leave `~/.config/grove/bot.yaml` in place (do NOT delete) as a backup. Symlink optional.
  - **Rollback**: revert plist to legacy in 7.8; legacy bot reads `~/.config/grove/bot.yaml` as before. The new `~/.config/cortex/cortex.yaml` does not interfere.
- [ ] **7.10** Generate cortex's CLAUDE.md via `arc upgrade compass` (or copy + fill).
- [ ] **7.11** Move all `docs/design-*.md` and `docs/iteration-*.md` from grove-v2 → cortex `docs/`. Archive obsolete ones.
- [ ] **7.12** Move `THIRD-PARTY-NOTICES.md`, `LICENSE`, `README.md`.
- [ ] **7.13** Final integration test: cortex starts, all adapters connect (Luna, Echo, Forge), Mission Control renders, NATS+myelin operational, `discord post` works, fixture inbound message routes to runner and back.
- [ ] **7.14** Bump cortex version. **Pick one path — see §6 question 3:** either `v0.2.0` (post-bootstrap, signals "running but not yet hardened") OR `v1.0.0` (signals "production target"). §6.3's lean is `v1.0.0`; if that lean holds at MIG-7 cutover time, bump to v1.0.0 here. Otherwise v0.2.0 stays.

**Acceptance:**
- Operator runs `arc upgrade Cortex` (fresh install).
- Operator runs `cortex start --config ~/.config/cortex/cortex.yaml`.
- Bot connects, dashboard loads, Discord round-trip works.
- E2E NATS messaging works (per JC's identity config requirement).

**PR(s):** Multiple — the top-level wiring is one big PR; arc-manifest + launchd updates are smaller follow-ups.

---

### MIG-8 — Cleanup + retirement

**Goal:** Legacy repos archived. Operator deployments cut over.

**Issue:** `cortex#9 — MIG-8: Retire grove + grove-v2`

**Steps:**

- [ ] **8.1** Verify cortex is in production for ≥1 week without rollback.
- [ ] **8.2** Open archive issues on `the-metafactory/grove` and `the-metafactory/grove-v2` linking to cortex.
- [ ] **8.3** `gh repo archive the-metafactory/grove` and `gh repo archive the-metafactory/grove-v2`.
- [ ] **8.4** Remove the deprecation shim added in MIG-7.7 (the `~/bin/grove-bot` → `~/bin/cortex` redirect).
- [ ] **8.5** Update any external references (docs, READMEs, website) pointing to grove or grove-v2.
- [ ] **8.6** *(no-op — `src/spikes/` is legacy-grove-only; nothing to retire from cortex's tree. Legacy grove had `src/spikes/{keygen.ts, nats-identity-test.ts}`, archived alongside legacy grove at MIG-8.3.)*
- [ ] **8.7** Update `~/Developer/compass/sops/*` references to grove → cortex.
- [ ] **8.8** Update blueprint references in sibling repos (myelin, signal, pilot, blueprint, compass) from `grove:G-NNN` → `cortex:C-NNN` for in-flight features.

**Acceptance:**
- `gh repo list the-metafactory` shows `grove` and `grove-v2` as archived.
- No active reference in any active document points at the archived repos.

**PR:** Multiple small ones across sibling repos.

---

## 5. PR + issue conventions

### 5.1 Issue structure

- **Umbrella:** `cortex#1 — Cortex platform — migration from grove-v2 (C-100)` linking to this plan.
- **Per-phase:** `cortex#N — MIG-N: {phase title}` containing the §4 checklist verbatim. Each checkbox = a PR (or part of a PR if trivially related).
- **Blueprint feature IDs:** `C-100` umbrella; `C-101` (MIG-0) through `C-108` (MIG-7) for phases; `C-1xx` for new features added during/after migration.

### 5.2 PR title format

```
feat(cortex): C-NNN.X — {one-line scope} (MIG-N.Y)
```

E.g.: `feat(cortex): C-102.1 — bus/nats transport primitives (MIG-1.1..1.3)`

### 5.3 Pilot-loop usage

Each PR runs through the standard pilot-review-loop skill with Echo as primary reviewer. Defer big architectural feedback (anything that questions decisions in `design-cortex.md`) back into a discussion on that doc rather than blocking the PR — `design-cortex.md` is the architecture ground truth; this plan is the migration ground truth.

### 5.4 Test discipline

- Every moved file's test moves with it. No silent drops.
- Every new file has at least one test.
- Type-check (`bunx tsc --noEmit`) is green before PR open.
- Pre-existing flake (DashboardApi WebSocket per grove-v2 issue #69) follows to cortex; track separately.

---

## 6. Decisions deferred / open questions

1. **Cortex initial visibility — public or private?** Default private at MIG-0; open question whether to make it public after MIG-7 stabilises (matches grove-v2 which is private).
2. **grove-auth fold-in.** Is grove-auth's identity layer absorbed into cortex's bus/identity, or stays as a sibling? **Defer to post-MIG-7.** Cortex MIG-7 includes the new `nats.identity` schema (per JC) but doesn't require grove-auth integration.
3. **Versioning at cutover.** Cortex starts at v0.1.0 (MIG-0). Is the v0.1 → v0.2 → ... cadence preserved across migration phases, or do we jump to v1.0 once MIG-7 lands? **Lean v1.0 after MIG-7** — cortex is the production target then.
4. **Mission Control v3 sub-feature numbering.** mc-v3's F-13..F-20 IDs are scoped to grove-v2's blueprint. Do they re-number under cortex's C-1xx, or does cortex inherit the existing F-13..F-20 IDs for historical continuity? **Lean inherit** — easier for tracking.
5. **Bots.d / per-bot AAA regression.** Legacy grove v0.29.0 has features grove-v2 lacks (PR #330, #333). MIG-7 cutover accepts this regression. **Open: when does it get re-implemented in cortex?** Probably when multi-operator becomes a real requirement.
6. **Naming for `src/bus/` directory.** Alternatives considered: `coordination/`, `myelin/`, `spine/`. **Decision: `bus/`** because it's the most operationally-evocative and doesn't conflict with the vendored myelin schema directory.
7. **Pilot's relationship to cortex's runner.** Pilot already coordinates review loops; cortex's runner spawns CC. They're peers on the bus. **No change.** Cortex projects pilot's errand state via myelin envelopes (G-1101 in event-taxonomy plan), but does not import pilot.
8. **Migration testing strategy.** Do we run cortex side-by-side with grove for a soak period, or hard cut over? **Lean: side-by-side for ≤7 days post-MIG-7**, then archive grove. The legacy grove process keeps responding; cortex takes over progressively as `arc upgrade` runs across operator hosts.
9. **Subject namespace reconciliation** (cross-references `design-cortex.md` §3.5). Whether `local.{org}.>` and `mf.net-{op}.>` are alternative subject hierarchies, nested, or transport-vs-envelope conventions. Resolution lives in myelin#7's still-pending acceptance criterion ("Seven-layer model documented in myelin"). MIG-1 tolerates both as input subjects; doc convergence happens upstream in myelin.
10. **Envelope contract docs location** (cross-references `design-cortex.md` §6.1). `cortex/docs/api/` per-app vs. an ecosystem-wide catalogue alongside myelin's namespace spec. **Lean local-to-cortex**; revisit if a registry pattern emerges.
11. **JetStream stream config ownership.** Cortex's MIG-1 "lost event ≠ lost state" guarantee relies on JetStream replay. Stream config (subjects, retention, max-msgs, ack policy) is NATS-server-side configuration. Where is this declared and tracked? Options: (a) cortex's `arc-manifest.yaml` declares JetStream stream requirements (operators provision externally); (b) a small `cortex jetstream apply` CLI does it imperatively per host; (c) myelin owns the canonical stream catalogue. **Lean (a) for v1** — declarative requirement in cortex's manifest, operator provisions externally; track ownership migration to (c) when myelin#7 doc lands. Open until then.
12. **DNS rename `grove.meta-factory.ai` → `cortex.meta-factory.ai`.** Out of scope for v1 cortex per MIG-2.6. **Open**: when does the rename happen? Tied to operator-facing brand stability vs. ergonomic parity. Lean: post-MIG-8, treated as cosmetic with a 30-day redirect window. File follow-on at that point.

---

## 7. Acceptance criteria — "migration complete"

The migration is complete when all of:

- [ ] MIG-0 through MIG-7 phases all closed.
- [ ] Cortex is the deployed bot on **the v1 cutover host (Andreas's deployment)** — `launchctl list | grep cortex` returns a PID. Multi-operator hosts come post-MIG-8 (see §6.5 / §6.7); v1 cortex is single-operator-deterministic.
- [ ] Mission Control loads at the configured deployment URL with all mc-v3 features intact.
- [ ] All three Discord adapters (Luna, Echo, Forge) connect to cortex on startup.
- [ ] At least one round-trip review cycle has completed via cortex (Andreas pings Echo, Echo reviews PR, cortex routes the verdict).
- [ ] **Agent bundles preserved per `design-cortex.md` §9 (agents own their presence): Luna / Echo / Forge reachable via Discord under the same display names, personas, and capability gates as before. Cross-agent trust resolves at startup from each agent's bot token (not from a hand-maintained Discord ID list). Adding a hypothetical Slack presence for Luna is a one-stanza edit under `agents[id=luna].presence`, not a new top-level adapter entry. Renderers (dashboard, pagerduty) load from a separate `renderers[]` top-level and do not bind to any agent.**
- [ ] `system.adapter.degraded` events emit correctly during a simulated shard outage.
- [ ] E2E NATS messaging works between cortex hosts (per JC's identity config).
- [ ] grove-v2 and grove repos archived on GitHub.
- [ ] No active doc references the archived repos.

---

## 8. References

- **Architecture (single source of truth)** — `docs/design-cortex.md`.
- **Lineage docs** — `docs/design-collaboration-surface.md` (PRs #58 + #83), `docs/design-event-taxonomy.md` (PR #81), `docs/iteration-collaboration-surface.md` (PR #79).
- **Stack model** — `~/Developer/myelin/specs/namespace.md`, `~/Developer/myelin/schemas/envelope.schema.json`, myelin#7 (seven-layer model), `~/Developer/myelin/docs/design-agent-task-routing.md` (myelin PR #36 — distribution modes + stratification + lifecycle), myelin#31 (chain-of-stamps).
- **Process SOPs** — `~/Developer/compass/sops/new-repo-pattern.md`, `dev-pipeline.md`, `worktree-discipline.md`, `pr-review.md`, `versioning.md`.
- **Adjacent / signal** — `~/Developer/signal/README.md` + `~/Developer/signal/docs/design-signal-bundle-migration.md`.
- **Pre-cutover PRs in grove-v2** — `the-metafactory/grove-v2#82` (Discord outage resilience; lands pre-MIG-3), `the-metafactory/grove-v2#81` (G-1111 event taxonomy), `the-metafactory/grove-v2#79` (G-1100 ladder retro), `the-metafactory/grove-v2#84` (this plan + design-cortex.md).
- **Reviewer routing** — `~/.claude/projects/-Users-andreas-Developer-grove-v2/memory/reviewer-discord-ids.md`.

---

*This plan is the ground truth for the migration. When reality drifts from it, update the plan first, then the world. For "what cortex IS" architecture, see `docs/design-cortex.md`.*
