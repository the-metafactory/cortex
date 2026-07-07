# Grove × Spawn — Execution & Capacity Integration

> **⚠️ Historical — lifted from grove-v2.** This document predates the Cortex Mission Control Cockpit
> redesign and describes grove-v2 architecture, module paths, or naming that no longer match current
> Cortex. It is retained for design lineage and rationale, **not** as current reference. For the
> canonical cockpit design and vocabulary see
> [`design-mission-control-cortex-cockpit.md`](./design-mission-control-cortex-cockpit.md) and
> [`glossary-mission-control.md`](./glossary-mission-control.md) (tracked under
> [G-1113](https://github.com/the-metafactory/cortex/issues/354)).
>
> **Superseded (Spawn premise specifically):** the head/hands/execution integration this doc sketches
> is superseded by [`design-distributed-agent-execution.md`](./design-distributed-agent-execution.md)
> (Mode A — recovered under FND-2, `docs/plan-mc-future-state.md` §4.C). That doc's own header states
> it plainly: "Spawn is superseded — integrate the shipped product (Managed Agents / CF sandboxes), do
> not rebuild the engine." Read this file for lineage only.

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-spawn-integration.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Status:** **On ice.** Spawn (the metafactory execution engine) is not yet ready. The design in this document is preserved as a future integration plan; none of it is in the Grove v2 Mission Control MVP. Mission Control v2 uses local `Bun.spawn` at Tier 1 only.
**Date:** 2026-04-15 (extracted from the prior `design-mission-control.md` during the v2 design sprint)
**Parent spec:** `docs/design-mission-control.md` (Grove Mission Control v2)
**Vocabulary:** Head/hands (matches parent spec §7.1). Any "pets/cattle" or "G-series" references from the original source have been removed.

---

## 1. Why this document exists

Earlier Grove design work included a full Spawn-integration chapter inside `design-mission-control.md`. That coupling caused two problems:

1. It implied Mission Control v2 depended on Spawn shipping — it does not (Mission Control v2 Conflict 3).
2. It mixed vocabulary: the old chapter used "pet agents vs worker capacity" while the v2 parent spec uses head/hands with `persistent: bool`.

This document extracts the Spawn-integration design so that:

- Mission Control v2 can ship without any Spawn prerequisite.
- The valuable execution-tier, capacity-gauge, and dispatch-UX thinking is not lost.
- When Spawn is ready, this document is the starting point for re-integration — aligned with the v2 head/hands data model.

**Nothing in this document is in the v2 MVP.** Every capability here is explicitly deferred in `design-mission-control.md` §10 (row: "Spawn-backed execution").

---

## 2. Design principle: Spawn is invisible

Spawn is the execution engine beneath the dashboard. It never appears in the UI by name. The principal never sees "EC2", "CF Worker", "tier", "backend", or "spawn profile." Spawn is like TCP/IP to a web app — essential infrastructure, completely hidden.

What the principal sees instead: **capacity** and **results**.

Mapping to v2 vocabulary: Spawn is a **host for hands runs**. A head (row in `agents`) does not care where its hands execute. An `agent_task_assignment` dispatches one or more hands runs; each hands run is a `session` bound to some execution backend. Spawn provides the backend; Grove never surfaces which backend was chosen.

---

## 3. Execution is automatic

Task complexity determines the execution tier. The principal never chooses:

| Task complexity       | Example                                       | Execution tier                        | Latency         |
| --------------------- | --------------------------------------------- | ------------------------------------- | --------------- |
| Simple / stateless    | Lint, format, validate, content scan          | CF Worker                             | ~5ms            |
| Medium / scoped       | PR review, digest generation                  | CF Dynamic Worker or pooled EC2       | ~5ms – 30s      |
| Heavy / agentic       | Implement feature, debug, refactor            | CC + PAI on local or long-lived EC2   | ~20 – 60s       |

When the principal clicks "Review this PR", they see the result. Whether it ran on a CF Worker or an EC2 instance is irrelevant.

**Interaction with the v2 assignment model:** the tier selection is made inside Spawn when a new hands run is requested for an `agent_task_assignment`. The assignment row does not record which backend ran the hands run — that is a session-level detail, surfaced only in the agent attention view's event log if the principal expands a session event. The attention card and focus area stay backend-silent.

---

## 4. Persistent heads vs anonymous hands capacity

The old design chapter split this as "pet agents vs workers". The v2 parent spec replaces that vocabulary. The equivalent Spawn-era framing is:

- **Persistent heads** (`agents` row with `persistent: true`) — named, memoried, always visible. The principal dispatches work to them by name.
- **Ephemeral heads** (`agents` row with `persistent: false`) — named for a single assignment, then garbage-collected.
- **Anonymous hands capacity** — the Spawn-managed pool of execution slots that any head can consume. This is a **resource**, like tokens. It is not an agent. It has no `agents` row. It never renders as an agent card.

Principal questions about hands capacity:

- How busy is it? (utilisation)
- Do we need more? (capacity planning)
- What's the pool status? (readiness)
- What's it costing? (spend awareness)

Hands capacity is rendered as a **capacity gauge**, alongside token usage — not as agent cards.

```
CAPACITY
  Tokens    ████████░░  78% (5h window resets 14:30)
  Hands     ██░░░░░░░░  2/10 active
              1 standby · 7 cold · 0 provisioning
              $2.40 today
```

### Pool states (what the capacity gauge reflects)

| State             | Meaning                               | Indicator         |
| ----------------- | ------------------------------------- | ----------------- |
| **Active**        | Running a hands run right now         | Solid fill        |
| **Standby**       | Stopped EC2, ready in ~20s            | Ready indicator   |
| **Cold**          | No instance, needs ~60s provision     | Empty capacity    |
| **Provisioning** | Starting up right now                 | Spinner           |

---

## 5. Dispatch UX (simplified)

The dispatch modal has no backend picker. No tier selector. Just:

```
+----------------------------------------------+
| Dispatch Task                                |
|                                              |
| What:  Review PR grove#52                    |
| Who:   [Luna ▼] or [Any available ▼]         |
| Notes: [optional free text]                  |
|                                              |
| [Cancel]                        [Dispatch]   |
+----------------------------------------------+
```

**"Luna"** = dispatch to a named persistent head (creates an `agent_task_assignment` row binding Luna to the task).

**"Any available"** = dispatch to the best available head for the task type (may create an ephemeral head for this assignment), and let Spawn pick the right tier and hands host automatically. The principal never sees the backend choice.

This is compatible with the v2 Phase E curation UX (`design-mission-control.md` §9) — the manual dispatch button described there becomes this modal once Spawn is wired in. Until Spawn ships, dispatch is "run locally via `cc-session.ts`" and there is no tier question to ask.

---

## 5a. Command queue and session endpoint abstraction

Grove's Mission Control v2 (`design-mission-control.md` §6.1) introduces a **session endpoint** abstraction for principal input. Today, at Tier 1 same-process, the endpoint is the in-process `cc-session.ts` stdin pipe. When Spawn enters the picture, the hands run no longer lives in the same process as grove-bot — possibly not even on the same machine — and the principal's input has to cross that boundary without changing shape.

This section describes the pattern Spawn integration must support. Even **locally**, a hands run may live in a different sandbox context from grove-bot (container, bwrap, different cwd / mount namespace); Spawn is just the most general case of that boundary. The pattern below subsumes both.

### 5a.1 The boundary

```
  Grove principal UI         Grove bot            Hands run (Spawn)
 ──────────────────── ──────────────────── ──────────────────────────
  browser                 grove-bot            local sandbox / EC2 / CF
  executionQueue          session endpoint     CC process + stdin
  (Maestro-borrowed)  ──▶ resolver       ──▶   stream-json over wire
                          (new in v2)
```

Everything left of the boundary is **client-side**. Everything right of the bot is **endpoint-specific**. The bot does not know or care which kind of endpoint it has — it writes the payload and gets an ack.

### 5a.2 Client-side queue (Maestro pattern, unchanged)

The dashboard's per-assignment `executionQueue` (Mission Control §6.3, ported from Maestro's `executionQueue` pattern in `src/renderer/hooks/input/useInputProcessing.ts` — see the reference pins table in parent §5.3 for approximate line numbers at audit time) works the same way whether the hands run is local or Spawn-hosted:

- Principal submits input → append to `executionQueue` for this assignment.
- While `assignment.state === 'running'`, items stay queued.
- When `assignment.state` transitions to `idle` (or, for Spawn, when the remote hands run signals it is ready for the next turn), the queue drains.
- UI reflects queue depth under the submit button.

**This is entirely client-side state.** It does not need to know the endpoint kind. It hands the payload to the bot's WebSocket write and trusts the bot to route.

### 5a.3 Session endpoint resolver (server-side, new in v2)

Grove v2 Phase A introduces a session endpoint resolver: given an `assignment_id`, return a handle that accepts `write(payload): Promise<ack>`. The resolver is the one place in grove-bot that knows about endpoint kinds.

v2 ships only the local-process kind:

- `local.process` — the existing `cc-session.ts` child process, stdin pipe. Used by all hands runs in v2 MVP.

Future kinds (this document's concern):

- `local.sandbox` — a CC process running in a local sandbox (container, bwrap, etc.) with a different mount namespace from grove-bot. Transport: unix socket or a short-lived named pipe to the sandbox, brokered by a tiny shim inside the sandbox that relays bytes to the CC process stdin.
- `remote.spawn` — a CC process running on Spawn-managed compute (EC2, CF worker, pooled instance). Transport: authenticated RPC over the Spawn control plane. Spawn exposes a "write to session X" primitive; grove-bot calls it.

**Endpoint lookup protocol.** The resolver accepts an `assignment_id` and returns `{ kind, write, close }`. Resolution order:

1. Look up the assignment's current `session_id` (via `agent_task_assignment → sessions`).
2. Read the session's endpoint descriptor.
3. If no descriptor exists → fall back to `local.process` (the v2 MVP default).
4. Construct the handle for the right kind and hand it back.

**v2 never takes step 2.** There is no `session_endpoint` / `endpoint_descriptor` column on `sessions` in v2 Phase A — the parent spec (`design-mission-control.md` §9 Phase A) does not add one, because v2 only needs `local.process` and step 3 handles every v2 assignment. The column (or whatever shape the descriptor takes — could be a separate `session_endpoints` table keyed by `session_id`) is added **when this document is reactivated**, as part of the Spawn re-integration work in §9 below. Until then, step 2 is a no-op and the resolver always constructs a `local.process` handle in step 4.

The handle shape `{ kind, write, close }` **is** stable in v2 — that is the one piece of this design the parent spec commits to, so that adding the descriptor storage later is a local change inside the resolver rather than a refactor of its call sites (`src/bot/grove-bot.ts` WebSocket `write` handler, the attention view's approve/deny path in §5.3.1 of the parent, etc.).

### 5a.4 Two-way traffic

The resolver is **bidirectional**: payloads go in, stdout/stream-json events come out. For Spawn-hosted hands runs, the output side (agent assistant messages, tool calls, tool results, thinking chunks — see Mission Control §5.3) must cross the same boundary back to grove-bot, which relays to the dashboard's WebSocket.

v2 Tier 1 same-process: the CC process writes stdout/stream-json directly into grove-bot's stdio handling (existing `cc-session.ts` parsing path); no new wire.

Future kinds need an **events-out channel** in addition to the write-in channel. For `local.sandbox` this is a second unix socket (or a single duplex one). For `remote.spawn` this is a stream subscription to Spawn's session event feed. Either way, the output events land in grove-bot's existing event parser exactly as they do today — the boundary-crossing is invisible to the rest of grove-bot.

**v2 scope note.** Only the local-process case ships. But v2 **does** define the `{ kind, write, close }` handle shape and the resolver call site, so that adding future kinds is a local change inside the resolver and an addition to the handle constructor — not a refactor of the WebSocket protocol, the `agent_task_assignment` schema, or the attention view.

### 5a.5 What this buys us

- **Mission Control v2 does not have to solve Spawn integration.** It only has to not preclude it.
- **The Maestro borrow stays intact.** `executionQueue` is client-side and endpoint-agnostic.
- **Local-sandbox execution is free to land first.** A container-based local backend can be introduced without waiting for remote Spawn compute, and it will plug into the same resolver.
- **The command surface does not bifurcate.** There is one "write to the session" call site in grove-bot — not one for local-process, one for spawn, one for sandbox. The resolver owns the kind.

---

## 6. Attention view — no backend surfacing

The agent attention view (`design-mission-control.md` §5) must not leak backend identity. When Spawn is integrated:

- **No spawn metadata on the summary header.** No backend labels, no instance IDs, no spawn profile names.
- **Session events in the event log** may include a single `hands.backend` field at debug level, expandable only when the principal explicitly opens the raw event. Default rendering hides it.
- The capacity gauge in the dashboard resource section is the **only** surface where hands-capacity information appears. It is not part of the attention view.

---

## 7. Capacity panel (new dashboard section)

Sits alongside any existing token-usage bar in the resource section of the dashboard (below the focus area and working grid, not inside the attention view):

```
RESOURCES
  +--------------------------------------------------------------+
  | Tokens (5h)   ████████░░  78%    resets 14:30               |
  | Tokens (7d)   ██████░░░░  62%    resets Mon                 |
  | Hands         ██░░░░░░░░  2/10   1 ready · $2.40 today      |
  +--------------------------------------------------------------+
```

**Data source:** Spawn exposes a pool health API. Dashboard polls it. Graceful degradation when the Spawn pool API is not available — the hands row disappears, token rows remain.

---

## 8. Cross-repo dependencies

These are the dependencies the original design chapter tracked. Names preserved verbatim; status rewritten to reflect that nothing here is in Grove v2 MVP.

| Dependency                            | Status                             | What it enables                              |
| ------------------------------------- | ---------------------------------- | -------------------------------------------- |
| Spawn — Grove imports spawn           | Not ready; on ice                  | Dispatch from dashboard via Spawn            |
| Spawn — Message router uses spawn     | Not ready; on ice                  | Discord dispatch via Spawn                   |
| Spawn — Dashboard Spawn integration   | Not ready; on ice                  | Capacity panel, dispatch UI                  |
| Spawn — Pool management API           | Not ready; on ice                  | Capacity gauge data source                   |
| grove-auth action tokens              | Separate track                     | Authorised dispatch at Tier 2                |

All Spawn rows are **blocked on Spawn being ready**. Grove v2 Mission Control does not wait on any of them.

---

## 9. Re-integration checklist

When Spawn ships and this document is reactivated, the work required to fold it back into Grove is:

1. **Add the session endpoint descriptor storage.** v2 never wrote one — the resolver always fell through to `local.process` (§5a.3 step 3). Spawn re-integration adds the descriptor, either as a nullable `endpoint_descriptor` JSON column on `sessions` or a separate `session_endpoints` table keyed by `session_id`. Pick one at re-integration time; the parent spec does not commit to either shape.
2. **Wire `sessions.backend` metadata.** Add an optional field capturing the backend that ran the hands run (e.g., `local`, `spawn:cf-worker`, `spawn:ec2-pool-a`). Surfaced only at debug level in the attention view. (Overlaps with item 1 — a single descriptor field could carry both kind and backend.)
3. **Verify v2 data model compatibility.** Confirm that `agent_task_assignment` and `sessions` accept the descriptor without breaking any v2 call sites. The handle shape `{ kind, write, close }` from §5a.3 is the stable contract v2 commits to — confirm the resolver's call sites (grove-bot WebSocket write handler, approve/deny path in parent §5.3.1) do not leak beyond it.
4. **Add the hands capacity gauge** to the dashboard resource section, polling Spawn's pool health API. Graceful degrade when the API is unreachable.
5. **Replace the Phase E manual dispatch button** (parent spec §9) with the simplified dispatch modal from §5 of this doc.
6. **Re-test the "Spawn is invisible" principle** — the principal must not be able to see backend identity anywhere except inside expanded raw session events.
7. **Revisit the "deferred" row** in parent spec §10 and flip it to "shipped" once all of the above land.

None of these steps is sized or scheduled. They exist only so that the next designer picking this up has a starting point.

---

## 10. What was explicitly left out

The original Spawn-integration chapter in the old `design-mission-control.md` contained several items that were dropped during the v2 sprint and are **not** carried forward in this document:

- **Compass governance panel** (old §5) — deferred entirely; not MVP, not a Spawn concern either. Removed from Grove v2 MVP.
- **Pets/cattle vocabulary** — replaced with head/hands + `persistent: bool` (v2 Conflict 5).
- **G-series feature IDs** (G-950, G-954, etc.) — the v2 sprint drops feature-ID references entirely; capabilities are named by what they do.
- **Phase tables tied to G-series iterations** — replaced by the v2 §9 phase order (A–E), which does not reference Spawn.
- **Network-level governance and SOP-drift detection brainstorming** — those belong in a future compass document, not a Spawn-integration document.

This document is scoped narrowly to execution and capacity. Any item not in §§2–9 is out of scope here.
