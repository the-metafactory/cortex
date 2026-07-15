# Grove as Collaboration Surface — Design Spec

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-collaboration-surface.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Status:** Design — proposes a re-positioning of Grove inside the new metafactory layered architecture (myelin protocol + signal observability + pilot review loop). Supersedes nothing; reframes the existing Mission Control v3 work as one application of a more general layered model.
**Date:** 2026-05-08
**Driver:** Andreas
**Scope:** Cross-cutting — touches mc-v3 (`docs/design-mission-control.md`, `docs/iteration-mc-dispatch-observe.md`), the agent-visibility roadmap (`docs/design-agent-visibility.md`), and the relationship between Grove and four sibling repos: `myelin/`, `signal/`, `blueprint/`, `compass/`, `pilot/`.
**Related:**
- `docs/design-mission-control.md` — the principal's cockpit (still the load-bearing UX spec)
- `docs/design-mc-f10-principal-input.md` — principal approval flow (the pattern this doc generalises)
- `docs/design-agent-visibility.md` — worklog channel + dashboard (the v1 surface)
- External: `~/Developer/myelin/ISA.md`, `~/Developer/signal/docs/design-signal-bundle-migration.md`, `~/Developer/blueprint/docs/design-event-sync.md`, `~/Developer/metafactory-f102-design/VISION.md`

---

## 1. Why this exists

Grove was originally built as a **bridge** — a synchronous Discord/Mattermost adapter that wrapped Claude Code sessions and made their output visible in chat. Agents pinged each other through Grove. Reviews happened through Grove. Principal approvals went through Grove. The bot was both the transport *and* the surface.

The metafactory direction has changed. Two things have moved to the foundation:

1. **myelin** is now the message envelope. Agent-to-agent traffic — pings, reviews, approval requests, status events — is being lifted onto a plain NATS bus with a published JSON-Schema envelope (`~/Developer/myelin/schemas/envelope.schema.json`) and a three-prefix subject namespace (`local.` / `federated.` / `public.` — see `~/Developer/myelin/specs/namespace.md`). Sovereignty (data residency, model class, hop count) travels in the envelope itself.
2. **signal** is now the observability tap. Tool calls, skill invocations, subagent spawns, and session lifecycle are emitted as OTLP spans on the same NATS bus under `mf.net-{principal}.trace.>` (`~/Developer/signal/docs/design-signal-bundle-migration.md`). Principals choose any OTLP backend (Grafana Cloud, Honeycomb, Datadog, self-hosted VictoriaMetrics) without changing the tap.

Both run *under* Grove, on a transport Grove doesn't own. Two consequences for Grove:

- **Loss of visibility by default.** When agents collaborate via myelin envelopes (review pings, fix-and-ack cycles, dispatch hand-offs) instead of through Grove's `messageCreate` handler, the activity is no longer in chat history. The principal sees the *result* of collaboration but not the *fact* of it. This is the failure state the rethink is designed against.
- **Grove stops being middleware.** Grove is no longer the wire — the wire is NATS+myelin. Grove becomes the **principal's surface**: the place where the human looks at what's happening, drills in, gives approval, gives input, redirects work. It is, literally, *the "+" in "AI + human"*. Everything below the "+" is machine-to-machine traffic on the bus; Grove's job is to make that traffic legible and actionable to the one human who needs to stay in the loop.

This document does two things. First, it places Grove inside a layered concern map so the boundaries between Grove, myelin, signal, blueprint, and compass are clear. Second, it specifies what changes in Grove's product surface so the under-the-hood collaboration becomes visible again — without re-coupling Grove to the wire.

### 1.1 Vision — the Flybridge command centre

The metaphor for the principal's view is a **flybridge command centre**: a single elevated cockpit where the principal can see the whole vessel at a glance and reach down into any subsystem. From the flybridge, the principal should be able to:

- See **aggregate** activity across all agents in flight — not a chronological event firehose, but a synthesised "what is the system doing right now?"
- **Drill down** from any aggregate into a single task, a single agent, a single review thread, a single SOP gate.
- See **principal-input requirements** without hunting for them — "what needs me?" is a first-class column, not a side effect of reading logs.
- Get **review-orientation support** when input is required: what was the work, what's the background, what's been done, what specifically is needed to unblock — without having to reconstruct context from raw event history. This is the load-bearing UX rule for §5.4 below.

Three existing reference dashboards in `~/Developer/` ground the implementation patterns. They are already cited extensively in `docs/design-mission-control.md` and `docs/design-mc-f10-principal-input.md`; this design doesn't add new reference systems, only reads them through the layered-model lens:

| Reference | What we borrow | Where in `~/Developer/` |
|-----------|----------------|-------------------------|
| **Maestro** | Stream-json input model, stdout chunk batching with RAF, ToolCallCard + TerminalOutput patterns, executionQueue client-side, paste/drag-drop image affordance | `~/Developer/maestro` (Electron over agent harnesses) |
| **Paperclip** | The "autonomous priority pull" pattern — explicitly *not* adopted in v1 (§7.6 of `design-mission-control.md`); referenced as the pattern to grow into when heartbeat-mode arrives | `~/Developer/paperclip` |
| **miner** | Event schema shape (event_id / event_type / timestamp / session_id / source / payload), extractive summarisation pattern, rich-context rendering | `~/Developer/miner` (metafactory process-mining repo) |

The Collaboration Surface is the layer-7 expression of those patterns over the layer-1..6 foundation described in §2.

### 1.2 KPIs — what good looks like

The flybridge isn't just visibility — it's optimisation. Four KPIs the surface should expose at the aggregate level (with drill-down into individual contributors) and continuously trend:

| KPI | Definition | Why it matters | Surface treatment |
|-----|------------|----------------|-------------------|
| **Cycle time** | Time from task entering INBOX to task DONE (per task, p50/p95 across cohort) | The single best signal that the surface is actually accelerating work, not just observing it | Per-card badge + iteration-level chart; segment by source kind |
| **PR throughput** | PRs merged per principal-day (or per agent-day for autonomous flows) | Volume of work shipped — guards against "looks busy but ships nothing" | Daily counter + 7-day trend on the existing F-18 metrics panel |
| **Human-input wait time** | Cumulative time tasks spend in NEEDS-ME (the inbox) per cohort | This is the *downtime* the flybridge is designed to reduce — the principal-bottleneck KPI | Per-card timer on cards in NEEDS-ME; aggregate "principal latency" widget on the flybridge header |
| **Token usage** *(secondary)* | Tokens consumed per task / per agent / per principal-day | Cost transparency, useful but not load-bearing for v1; the same KPI the existing token-usage monitor (G-206) already exposes | Drill-down only; do not promote to the header until cycle-time and human-wait are landed |

The first three optimise the same underlying loop: **less time waiting on humans → more time shipping work.** Token usage is an honest secondary because it doesn't move that loop; it's a cost-management dial, not a throughput dial. (Per principal instruction 2026-05-08: token usage is "secondary, not important now" — capture as a dimension, not a top-line metric.)

These KPIs map onto existing Grove infrastructure: F-18 (`docs/design-mc-f18-metrics.md`) is the metrics panel; G-206 is the token monitor. The work in §8 below extends those panels with the cycle-time + human-wait-time computations and exposes them on the flybridge header.

---

## 2. The layered concern map

![Event architecture — three event classes share NATS as transport, differ in subject prefix, retention, and audience](diagrams/collaboration-surface__event-architecture.jpg)

*Figure 1 — Event architecture overview. Producers (agents, surfaces, external webhooks) publish onto a four-lane NATS bus (`events.>`, `trace.>`, `metric.>`, `log.>`). Consumers split into a hot path (Grove subscribes narrowly to `events.>` for the surface), a cold path (signal-collector taps the telemetry lanes for the observability stack — TSDB, Loki, Tempo), and a replay path (JetStream stream + D1 projection with `last_event_id` checkpoint). Source: `docs/diagrams/collaboration-surface__event-architecture.jpg`.*

The metafactory ecosystem now decomposes cleanly into seven layers. Each layer has one job, one primary artifact, and lives in one (or one canonical) repo. Like the OSI model, the layers are independent: a host can replace any one layer without touching the others, as long as it honours the contracts at the boundary.

| # | Layer | Job | Primary artifact | Primary repo |
|---|-------|-----|------------------|--------------|
| 1 | **Transport** | Move bytes between agents, hosts, and principals. | NATS server + leaf-node federation | `the-metafactory/nats` (config) + upstream NATS |
| 2 | **Envelope** | Wrap every message in one universally-parseable schema with sovereignty travelling inside the message. | `envelope.schema.json` + `namespace.md` | `the-metafactory/myelin` |
| 3 | **Telemetry** | Emit structured agent activity (tool use, skill invocation, subagent lifecycle) onto the bus as OTLP. | Hooks + W3C trace context lib + OTLP envelope builder | `the-metafactory/signal` |
| 4 | **Coordination** | Agent-to-agent protocols built on the envelope: dispatch, observe, review, approve, hand-off. | Event taxonomies + interaction patterns | `the-metafactory/grove-v2` (`src/hooks/lib/event-taxonomy.ts`) + `the-metafactory/pilot` |
| 5 | **Process** | Standard operating procedures, playbooks, gates, governance. The *how* of doing work. | SOPs + governance skill | `the-metafactory/compass` |
| 6 | **Knowledge graph** | Track what work exists, what depends on what, what's blocked, what's done — across repos. | `blueprint.yaml` per repo + cross-repo CLI | `the-metafactory/blueprint` |
| 7 | **Surface** | Make the layers below legible and actionable to humans. Trigger work in. Surface decisions out. | Web UI, Discord adapter, CLI | `the-metafactory/grove-v2` |

This is the "+" in "AI + human collaboration" mapped onto a stack: layers 1-3 are pure machine substrate, layer 4-5 are how machines collaborate using process artifacts, layer 6 is the durable graph of what's happening, and layer 7 is where the human plugs in.

### A note on independence

Layers compose top-down via well-known artifacts, never via runtime imports. A real example: `signal` MUST NOT `import from grove/src/` — it publishes to a subject and lets Grove (or any other surface) subscribe (`~/Developer/signal/README.md`, "Coupling Rules"). Grove can be replaced by a different surface (a phone app, a TUI, a Slack adapter) without touching myelin or signal. Equivalently, the storage backend behind signal can be anything OTLP-compatible; Grove neither knows nor cares.

This is the upgrade over the old design, where Grove's `grove-bot.ts` was simultaneously transport, coordinator, observer, and surface — every one of those concerns has now moved to its proper layer.

### What this means for Grove

Grove sits at layer 7 — and *only* layer 7. Existing pieces that look like layer 4 work (event-taxonomy, role resolver, security preamble, response poster) remain in Grove because they shape how Grove subscribes to the bus and renders for humans. They do not transit between agents anymore — agents transit on myelin envelopes published directly to NATS, with Grove subscribing as just another consumer.

---

## 3. Two "blueprints" — disambiguation

The word "blueprint" is overloaded across the ecosystem. Confusing the two costs hours.

| Name | What it is | Lives in | When you mean this |
|------|------------|----------|--------------------|
| **metafactory blueprint** | A CLI + per-repo `blueprint.yaml` schema that tracks features and dependencies *across* repos. Layer 6 of the model above. Computes `ready` / `blocked` / `next` from the dependency graph. | `the-metafactory/blueprint` | Whenever the user (or this doc) says "blueprint" without qualification |
| **arc blueprints** | Per-agent-package configuration shipped by the `arc` package manager (`agent-installer` patterns, manifests). Concerned with installing *a single* agent into a host. | `the-metafactory/arc` and per-agent repos | Only when explicitly prefixed `arc blueprint` |

This document uses "blueprint" exclusively for the metafactory-blueprint sense. Where arc blueprints come up (e.g., `grove install signal-collector --profile=...`) the qualifier is included.

There is also a third unrelated overload — Stripe's "Minions blueprints" (deterministic agent graphs — see `~/Developer/research-stripe-blueprints-and-ea-frameworks.md`). When that comes up, it is always prefixed "Minions".

---

## 4. What Grove already is

Grove v2 already implements a substantial fraction of the layer-7 surface. The rethink is about **completing** the picture, not replacing it. The honest inventory:

### 4.1 Surfaces that already exist

| Component | What it does | Where |
|-----------|--------------|-------|
| **Mission Control v3** — Web dashboard at `grove.meta-factory.ai` | Principal cockpit: focus area, attention view, task table, working grid, iteration kanban, metrics panel | `src/dashboard/` (React) + `src/worker/` (Cloudflare Worker / Hono REST + D1) |
| **Discord bot** | messageCreate handler, role-based access, async/team modes, response posting | `src/bot/grove-bot.ts` and `src/bot/lib/*` |
| **CC session wrapper** | `claude --print --output-format stream-json` parser, per-thread session resume | `src/bot/lib/cc-session.ts`, `session-manager.ts`, `stream-parser.ts` |
| **Event pipeline** | EventLogger hook → JSONL → relay (policy filter) → published events → bot → API | `src/relay/`, `src/hooks/`, `src/bot/lib/event-taxonomy.ts` |
| **GitHub webhook ingestion** | HMAC-validated events (`pr_merged`, `issue_closed`, `push`, `release`) into a unified activity timeline | `src/webhook-proxy/` (CF Worker at `hooks.meta-factory.ai`) → `src/worker/` |
| **Principal-input affordance** | Per-task drill-down with text + screenshot return path that resumes the agent | `docs/design-mc-f10-principal-input.md`, dashboard drilldown |
| **Discord CLI** | `discord post --thread …` from any terminal session | `src/cli/discord.ts` (`~/bin/discord`) |
| **Dispatch button (F-19)** | One-click dispatch of a curated task to an agent, with 2 s server-side debounce on `(taskId, agentId)` | `src/dashboard/components/dispatch-button.tsx`, `handleCreateSession` |
| **Observed session registration (F-20.A–F)** | `cldyo-live` wrapper registers a UUID with the API before exec; ingestor auto-transitions `dispatched → running → completed` from hook events; `endpoint_kind` surfaced on `/api/tasks` | `src/cli/cldyo-live`, `POST /api/sessions`, ingestor |

### 4.2 Surfaces that don't yet exist (the gap)

| Gap | Why it matters | Today |
|-----|----------------|-------|
| **Agent-to-agent visibility** — review pings, fix-and-ack cycles, hand-offs between agents | These are the *interesting* moments in collaboration; they used to ride through Grove's chat plumbing and now ride past it on myelin envelopes | Agents use myelin and pilot directly; Grove sees nothing |
| **OTLP / signal cohabitation** — telemetry alongside CloudEvents, with the surface able to drill from a task → its trace tree | Principals currently pivot to Grafana to see what tools/skills an agent ran | Two surfaces, one task |
| **Process traceability** — which SOP an agent is following, which gate it's at, what's left to satisfy the gate | "Did the agent skip the security review SOP?" is unanswerable today | Compass SOPs are markdown the agent reads; the surface has no idea |
| **Cross-repo blueprint visibility** — a feature in `grove:G-204` blocked on `arc:A-103` should be obvious from the surface | Principals read `blueprint ready` in the terminal | CLI-only; the dashboard treats grove as an island |
| **Multi-trigger inbox** — principal-input items can arrive from CC backend, pilot bot, signal alerts, blueprint state changes; today they're scattered | One unified "needs you" queue is the load-bearing UX | F-7 attention view is the seed; needs broadening |

The rethink in §5 is the design for closing those gaps without re-coupling Grove to the wire.

---

## 5. The Collaboration Surface

Grove v2 + the gaps above + the layered model = a coherent product I'll refer to as **the Collaboration Surface**. It is what the principal opens when they want to *see and steer*.

### 5.1 Core metaphor — Kanban over a live event stream

The surface is fundamentally a Kanban board where each card is a **work item** (a curated task, an in-flight feature, an issue, a PR), and the column states track the lifecycle:

```
INBOX        SCHEDULED       IN-FLIGHT       IN-REVIEW       NEEDS-ME       DONE
  │             │               │                │              │             │
  │             │               │                │              │             └─ historic record, drill-down still works
  │             │               │                │              └─── principal-action queue (F-10 generalised)
  │             │               │                └─── PR open, Luna reviewing, pilot babysitting (the under-the-hood loop)
  │             │               └─── agent dispatched (F-19) or observed (F-20), running
  │             └─── triaged into the queue (F-12 task curation), awaiting an agent
  └─── new GitHub issue / new pilot ping / new principal note
```

Today's `task-table.tsx` + `working-grid.tsx` + `iteration-board.tsx` are the seed of this. The change is widening "what counts as a card" beyond mc-v3's `tasks` row to include **anything a principal might want to see, steer, or approve**:

- A curated task (existing).
- An in-flight feature with attached PR (new — sourced from blueprint + GitHub).
- A pilot review cycle (new — sourced from pilot's `errands.sqlite` projected onto the bus, or directly subscribed via myelin).
- An iteration in flight (existing — `iteration-board.tsx`).
- An principal-action item (existing — F-10 drill-down — but generalised to receive items from any trigger source).

### 5.2 Drill-down — task → trace → context

Clicking a card opens a drill-down with three stacked views, all live:

1. **Activity timeline** (top). Time-descending stream of CloudEvents *and* OTLP spans for this task. The fact that two channels share a NATS bus (`mf.net-*.events.>` for product events, `mf.net-*.trace.>` for OTLP — see `~/Developer/signal/docs/design-signal-bundle-migration.md`) is invisible to the principal: the surface joins them by `correlation_id` from the myelin envelope.
2. **Conversation / review log** (middle). Pilot review thread, agent reasoning excerpts, principal notes, Discord thread mirror. This is where the "agents pinging each other" becomes visible — every myelin envelope on `local.{org}.review.>` and `local.{org}.dispatch.>` lands here in time order.
3. **Artifacts panel** (bottom). Linked PR, linked issue, iteration-plan checkbox progress, applicable SOP from compass, blueprint dependency status. Each entry is a hyperlink to the corresponding artifact in its native repo.

The point of stacking these is: in one open card, the principal sees *what happened* (timeline), *why* (review log), and *against what* (artifacts).

### 5.3 The "needs-me" inbox — one queue, many triggers

This is the most important UX primitive in the rethink. It generalises mc-v3's F-7 attention view from "tasks blocked on me" to "anything the human needs to look at." It is a single, prioritised, unified inbox; whatever feeds it doesn't matter.

Trigger sources (must support at least these three at v1):

| Source | What gets enqueued | Today |
|--------|--------------------|-------|
| **Claude Code backend** | An agent's session hit a stop hook (Bash guard, permission prompt, an explicit human-in-the-loop pause). This is the existing F-10 pattern. | Already implemented for mc-v3 controlled sessions. Generalise to observed (cldyo-live) sessions too. |
| **pilot bot** | A PR review cycle has produced findings that pilot couldn't auto-fix; needs principal decision (apply / defer / dismiss). Pilot's errand DB lives at `~/.metafactory/agents/pilot/errands.sqlite` and pilot already pings on Discord; we want it on the surface. | Currently lives only in pilot's own dashboard.md and Discord pings. Subscribe to pilot's myelin envelopes (`local.{org}.pilot.errand.needs-decision`) and surface in the inbox. |
| **signal observability** | A trace anomaly: agent in a tight loop, exceeding token budget, error rate > threshold, sovereignty violation (`max_hop` exceeded, frontier-only signal hitting a frontier-disallowed agent). | Doesn't exist yet. signal layer 2 (collector profiles) is the natural place to define these and emit `local.{org}.signal.alert.>` envelopes the surface subscribes to. |
| **blueprint state changes** | A feature transitioned to `ready` (dependencies just finished). Principal decision: dispatch now? defer? add a constraint? | `blueprint ready` is CLI-only today. Surface it as inbox cards once `B-202` (event-driven status sync) lands. |
| **GitHub events** | A PR review has been left, a CI run failed on `main`, an issue was assigned to a person who's offline. | Some of this already lands in the activity timeline (G-203). We want a curation step that promotes a subset to the inbox. |

The contract is: anything that wants the principal's attention publishes a myelin envelope on `local.{org}.attention.>` (or its source-specific subject), with a known minimum payload (`subject_id`, `summary`, `context_url`, `urgency`, `source_kind`). The surface subscribes, dedupes, ranks, renders. New trigger sources cost one envelope schema entry, not a Grove change.

### 5.4 Principal-input return path — symmetric to triggers

Today's F-10 principal-input flow is the *return* half of the loop: principal types, attaches a screenshot, hits send, agent resumes (`docs/design-mc-f10-principal-input.md`). The rethink keeps this exact mechanism for controlled CC sessions and generalises the rest:

- For pilot errands: principal-input is decision metadata (`apply` / `defer` / `dismiss` + optional note). Posted as an envelope on `local.{org}.pilot.errand.decision`. Pilot's CLI already supports these state transitions; we just give them a UI affordance.
- For observed sessions: principal-input is *out of band* — there is no live process to send to. The "input" is a Discord ping-back to the human running `cldyo-live` plus a written note attached to the task. Honest framing: we can't unblock an observed session, only annotate it.
- For blueprint cards: principal-input is metadata attached to the feature (`status` change, `note`, `assignee`, `priority`).

The pattern is the same in every case: principal hits one affordance per card, the surface emits one envelope on the appropriate subject, the relevant downstream system picks it up. No new pipes; new payload types on existing pipes.

### 5.5 Artifact-aware rendering

A first-class anti-goal for the rethink is **flat event lists**. The surface's job is to give the principal context, not just chronology. So every card in the Kanban knows its **artifact bundle**:

| Artifact type | Where it lives | What the surface does with it |
|---------------|----------------|-------------------------------|
| **Iteration plan** | `docs/iteration-{slug}.md` in each repo | Render the checkbox tree alongside the card. Tick boxes when GH issues / PRs close (see B-202 in `~/Developer/blueprint/docs/design-event-sync.md`). |
| **Umbrella issue** | GitHub issue with `feature` or `epic` label | Card groups its child PRs and tasks under the umbrella issue's identity. |
| **Research doc** | `docs/research/research-*.md` per repo | Linked from the card if mentioned in the iteration plan or design doc. |
| **Design spec** | `docs/design-*.md` per repo | The source of acceptance criteria; surface highlights the criteria not yet satisfied. |
| **SOP** | `compass/sops/{name}.md` (`~/Developer/compass/sops/`) | Surface displays which SOPs apply to the current work, which gates have been crossed, which are pending. Compass currently has 10 SOPs: `brainstorming-and-review`, `deployment`, `design-process`, `dev-pipeline`, `new-repo-pattern`, `pr-review`, `release-checklist`, `retrospective-and-process-mining`, `versioning`, `worktree-discipline` (replace this list dynamically by reading the directory at render time). |
| **Blueprint dependency** | `blueprint.yaml` resolved by `blueprint`'s CLI | A small "blocked by" / "unblocks" badge on each card, hyperlinked to the depended-upon feature even when it's in another repo. |

The principle from `~/Developer/metafactory-f102-design/VISION.md` applies: *"The act of doing work through agentic tools IS the process mining."* The artifacts already exist as side effects of running work. The surface's job is to gather, render, and link — never to be the source of truth for any of them.

### 5.6 Visual sketch (text mock)

```
┌─ Collaboration Surface ─────────────────────────────────────────────────────┐
│ [Focus] [Inbox 4] [Tasks] [Iterations] [Reviews] [Activity] [Metrics] [⚙]   │
├─────────────────────────────────────────────────────────────────────────────┤
│ ── INBOX (4) ───────────────────────────────────────────────────────────── │
│ [pilot]   PR #57 — 3 review comments awaiting decision      grove · 2m ago │
│ [signal]  Agent "luna" exceeded 80% rate-limit              session · 5m   │
│ [cc]      Agent paused on Bash guard — needs approval       grove · just   │
│ [bp]      grove:G-1101 became ready (deps just merged)       blueprint · 3h │
│                                                                             │
│ ── KANBAN ───────────────────────────────────────────────────────────────── │
│ INBOX        │ SCHEDULED   │ IN-FLIGHT   │ IN-REVIEW   │ NEEDS-ME │ DONE   │
│ ─────────────┼─────────────┼─────────────┼─────────────┼──────────┼─────── │
│ G-1103 spec   │ G-1101 metr  │ F-21.A obs  │ PR #57 sigl │ ↑ inbox  │ F-20.F │
│ #44 typenit  │ G-1102 sov   │ F-22 inbox  │ PR #56 dispt│  4 items │ F-20.A │
│              │             │   (luna)    │   (pilot)   │          │        │
└─────────────────────────────────────────────────────────────────────────────┘

(click any card → drill-down with timeline + review-log + artifacts)
```

This is a sketch, not a screen design — but it shows the load-bearing primitive: a single surface where the four mc-v3 pieces (focus area, attention, task table, iteration board) merge into a Kanban + inbox, fed by every layer below.

### What this means for Grove

The surface as described is **mostly built**. Mission Control v3's components — `task-table`, `working-grid`, `iteration-board`, drilldown, dispatch button, observed-session badge — are the bones of every column in the Kanban above. The work is:

1. **Widen subscriptions**: Grove's bot needs to subscribe to `mf.net-*.trace.>` (signal) and `local.{org}.pilot.>` and `local.{org}.attention.>` envelopes, and project them into the existing dashboard data model. This is mostly a `nats-publisher.ts`-style subscriber and a few new event handlers in `event-taxonomy.ts`.
2. **Generalise the inbox**: F-7 attention view becomes the multi-source inbox in §5.3. One Hono REST route, one WebSocket event type.
3. **Project pilot and signal alerts**: thin adapters that turn pilot errand events and signal anomalies into surface cards. Pilot is read-only-friendly (`pilot fetch` + sqlite); signal becomes the alert source once collector profiles ship.
4. **Link artifacts**: load `compass/sops/`, `blueprint.yaml`, iteration markdown into the card render path. Read at render time — no replication.

No piece of mc-v3 gets deleted. No agent-visibility infrastructure gets re-architected. The wire moves to NATS+myelin, the surface widens to subscribe to it.

---

## 6. Trigger composability — how new triggers slot in

The surface is decoupled from triggers via the myelin envelope. This is the same pattern signal uses to decouple itself from collectors and backends. Concretely:

### 6.1 Today's triggers

- **Claude Code backend** (mc-v3): `handleCreateSession` spawns `claude --print …`, the EventLogger hook publishes to the bus, the dashboard renders. Already there.
- **pilot bot in Discord** (JC): `pilot ping <pr>` posts to Discord and registers an errand. Pilot already maintains its own state — we add a thin projection from pilot's state onto `local.{org}.pilot.errand.>` envelopes so the surface sees it as just another card source.

### 6.2 Tomorrow's triggers

- **signal anomalies**: Once `signal-collector` ships (signal layer 2), backend profiles can fire alert envelopes onto `local.{org}.signal.alert.>` for things like rate-limit headroom < 20%, error rate > threshold, sovereignty violation. These become inbox cards.
- **blueprint state changes**: `blueprint`'s event-sync (`B-202` in `~/Developer/blueprint/docs/design-event-sync.md`) already plans to call Grove on GitHub webhooks. Closing the loop: when blueprint computes a feature transition (`planned` → `ready`), it emits `local.{org}.blueprint.feature.ready`. The surface picks it up and offers a "dispatch" action.
- **scheduled triggers** (cron, calendar, retrospective intervals): `the-metafactory/grove-v2`'s existing `schedule` skill or arc's cron primitives publish on `local.{org}.schedule.fired` envelopes. Surface treats them like any other card.
- **principal-side schedules** (PAI's `cldyo-live` instrumentation): already writes events that flow through the relay into the dashboard. With signal in place, this becomes the OTLP path; surface joins by `correlation_id`.

The contract for adding any new trigger source is a one-page envelope spec and a NATS subject. Grove gets to keep the surface stable; the ecosystem gets to grow the trigger menu without coordinating with Grove.

### What this means for Grove

The bot's existing `messageCreate` handler stays as-is for the **trigger from chat** path (humans can still address agents in Discord; agents still post results back). What changes is that we add a parallel **subscription** path for trigger sources that don't go through Discord. Architecturally: keep `grove-bot.ts` and `cc-session.ts` exactly as they are; introduce `src/bot/lib/myelin-subscriber.ts` (mirroring the shape of `nats-publisher.ts`) that fans subjects into existing event handlers.

---

## 7. Integration with mc-v3 work in flight

The mc-v3 dispatch + observe iteration (`docs/iteration-mc-dispatch-observe.md`) shipped F-19 (dispatch button + 2 s debounce) and F-20.A–F (observed sessions, `cldyo-live` registration, `endpoint_kind` projection) by 2026-05-06 (PRs #55, #56, #57 on `main`). Tests + manual smoke (F-19.G, F-20.G, F-20.H) are the next ticks.

This rethink does **not** displace any of that. The mapping into the layered model:

| mc-v3 piece | Layer in §2 | Status under the rethink |
|-------------|-------------|--------------------------|
| `dispatch-button.tsx` + 2 s debounce | 7 (surface) — calls layer 4 (coordination) | Stays. Becomes the canonical "schedule" affordance on Kanban cards. |
| Observed-session registration | 4 (coordination) — protocol over layer 1+2 | Stays. The `cldyo-live` wrapper is the reference implementation of "an external agent advertising itself onto the bus." |
| `endpoint_kind` projection on `/api/tasks` | 7 (surface) | Stays. The badge becomes one of several source-kind badges on cards. |
| F-7 attention view | 7 (surface) | Becomes the **inbox** in §5.3 — broadened to accept non-CC sources. |
| F-10 principal-input drill-down | 7 (surface) | Becomes the **return path** in §5.4 — broadened to emit envelopes on the appropriate subject for non-CC sources. |
| Iteration kanban (`iteration-board.tsx`) | 7 (surface) — over layer 6 (knowledge graph) | Stays, integrates with blueprint state-change envelopes. |

In other words: the rethink is **additive**. Every existing mc-v3 component has a place; the additions are subscription paths, an inbox generalisation, and the artifact-aware drill-down.

---

## 8. Feature breakdown (proposed G-5xx range)

These are draft entries for `blueprint.yaml`. IDs avoid collision with existing G-100..G-410.

| ID | Feature | Depends on | Description |
|----|---------|------------|-------------|
| **G-1100** | Myelin subscriber in grove-bot | G-401 (cloud event publisher) | Add `src/bot/lib/myelin-subscriber.ts`. Mirrors `nats-publisher.ts` shape; subscribes to `local.{org}.>` subjects and fans into existing event handlers. Validates envelopes against `myelin/schemas/envelope.schema.json`. |
| **G-1101** | Pilot errand projection | G-1100 | Subscribe to `local.{org}.pilot.errand.>` envelopes; project errand state onto a new `pilot_errands` D1 table; render as a card source on the surface. Two-way: principal decisions emit `local.{org}.pilot.errand.decision`. |
| **G-1102** | Signal alert ingestion | G-1100, signal-collector v1 | Subscribe to `local.{org}.signal.alert.>`; render as inbox cards with severity, drill-link to the OTLP trace tree (when collector profile points at a backend whose UI we know how to deep-link to). |
| **G-1103** | Generalised inbox | G-1101, G-1102 | Replace F-7 attention view's data source with a unified inbox table fed by all card sources. Prioritisation rules in front of the table. |
| **G-1104** | Blueprint state-change ingestion | B-202 (blueprint event-sync) | Subscribe to `local.{org}.blueprint.feature.ready`; surface ready features as schedulable cards. Bidirectional: dispatch from a blueprint card emits `local.{org}.blueprint.feature.dispatched`. |
| **G-1105** | Artifact-aware drill-down | G-1103 | Drill-down view loads applicable SOPs from `compass/sops/`, iteration markdown from `docs/iteration-*.md` of the relevant repo, blueprint dependency state. Read at render time; no replication. |
| **G-1106** | OTLP+CloudEvent timeline join | G-1100, G-1102 | Drill-down activity timeline merges `mf.net-*.events.>` and `mf.net-*.trace.>` by `correlation_id` from the envelope. |
| **G-1107** | Universal principal-input return path | G-1103, G-1105 | Generalise F-10 to emit envelopes on the appropriate subject per card source (`pilot.errand.decision`, `task.input`, `feature.update`). |
| **G-1108** | Cross-repo blueprint badge | blueprint dashboard-integration-schema (B-?) | "Blocked by `arc:A-103`" rendered on cards, hyperlinked. |
| **G-1109** | Triggered-by-schedule cards | arc cron primitives | Surface cards for cron-fired work; same Kanban lifecycle. |
| **G-1110** | Sovereignty render | G-1100 | Display envelope `sovereignty` (classification, residency, model class) on cards where it's meaningful (federated workflows). |

`G-1100` and `G-1103` are the load-bearing pair — every other feature builds on subscription + the unified inbox. Suggested first iteration: **G-1100 + G-1101 + G-1103**, which produces a tangible principal improvement (pilot errands surfaced) and exercises the whole subscription path end-to-end. Subsequent iterations layer signal, blueprint, artifact-aware rendering, and so on.

---

## 9. Coupling rules (mirroring signal)

The same coupling discipline that keeps signal host-agnostic applies here, in reverse. To prevent Grove (now Cortex) from re-becoming the wire:

- Cortex MAY subscribe to any subject under `local.{org}.>` and `mf.net-*.>`.
- Cortex MAY publish principal-decision envelopes on `local.{org}.*.decision` and `local.{org}.*.update`.
- Cortex MUST NOT publish on subjects owned by other layers (no trace spans, no pilot errand updates, no blueprint state writes from the bot).
- Cortex MUST NOT import the myelin **envelope schema** at runtime — the schema travels by value (vendored at `src/bus/myelin/vendor/envelope.schema.json` per the `SCHEMA_SOURCE_COMMIT` pin in `src/bus/myelin/envelope-validator.ts`). A myelin outage MUST NOT wedge cortex's envelope validator. Schema bumps are explicit PRs that re-vendor the file and update the pin.
- Cortex MAY import **pure-string utility modules** from `@the-metafactory/myelin` when myelin explicitly publishes them for cross-consumer use with **zero transitive dependencies** on the envelope schema, Ajv, NATS, or any other heavy artefact (myelin#115 designed `@the-metafactory/myelin/subjects` to this contract). This relaxes the prior "MUST NOT import from `myelin/` at runtime" rule, which originated when myelin had not yet shipped a consumable TS library. Importing schema-bound or transport-bound surfaces from myelin remains forbidden under the schema-by-value rule above.
- Cortex MUST NOT import from `signal/`, `pilot/`, or `blueprint/` at runtime.
- Cortex MUST stay **runnable** without any of the above repos being present — once installed, a myelin GitHub outage MUST NOT wedge cortex. The validator never reaches the network; `node_modules` cached during a prior `bun install` is sufficient. (The myelin npm dep transitively pulls NATS/Ajv/Ed25519/msgpack at install time, but cortex only imports the pure-string `@the-metafactory/myelin/subjects` module — the rest of the tree is install-only ballast.)
- Cortex's **fresh-install** path has an acknowledged carve-out: `bun install` requires the myelin GitHub repo (or a lockfile-cached tarball) to be reachable. Lockfile sha-pinning prevents tampering; lockfile-aware mirrors or `bun install --frozen-lockfile` against a pre-warmed cache cover the outage case. If this fresh-install dependency on myelin becomes operationally problematic, the resolution is for myelin to publish `@the-metafactory/myelin-subjects` as a separate zero-dep package (myelin-side work, not cortex-side), at which point cortex re-pins to the lighter dep.

These rules turn the layered model into something we can audit, not just describe.

---

## 10. Research foundations

Three research artefacts ground this design — all live in `~/Developer/`:

- **`agent-packaging-research.md`** — Multi-perspective study of how agent capabilities get distributed (LangGraph manifests, CrewAI Python packaging, MCP, Nix/Devbox, container isolation). The "manifest + thin tap + swappable backend" pattern that signal adopts and that this surface design mirrors comes directly from §1's tour of LangGraph and §3 (HashiCorp Vault profile-driven secrets).
- **`ai-agent-security-zones-research.md`** — Multi-perspective security architecture review covering "treat agents as untrusted requesters" model, sandbox + secret injection, credential-isolated proxy, OWASP Agentic Top 10 mapping. Underpins the §9 coupling rules and the sovereignty-fields-in-the-envelope decision (myelin's `sovereignty.classification`, `data_residency`, `frontier_ok`, `model_class` come from this lineage).
- **`research-stripe-blueprints-and-ea-frameworks.md`** — Examination of Stripe's Minions blueprints (deterministic agent graphs that ship 1300+ PRs/week — Stripe Engineering, 2026-02-09 / 2026-02-19) and lightweight enterprise-architecture frameworks. Confirms the "blueprint = composable graph" convention used by the metafactory-blueprint repo (distinct from arc blueprints — see §3).

The metafactory `VISION.md` ("Every way agents do work can be captured, shared, and improved … the act of doing work through agentic tools IS the process mining" — `~/Developer/metafactory-f102-design/VISION.md`) is the load-bearing thesis these three studies converge on. The Collaboration Surface is the *layer-7 expression* of that thesis: the place where the human watches the factory observe its own production lines.

---

## 11. What this does NOT do

- **Not a re-architecture of mc-v3.** Every existing F-* feature retains its place; §7 maps each one explicitly.
- **Not a transport.** Grove subscribes to NATS via myelin envelopes; it does not implement NATS, does not extend the envelope schema, does not own a subject namespace beyond what's documented in `myelin/specs/namespace.md`.
- **Not a fork of pilot.** Pilot stays where it is; Grove projects pilot's state via subscription. Pilot's CLI remains the principal's other side of the conversation when they want to act on a review thread directly.
- **Not a replacement for Grafana/Honeycomb/Datadog.** When principals want to drill into raw OTLP traces, they go to whichever backend `signal-collector` is pointed at. The surface deep-links there for context but does not own trace storage.
- **Not a CLAUDE.md change.** The CLAUDE.md generation pipeline (`arc upgrade compass`) is unaffected. This document goes in `docs/` like every other design spec.
- **Not a code change in this PR.** This document is the design only; G-1100..G-1110 are draft blueprint entries to discuss before implementation.

---

## 12. Open questions

- **Subject naming for "attention" envelopes.** Should there be a single `local.{org}.attention.>` subject any source can publish to (simpler subscription), or should each source own its own subject (`local.{org}.pilot.errand.needs-decision`, `local.{org}.signal.alert.>`, etc.) and the surface union them at the subscriber level (cleaner ownership)? Default to the latter — sources own their subjects; surface unions in code. This matches signal's "events on `events.>`, traces on `trace.>`" precedent.
- **Where do iteration-plan checkbox transitions originate?** B-202 covers issue/PR-driven transitions, but iteration plans tick boxes for sub-tasks that aren't always single PRs. Open: do iteration-plan markdown commits emit a transition envelope, or does the surface infer ticks from PR commit messages? Either works; pick one.
- **OTLP join key.** Today's CloudEvents and tomorrow's OTLP spans both need to share a `correlation_id`. The myelin envelope has `correlation_id` as optional. Decision: is it *required* for any envelope that wants its events joined into a task drill-down? Probably yes — subscribers should reject (or quarantine) un-correlated envelopes for joined surfaces.
- **Which compass SOP applies to which card?** Today the human picks via the `Standard Operating Procedures` table in CLAUDE.md. For automation, a small SOP-classification rule (e.g., "any `feature` GH issue → activate dev-pipeline") should be encoded somewhere — maybe in compass itself.
- **Multi-principal surface.** mc-v3 is single-principal at Tier 1 (CF Worker + D1 at Tier 2 is multi-principal-ready — `docs/design-mission-control.md` §1.2). The Collaboration Surface should follow the same "single principal now, schema doesn't preclude multi-principal later" rule. Confirm at G-1100 design time.
- **Sovereignty surfacing (G-1110).** For `local.` envelopes everything's fine. For `federated.` cards, what does the principal see? "model_class: local-only" should probably block dispatching to a frontier-only agent — a small UI guardrail that mirrors signal's eventual sovereignty enforcement at NATS leaf nodes (`MY-200`).

---

## 13. References

- **Vision** — `~/Developer/metafactory-f102-design/VISION.md`
- **Layer 1-2** — `~/Developer/myelin/README.md`, `~/Developer/myelin/ISA.md`, `~/Developer/myelin/specs/namespace.md`, `~/Developer/myelin/schemas/envelope.schema.json`
- **Layer 3** — `~/Developer/signal/README.md`, `~/Developer/signal/docs/design-signal-bundle-migration.md`
- **Layer 4** — `~/Developer/grove-v2/src/hooks/lib/event-taxonomy.ts` (Grove side), `~/Developer/pilot/README.md` (pilot side)
- **Layer 5** — `~/Developer/compass/sops/*.md`, `~/Developer/compass/docs/design-governance-skill.md`
- **Layer 6** — `~/Developer/blueprint/README.md`, `~/Developer/blueprint/docs/design-event-sync.md`, `~/Developer/blueprint/docs/dashboard-integration-schema.md`
- **Layer 7 (this repo)** — `docs/design-mission-control.md`, `docs/design-agent-visibility.md`, `docs/design-mc-f10-principal-input.md`, `docs/iteration-mc-dispatch-observe.md`
- **Research foundations** — `~/Developer/agent-packaging-research.md`, `~/Developer/ai-agent-security-zones-research.md`, `~/Developer/research-stripe-blueprints-and-ea-frameworks.md`
- **In-flight mc-v3 work** — PRs #55 (F-19), #56 (F-20), #57 (F-20.F) on `main`; F-19.G, F-20.G, F-20.H pending
