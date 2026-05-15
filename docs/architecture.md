# Cortex — Design Spec

**Status:** Living architecture reference. Static — describes what cortex IS, not how we get there. The working migration document is `docs/plan-cortex-migration.md` (eventually retires); this doc remains the canonical reference and is copied to `cortex/docs/architecture.md` at MIG-0.10 of the migration.
**Date opened:** 2026-05-09
**Driver:** Andreas
**Related docs (load-bearing):**

- `docs/plan-cortex-migration.md` — the working document covering current-state inventory + phase plan + checklists for the grove-v2 → cortex migration.
- `docs/design-collaboration-surface.md` — the layer-7 framing + the flybridge cockpit metaphor; this design supersedes its "ecosystem L1–L7" framing per §1.2 below.
- `docs/design-event-taxonomy.md` — G-1111 event vocabulary including §3.5 `system.*` operational domain + §4.6 fail-safe subscription rule.
- `~/Developer/myelin/README.md`, `~/Developer/myelin/specs/namespace.md`, myelin#7 (closed) — the canonical M1–M7 stack model.
- `~/Developer/myelin/.specify/specs/f-018-my-400/spec.md` — M4 identity spec.
- `~/Developer/myelin/docs/design-agent-task-routing.md` (currently myelin PR #36 — three distribution modes + M7 stratification + event lifecycle) — the M7 task-routing pattern cortex's dispatch handler implements.
- `~/Developer/signal/README.md` — the sibling M7 telemetry app pattern.
- `~/Developer/compass/sops/new-repo-pattern.md`, `~/Developer/compass/sops/dev-pipeline.md`, `worktree-discipline.md`, `pr-review.md`, `versioning.md`, `design-process.md` — process artefacts cortex consumes.

---

## 1. What cortex is — and why it exists

### 1.1 The journey here

For months we've operated as heavy Discord-and-dashboard users. The lived pattern:

- **Discord** as the primary surface, with a channel-per-repo routing convention (`#grove`, `#arc`, `#compass`, `#myelin`, `#blueprint`, etc. — one channel per repo, threads for individual issues / PRs / features).
- **Multiple agent personas** collaborating in those channels — Luna, Echo, Holly, Ivy, Forge — each with their own Discord identity, persona file, capability gates, and trust relationships. Operators ping a persona; the persona does work.
- **The pilot review loop** running on top of those personas: open PR → ping reviewer-persona → reviewer reads, posts findings → operator/agent triages → fix or defer → re-ping → merge. Driven by the `pilot` CLI; foundational and backend support coming from compass SOPs, blueprint dependency tracking, and a cloud of CLAUDE.md files.
- **The Grove dashboard** as the secondary surface — repository-organised activity feed, GitHub entities (releases / issues / PRs) visible inline, agent state per repo, F-7 attention view for "what needs me." The browser tab the operator left open all day.
- **Mattermost** as a parallel surface for flows that didn't live in Discord — same adapter pattern, different platform.

The pattern worked. Send work in via chat; watch it progress on the dashboard; get pinged when human input is needed; merge.

One specific consequence of this pattern shapes how cortex is designed: **today's Discord-only surface conflates three concerns onto one channel, producing two opposite visibility failures depending on what an agent is doing.**

| Pattern | Symptom | Operator experience |
|---------|---------|---------------------|
| **Tool-call flashing** — bots that emit per-tool worklog messages (e.g. cc-session-driven workflow runners) | The worklog thread scrolls with each `Read`, `Grep`, `Bash`, `Edit`, etc. | Operators skim, partly as work-tracking and partly as a "yes the bot is alive" signal. High noise, low intentionality. |
| **Silent grinding** — agents that DON'T emit per-tool worklog messages (e.g. reviewer agents like Echo running a `/review-pr` skill) | No worklog. The agent just stops responding while CC processes internally. | Operators ping → wait. After ~9 minutes (the empirical pilot-loop cap of 540s), the loop concludes "agent stalled" and re-pings — even though the agent may still be working. **The opacity is the problem.** |

Both failures share one root cause: **a single Discord surface is the only place the bot's activity shows up**, so the choice is "flood the channel with detail" or "flood the channel with nothing." Neither answers the operator's actual questions ("is it alive?", "what's it working on?", "should I intervene?") well.

§3.6 below describes how cortex resolves this by splitting visibility into three tiers — Tier 1 (work management on the dashboard) answers "is it alive + what is it working on" without flooding chat; Tier 2 (cortex drill-down) answers "where is this specific agent in its lifecycle"; Tier 3 (signal observability) answers "what tools did it actually run" for the operator who wants to drill in. The pilot-loop's "ping → 540s silence → re-ping" cycle, encountered repeatedly during this design's authoring, is the empirical case study for why Tiers 1+2 are load-bearing.

### 1.2 What changed

**NATS + myelin landed underneath, and forced the OSI-style layered model into the open.** Sovereignty travels in the envelope (myelin); agents publish structured events to a bus (NATS) instead of message-creating in Discord; signal/OTLP arrives as a separate observability path on the same transport.

The canonical layer model is **M1–M7 — the Myelin stack** (myelin#7, JC + Andreas converged 2026-05-07): connectivity / transport / envelope / identity / discovery / composition / surfaces. G-1100..G-1110 implemented the bus glue (myelin client + envelope validator + subscription primitive at M2–M3); G-1111 specifies the M7-application-side event vocabulary cortex emits and consumes.

Once the bus appeared, the question "which layer owns which concern?" became operationally real. You can't have your transport client (M2), your envelope handling (M3), your dispatch handler, your workflow runner, *and* your Discord surface adapter all sharing the same `src/bot/` files anymore — M1–M6 are real now, with their own contracts owned by myelin, and the M7 application that consumes them needs its own home with a clean internal split.

Cortex is that home. It is one M7 application — alongside pilot, signal-collector, and any future apps — that consumes the bus and presents the operator surface.

> **A note on naming.** Earlier drafts of the cortex framing referenced an "ecosystem seven-layer model" lifted from `design-collaboration-surface.md` §2 (transport / envelope / telemetry / coordination / process / knowledge-graph / surface). That artifact is a useful **concern map** — which sibling repo owns which architectural concern — but it is **not a layer model in the same sense as M1–M7**. Presenting both with `L1..L7` numbering was the source of confusion. M1–M7 is the canonical stack; the concern-map content survives as prose in §5 (M7 sibling apps and adjacent knowledge artefacts), without competing layer numbers.

### 1.3 The brand metaphor

The metafactory ecosystem uses a nervous-system family of names. Cortex slots in cleanly:

- **myelin** — insulator wrapping signals on the axon — owns M2–M6 of the stack (the protocol)
- **signal** — action potentials carrying telemetry — an M7 app (the OTLP collector)
- **pilot** — rhythmic coordinator — an M7 app (the review loop)
- **compass** — heading control — knowledge artefacts cortex consumes (SOPs)
- **blueprint** — body plan / wiring diagram — knowledge artefacts cortex consumes (feature graph)
- **cortex** — conscious processing surface where the operator perceives and acts — an M7 app (this design)

---

## 2. The Myelin stack (M1–M7)

The canonical layered architecture is **M1–M7**, the Myelin stack — OSI-style protocol layering of the nervous system. Defined in myelin#7 (closed 2026-05-07, JC + Andreas converged); a pending acceptance criterion is "Seven-layer model documented in myelin (`docs/architecture.md`)" — to be landed before cortex's plan freezes its references.

```
                                                                  spec / contract
   ┌─────────────────────────────────────────────────────────────────────────────┐
M7 │ SURFACES        — applications consuming the bus               │  per app   │
   │                   cortex · pilot · signal-collector · future   │            │
   ├────────────────────────────────────────────────────────────────┼────────────┤
M6 │ COMPOSITION     — pipeline · fan-out/fan-in · request/reply    │  myelin    │
   │                   (interaction patterns above the envelope)    │  spec TBD  │
   ├────────────────────────────────────────────────────────────────┼────────────┤
M5 │ DISCOVERY       — capability registry · manifest queries       │  myelin    │
   │                   (runtime "what's out there?")                │  spec TBD  │
   ├────────────────────────────────────────────────────────────────┼────────────┤
M4 │ IDENTITY        — verifiable principal per envelope            │  myelin    │
   │                   ("who sent this?" cross-transport)           │  MY-400    │
   ├────────────────────────────────────────────────────────────────┼────────────┤
M3 │ ENVELOPE        — message format · sovereignty metadata        │  envelope. │
   │                   ✅ shipped (MY-100)                          │  schema.   │
   │                                                                │  json      │
   ├────────────────────────────────────────────────────────────────┼────────────┤
M2 │ TRANSPORT       — abstract bus · pub/sub · delivery            │  myelin    │
   │                   guarantees (NATS as concrete implementation) │  M2 abstr. │
   ├────────────────────────────────────────────────────────────────┼────────────┤
M1 │ CONNECTIVITY    — TCP/TLS/federation topology (out of scope)   │  upstream  │
   │                                                                │  NATS      │
   └─────────────────────────────────────────────────────────────────────────────┘
```

Cortex sits at **M7** as one application among many. Cortex consumes contracts from M2–M6, must not runtime-import myelin's runtime, and shares M7 with pilot, signal-collector, and any other app that connects to the bus.

The independence of M1–M6 is what makes the architecture work in practice: the bus's transport client, envelope spec, identity model, discovery/composition patterns can each evolve under myelin's stewardship without touching M7 apps, as long as the contracts hold.

---

## 3. Event architecture — three event classes on the bus

Reference: diagram embedded in `docs/design-collaboration-surface.md` (PR #83, 2026-05-09). The bus carries **three event classes** plus a logging channel, all sharing NATS transport but distinguished by subject prefix, retention policy, and audience. This is the canonical event-routing scheme for cortex and every other M7 app.

```
PRODUCERS                          NATS BUS                         CONSUMERS
─────────                          ────────                         ─────────

Agents (CC hooks)        ┌──→  mf.net-{op}.events.>                    Hot path
  emits agent.task.*     │       domain + process events            ┌─→ cortex subscriber
  + trace + metric + log │       (review, dispatch, attention,      │   → Kanban / Inbox / Cards
                         │        gate, system)                     │   (operator-facing,
Surfaces (cortex/pilot)  │       JetStream over events.>            │    latency-sensitive)
  emits review.*         │       fire-and-forget · sub-second
  dispatch.* attention.* │       no ack on hot path
  gate.*                 │
                         ├──→  mf.net-{op}.trace.>     OTLP spans   Cold path
External (GitHub        │     mf.net-{op}.metric.>   counters/gauges ┌─→ signal-collector
webhooks, cron)         │     mf.net-{op}.log.>      structured logs │   (Vector / otelcol)
  domain events →       │                                            │   → VictoriaMetrics
  gate transitions      │                                            │     (TSDB)
                         │                                            │   → Loki (logs)
                         │                                            │   → Tempo (traces)
                         │                                            │   (observability,
                         │                                            │    high volume,
                         │                                            │    no surface coupling)
                         └────────────────────────────────────────────┘
```

### 3.1 The four subject classes

| Class | Subject prefix | Carries | Audience | Retention |
|-------|----------------|---------|----------|-----------|
| **Events** | `mf.net-{op}.events.>` | Domain + process lifecycle: `review.*`, `dispatch.*`, `attention.*`, `gate.*`, `system.*` (G-1111 vocabulary) | Hot-path: cortex subscriber → operator surfaces | JetStream — durable, replayable, last_event_id checkpointable |
| **Trace** | `mf.net-{op}.trace.>` | OTLP spans (CC tool calls, skill invocations, subagent spawn, session lifecycle) | Cold-path: signal-collector → Tempo / Honeycomb / Datadog | Per OTLP backend; not on JetStream |
| **Metric** | `mf.net-{op}.metric.>` | Counters / gauges | Cold-path: signal-collector → TSDB (VictoriaMetrics / Prometheus) | Per TSDB |
| **Log** | `mf.net-{op}.log.>` | Structured logs | Cold-path: signal-collector → Loki | Per logger |

**Subjects ARE the filter.** No payload-level subscriptions; consumers filter by subject pattern at NATS level. This is the load-bearing performance property — it lets the bus scale to high event volumes without coupling consumers to producer-side schema.

### 3.2 Hot path vs cold path

Two consumer classes live on the same transport but at different latency / durability tiers:

**Hot path — operator-facing**
- Cortex's surface-router subscribes to `mf.net-{op}.events.>` (filtered to relevant subjects per renderer/adapter).
- JetStream gives durable replay, but the hot path renders fire-and-forget at sub-second latency. **No ack on the hot path.**
- The dashboard projection ingests events into D1, checkpointing `last_event_id` per stream — **lost event ≠ lost state**: missed events on the hot path are recoverable from the JetStream stream up to the retention window.
- Hot-path consumers (cortex, future M7 apps) MUST stay narrow on subject filters and avoid blocking on per-event work.

**Cold path — observability**
- signal-collector (Vector / otelcol) subscribes to `trace.>`, `metric.>`, `log.>` and forwards to operator-chosen OTLP/log/metric backends.
- High volume, high cardinality, longer retention horizons.
- Cortex MUST NOT couple to the cold path. Operator-facing computations (cycle-time, PR-throughput, human-wait KPIs) are **PromQL queries on the TSDB, not computed in cortex.** The cold path owns aggregation; cortex just renders cards.

### 3.3 JetStream over events — durability for the things that matter

`events.>` is JetStream-backed by default; `trace.> / metric.> / log.>` are not. Rationale: domain/process events are workflow-bearing (a missed `review.verdict.approved` matters; a missed metric tick doesn't, the next tick replaces it).

Cortex's projection layer (Mission Control DB on D1) checkpoints `last_event_id` per JetStream stream so reconnects resume cleanly. This is the operational meaning of **lost event ≠ lost state** — even if cortex's process crashes mid-stream, the dashboard reconstructs by replaying from the last checkpoint.

`system.*` events specifically (per G-1111 §3.5.5) require JetStream; the §4.6 fail-safe rule depends on durability for `system.adapter.degraded` etc. to reach pager-class subscribers.

### 3.4 Cortex's spine — the in-process flow

Within cortex, every coordinated action flows through the surface-router:

```
inbound from a surface ─→ presence adapter ─→ tap (publish dispatch.* envelope) ─→ bus
                                                                                    │
                                                                                    ▼
        runner subscribes ───────────────────────────────────────── runner.handle(envelope)
                                                                                    │
                                                                                    ▼
        runner emits dispatch.task.* events on bus ─────→ surface-router fans to adapters
                                                                                    │
                                                                                    ▼
        adapters render to their platform; renderers project to dashboard / pagerduty / ...
```

The **surface-router** (G-1111.A target) is the single in-process fan-out point. Adapters and renderers do not subscribe to NATS directly; they register with the surface-router and the surface-router owns the JetStream consumer. Per `docs/design-event-taxonomy.md` §7.6 anti-pattern: "DO NOT subscribe surfaces directly to NATS."

**Operator-tool exception — short-lived bus consumers.** Some CLIs need to block on a specific bus event without standing up the surface-router (e.g. `cortex-wait-for-review` waiting for a `github.pull_request_review.submitted` envelope before resuming a pilot loop). These tools open their own `NatsLink` + `MyelinSubscriber` pair against the operator's configured NATS, filter at the envelope-payload layer, and exit on first match or timeout. They are deliberately outside the surface-router because their lifetime is bounded to one wait — registering with the router would mean the router owns shutdown of an ephemeral consumer, which inverts the dependency. The anti-pattern in §7.6 of the design-event-taxonomy doc applies to **long-running surfaces** (renderers, adapters, projections); short-lived "subscribe-once-then-exit" tooling is the explicit complement. See cortex#232 for the canonical example and `src/cli/cortex/commands/wait-for-review.ts` for the pattern other CLIs follow.

### 3.5 Namespace reconciliation — RESOLVED

**Decision (2026-05-09):** The federated namespace `local.{org}.{domain}.{entity}.{action}` (per `myelin/specs/namespace.md`) is the canonical subject convention. The earlier `mf.net-{operator}.*` convention was a first iteration that appeared in documentation diagrams but was never adopted in implementation — cortex's runtime already publishes exclusively on `local.{org}.*` subjects.

The three-prefix model from myelin's namespace spec applies:
- **`local.{org}.*`** — intra-operator semantic events (current scope)
- **`federated.*`** — cross-operator task markets (requires sovereignty enforcement, [myelin#11](https://github.com/the-metafactory/myelin/issues/11))
- **`public.*`** — open discovery (future)

**Migration:** Diagrams and tables in §3.1–§3.4 of this document still reference `mf.net-{op}.*` as a visual convention. These will be updated to `local.{org}.*` as part of [myelin#7](https://github.com/the-metafactory/myelin/issues/7) documentation convergence. The runtime requires no changes — it already uses the correct convention. See also: myelin task routing design doc, Decision #6.

### 3.6 Operator visibility — three tiers

The hot/cold-path split in §3.2 plus signal's three-repo bundle (§5.2) gives the operator three distinct views of agent activity, each at a different level of detail and on a different surface. This is a deliberate design choice — collapsing them onto one surface is what made grove-v2's worklog thread scroll past as bots flashed every tool call (§1.1). Cortex separates the concerns.

| Tier | Surface | Question it answers | Granularity | Source |
|------|---------|---------------------|-------------|--------|
| **1. Work management** | Cortex Mission Control dashboard | "What's happening in my world? Which projects, issues, PRs are in flight? Where's the work?" | Coarse — cards for projects/issues/PRs/iterations; agents appear as actors on cards | `mf.net-{op}.events.>` (filtered to domain-event subjects: review, dispatch, attention, gate, …) — JetStream-backed, durable, replayable |
| **2. Agent activity** | Cortex drill-down (a card → an agent task) | "What is this specific agent doing right now? How far along? Did it get stuck?" | Medium — lifecycle envelopes (`dispatch.task.{started,progress,completed,failed,aborted}`) and high-level status updates | Same `events.>` class, narrower subject filter for one task's correlation_id |
| **3. Tool-call detail** | Signal observability backend (Grafana / Honeycomb / Datadog / local-stack) | "Exactly what tool calls did the agent make? What were the arguments? Where did it spend time?" | Fine — every `Read`, `Bash`, `Edit`, subagent spawn, tool argument, span timing | `mf.net-{op}.trace.>` (OTLP spans) — cold path, signal-collector → backend |

The dashboard renders Tier 1 by default. Drilling into a card opens Tier 2 (cortex's own surface, fed from the bus). A "view trace tree" link from Tier 2 deep-links into the operator's chosen signal backend for Tier 3. The operator chooses how deep to go; cortex doesn't force every tool call into the operator's eyeline.

**Behavioural change from grove-v2 to cortex** (full migration coverage in `plan-cortex-migration.md`; sketched here because it shapes the design):

- Today (grove-v2): every tool call flashes as a Discord message in the worklog thread. Tiers 1, 2, and 3 are all collapsed onto one surface — chat — and the operator skims for "is this alive" + "what's it doing" + "what tools did it run" all at once.
- Tomorrow (cortex): chat carries collaboration (pings, decisions, results posted by agents); the dashboard carries work state at Tier 1; signal carries Tier 3 detail in whatever backend the operator chose. **Tool calls do not scroll past in chat by default.** If the operator wants the tool-call view they open the trace tree; otherwise the noise stays where it scales — in the observability backend.

This is the operator-facing payoff of the layered architecture: each tier of detail lives where it scales, on a surface that suits its grain. Chat scales poorly to high-frequency events; signal scales well. The dashboard scales well to coarse work-state; chat scales poorly to that too. Cortex makes the choice explicit instead of leaving it to scrollback.

---

## 4. Cortex's contract with each layer

What cortex depends on, what cortex must not do, and what to read in each upstream repo for the canonical spec.

### 4.1 M1 — Connectivity

| Aspect | Detail |
|--------|--------|
| Spec home | Out of scope for the metafactory ecosystem — upstream NATS / TCP / TLS / leaf-node federation. |
| Cortex's dependency | None directly — cortex uses M2's pub/sub abstraction; the underlying transport is a deployment concern. |
| Reading order | Upstream NATS docs only when configuring leaf nodes. |

### 4.2 M2 — Transport

| Aspect | Detail |
|--------|--------|
| Spec home | `the-metafactory/myelin` — abstract bus interface; NATS is the v1 concrete implementation. |
| Status | NATS pub/sub via `nats@2.x` JS client is operational; abstract transport interface (myelin-side spec) in flight. |
| Cortex's dependency | `nats@2.x` JS client. Connection model: leaf node connecting to a hub. |
| Cortex's contract | Cortex publishes on subjects under `local.{org}.>` (per myelin's M3 namespace spec) and `mf.net-{operator}.>` per the §3 event architecture. JetStream is **required** for `system.*` events per G-1111 §3.5.5; plain NATS Core suffices otherwise. |
| Coupling discipline | Cortex MAY copy patterns from the bus client; cortex MUST NOT couple to NATS-specific surface area beyond what myelin's M2 abstraction exposes. |
| Reading order | `~/Developer/myelin/specs/namespace.md` for subject grammar → upstream NATS client docs for the API. |

### 4.3 M3 — Envelope

| Aspect | Detail |
|--------|--------|
| Spec home | `the-metafactory/myelin` — `schemas/envelope.schema.json` + `specs/namespace.md`. |
| Status | ✅ Shipped (MY-100 — ISA 30/30 complete). MY-102 (TS library) and MY-200 (sovereignty enforcement) on the myelin roadmap. |
| Cortex's dependency | **Vendored** at `src/bus/myelin/vendor/` — pinned at upstream commit `4578ae1` (IAW Phase A.2 bump from `96b14ea`, post-F-021 task envelope + MY-400 chain-of-stamps + F-15 economics). Vendor bumps are explicit PRs. |
| Cortex's contract | Cortex never extends the envelope schema. Cortex validates inbound envelopes via Ajv2020 before processing. Cortex publishes envelopes whose `type` matches the documented `domain.entity.action` grammar. Cortex sets `sovereignty` per-envelope at publish time (defaults: `local`, `frontier_ok: true`, `model_class: any` for review/dispatch domains; tightened for sensitive payloads). |
| Subject namespace | `local.{org}.{domain}.{entity}.{action}` (org-only), `federated.{org}.{domain}.{entity}.{action}` (cross-org via sovereignty), `public.{domain}.{entity}.{action}` (unrestricted). |
| Coupling discipline | Cortex MUST NOT runtime-import `myelin/` — vendor schema only. (Once MY-102 ships a `@metafactory/myelin` TS library it may be added as a dependency.) |
| Reading order | `myelin/README.md` → `myelin/specs/namespace.md` → `myelin/schemas/envelope.schema.json` → `myelin/ISA.md`. |

### 4.4 M4 — Identity

| Aspect | Detail |
|--------|--------|
| Spec home | `the-metafactory/myelin` — MY-400 (`.specify/specs/f-018-my-400/spec.md`); myelin#8 closed, implementation in flight. |
| Status | Design landed. Implementation depends on grove#320 (NATS AAA) and grove#321 (manifest identity), both migrating to cortex-side equivalents. |
| Cortex's dependency | `nats.identity` config block per JC's E2E NATS work. Each agent's presence adapter authenticates with its own NATS user (one bot = one user) and signs envelopes with its agent's keypair. |
| Cortex's contract | Cortex publishes envelopes with `signed_by` populated per the M4 spec. Cortex verifies inbound `signed_by` via the M4 verification rules before processing. Cortex tolerates pre-M4 envelopes during the rollout window. |
| Reading order | `myelin/.specify/specs/f-018-my-400/spec.md`. |

### 4.5 M5 — Discovery

| Aspect | Detail |
|--------|--------|
| Spec home | `the-metafactory/myelin` — myelin#9 (open, future). |
| Status | Spec not yet written. No runtime capability registry today; agents discover each other via static config (`agents[].trust:` in cortex.yaml). |
| Cortex's dependency | None at v1. When M5 lands, cortex's agent registry would consume it for runtime discovery instead of static config. |
| Cortex's contract | Cortex's static `agents[].trust:` is a placeholder for the M5 query — when M5 lands, this becomes a runtime lookup. The agent task routing pattern in §7 effectively prototypes M5's capability registry. |

### 4.6 M6 — Composition

| Aspect | Detail |
|--------|--------|
| Spec home | `the-metafactory/myelin` — myelin#10 (open, future). |
| Status | Spec not yet written. Cortex implements *patterns* (pipeline, fan-out, request/reply) ad-hoc today; M6 will codify them. |
| Cortex's dependency | None at v1. When M6 lands, cortex's surface-router and dispatch handler may rebase on M6 patterns. The bidding sovereignty mode in §7.3 is the first concrete request/reply use-case. |

---

## 5. M7 sibling apps and adjacent knowledge artefacts

What sits around cortex at the application layer, and what knowledge artefacts cortex consumes that aren't bus participants.

### 5.1 M7 sibling apps

Multiple repos live at M7. Each consumes M2–M6 contracts; none impose on the others except through bus envelopes.

| App | Repo | Role |
|-----|------|------|
| **cortex** | `the-metafactory/cortex` | The operator's collaboration surface — Discord/Mattermost adapters, Mission Control dashboard, workflow runner spawning Claude Code, GitHub-webhook tap, CC-event tap. The M7 application this design is about. |
| **pilot** | `the-metafactory/pilot` | Review-loop coordinator. Manages errand state (ping → fetch → triage → apply); operates independently. Cortex projects pilot's errand events as cards in the surface. |
| **signal bundle** | three repos — see §5.2 | Modular observability bundle: tap (host-agnostic) + collector (profile-driven) + optional self-hosted stack. Cortex hosts a signal tap; cortex eventually drills into traces by `correlation_id`. |
| **future apps** | various | Anything else that connects to the bus — e.g. an inbox-only TUI, a Slack assistant, a metrics panel — counts as another M7 sibling. |

**Cortex's contract with sibling M7 apps:**

- Cortex MUST NOT runtime-import sibling-app code (no `import from '~/Developer/pilot/src/'`). Cross-app communication is by bus envelope.
- Cortex MAY shell out to a sibling app's CLI (e.g. `pilot fetch <PR>`) when the bus path doesn't exist yet — surface this as a known coupling and track removal as the bus path lands.
- Cortex MUST tolerate sibling absence: if signal-collector isn't installed, drill-down trace trees show "no telemetry available," but the rest of cortex works.

### 5.2 The signal bundle — three independently rolled-out repos

Reference: `~/Developer/signal/README.md` + signal's modular-bundle architecture diagram (in signal repo's `docs/`). Signal is **not one repo** — it's three, each independently installable, glued together by the bus and the OTLP contract.

```
        AGENT HOST                         NATS bus              COLLECTOR (M7)         BACKENDS (operator's choice)
        (cortex, PAI, CI, …)               (local leaf)                                  pick zero, one, or many
        ┌─────────────────────────┐                              ┌─────────────────┐    ┌──────────────────┐
        │ signal (tap) ─ metafac- │ publish OTLP envelopes       │ signal-         │    │ Grafana Cloud    │
        │ tory bundle, always     │ ───────────────►             │ collector       │ ──►│ (SaaS)           │
        │ installed.              │                              │ (Vector or      │    └──────────────────┘
        │                         │ mf.net-{op}.trace.>          │  otelcol)       │    ┌──────────────────┐
        │ 4 hooks:                │ mf.net-{op}.metric.>         │                 │ ──►│ Honeycomb (SaaS) │
        │  Pre / Post /           │ mf.net-{op}.log.>            │ profile-driven: │    └──────────────────┘
        │  Subagent /             │                              │   grafana-cloud │    ┌──────────────────┐
        │  LoadContext            │                              │   .yaml         │ ──►│ Datadog (SaaS)   │
        │                         │                              │   honeycomb     │    └──────────────────┘
        │ + W3C trace context     │                              │   .yaml         │    ┌──────────────────┐
        │ + OTLP envelope builder │                              │   datadog.yaml  │ ──►│ Enterprise OTel  │
        │ + NATS publisher        │                              │   enterprise-   │    │ (your org's      │
        └─────────────────────────┘                              │   otel.yaml     │    │  stack)          │
                                                                 │   local-stack   │    └──────────────────┘
                                                                 │   .yaml         │    ┌──────────────────┐
                                                                 │                 │ ──►│ signal-stack     │
                                                                 │ metafactory     │    │ (self-hosted —   │
                                                                 │ bundle —        │    │  VictoriaMetrics │
                                                                 │ optional        │    │  + Grafana, in   │
                                                                 └─────────────────┘    │  Docker. NOT a   │
                                                                                        │  metafactory     │
                                                                                        │  bundle —        │
                                                                                        │  separate repo)  │
                                                                                        └──────────────────┘
```

| Component | Repo | Bundle status | Role |
|-----------|------|---------------|------|
| **signal (tap)** | `the-metafactory/signal` | metafactory bundle — always installed | Host-agnostic CC instrumentation: 4 hooks (Pre / Post / Subagent / LoadContext), W3C trace context, OTLP envelope builder, NATS publisher |
| **signal-collector** | `the-metafactory/signal-collector` *(planned, not yet a real repo)* | metafactory bundle — optional | Profile-driven Vector / otelcol wrapper. Subscribes to `mf.net-*.trace.>` etc., forwards via OTLP to operator-chosen backend(s) |
| **signal-stack** | `the-metafactory/signal-stack` *(planned, not yet a real repo)* | NOT a metafactory bundle — declared dependency of the `local-stack` collector profile | Self-hosted backend template. Docker Compose with VictoriaMetrics + Grafana. Optional. |

**Cortex's relationship to the bundle:**

- Cortex **hosts a signal tap**: the CC hooks (today's `src/hooks/EventLogger.hook.ts` etc., moving to `cortex/src/taps/cc-events/`) are an instance of signal's tap pattern. The tap publishes OTLP envelopes onto `mf.net-{op}.trace.>` whether or not signal-collector is installed.
- Cortex does NOT bundle a collector or backend. Operators choose: SaaS-only (tap + collector → Grafana Cloud / Honeycomb / Datadog), local-first (tap + collector + signal-stack), or distributed (tap on laptop, collector on server, stack on a third box). The NATS bus + OTLP contract make all three topologies identical to the tap.
- Cortex MUST tolerate signal-collector being absent: the tap publishes; if no consumer is subscribing, NATS handles the no-op cleanly. Cortex's drill-down trace-tree feature degrades gracefully to "no telemetry available."
- **Coupling rule (mirroring signal's own discipline):** Signal MUST NOT import from `cortex/src/`; cortex MUST NOT import from `signal/src/`. Both publish/subscribe on the shared transport.

**Lineage**: signal began as a prototype skill in `mellanon/pai-2.3:feature/signal-agent-2`. The prototype proved distributed tracing across hooks and subagents worked; modularising into the three-repo bundle is the re-homing.

### 5.3 Adjacent to the stack — knowledge artefacts cortex consumes

Not stack participants. Files (or files plus a CLI) that M7 apps reference at design time, build time, or run time.

| Artefact | Repo | Role | Cortex's dependency |
|----------|------|------|---------------------|
| **compass SOPs** | `the-metafactory/compass` — `~/Developer/compass/sops/*.md` | Standard operating procedures (dev-pipeline, worktree-discipline, pr-review, design-process, versioning, retrospective, new-repo-pattern). | Build-time + governance: cortex's CLAUDE.md is generated via `arc upgrade compass`; cortex CI runs compass validators. |
| **blueprint graph** | `the-metafactory/blueprint` — `blueprint.yaml` per repo + `blueprint` CLI | Cross-repo feature dependency graph; computes `ready` / `blocked` / `next`. | Cortex has its own `blueprint.yaml` with C-1xx feature IDs. Cortex's Mission Control surface renders cross-repo status by invoking the `blueprint` CLI. |
| **CLAUDE.md** | per repo | Project-specific agent rules + architecture summary. | Cortex's CLAUDE.md is regenerated by `arc upgrade compass` from a template + section files in `docs/agents-md/`. |

These are real architectural concerns. They are NOT layers in M1–M7. The earlier ecosystem-L1–L7 framing in `design-collaboration-surface.md` §2 treated them as layers (calling compass "L5 Process" and blueprint "L6 Knowledge graph") and that produced the M-vs-L confusion. The artefacts are valuable; the layer framing for them was wrong.

### 5.4 arc — distribution and bundling

Reference: `the-metafactory/arc` — the metafactory package manager. Like compass and blueprint, arc is **adjacent to the stack, not in it** — it's a distribution-layer concern that happens to install M7 apps + their dependencies onto operator hosts. Surfacing it explicitly because cortex's existence as a deployable thing depends on arc.

**What arc does:**

- **Bundles** metafactory things — myelin (the M2–M6 protocol bundle), signal (the observability tap), cortex (this M7 app), pilot, plus tools, skills, and CLIs. Each bundle declares itself in an `arc-manifest.yaml` with `name`, `version`, `description`, and a `provides:` list of files to install.
- **Distributes** bundles across operator hosts via `arc upgrade <Name>`. The operator runs one command and gets the binary + hooks + skills + config templates installed at the right filesystem paths (`~/bin/`, `~/.claude/hooks/`, `~/.claude/skills/`, …).
- **Configures** environment-specific things at install time — NATS identity keys (per myelin#8 / MY-400), CF Access secrets, per-host overrides. Templates live in the manifest; concrete values live in the operator's environment.
- **Tracks** what's installed and at what version — `arc list` shows installed bundles, `arc upgrade` updates them.

**Cortex's relationship to arc:**

| Aspect | Detail |
|--------|--------|
| Cortex is a metafactory bundle | Installable via `arc upgrade Cortex` once MIG-7 lands. Pre-cutover the package name is `Grove`; the rename to `Cortex` happens at MIG-7.7. |
| Cortex's `arc-manifest.yaml` | Declares `provides:` — `~/bin/cortex` (the bot binary), `~/bin/discord` (operator CLI), `~/bin/cldyo-live` (CC instrumentation wrapper), CC hooks, skills. The same shape grove-v2 has today. |
| Cortex consumes other bundles indirectly | Operators install `myelin` (via arc) for the bus protocol; `signal` (via arc) for the observability tap; `cortex` (via arc) for the surface. Each is independently rolled out. |
| Cortex does NOT runtime-import arc | arc is a build/install-time tool. At runtime cortex doesn't know it was installed by arc — it just finds its config at the configured path and runs. |
| Cross-bundle dependencies | Declared via the `arc-manifest.yaml` `dependsOn:` field. Cortex declares `myelin` (the schema is vendored, but operators need myelin's CLI for identity-key provisioning per MIG-7's `nats.identity` config). signal is *recommended* but not required (cortex tolerates absent collector). |
| Existing examples | `~/.config/metafactory/pkg/repos/` shows installed bundles today: `grove` (legacy bot), `compass` (SOPs + validators), `pilot`, etc. The same directory will hold `cortex` post-MIG-7. |

**Why this matters for the design:**

- Cortex's `provides:` list is the operator-facing API of the package, just as cortex's envelope set (§6.1) is the agent-facing API of the running app. Both are versioned, append-only, and form contracts cortex must honour across versions.
- arc's `dependsOn:` mechanism is the only place cross-bundle ordering shows up — at install time. At runtime, the bus mediates everything; arc has no runtime role.
- The migration's MIG-6 (CLIs) and MIG-7 (top-level wiring) phases both spend significant time on arc-manifest changes. The plan tracks that explicitly.

**Coupling discipline (mirroring §4 / §5.2):**

- Cortex MUST NOT runtime-import from `arc/src/`. arc reads cortex's manifest; cortex doesn't read arc.
- Cortex's `arc-manifest.yaml` MUST be valid against arc's published manifest schema. Manifest validation runs in cortex's CI.
- Cortex MAY shell out to `arc` for one-shot install-time steps (e.g. `arc identity provision` per JC's E2E NATS work) but never as a runtime dependency.

**Reading order:** `~/Developer/arc/README.md` for the install model → `arc list` / `arc upgrade --help` for the operator-facing CLI → existing manifests in `~/.config/metafactory/pkg/repos/*/arc-manifest.yaml` as concrete examples.

---

## 6. M7 application architecture

The M1–M6 stack tells us how messages move and what shape they take. It says nothing about how M7 applications are structured internally or how they relate to one another. This section sets the design principles for the M7 layer — the constitution every M7 app (cortex, pilot, signal-collector, future apps) is expected to honour.

### 6.1 Strongly-typed app APIs — the envelope IS the API

An M7 app's public surface is **the set of envelopes it publishes + the set it consumes + the patterns it responds to** (per M6 once that lands — pipeline, fan-out, request/reply). Not its source code, not its CLI, not its REST endpoints — those are implementation details. The contract is the envelope schema set.

For cortex, concretely:

- **Inbound contract:** cortex consumes `local.{org}.review.*` (from pilot), `local.{org}.dispatch.task.received` (from itself or external dispatchers), `local.{org}.attention.item.*` (from any source), `local.{org}.system.*` (operational events from any M7 app), and a few more. Each subject has a documented payload schema in cortex's domain catalogue.
- **Outbound contract:** cortex publishes `local.{org}.dispatch.task.{started,progress,completed,failed,aborted}` (workflow runner emissions), `local.{org}.system.adapter.*` (per G-1111 §3.5), `local.{org}.review.*.decision` (operator decisions out of the surface).
- The envelope schemas are versioned, append-only, and live in cortex's repo (`docs/api/` or `src/contracts/` — TBD; see open questions in the migration plan).
- A consumer of cortex's contract can — in principle — replace cortex with a re-implementation that publishes/consumes the same envelopes, and the rest of the system doesn't notice. **That's the load-bearing property.**

The same applies for every M7 app: pilot has a contract, signal-collector has a contract, future apps have a contract. Documented per-app in their own repos. A sibling M7 app integrates with cortex by reading cortex's contract docs, not by reading cortex's source.

### 6.2 Microservices architecture — M7 apps are independently deployable

Each M7 app is a microservice in the architectural sense: independently deployable, owns its own data, communicates with peers async via the bus, fails independently.

- **Independent deployment.** cortex and pilot ship via separate `arc` packages, separate version cadences. An operator can run pilot at a different version than cortex; if their envelope contracts are intersecting versions, they interoperate.
- **Data ownership.** Each M7 app owns its persistent state behind its own boundary. Cortex's Mission Control DB belongs to cortex; pilot's `errands.sqlite` belongs to pilot. No shared database, no foreign-key relationships across apps. State that needs to flow between apps flows as envelopes.
- **Async-first communication.** Apps communicate via published envelopes (fire-and-forget), with M6 request/reply for synchronous needs. No app calls another app's HTTP endpoint as a primary integration mechanism. (CLI shell-outs for transitional integrations — e.g. `pilot fetch <PR>` — are tolerated short-term and tracked for removal.)
- **Failure isolation.** An M7 app crashing degrades the system gracefully — its envelopes stop flowing, its surfaces go dark, but other apps keep running. The bus's `system.adapter.*` events make this visible per G-1111 §3.5 + §4.6.

The microservices framing also says what cortex is NOT: cortex is not a monolith with multiple internal "services" calling each other through in-process function calls dressed up as services. Cortex is **one** microservice — internally decomposed (bus / surface / adapters / runner / taps) for code-organisation reasons, but a single deployable unit that talks to its peers (pilot, signal-collector, etc.) over the bus.

### 6.3 Domain-Driven Design — bounded contexts at M7

DDD is the lens for *how to scope an M7 app*. The question "what belongs in cortex vs. what belongs in a separate M7 app?" is answered by bounded-context discipline.

Cortex's bounded context, roughly:

| Concept | In cortex's bounded context? |
|---------|------------------------------|
| The operator's collaboration surface (Discord, Mattermost, Mission Control dashboard) | ✅ Yes — operator-collaboration is the core domain. |
| Workflow runner that spawns Claude Code on dispatch | ✅ Yes — dispatching work to Claude is part of the same bounded context. |
| Worklog state per agent task | ✅ Yes — directly tied to dispatch lifecycle. |
| GitHub webhook tap that publishes envelopes | ✅ Yes (probably) — thin shim that brings external events onto the bus where cortex's surface can render them. Could split out later. |
| CC hook tap that publishes envelopes | ✅ Yes — same reasoning. |
| OTLP span emission from CC tool calls | ❌ No — that's signal-collector's bounded context. |
| PR review-loop coordination (errand DB, ping/fetch/triage/apply) | ❌ No — that's pilot's bounded context. Cortex consumes pilot's events; doesn't implement them. |
| Cross-repo feature dependency graph | ❌ No — that's blueprint's bounded context. Cortex consumes the graph via the `blueprint` CLI. |
| SOP definitions and validators | ❌ No — that's compass's bounded context. Cortex consumes SOPs as markdown. |

Within cortex, the **internal modules** (§8 below) are sub-domains of the cortex bounded context. They communicate in-process via TypeScript interfaces — internal implementation, not architecture.

---

## 7. Agent task routing — capability-driven dispatch

Reference: `~/Developer/myelin/docs/design-agent-task-routing.md` (myelin PR #36 — three distribution modes + M7 stratification + event lifecycle; **Pattern 4 accepted 2026-05-09**). Cortex's M7 dispatch handler is the canonical first consumer of this pattern, and serves as the worked example for §6's M7 application principles.

### 7.1 Three distribution modes — what gets routed how

The protocol carries three operator-facing modes, all on the same wire but with different operator contracts:

| Mode | Operator says | Mechanism | Operator commits to |
|------|---------------|-----------|---------------------|
| **Broadcast** | "someone do this" | competing consumers — any qualifying agent claims | a *task* (one unit of work) |
| **Direct** | "Forge, cut a release" | named recipient — single agent, no competing | a *task* delivered to a known agent |
| **Delegate** | "Pilot, drive PR #32 to merge" | same wire as Direct, but the receiving agent internally orchestrates a multi-step outcome | an *outcome* (not a task graph) |

The cognitive-load argument for naming **Delegate** as a first-class mode: without it, the design implies all routing is open-market, and the operator-facing benefit (agents absorbing coordination overhead so the human commits to outcomes rather than task graphs) becomes invisible. Pilot's review loop is the canonical Delegate case — the operator says "drive this to merge," pilot internally decomposes that into ping/fetch/triage/apply/dispatch/sync.

Delegate auditability rides on chain-of-stamps (myelin#31).

### 7.2 The mechanism — JetStream + Capability Registry

myelin's Pattern 4 evaluates the **Broadcast-mode** mechanism. Direct and Delegate ride on top via subject-shape conventions (named-recipient subjects + `target_principal` envelope field), not separate transport patterns.

- **Publish** tasks to `local.{org}.tasks.{capability}.{subcapability}` subjects, e.g. `local.{org}.tasks.code-review.typescript`, `local.{org}.tasks.security-scan.*`, `local.{org}.tasks.deploy.cloudflare`. The capability hierarchy IS the routing key.
- **Capability registry** in a NATS KV bucket at `local.{org}.agents.capabilities` — agents self-register on startup with `capabilities`, `sovereignty`, `maxConcurrent`, `load`. The registry enables dynamic consumer-group lifecycle and capability matching. KV writes are signed per myelin#31.
- **Dead-letter** at `local.{org}.tasks.dead-letter.{capability}` for tasks that exceed retry budgets.

### 7.3 Event-driven lifecycle — the dispatch contract

Every routed task emits a JetStream-backed envelope sequence on the `events.>` class (per §3). This lifecycle is **part of the protocol**, not an M7 implementation choice — Delegate visibility, replay, chain-of-stamps auditability, and threshold-review for velocity-class harm all depend on it.

Canonical subjects:

```
local.{org}.dispatch.task.received     ── tap or operator-input → bus; pre-dispatch
local.{org}.dispatch.task.assigned     ── routing decision (which agent claimed it)
local.{org}.dispatch.task.started      ── agent began executing
local.{org}.dispatch.task.progress     ── intermediate signal (Delegate sub-step, status update)
local.{org}.dispatch.task.completed    ── ack outcome
local.{org}.dispatch.task.failed       ── unrecoverable error; correlation_id for retry-thread join
local.{org}.dispatch.task.aborted      ── operator-cancelled or system-aborted
```

**Structured nak reasons** — when an agent rejects (naks) a Broadcast task, the reason MUST be one of:

- `cant-do` — capability mismatch (agent doesn't claim this capability)
- `wont-do` — sovereignty refuses (agent could but policy says no)
- `not-now` — backpressure (retry me later, capability still valid)
- `compliance-block` — agent's compliance attestation forbids it (e.g. STD-NPW-AI-001 gate)

This four-way discrimination is what makes Delegate-mode observability tractable. "Pilot couldn't drive this PR" is materially different from "Pilot won't drive this PR right now" or "Pilot is compliance-blocked from acting on this PR."

### 7.4 Sovereignty modes

Four declarative modes control task acceptance per agent:

- `open` — auto-ack all matching tasks
- `selective` — agent evaluates and may nak (with structured reason per §7.3)
- `strict` — explicit capability + sovereignty match required
- `bidding` — triggers a request/reply (M6 pattern) for selection optimisation

### 7.5 Stratification — what's in the bus, what's in cortex

myelin#36 draws an explicit boundary. Five concerns DO NOT live in the bus protocol; they live in M7. This matters for cortex because cortex IS the M7 app that owns these:

| Concern | Lives in | Cortex's home for it |
|---------|----------|----------------------|
| Agent capability declaration (tools, envs, creds, reach) | M7 deployment config | `cortex.yaml` `agents[].roles + .trust + .presence` per §9 |
| Orchestrator translation of operator intent → task graph | M7 orchestrator agent | The Delegate-receiving agent's internal logic (e.g. pilot's review-loop logic — not in cortex; pilot is its own M7 app) |
| Compliance attestation (e.g. Northpower STD-NPW-AI-001) | M7 deployment-time, signed at install | Cortex's `arc-manifest.yaml` + agent persona declarations; out of scope for v1 cortex but the slot exists |
| Notification surface routing | M7 surface-router | `cortex/src/bus/surface-router.ts` (§8) — exactly this concern |
| Sub-agent trust floor | M7 orchestrator policy + chain-of-stamps | Cortex's agent registry + chain-of-stamps verification (myelin#31) |

The mistake to guard against: lifting any of the above into the bus. Each lift would couple the protocol to one operator's policy choices, break transport-independence, and create rot surface. Capability is too thin a primitive *if you put it in the bus*; rich enough *at M7*.

### 7.6 Cortex's responsibilities

Cortex's M7 dispatch handler — the runtime that takes inbound work (Discord ping, dashboard click, GitHub event triggering a workflow) and turns it into a task on the bus — must:

1. **Publish** the lifecycle envelope sequence per §7.3 (`local.{org}.dispatch.task.{received,assigned,started,progress,completed,failed,aborted}`) on the `events.>` class. Every routed task is an event stream — the lifecycle is the protocol.
2. **Tag mode** in envelope payload so consumers can distinguish Broadcast / Direct / Delegate. For Delegate, the receiving agent owns sub-step progress emission.
3. **Consume** via JetStream pull consumers filtered to the agent's capabilities, **not** hardcoded by subject. Each cortex-hosted agent (Luna, Echo, Forge, …) subscribes through a pull consumer keyed on its declared capability set.
4. **Respect nak semantics with structured reasons** (§7.3) — surface `cant-do` vs `wont-do` vs `not-now` vs `compliance-block` to operators rather than collapsing to a generic failure.
5. **Register** each agent's capabilities into the KV bucket on startup with signed writes (myelin#31). The registry is the M5 Discovery seed; future myelin#9 spec consumes it.
6. **Support sovereignty declaration** — each agent's config carries a `sovereignty:` field that determines its claim behaviour. Maps to the four modes in §7.4.
7. **Honour stratification (§7.5)** — keep capability declaration, compliance attestation, surface routing, and orchestrator policy in cortex's M7 layer; never push them into bus envelopes.

This shifts cortex's dispatch from hardcoded routing (`if message in #grove → spawn CC with grove agent`) to **declarative, durable, pull-based task claiming** — agents decide what work fits their capabilities, with NATS infrastructure handling competing-consumer fairness and retry guarantees. Today's grove-v2 dispatch handler is hardcoded; cortex's is registry-driven from day one.

### 7.7 Relationship to the M1–M7 stack

- **M2 (Transport)** provides JetStream consumer groups + KV bucket primitives + dead-letter subjects.
- **M3 (Envelope)** carries task payload (`requirements`, `sovereignty_required`, `target_principal` for Direct/Delegate).
- **M4 (Identity)** signs the publishing source so consumers can verify task origin; signed KV writes for the capability registry.
- **M5 (Discovery)** is the capability registry — the `AGENT_CAPABILITIES` KV bucket defined in this design IS the M5 seed. myelin#9 spec will formalise the KV schema, watcher contract, capability taxonomy, and signed registration envelope format.
- **M6 (Composition)** provides the bidding-mode request/reply pattern.
- **M7 (this layer, cortex)** owns capability declaration, orchestrator translation, compliance attestation, surface routing, and sub-agent trust per §7.5.

The agent task routing pattern thus exercises M2–M7 end-to-end and is the canonical worked example for "how M7 apps coordinate via the bus."

---

## 8. Cortex internal componentisation

The five top-level `src/` subdirectories below are **modules of one M7 application**. They are NOT layers — they are the internal componentisation of cortex, much as any application has internal modules. They map to the bus stack as consumers (bus client subscribes to M2; surface adapters render envelopes; etc.), but cortex-the-app sits at M7 of the Myelin stack as a whole.

```
cortex/
  src/
    bus/              ── M2–M6 client code (cortex's connection to the Myelin stack):
                          NATS client (M2), envelope validator (M3),
                          identity client (M4 when MY-400 lands), surface-router
                          (cortex-internal fan-out from bus to adapters/runner).
                          Loads ~/.config/cortex/cortex.yaml.
    surface/          ── Operator surfaces — what humans see.
      mc/             ── Mission Control v3 (Hono + React, observed-session model).
      cli/            ── Future TUI / cli-tail surfaces. Empty in v1.
    adapters/         ── Platform-specific adapters (Discord, Mattermost, etc.).
                          Each adapter is a per-agent presence runtime (per §9):
                          subscribes to the surface-router, renders envelopes
                          to the platform, posts platform input back as envelopes.
      discord/        ── DiscordAdapter (today's grove-v2 src/bot/lib/adapters/discord.ts)
      mattermost/     ── MattermostAdapter
      slack/          ── (Future)
      pagerduty/      ── (Future — paging renderer for system.* events)
    runner/           ── Workflow runner. Spawns Claude Code, owns session state,
                          manages worklog threads, emits dispatch.* lifecycle events.
    taps/             ── Cortex-side publishers that turn external events into bus
                          envelopes (so the surface-router and runner can act on them).
      gh-webhook/     ── GitHub webhook → NATS
      cc-events/      ── Claude Code hooks → NATS
    cli/              ── Operator CLIs.
      discord/        ── ~/bin/discord (subdir: discord.ts entry + lib/ + skill/)
      cldyo-live      ── CC instrumentation wrapper (single bash script, NOT a directory)
    common/           ── Shared types, utilities.
  docs/
    architecture.md   ── This doc, copied in at MIG-0.10.
    api/              ── Envelope contract docs (per §6.1) — schemas + examples.
    design-*.md       ── Per-feature design docs (lifted from grove-v2).
  arc-manifest.yaml   ── name: Cortex
  blueprint.yaml      ── New ID range C-1xxx
  CLAUDE.md           ── Generated from compass template
```

Internal module boundaries are TypeScript directory + import discipline, not packages. A flat `src/` is sufficient at v1; package-ising can come later if the codebase grows past a comfort threshold.

---

## 9. The agent + presence/renderer model

A load-bearing concept from grove-v2 that cortex preserves and simplifies: each Discord-facing personality (Luna, Echo, Holly, Ivy, Forge) is a bundle of identity + persona + capabilities + platform credentials. Operators interact with these bundles by name — "ping Echo for review", "ask Luna to summarise", "Holly is JC's reviewer". That contract cannot break.

### 9.1 Agents own their presence (not the other way around)

Mental model: a human user connects to a server with their credentials; the server doesn't pre-declare "Andreas works here." Agents are principals; platforms are servers; the agent's credentials are how the agent shows up on a platform.

**Two kinds of surface, with a clean split:**

| Kind | Describes | Owned by | Examples |
|------|-----------|----------|----------|
| **Presence** | An agent's identity on a chat-style platform — one agent per connection | the agent (in `agents[].presence`) | Discord bot, Mattermost bot, Slack bot |
| **Renderer** | A non-agent-bound surface that projects bus state to humans (or pages out) | the cortex deployment (in top-level `renderers[]`) | Dashboard, PagerDuty, cli-tail, generic webhook out |

Cortex config schema:

```yaml
operator:                          # who is running this cortex instance
  id: andreas
  discordId: "1134..."

agents:                            # first-class agent bundles — the canonical list
  - id: luna
    displayName: Luna
    persona: ./personas/luna.md
    roles: [operator]              # cortex-wide capability set
    trust:                         # peer agents this agent trusts (by agent id)
      - echo
      - holly
      - ivy
    presence:                      # where this agent shows up — owned by the agent
      discord:
        token: <luna-discord-token>
        guildId: "1487..."
      # slack:                     # future — same Luna, Slack presence
      #   token: ...
      #   workspace: ...

  - id: echo
    displayName: Echo
    persona: ./personas/echo.md
    roles: [agent-restricted]
    trust: [luna, holly]
    presence:
      discord:
        token: <echo-discord-token>
        guildId: "1487..."

  - id: forge
    displayName: Forge
    persona: ./personas/forge.md
    roles: [agent-restricted]
    presence:
      discord:
        token: <forge-discord-token>
        guildId: "1487..."

renderers:                          # multi-agent / non-agent-bound surfaces
  - kind: dashboard                 # operator cockpit — Mission Control v3
    port: 8767
    publicUrl: https://cortex.meta-factory.ai
    subscribe: ["local.{org}.>"]
    projections:
      - source: review.*
        into: kanban-card
        column: in-review
      - source: dispatch.task.*
        into: kanban-card
        column: in-flight
      - source: attention.item.*
        into: inbox-row
      - source: system.adapter.degraded
        into: status-banner

  - kind: pagerduty                 # operational events out (per G-1111 §4.6)
    routingKey: ${PAGERDUTY_ROUTING_KEY}
    subscribe:
      - "local.{org}.system.adapter.degraded"
      - "local.{org}.system.process.crashed"
      - "local.{org}.system.subscription.dropped"
      - "local.{org}.system.buffer.overflowed"

  - kind: cli-tail                  # local stdout follower (developer tool)
    subscribe: ["local.{org}.>"]
```

### 9.2 Renderer organisation — agents are actors, not categories

Renderers organise around **events / work-items / cards**, not agents. A dashboard isn't "Luna's panel" plus "Echo's panel" — it's a Kanban over the bus stream where agents appear as the actor field on each card. This mirrors `design-collaboration-surface.md` §5.1: the dashboard's primary unit is the work-item card, not the agent.

| Concern | Agent-centric (rejected) | Activity-centric (canonical) |
|---|---|---|
| What does the dashboard subscribe to? | per-agent slices | `local.{org}.>` whole-org bus; filter at render time |
| What's the primary unit? | "Luna's tasks" | "PR #57 in review (cycle 2, currently with Echo)" |
| Where do agents appear? | As headers / panels | As actor fields on cards: `assignee`, `reviewer`, `requested-by`, `last-touched-by` |
| Where do non-agent events appear? | Awkward — they have no agent header | Naturally — they're cards: GitHub PR-merged, pilot errand `needs-decision`, signal alert, blueprint feature `became-ready`, compass SOP `gate-passed` |

Two kinds of renderer config:

1. **Static** (in YAML) — initial subscriptions, projection rules, paging rules, default columns. Deployment-time decisions.
2. **Runtime / UX** (in the dashboard itself) — operator preferences: which columns to expand, which filters to pin, which agent's activity to highlight. Live in the renderer's own state (D1 / SQLite / browser localStorage), not in cortex.yaml.

The split keeps cortex.yaml deterministic + reviewable while letting operators arrange their own view without a config edit + restart.

### 9.3 Coupling discipline

- An agent definition MUST NOT reference any other agent's platform user ID. References between agents are by logical agent id (`trust: [echo, holly]`), never by Discord/Slack/Mattermost ID. Platform IDs are an adapter-runtime concern.
- An agent's `presence.<platform>` block contains only that platform's identity material (token, guild, workspace) — never a persona override, never a role override. The agent's persona and roles are global to the agent across all presences.
- A presence adapter MUST refuse to start if its parent agent's id is missing from the registry, or if its credentials are invalid. Fail-closed.
- Personas MUST be platform-neutral markdown — no Discord-specific formatting, no `<@id>` mentions baked in. The presence adapter translates logical mentions (`@echo`) into platform syntax at render time.
- An agent's roles list defines its **maximum** capability set. A presence MAY further restrict (e.g., Luna's Slack presence in a public workspace may strip `team` mode). Presences never widen.
- Cross-agent trust resolves at adapter startup: each presence adapter, on connect, learns its own platform user id (e.g. `discord.client.user.id`) and registers it in a process-wide `(platformId → agentId)` map. When an inbound message arrives from a known platform id, the receiving adapter looks up the source agent and consults its parent's `trust:` list.
- **Renderers MUST NOT publish on the bus** as a side effect of rendering. Renderers are sinks: they subscribe and present. Operator-input emitted from a renderer (e.g., a dashboard "approve" click) goes through the bus as a logical envelope from the operator, not from any agent.

---

## 10. Reading order for new contributors

To understand what cortex IS in two hours:

1. **15 min** — `myelin/README.md` + `myelin/specs/namespace.md` (the universal envelope; everything cortex does flows in this shape)
2. **20 min** — myelin#7 issue body (the canonical M1–M7 stack model; until it lands as `myelin/docs/architecture.md`)
3. **15 min** — `myelin/docs/design-agent-task-routing.md` (the M7 task routing pattern cortex's dispatch implements — §7 of this doc)
4. **30 min** — `docs/design-collaboration-surface.md` (cortex's lineage as the layer-7 surface + flybridge cockpit framing + the event architecture diagram)
5. **30 min** — `docs/design-event-taxonomy.md` (cortex's M7-side event vocabulary, including the system.* operational domain)
6. **15 min** — `docs/iteration-collaboration-surface.md` (G-1100 ladder retro — what got built, what was learned)
7. **30 min** — this design doc (synthesis: what cortex IS, the M7 app principles, agent + renderer model)
8. **20 min** — `docs/plan-cortex-migration.md` (the working migration plan; only relevant during the grove-v2 → cortex transition)

Skip on first pass: signal collector internals (still design), pilot's internals (cortex consumes events read-only), arc/compass/blueprint internals (operate as black boxes via SOPs/CLIs).

---

## 11. References

- **Stack model** — myelin#7 (canonical; doc landing pending), `~/Developer/myelin/specs/namespace.md`, `~/Developer/myelin/schemas/envelope.schema.json`, `~/Developer/myelin/.specify/specs/f-018-my-400/spec.md`, `~/Developer/myelin/docs/design-agent-task-routing.md` (myelin PR #36 — three distribution modes + M7 stratification + event lifecycle), myelin#31 (chain-of-stamps signing — drives Delegate auditability).
- **Lineage docs** — `docs/design-collaboration-surface.md` (PR #58 + #83 — includes the event architecture diagram), `docs/design-event-taxonomy.md` (PR #81), `docs/iteration-collaboration-surface.md` (PR #79).
- **M7 sibling apps** — `~/Developer/pilot/README.md`, `~/Developer/signal/README.md` + `~/Developer/signal/docs/design-signal-bundle-migration.md`.
- **Knowledge artefacts** — `~/Developer/compass/sops/*.md`, `~/Developer/blueprint/README.md`, `~/Developer/blueprint/docs/design-event-sync.md`.
- **Distribution layer** — `~/Developer/arc/README.md`, existing manifests at `~/.config/metafactory/pkg/repos/*/arc-manifest.yaml` (concrete examples).
- **Process** — `~/Developer/compass/sops/dev-pipeline.md`, `worktree-discipline.md`, `pr-review.md`, `design-process.md`, `versioning.md`, `new-repo-pattern.md`.
- **Working migration plan** — `docs/plan-cortex-migration.md`.

---

*This document is the static architecture reference. The migration plan is its working-document sibling. When this doc and reality disagree, this doc wins (or is updated, never silently).*
