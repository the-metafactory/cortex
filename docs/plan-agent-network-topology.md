# Plan — Agent Network Topology (G-1114)

**Status:** grounded — reconciled to [ADR-0007](adr/0007-agent-presence-protocol.md)
**Design:** [`docs/design-agent-network-topology.md`](design-agent-network-topology.md)
**Umbrella issue:** #355
**Process:** umbrella → phase sub-issues → sub-feature PRs; one PR per
sub-feature; pilot review loop with Echo primary.

> **Reconciliation note.** Reconciled to
> [ADR-0007](adr/0007-agent-presence-protocol.md) (G-1114 grilling, 2026-06-10):
> `{org}→{principal}` throughout; `agent`-domain presence distinct from the
> dispatch-scoped `system.agent.heartbeat`; network-as-namespace dropped in
> favour of registry-roster grouping; public scope deferred to G-1115. When
> this plan and ADR-0007 disagree, ADR-0007 wins. When this plan and the design
> spec disagree on what the protocol *is*, the design spec wins.

## 1. What we're building (recap)

G-1114 makes **agent presence** (whether an agent process is up and consuming
the bus, independent of any dispatch) observable across stacks:

1. **Presence protocol** on the `agent` domain —
   `local.{principal}.{stack}.agent.{online|heartbeat|offline|capabilities-changed}`
   (and the `federated.` counterpart). Distinct from the dispatch-scoped
   `system.agent.heartbeat` (cortex#361).
2. **Consumer-side runtime registry** — a subscriber maintains an observable
   "who is here, in what state, with what capabilities" store, with a 5-min
   liveness FSM.
3. **Network view in Mission Control** — a graph render (React Flow + ELK,
   lifting Strata's UI). Presence + dispatch-lifecycle metadata only — never
   peer session interiors (ADR-0005).
4. **Two transports, one envelope** — bus federation feeds the local view
   (G-1114.E); the [ADR-0006](adr/0006-network-view-feed-registry-anchored.md)
   registry-anchored push feeds the hosted pane.

The existing capability-matched dispatch path (cortex#237) is **unchanged** —
the runtime registry is an observability + discovery layer on top.

### 1.1 Iterative delivery — each phase ships visible value

| Phase | What the principal sees after this phase |
|---|---|
| A — Grounding | Design + plan reconciled on `main`; inert `agent.*` payload types in the codebase (no producer / no subscriber); a "Network (preview)" placeholder tab. **Zero runtime change.** |
| B — Local producer + subscriber | The preview tab becomes a real agents panel; agents pop up on boot, drop off after 5 min of silence. |
| C — Capabilities delta + liveness FSM | Live capability badges; offline agents render muted with last-seen. |
| D — Network view (stack-local) | A "Network" tab with the React Flow + ELK graph. Click for a detail panel. |
| E — Federation | The view extends to federated peer stacks (bus-federation transport). Foreign agents render with `{principal}/{stack}` provenance. |
| F — Capability-routing UX | Hover a task → matching agents highlight. Right-click an agent → "dispatch direct." |

## 2. Issue + PR structure

```
G-1114  Agent Network Topology (umbrella, #355)
  ├── G-1114.A  Phase A — Grounding & Protocol Types   (sub-issue → 1 PR)
  │     └── G-1114.A.1  Grounding PR (this slice)
  ├── G-1114.B  Phase B — Stack-Local Producer + Subscriber
  ├── G-1114.C  Phase C — Capabilities Delta + Liveness FSM
  ├── G-1114.D  Phase D — Network View (stack-local)
  ├── G-1114.E  Phase E — Federation
  └── G-1114.F  Phase F — Capability-Routing UX
```

Branch name `feat/g-1114-{phase-letter}-{slug}`. Title
`feat(mc): G-1114.X — {scope}`.

## 3. Phase sequencing

```
A  Grounding ──▶ B  Producer+Subscriber ──▶ C  Caps+FSM ──▶ D  Network View ──┐
                                                                              ├──▶ F  Cap-Routing UX
                                                       E  Federation ─────────┘
```

- `G-1114.A` ← no deps
- `G-1114.B` ← `[G-1114.A]`
- `G-1114.C` ← `[G-1114.B]`
- `G-1114.D` ← `[G-1114.C]`
- `G-1114.E` ← `[G-1114.D]`
- `G-1114.F` ← `[G-1114.D, G-1114.E]`

## 4. The phases

### 4.1 Phase A — Grounding & Protocol Types (G-1114.A)

**Goal:** land the reconciled design + plan on `main`, define the `agent.*`
presence payloads as **inert** TypeScript/zod types, and put a "Network
(preview)" placeholder on the dashboard. **Zero runtime behavior change** — no
producer publishes, no subscriber consumes, no live data.

**Sub-features:**

- [x] **G-1114.A.1** — Grounding PR · single PR
  - Reconcile + land `docs/design-agent-network-topology.md` +
    `docs/plan-agent-network-topology.md` to ADR-0007.
  - Add inert `agent.*` payload types at `src/bus/agent-network/envelopes.ts`
    (defined + exported + unit-tested; no producer / no subscriber).
  - Add a "Network (preview)" stub tab in `src/surface/mc/dashboard-v2/`.
  - Unit tests: payload shape/validation + envelope round-trip + agent-domain
    subject derivation; a render test for the stub tab.

**Acceptance criteria:**

- `bunx tsc --noEmit` clean, `bun run lint` 0 errors, full `bun test` green.
- Inert types validate + round-trip through the myelin envelope validator;
  subjects derive `{scope}.{principal}.{stack}.agent.{action}`.
- "Network (preview)" tab visible in the dashboard.
- No producer/consumer wired; no runtime behavior change.

**Dependencies:** none.

---

### 4.2 Phase B — Stack-Local Producer + Subscriber (G-1114.B)

**Goal:** wire the protocol end-to-end in one stack. Agent boot emits
`agent.online`; periodic `agent.heartbeat`; graceful shutdown emits
`agent.offline`. A subscriber on the same stack builds the runtime registry.

**Sub-features (sketched — refined at phase start):**

- [ ] **G-1114.B.1** — Envelope builders + signing path for the four payloads.
- [ ] **G-1114.B.2** — Producer wired into cortex boot lifecycle (`agent.online`
  on boot; `agent.heartbeat` on interval; `agent.offline` on graceful shutdown).
- [ ] **G-1114.B.3** — Runtime registry subscriber on
  `local.{principal}.{stack}.agent.>`; observable store; 5-min reaper.
- [ ] **G-1114.B.4** — Agents panel UI (replaces the Phase A placeholder).
- [x] **G-1114.B.5** — Dual-emit with `agents.capabilities.registered` during
  the deprecation window. **Finding:** the dual-emit was ALREADY in force the
  moment B.2 wired the presence producer — both `publishCapabilityRegistry()`
  (legacy `agents.capabilities.registered`) and `AgentPresenceProducer.start()`
  (superseding `agent.online`) fire at boot, independently, both reading the
  SAME `agent.runtime.capabilities[]` field. So B.5's work was NOT new wiring
  but (a) marking `agents.capabilities.registered` / `publishCapabilityRegistry`
  / `buildCapabilityRegisteredEnvelope` / `CAPABILITY_REGISTERED_EVENT_TYPE`
  `@deprecated` (citing ADR-0007 decision 3); (b) pinning the
  capability-consistency invariant with a regression test
  (`src/bus/__tests__/capability-registry-presence-consistency.test.ts`); and
  (c) documenting the retirement path. **Retirement path (later step — NOT B.5):**
  once `agent.online` is confirmed the sole source of truth and any external
  consumer has cut over, remove (1) `publishCapabilityRegistry()` +
  `buildCapabilityRegisteredEnvelope()` + the `CAPABILITY_REGISTERED_EVENT_TYPE`
  constant; (2) the cortex#237 PR-7 boot block in `src/cortex.ts`; (3) the file
  once nothing imports it. Capability dispatch (cortex#237) is untouched by both
  deprecation and retirement — it never routed on this envelope.

**Acceptance criteria:** boot a fresh cortex process → its agent appears within
~5 s; stop it → drops within 5 min (or instantly on graceful shutdown); no
regression in capability dispatch.

**Dependencies:** Phase A.

---

### 4.3 Phase C — Capabilities Delta + Liveness FSM (G-1114.C)

**Goal:** capability changes flow through `agent.capabilities-changed` without
restart, and the liveness FSM handles offline correctly.

**Sub-features (sketched):**

- [ ] **G-1114.C.1** — `agent.capabilities-changed` producer (emit on mutation).
- [ ] **G-1114.C.2** — subscriber applies the full new set; reconciles state.
- [ ] **G-1114.C.3** — liveness FSM (single 5-min TTL; consumes the NEW
  `agent.heartbeat`, never `system.agent.heartbeat`; graceful-offline path).
- [ ] **G-1114.C.4** — panel UI: capability badges + offline rendering.
- [ ] **G-1114.C.5** — fixture tests replaying scripted envelope streams.

**Dependencies:** Phase B.

---

### 4.4 Phase D — Network View (stack-local) (G-1114.D)

**Goal:** the graph view. Lift Strata's React Flow + ELK pattern into the MC
dashboard.

**Sub-features (sketched):**

- [ ] **G-1114.D.1** — lift Strata UI primitives (`FlowCanvas`, `ContextMenu`,
  `DetailPanel`, `SpotlightSearch`, `Legend`).
- [ ] **G-1114.D.2** — graph data adapter (registry → React Flow nodes/edges).
- [ ] **G-1114.D.3** — ELK layout config.
- [ ] **G-1114.D.4** — detail panel (presence + capabilities + dispatch
  lifecycle; **never** session interiors).
- [ ] **G-1114.D.5** — filters + spotlight search.

**Dependencies:** Phase C.

---

### 4.5 Phase E — Federation (G-1114.E)

**Goal:** the Network view extends to federated peer stacks via the
bus-federation transport — subscribe to `federated.{principal}.{stack}.agent.*`
per the federation accept-list. This is the **local-view** half; the hosted-pane
half is [ADR-0006](adr/0006-network-view-feed-registry-anchored.md).

**Sub-features (sketched):**

- [ ] **G-1114.E.1** — federation policy (opt-in per envelope-type) in stack
  config.
- [ ] **G-1114.E.2** — subscriber path for the `federated.` namespace with
  scope/provenance tagging (`{principal}/{stack}`).
- [ ] **G-1114.E.3** — registry-roster grouping in the view (membership from the
  ADR-0003 roster, never a wire token).
- [ ] **G-1114.E.4** — UI: scope filter + foreign-agent visuals.
- [ ] **G-1114.E.5** — trust extension (`signed_by[]` verification of foreign
  presence envelopes).

**Acceptance criteria:** two stacks federated via NATS leaf both show the
other's agents (per opt-in policy); cross-stack provenance renders; disabling
federation cleanly removes foreign agents. **Peer interiors never visible.**

**Open question (resolve at E.1):** federation default — opt-in vs opt-out.

**Dependencies:** Phase D.

---

### 4.6 Phase F — Capability-Routing UX (G-1114.F)

**Goal:** make capability-matched dispatch visible and principal-driven.

**Sub-features (sketched):**

- [ ] **G-1114.F.1** — capability-match index (task ↔ agent map).
- [ ] **G-1114.F.2** — hover affordances (cross-component highlight).
- [ ] **G-1114.F.3** — "dispatch direct" affordance.

**Dependencies:** Phase D + Phase E.

---

## 5. Sequencing summary

| Phase | Depends on | Indicative PR count |
|---|---|---|
| A — Grounding & types | — | 1 |
| B — Local producer + subscriber | A | 5 |
| C — Capabilities delta + FSM | B | 5 |
| D — Network view (stack-local) | C | 5 |
| E — Federation | D | 5 |
| F — Capability-routing UX | D + E | 3 |

Total indicative: **~24 PRs** across the umbrella.

## 6. Decisions settled by the ADRs

- **Domain + dispatch distinction, supersession, peer-visibility boundary, TTL,
  public-scope deferral** → [ADR-0007](adr/0007-agent-presence-protocol.md).
- **Subject grammar (`{principal}.{stack}`, network never on the wire)** →
  [ADR-0001](adr/0001-federated-subject-grammar.md).
- **Network membership = registry roster** →
  [ADR-0003](adr/0003-network-join-control-plane.md).
- **Hosted-pane feed (own-slice, metadata-only, registry-anchored auth)** →
  [ADR-0006](adr/0006-network-view-feed-registry-anchored.md).
- **In-process MC, bus-projected sessions, session interiors stay local** →
  [ADR-0005](adr/0005-mission-control-integration-architecture.md).

## 7. Process notes

- **Worktree discipline.** Each sub-feature gets its own worktree under
  `../Cortex-g1114-{slug}` cut from `origin/main`.
- **Review loop.** Echo primary on PR review via the pilot loop; in-session
  Engineer sub-agent fallback when Echo dispatch flakes.
- **Tick discipline.** Merging a sub-feature PR ticks the box here AND
  comments-and-closes the sub-feature sub-issue. The phase sub-issue closes when
  all its sub-features tick; the umbrella (#355) closes when all phases close.
- **Plan vs blueprint.** The dependency graph lives in `blueprint.yaml` under
  `G-1114` + `G-1114.A` .. `G-1114.F`.
- **Relation to G-1113.** Independent umbrellas. G-1113's config-driven Stack
  Agents panel is superseded by this bus-driven runtime registry when G-1114.B
  lands. No hard blocking between the two.
