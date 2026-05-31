# Grove v1 → v2 cutover plan

<!-- archived-at-MIG-7.11 -->
<!-- Source: grove-v2 docs/v1-to-v2-cutover.md -->
<!-- Status: STALE — describes intra-repo (branch-based) cutover from grove-v0 to grove-v2.  -->
<!--   Superseded by docs/plan-cortex-migration.md (the inter-repo grove-v2 → cortex cutover). -->
<!--   Retained here for historical reference only; do not act on this doc. -->

**Status:** Draft. v2 (Mission Control) is under active development on the `v2` branch, in `src/mission-control/`. This doc captures the things that have to happen when v2 is ready to replace v1 as the primary Grove experience, so we don't lose them between now and then.

**Related docs:**

- `docs/design-mission-control.md` — v2 design spec (merged 2026-04-15, PR #189)
- `docs/design-spawn-integration.md` — on-ice spawn integration, reactivated post-cutover

---

## 1. Why this doc exists

v2 develops as a **self-contained local app** alongside v1. The two share only the `claude` binary on PATH — zero runtime coupling, zero shared database, zero shared process. v1 stays in production use throughout v2's development; v2 is developed locally against `localhost`.

Because v2 deliberately does not touch v1 infrastructure during development, there is a pile of **deferred refactors** that cannot happen until v2 is ready to take over. This doc is the list of those deferred refactors, so when cutover time arrives we don't have to reconstruct the context.

---

## 2. Development posture (while v2 matures)

| Aspect         | v1 (production)                                    | v2 (local development)                     |
|----------------|----------------------------------------------------|---------------------------------------------|
| Branch         | `main`                                             | `v2` (long-lived integration branch)        |
| Code location  | `src/bot/`, `src/worker/`, `src/dashboard/`        | `src/mission-control/`                      |
| Process        | `grove-bot` (Discord-connected)                    | `mission-control` (localhost HTTP+WS)       |
| Database       | Bot SQLite + Worker D1                             | Local SQLite at `~/.local/share/mission-control/data.db` |
| Dashboard      | `grove.meta-factory.ai` (CF Pages)                 | `http://localhost:8767`                     |
| Discord        | Yes (production bot token)                         | None                                        |
| Cloud Worker   | Yes (`grove-api`, `webhook-proxy`)                 | None                                        |
| Hook stream    | Consumed by `grove-relay` → `grove-bot`            | Consumed directly by v2 via own cursor      |

**Rules:**

- Bug fixes and v1 features target `main`.
- v2 work targets `v2`.
- `main` → `v2` forward-merge on demand (not on a schedule) so v2 picks up fixes without drifting on every unrelated change.
- v2 never merges to `main` until cutover time, at which point it is one big intentional cutover PR.

---

## 3. What v2 replaces at cutover

These are the pieces that v2 is designed to own once it's ready. At cutover, v1's equivalent code retires.

| Area                          | v1 today                                       | v2 equivalent                                   | Decision at cutover                 |
|-------------------------------|------------------------------------------------|-------------------------------------------------|-------------------------------------|
| Dashboard UI                  | `src/dashboard/` (React, CF Pages deploy)      | `src/mission-control/ui/`                       | **Retire v1 dashboard.** v2 is the only dashboard. |
| Data schema                   | `src/bot/lib/dashboard-db.ts` + `src/worker/src/db/schema.ts` (duplicated) | `src/mission-control/db/schema.ts` (single source) | **Retire v1 schema.** v2's schema becomes canonical. |
| Session tracking              | Ad-hoc `sessions` table, session-id-per-CC-invocation | `agent_task_assignment` link table + state machine + tagged-union `block_reason` | **Retire v1 session tracking.** Start fresh (no v1→v2 data migration by default). |
| Event pipeline                | `~/.claude/events/raw/` → `grove-relay` → `~/.claude/events/published/` → `grove-bot` | `~/.claude/events/raw/` → v2 bot (direct, own cursor) | **Retire `grove-relay`** — v2 ingests directly. The relay's policy-filter job can be folded into v2's ingestion if needed. |
| Dispatch path (Discord)       | `grove-bot` spawns `CCSession` (single-turn + `--resume`) per Discord message | v2 spawns long-lived `CCSessionV2` with `--input-format stream-json` from dashboard UI clicks | **See §4 — Discord's future is uncertain.** |
| State storage location        | Bot SQLite in `~/.config/grove/`, Worker D1 in CF account | Local SQLite in `~/.local/share/mission-control/` | **Retire v1 storage locations.** Follow XDG spec cleanly. |

---

## 4. What survives cutover (probably)

These pieces are either outside v2's scope or are infrastructure v2 reuses as-is. They should not be touched during the cutover PR.

- **The `claude` binary and CC's own session files** (`~/.claude/projects/*.jsonl`). Unchanged. v2 just invokes CC differently.
- **The hook infrastructure** (`~/.claude/events/raw/`, the EventLogger hook in `src/hooks/`). v2 consumes it; the hook script itself doesn't change.
- **The GitHub webhook path** (`src/webhook-proxy/`). The HMAC validation + dedup Worker keeps existing; what it forwards to is decided at cutover (v2 local bot via tunnel? a new v2 Worker? retire entirely?).
- **The Discord CLI** (`~/bin/discord`, `src/cli/discord.ts`). Separate from the bot. Keeps working regardless of what happens to the bot.
- **CLAUDE.md, SOPs, compass, blueprint.** v2's existence is already documented in CLAUDE.md; cutover just updates the architecture section.
- **Open source attribution, third-party notices, license.** Unchanged.

---

## 5. Uncertain at cutover

Decisions deferred until we actually need to make them:

- **Does v2 keep a cloud Worker at all?** v2 is local-only during development. If post-cutover Grove wants remote access (dashboard hosted in cloud, accessible from a phone, shared with collaborators), v2 grows a Worker layer at that point. If Grove stays single-principal-local-only forever, `src/worker/` is deleted at cutover.
- **Does v2 keep Discord as an input channel?** v2's MVP is browser-driven, no Discord. Three possible futures:
  - (a) Discord retires entirely — v2 is local browser only.
  - (b) Discord becomes a secondary input — v2 adds a Discord listener that maps messages to dashboard-equivalent actions.
  - (c) Discord stays as-is — v1's Discord bot runs alongside v2 indefinitely (ugly, avoid).
- **Does v2 import v1's historical data?** Default: **no.** Start fresh. If someone wants historical event data preserved, we can write a one-off migration at cutover — but the v1 schema is already divergent enough that it's probably cheaper to start fresh.
- **How do external Grove installations migrate?** Assume we're the only user until cutover; revisit if external users onboard before then.
- **Does the `grove-auth` work still fit?** v1's auth story (webhook-auth-patterns research, design-auth-aaa) was scoped to v1's cloud Worker + Discord model. Post-cutover, the auth layer needs to be re-scoped for whatever v2 deployment shape lands.
- **What happens to `grove-relay` as a component?** Folded into v2's ingestion (likely) or kept as a separate process if we want out-of-process policy filtering (unlikely at v2's scale).

---

## 6. Cutover checklist

When v2 is ready to become the primary Grove experience, work through:

### 6.1 Code promotion

- [ ] Merge `v2` branch to `main` via a single cutover PR. This is intentionally big; don't try to salami-slice it.
- [ ] Rename `src/mission-control/` → `src/bot/` (or an equivalent promotion that makes v2 the canonical module path). Update every import.
- [ ] In a **separate follow-up PR**, delete v1's old `src/bot/`, `src/worker/`, `src/dashboard/` code. Keeping deletion separate from promotion makes the cutover PR reviewable.
- [ ] Retire `src/relay/` (or fold it into v2) per §5 decision.
- [ ] Update `CLAUDE.md` architecture section to describe v2's module layout as canonical. Regenerate via `arc upgrade compass`.
- [ ] Update `docs/agents-md/*.md` sources that reference v1's layout.

### 6.2 Infrastructure

- [ ] Decide the fate of `src/worker/` per §5 (retire, keep, or rewrite for v2's needs).
- [ ] Decide the fate of `src/dashboard/` (default: delete — v2 has its own UI).
- [ ] Update `arc upgrade grove` deploy target to v2.
- [ ] Retire or update the CF Pages dashboard deploy (v2 may self-serve from the local bot; CF Pages deploy may become obsolete).
- [ ] Update the GitHub webhook target if v2's HTTP endpoint lives in a new place.
- [ ] Decommission the v1 production bot wherever it runs (systemd, cloud VM, whatever).

### 6.3 Data

- [ ] Decide the v1 → v2 data migration shape per §5.
- [ ] If migrating, write and test a one-off migration script. Back up v1's data first. Verify state-machine transitions on migrated data.
- [ ] If starting fresh, archive v1's bot DB somewhere safe (`~/.local/share/grove-v1-archive/`) before decommissioning.

### 6.4 Operational

- [ ] Bump major version in `arc-manifest.yaml` (v0.x → v2.0 if we jump, or whatever makes sense).
- [ ] Write the v2.0 release announcement / migration note.
- [ ] Update any external docs, READMEs, website content that describes v1's architecture.
- [ ] Rewrite the Discord channel routing SOP per §5 decision about Discord's role.
- [ ] Audit the compass SOPs that reference Grove-specific patterns to ensure they still apply.

### 6.5 Post-cutover cleanup

- [ ] Delete the `v2` branch (its history is now on main).
- [ ] Close issue #190 (Phase A) and any open v2 phase issues that are subsumed by the cutover.
- [ ] File follow-up issues for anything marked "decide at cutover" that got deferred again.

---

## 7. Deferred refactors worth tracking

Things v2's development is deliberately not fixing that v1's code has today. These are **v1 tech debt that cutover inherits**, and post-cutover work should address them:

- **Dual-dialect schema duplication.** v1 has `src/bot/lib/dashboard-db.ts` (SQLite) and `src/worker/src/db/schema.ts` (D1) with drift between them. v2 skips this by being SQLite-only. If v2 grows a Worker post-cutover, the shared-schema module (`src/common/grove-db/` from the original Phase A plan) becomes real.
- **`sessions.operator_id` schema drift.** Bot has it (`src/bot/lib/dashboard-db.ts:246`), worker does not. v2 declares it from day one in the fresh schema. At cutover, the old drift disappears naturally.
- **Silently-ignored empty catch blocks.** See CLAUDE.md critical rules — v1 has a few historical spots. v2 starts with the rule baked in and has none.
- **`invokeClaudeCode()` dead code.** `src/bot/lib/claude-invoker.ts:66` is unused. Retire it during cutover cleanup.

---

## 8. Update cadence

This doc is a **living artifact until cutover.** Update it when:

- A new deferred refactor is identified during v2 development.
- One of the §5 "uncertain" decisions becomes a decision (move it to §3 or §4).
- A cutover-checklist item gets resolved or refined.

When cutover is complete, this doc becomes historical — move it to `docs/archive/` as a record of the decision trail.
