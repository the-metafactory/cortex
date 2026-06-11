# Refactor: Mission Control Session-Tree Domain Model

**Status:** Planned · **Resolved:** 2026-06-11 (MC session-tree grilling) · **Tracking:** TBD (umbrella issue) · **Schema convergence:** [ADR-0011](adr/0011-unified-mc-session-schema.md)

This is the deterministic refactoring map for moving Mission Control + the dev-loop from
the *"every Claude Code session is an `agents` row"* model to the substrate-agnostic
**session-tree** domain model resolved in `CONTEXT.md` (§Sessions) and
`compass/ecosystem/CONTEXT-MAP.md` (boundary terms `session` / `substrate`, the
projection relationship).

Every section lists `file:line — current behavior — required change`. Line numbers are
from the survey snapshot (2026-06-11); treat them as anchors, re-confirm before editing.

---

## 1. Why

**The bug (observed 2026-06-11):** the dashboard rendered **1,044 identical "Luna —
Observed sessions (unregistered)" tiles**. Root cause: the MC orphan ingestor mints **one
`agents` row per `cc_session_id`**, typed `head` (`db/sessions.ts` `registerOrphanSession`
→ `ensureOrphanAgent`). An overnight autonomous run is a **deep recursive tree of ~1,000
sessions** (425 `tool.agent.spawned` edges); the model flattened that whole tree into
sibling "agent" tiles, and none were reaped (stuck `running`, the prune only catches
terminal rows).

**The target model (substrate-agnostic):**

```
agent          the bus runtime identity (NKey + consumer); ~1 per assistant×stack
  └─ session       one run of a substrate (cc_session_id, interior); belongs to the agent
       └─ child session   a session with parent_session_id → the session that spawned it
            └─ …          recursive
   substrate = claude-code | codex | …   (an ATTRIBUTE of a session, derived from HarnessId)
```

- A **session is not an agent.** Orphan/observed sessions attach to the **real owning
  agent** (Luna), as sessions — not as 1,044 synthetic agents.
- **"sub-agent" is a substrate-projection label** (Claude Code's word for a child session),
  *derived at render* from `substrate` + `parent_session_id != null` — never stored as an
  entity type.
- The working grid renders **agent → its session tree**; sub-agents nest under their parent
  session.

**Canonical schema (ADR-0011).** The MC backend is dual-substrate (local bun:sqlite + cloud
D1), and the two `sessions` schemas had **diverged** (normalized-local vs denormalized-cloud,
no shared source). Per [ADR-0011](adr/0011-unified-mc-session-schema.md), they converge onto
**one identical canonical session schema** from a **single shared source + a CI parity
test** — local **denormalizes** its `sessions` row to the flat canonical shape
(`agent_name`/`principal_id`/`status`/`substrate`/`parent_session_id`/sovereignty as
columns), cloud was already flat. The two differ only in **reach** (local = single-stack,
offline; cloud = network-wide) and **depth** (local holds the interior `events`; cloud is
metadata-only) — **never in shape**. No domain-mapping layer (deferred — two users). The
session-tree fields land in the canonical schema, not bolted onto two diverged ones.

---

## 2. Invariants (must not break)

1. **Session↔assignment binding** stays for **controlled / dispatch** sessions (every read
   query joins from `agent_task_assignment` outward; `db/working-agents.ts:93-182`).
2. **Partial unique indices** on `sessions` stay: `idx_sessions_active_assignment
   (assignment_id) WHERE ended_at IS NULL` (one active controlled session per assignment)
   and `idx_sessions_active_cc_session_id` (no duplicate live observed session).
3. **Terminal → `ended_at` stamping** (`transitions.ts:133-138`) is the new anchor for
   age-based reaping (replaces the `mc-orphan-` id-prefix anchor).
4. **Orphan registration idempotency** — keyed on `cc_session_id` + `ended_at IS NULL`.
5. **Network panel ≠ sessions (ADR-0007).** The G-1114 Network tab is **agent-presence
   topology** (online/offline/capabilities/federation), *never* session interiors. This
   refactor does **not** touch `network-*.tsx` / `lib/agents-display.ts` /
   `lib/network-graph-adapter.ts`. Keep the boundary strict: Network = presence; Working
   grid = session trees.
6. **Dual-backend coherence.** The MC backend is **two databases** — local **bun:sqlite**
   (`db/schema.ts`, `:8767`) and cloud **Cloudflare D1** (`src/surface/mc/worker/`,
   `grove.meta-factory.ai/api/*`) — with **already-diverged** `sessions` schemas. Every
   column/projection change applies to **both, in the same PR** (see §5b). The bus envelope
   is the shared contract feeding both ingest paths — make it the source of truth. (This
   session already hit this exact bug class: the mc/cockpit/grove schema divergence,
   #877/#879.)

---

## 3. Open design decisions (resolve early)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | **Parent-linkage capture** | (a) env-stamp `CORTEX_PARENT_SESSION_ID`; (b) spawn-prompt correlation (`tool.agent.spawned` ↔ child's first prompt); (c) native CC hook field | **Both (a)+(b).** cortex-runner-spawned children (agent-team moderator/participants, dispatched sessions) → **env-stamp (deterministic)**. Claude-Code-`Agent`-tool-spawned children (the orphan flood — the principal's own instrumented run, which cortex's runner never touches) → **prompt-correlation in the ingestor (v1 fallback)**. Adopt native CC parent-session if/when Claude Code exposes it. |
| **D2** | **Orphan session ownership** | (a) keep per-session synthetic agent; (b) attach orphan sessions to the **real owning agent** | **(b).** Stop minting `mc-orphan-{uuid}` agents. An observed session belongs to the owning **agent** (e.g. Luna); store the observed display name as **session metadata**, not an agent row. Collapses 1,044 fake agents → 1 real agent + 1,044 sessions. |
| **D3** | **`sessions.assignment_id`** | (a) keep NOT NULL (synthetic assignment for observed); (b) make nullable | **(a) short-term** (zero blast radius on the assignment-anchored joins), revisit to (b) once reads are session-anchored. The synthetic assignment now points at the **real agent**, not a per-session one. |
| **D4** | **`substrate` column** | (a) `NOT NULL DEFAULT 'claude-code'`; (b) derive from HarnessId at read | **(a).** Store it (cheap, indexable, future substrates self-describe). Set from HarnessId at creation; default `claude-code` for observed hook sessions. |
| **D5** | **Tree expand/collapse state** | local per-grid vs lifted | **Local component state**, default **collapsed** (child sessions shown on expand). Keyboard-navigable (Arrow up/down depth, left/right expand). |

---

## 4. Phases

Phases are dependency-ordered. Each maps to a slice issue under the umbrella.

### Phase 0 — Schema convergence + canonical session model (foundation) — see [ADR-0011](adr/0011-unified-mc-session-schema.md)
Converge local + cloud onto **one identical canonical session schema** from a single shared
source (DDL for both substrates + TS types generated from it; CI **parity test**). Local
**denormalizes** its `sessions` row to the flat canonical columns (keeping `tasks`/
`assignment` underneath for the dispatch control plane, synced on write); cloud adds the two
new columns. The session-tree fields (`parent_session_id`, `substrate`) are part of the
canonical schema. Interiors (`events`) stay local-only (ADR-0005). No behavior change yet —
this is the foundation §5 / §5b / §6 build on.

### Phase 1 — Parent-linkage capture (dev-loop / taps / runner)
Thread `parentSessionId` end-to-end so the tree can be *built*. Per D1: env-stamp for
runner-spawned, capture the field if present.

### Phase 2 — Ingestor: sessions, not agents
Stop minting per-session agents; attach observed sessions to the owning agent; set
`parent_session_id` (env field) or defer to prompt-correlation; set `substrate`.

### Phase 3 — Retention / reaping by session terminal-age
Reap stuck-`running` and terminal sessions by `ended_at` age, not `mc-orphan-` prefix.
(Also the immediate-relief mechanism for the zombie class.)

### Phase 4 — API: `/api/working-agents` projects the session tree
Project `parent_session_id`, `substrate`, `child_sessions[]`, grouped by owning agent.

### Phase 5 — Frontend: render the session tree
DTO rename + the new tree component (expander, indentation, a11y). Substrate-projection
label derived at render.

### Phase 6 — Terminology sweep
Rename `sub-agent`/`subagent` in runner/taps/discord display code to child/spawned-session
per CONTEXT.md.

### Phase 7 — Tests
Update fixtures + add tree/reaping/linkage coverage.

---

## 5. Change matrix — MC backend

`src/surface/mc/`

| File:line | Current | Change | Phase |
|---|---|---|---|
| `db/schema.ts:88-97` (`sessions` DDL) | no parent/substrate cols | **ADD** `parent_session_id TEXT NULL REFERENCES sessions(id) ON DELETE CASCADE`; **ADD** `substrate TEXT NOT NULL DEFAULT 'claude-code'`; optional `observed_agent_name TEXT` | 0 |
| `db/schema.ts:128-151` (indices) | assignment-centric | **ADD** `idx_sessions_parent_session_id`, `idx_sessions_substrate` | 0 |
| `db/schema.ts:56-62` (`agents` DDL) | conflated | keep for **runtime agents only**; add comment "NOT a CC session" | 0 |
| `types.ts:446-454` (`Session`) | `{id, assignment_id, cc_session_id, endpoint_kind, pid, started_at, ended_at}` | **ADD** `parent_session_id?: string \| null`, `substrate: string`, optional `observed_agent_name?` | 0 |
| `types.ts:428-434` (`Agent`) | bare | comment: dispatch/runtime agent, **not** a session | 0 |
| `db/sessions.ts:10-43` (`createSession`) | basic insert | **ADD** params `parentSessionId?`, `substrate` (default `claude-code`), `observedAgentName?` | 0 |
| `db/sessions.ts:235-288` (`ORPHAN_AGENT_PREFIX`, `orphanAgentId`, `ensureOrphanAgent`) | mints `mc-orphan-{cc}` agent per session | **REMOVE** per-session agent minting (D2) | 2 |
| `db/sessions.ts:251-258` (`ensureOrphanTask`) | synthetic catch-all task | keep minimal (D3) — anchors the synthetic assignment, but assignment now points at the **real owning agent**, not a per-session orphan | 2 |
| `db/sessions.ts:311-351` (`registerOrphanSession`) | task + per-orphan agent + assignment + session | **REWRITE**: resolve owning agent (real); insert **session** with `substrate`, `observed_agent_name`, `parent_session_id` (if known); no per-session agent | 2 |
| `hooks/ingestor.ts:93-119` (orphan auto-register) | calls `registerOrphanSession` (mints agent) | call the rewritten path; **set `parent_session_id`** from the event field (Phase 1) or leave null for prompt-correlation; idempotent on `cc_session_id` | 2 |
| `hooks/ingestor.ts` (new) | — | **ADD** prompt-correlation (D1b): on a child's first `UserPromptSubmit`, match a recent `tool.agent.spawned.payload.tool_input.prompt` from another session → set child's `parent_session_id` | 2 |
| `api/handlers.ts:537-551` (`ensureNamedAgent`) | mints agent from wrapper id for observed | **REMOVE/relocate**: store wrapper `agentName` as session metadata, not an agent row | 2 |
| `api/handlers.ts:600-918` (`handleCreateSession`) | ensures named/default agent; branches on kind | observed path: stop `ensureNamedAgent`; pass `substrate`, `parent_session_id`, `observed_agent_name` to `createSession` | 2 |
| `api/handlers.ts:520-527` (`ensureDefaultAgent`) | mints `mc-default-agent` (`hands`) | keep (real dispatch agent); comment "not a session" | 2 |
| `session/endpoint-resolver.ts:89-188` (`spawnControlledSession`) | creates controlled session | pass `substrate='claude-code'`, `parent_session_id=NULL` (top-level dispatch) | 2 |
| `db/retention.ts:100-122` (`selectPrunableOrphanAssignments`) | filters `agent.id LIKE 'mc-orphan-%'` | **REWRITE**: select sessions by `ended_at < cutoff` (terminal) OR stuck-running past TTL; no agent-prefix filter | 3 |
| `db/retention.ts:139-211` (`pruneOrphanSessions`) | deletes session+assignment+orphan-agent | delete **sessions** (CASCADE handles children); no orphan-agent delete | 3 |
| `db/retention.ts:47-65` (consts) | `ORPHAN_RETENTION_MS` | rename `TERMINAL_SESSION_RETENTION_MS`; **ADD** `STUCK_RUNNING_TTL_MS` (reap zombies) | 3 |
| `db/working-agents.ts:93-182` (`listWorkingAgents`) | joins agents→assignments→tasks | **REWRITE** to project, per owning agent, its **sessions** with `parent_session_id`/`substrate`; assemble `child_sessions[]` tree; keep assignment join for lifecycle | 4 |
| `api/agents.ts:162-179` (`handleListAgents`) | runtime presence registry | **NO CHANGE** (bus agents, separate domain) | — |

> **Reaping note (Phase 3 doubles as the zombie fix):** the 1,044 stuck-`running` orphans
> cannot self-clear today (prune is terminal-only). The new `STUCK_RUNNING_TTL_MS` reaper
> closes them on a liveness lapse — same TTL discipline as the G-1114 agent-presence FSM.

---

## 5b. Change matrix — Cloudflare D1 (cloud backend)

**The MC backend is dual-substrate.** The local in-process daemon uses **bun:sqlite**
(`db/schema.ts`, served at `:8767`); production uses **Cloudflare D1** behind the CF Worker
(`src/surface/mc/worker/`, served at `grove.meta-factory.ai/api/*`). The two `sessions`
schemas have **already diverged**:

- **Local:** normalized — `sessions{id, assignment_id, cc_session_id, endpoint_kind, …}` +
  `agents` / `agent_task_assignment` / `tasks`.
- **D1:** flat summary — `sessions{session_id, agent_id, agent_name, project, status, …}`
  (`agent_name` is **already a column** — *no per-session agent row in cloud*; the cloud
  side is structurally closer to the target). Neither has `parent_session_id`/`substrate`.

Both are fed by the **same bus envelope**: local via relay → ingestor; cloud via
`taps/cc-events/cloud-publisher.ts` → `POST /api/ingest` → `worker/src/routes/ingest.ts`.
**Phase 1 (envelope carries `parent_session_id` + `substrate`) is the single upstream
change that feeds both** — the coherence anchor.

| File:line | Current | Change | Phase |
|---|---|---|---|
| `worker/schema.sql:10-37` (`sessions` DDL) | no parent/substrate | **ADD** `parent_session_id TEXT`, `substrate TEXT DEFAULT 'claude-code'` | 0 |
| `worker/schema.sql:137-141` (indices) | status/principal | **ADD** `idx_sessions_parent_session_id`, `idx_sessions_substrate` | 0 |
| `worker/migrations/0005_session_tree.sql` (**NEW**) | next after 0004 | `ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;` + `ADD COLUMN substrate TEXT DEFAULT 'claude-code';` + the two indices; bump `schema_version` (mirror 0004 format) | 0 |
| `worker/src/routes/ingest.ts:172-177` (INSERT sessions) | no parent/substrate | write `parent_session_id`, `substrate` from the event payload | 2 |
| `worker/src/routes/ingest.ts:177` (`ON CONFLICT … DO UPDATE`) | COALESCE later events | COALESCE-set the two new cols so later events fill nulls | 2 |
| `worker/src/routes/ingest.ts:213,279` (UPDATE sessions) | lifecycle updates | preserve the two new cols | 2 |
| `worker/src/routes/state.ts:243-248,406-409` (session projections) | select `agent_id, agent_name, …` | **SELECT** `parent_session_id`, `substrate`; assemble the **tree** in the cloud state response | 4 |
| `/api/working-agents` (cloud) | **NOT served by the worker** (grep: none) | cloud working-grid reads `/api/state`; ensure that response carries the session tree, or add a worker `/api/working-agents` mirroring the local projection | 4 |
| deploy | — | apply the D1 migration **dev → prod** (`wrangler d1 migrations apply <DB> --env dev`, verify, then `--env production`) per `compass/sops/deployment.md` | — |

> **Divergence-coherence rule.** Any change to the session columns or their projection MUST
> land in **both** backends in the **same PR**: bun:sqlite DDL + queries AND D1
> schema.sql + migration + worker queries. A column added to one and not the other silently
> renders the tree on one surface and not the other. The envelope (Phase 1) is the shared
> contract both ingest paths read — fix it once, both backends inherit the fields.

---

## 6. Change matrix — dev-loop / runner / taps

`src/runner/`, `src/taps/`, `src/common/`

Per **D1**, the robust path for runner-spawned children is the env-stamp
`CORTEX_PARENT_SESSION_ID`; the EventLogger reads it like any other `CORTEX_*` surface env.

| File:line | Current | Change | Phase |
|---|---|---|---|
| `taps/cc-events/hooks/lib/event-types.ts:13-33` (`RawEventSchema`) | no parent field | **ADD** `parent_session_id?: z.string().optional()` | 1 |
| `taps/cc-events/hooks/lib/event-types.ts:41-51` (`PublishedEventSchema`) | — | **ADD** `parent_session_id?` | 1 |
| `taps/cc-events/hooks/lib/event-types.ts:59-81` (`createRawEvent`) | — | **ADD** `parentSessionId` option; stamp into result | 1 |
| `taps/cc-events/hooks/EventLogger.hook.ts:39-52` (`HookInput`) | `session_id?` only | **ADD** `parent_session_id?` (note: not native — see D1) | 1 |
| `taps/cc-events/hooks/EventLogger.hook.ts:~172` | reads `session_id` only | **ADD** `const parentSessionId = hookInput.parent_session_id ?? process.env.CORTEX_PARENT_SESSION_ID ?? undefined` | 1 |
| `taps/cc-events/hooks/EventLogger.hook.ts:247-251` (`createRawEvent` call) | passes session/tool/network | **ADD** `parentSessionId` | 1 |
| `taps/cc-events/cc-events.ts:199-215` (`createCcEventEnvelope`) | flattens event | carry `event.parent_session_id` into `payload.parent_session_id` when present | 1 |
| `runner/cc-session.ts:22-85` (`CCSessionOpts`) | no parent | **ADD** `parentSessionId?: string` | 1 |
| `runner/cc-session.ts:130-153` (`buildSessionEnv`) | builds `CORTEX_*` | **ADD** `...(opts.parentSessionId && { CORTEX_PARENT_SESSION_ID: opts.parentSessionId })` | 1 |
| `runner/claude-invoker.ts:23-38` (`ClaudeInvocationOpts`) | no parent | **ADD** `parentSessionId?: string` (carried via env, not CLI arg) | 1 |
| `runner/agent-team.ts:106-159` (`AgentTeamOpts`) | no parent | **ADD** `parentSessionId?: string` | 1 |
| `runner/agent-team.ts:287-302` (`buildTeamOpts`) | maps DispatchRequest→opts | map `req.runtime?.parentSessionId` | 1 |
| `runner/agent-team.ts:~575` (moderator spawn) | no parent | thread `parentSessionId: this.opts.parentSessionId` | 1 |
| `runner/agent-team.ts:~686` (participant spawn) | no parent | thread `parentSessionId` | 1 |
| `runner/agent-team.ts:~864` (synthesis spawn) | no parent | thread `parentSessionId` | 1 |
| `common/substrates/types.ts:236-292` (`DispatchRuntime`) | `resumeSessionId` etc | **ADD** `parentSessionId?: string` | 1 |
| `runner/dispatch-listener.ts:192-229` (`DispatchTaskReceivedPayload`) | wire schema | **ADD** `parent_session_id?: string` | 1 |
| `runner/dispatch-listener.ts:~1570` (`buildDispatchRequest`) | maps payload→runtime | map `payload.parent_session_id → req.runtime.parentSessionId` | 1 |
| `substrates/claude-code/harness.ts` (locate) | builds `CCSessionOpts` | thread `req.runtime.parentSessionId → CCSessionOpts.parentSessionId` | 1 |
| `runner/session-manager.ts:6-11` (`SessionEntry`) | thread↔session map | **NO CHANGE** (domain conversation map, not substrate) | — |

### Terminology sweep (Phase 6) — rename substrate-label "sub-agent" → child/spawned session

| File:line | Current | Change |
|---|---|---|
| `runner/agent-team.ts:3` | "Sub-agent team orchestration" | "Child-session (moderator + participant) orchestration" |
| `runner/cc-session.ts:328` | "clean up sub-agents" | "clean up child sessions" |
| `runner/worklog-formatter.ts:7,26,31-36` | `isSubAgentEvent`, "sub-agent prompts" | `isSpawnedSessionEvent`; "spawned-session prompts (Agent-tool child CC sessions)" |
| `runner/worklog-manager.ts` (grep `sub-agent`) | comments | "spawned/child session" |
| `common/event-utils.ts:85` | `label: "subagent"` | `label: "spawned-session"` (or `"child-session"`) |
| `adapters/discord/event-formatter.ts` (grep) | `tool.agent.spawned` → "subagent" | display label → "spawned-session" |

> Keep "sub-agent" only where it genuinely means *the Claude Code substrate label* (docs,
> user-facing CC-lens copy). In the **model / schema / API**, say **child session**.

---

## 7. Change matrix — MC frontend

`src/surface/mc/dashboard-v2/`

| File:line | Current | Change | Phase |
|---|---|---|---|
| `hooks/use-working-agents.ts:22-47` (`WorkingAgentTile`, response, state) | flat agent-tile DTO (`agent_id`, `agent_name`, `agent_type`, scalar state) | **RENAME → `SessionTreeTile`**: `session_id`, `parent_session_id`, `substrate`, owning `agent_id`, `session_label`, `child_sessions: SessionTreeTile[]`, `primary_session{state,...}`, `additional_active_sessions_count`; drop `agent_type` | 5 |
| `components/working-grid.tsx:25-127` | flat `.map(agent => tile)` | **RENDER TREE**: group by owning **agent**; per session render tile with **derived substrate-projection label**; expander + nested `child_sessions` (D5); keyboard tree nav | 5 |
| `lib/working-grid-display.ts:10-52` (`pickWorkingGridMode`) | `agents` input | rename `agents → sessions`; "tiles" mode = render tree; branching logic unchanged | 5 |
| `lib/` (new) | — | **ADD** `substrate-label.ts`: pure `(substrate, hasParent) → display label` ("sub-agent" for `claude-code`+parent; substrate-neutral otherwise) | 5 |
| `app.tsx:82,150-201` | `useWorkingAgents`; `<WorkingGrid agents=…>` | prop rename `agents → sessions`; dispatch handlers unchanged (agent-scoped) | 5 |
| `lib/network-detail-display.ts:96-109` (`selectAgentDispatchActivity`) | per-agent activity join | rename `selectAgentDispatchSessions`; return `{primarySession, additionalSessions[]}` (still lifecycle-metadata only — ADR-0007) | 5 |
| `components/network-detail-panel.tsx:56-109` | consumes the join | consume renamed/tree-shaped join | 5 |
| text/aria: `working-grid.tsx:91,96` | "Working agents" / "No agents working" | "Working sessions" / "No sessions active" | 5 |
| CSS `working-grid.tsx` (`.agent` etc.) | agent classes | `.session-tile`/`.session-label`/tree-row classes | 5 |
| `components/agent-chips.tsx`, `drill-header.tsx` | assignment **agent** labels | **NO CHANGE** (assignment = agent-level contract) | — |
| `lib/agents-display.ts`, all `network-*.tsx`, `network-graph-adapter.ts` | agent-presence topology | **NO CHANGE** (Network ≠ sessions; ADR-0007) | — |
| `components/metrics-panel.tsx:213` | "No agent activity…" | **NO CHANGE** (per-agent aggregate) | — |

---

## 8. Tests (Phase 7)

| File | Change |
|---|---|
| `mc/__tests__/sessions-db.test.ts` | cover `createSession` with `parent_session_id`, `substrate` |
| `mc/__tests__/ingestor.test.ts` | assert orphan insert creates a **session row, not an agent row**; parent set from event field; prompt-correlation path |
| `mc/__tests__/retention-prune.test.ts` | rewrite: terminal-age + stuck-running-TTL reaping; no agent-prefix filter |
| `mc/__tests__/agents-ensure-row.test.ts` | clarify: dispatch agents only; observed sessions mint no agent row |
| `dashboard-v2/__tests__/working-grid.test.tsx` | `sessionTile()` fixtures; tree render, expand/collapse, keyboard nav, derived substrate label |
| `dashboard-v2/__tests__/network-detail-display.test.ts` | renamed join DTO |
| taps/runner | env-stamp test: spawning a child sets `CORTEX_PARENT_SESSION_ID`; EventLogger carries `parent_session_id` into the envelope |

---

## 9. Sequencing

```
Phase 0 (schema+types) ─┬─> Phase 1 (capture: taps/runner)
                        └─> Phase 2 (ingestor) ──> Phase 3 (reaping)
                                                └─> Phase 4 (API projection) ──> Phase 5 (frontend)
Phase 6 (terminology) — independent, any time
Phase 7 (tests) — alongside each phase
```

Phase 3 can ship **first** as standalone zombie relief (reap stuck-running by TTL) even
before the tree lands. Phases 4→5 are the visible payoff (the grid stops flattening the
tree). Phase 1 is the prerequisite for *accurate* (non-correlation) parenting of
runner-spawned children.

---

## 10. Provenance

- Domain model resolved in `CONTEXT.md` §Sessions + Flagged ambiguities (2026-06-11) and
  `compass/ecosystem/CONTEXT-MAP.md` (boundary terms `session`/`substrate`; projection
  relationship).
- Empirical basis: 1,029 distinct sessions / 425 `tool.agent.spawned` edges in the
  2026-06-10 overnight backlog; Claude Code emits no native child→parent session pointer
  (parent linkage is split across the parent's `tool.agent.spawned` event and the child's
  first prompt).
- ADR-0007 boundary preserved: Network view = agent presence; this refactor = working-grid
  session trees. The two never merge.
