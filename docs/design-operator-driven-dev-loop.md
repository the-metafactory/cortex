# Design — Operator-driven dev-loop (Pilot/vega as an in-process orchestrator agent)

**Status:** design / pre-ADR · **Date:** 2026-06-26 · **Principal:** Andreas
**Refs:** `CONTEXT.md` (§Assistant, §Dispatch domain, §Stack/zone), `docs/adr/0001` (subject grammar), `docs/adr/0002` (dispatch addressing/verdict-back), `compass/sops/federation-wire-protocol.md`, `compass/sops/autonomous-work.md` (the auto-dev SOP), `pilot-review-loop` skill, `src/bus/dev-events.ts`, `src/runner/dev-consumer*.ts`

> **One line.** Replace the blueprint-driven standalone `pilot tick` with an **in-process meta-factory orchestrator agent (Pilot, instance `vega`)** that, on a **principal-gated Discord command naming a specific GitHub issue/PR**, publishes a `dev.implement` dispatch through the **stack's own runtime** (myelin wire protocol → cortex zone-routes it `local`), the live `dev` agent claims it, and Pilot drives the loop to the **principal merge gate**.

## 1. Motivation — why change the existing loop

The current dev-loop entry is `pilot tick`: a **standalone `pilot` daemon** scans the **blueprint** across repos, auto-picks the top ready feature, posts a veto window, then dispatches. Two problems, both observed this session:

1. **The blueprint dependency is heavy and broken on this machine.** `blueprint ready` requires: the `blueprint` CLI on PATH (it isn't), a compass `repos.yaml` that parses (it didn't — a `status: planned` repo failed a stale enum), a `blueprint.yaml` schema the CLI accepts (cortex's is a `features:` *map*; the CLI's sync wants an *array* → `expected array, received object`), and a clean cross-repo graph (arc/grove have unresolvable refs). Andreas **does not use the blueprint** and does not want the scan→auto-pick→veto machinery.
2. **A standalone daemon is fragile.** It hand-connects a *second* runtime as the stack, juggling `CORTEX_CONFIG` (a one-off using the wrong env var silently fell back to a legacy single-file config; another attempt hung connecting a duplicate runtime). The Offer never landed on `DEV_IMPLEMENT`.

**What Andreas wants instead:** *"I tell the bot to kick off the dev-loop on a specific GitHub issue or PR — and only me, since it's my assistant."* Simpler, principal-in-control, issue-targeted, no blueprint.

## 2. The model

```
Andreas (Discord, gated to user 333333333333333333)
   │  "@vega implement cortex#1196"        (or: review cortex#1204)
   ▼
Pilot/vega  — IN-PROCESS meta-factory agent (agents.d fragment, rides the stack identity + runtime)
   │  1. gate: honor ONLY the principal's Discord id
   │  2. read the issue/PR (gh) → build the brief (intent + refs)
   │  3. publish dev.implement dispatch via the STACK RUNTIME + dev-events builder
   ▼  (myelin wire protocol — cortex derives `local.andreas.meta-factory.tasks.dev.implement`,
      routes to the LOCAL zone; no hand-spliced subject, no second connection)
dev  — live consumer claims it → worktree → claude -p → opens PR → dispatch.task.completed
   ▼
Pilot/vega reacts to the lifecycle:
   • PR open  → request review (echo, code-review.<flavor> dispatch)
   • verdict  → changes-requested → dispatch a fix back to dev
              → approved          → HOLD at the principal merge gate (Andreas merges)
```

**Dropped vs the old loop:** the blueprint scan, the auto-pick, the veto window, the standalone daemon, the `CORTEX_CONFIG` juggling. **Kept:** the pilot-review-loop *orchestration pattern* (dispatch → wait → triage → review → merge), lifted into an in-process reactor.

## 3. Why in-process is the correct fix (not just convenient)

Running the orchestrator **inside the stack daemon** means it reuses the **already-connected, already-authenticated MyelinRuntime**. That single fact removes every failure we hit:

| Standalone `pilot` daemon | In-process Pilot/vega agent |
|---|---|
| Hand-connects a 2nd runtime as the stack → hung | Reuses the stack's live runtime |
| Picks config via `CORTEX_CONFIG` → wrong/legacy file | No config resolution — it *is* the stack |
| Hand-rolled publish path | `runtime.publish()` + `dev-events` builder → wire-protocol-native; cortex zone-routes (ADR-0001/0002) |
| Own creds/Discord bot/lifecycle | Rides the stack signing identity, the stack's Discord adapter, `arc upgrade` lifecycle |

This is the [[use-stack-primitives]] rule applied: bus work delegates to `MyelinRuntime` + the dispatch/dev-event builders; never a raw connect / sign / subject-splice. **cortex decides local vs federated by scope** — the orchestrator never names a zone.

## 4. Components

### 4.1 vega agent fragment (`agents.d/vega.yaml` + `personas/vega.md`)
In-process meta-factory agent, same shape as `approver.yaml`/`dev.yaml`: `id: vega`, `displayName: Vega`, `persona`, **no per-agent signing material** (rides the stack identity). "Pilot" is the orchestrator *role*; **vega** is the principal's instance/name for it (the principal addresses her as `@vega`), so the `agents.d` id is `vega` (Q1 resolved). Declares the **`dev.orchestrate` capability** (it dispatches; it does not run `claude -p` itself). The command handler routes on this capability, never on the id, so the fragment is the dispatch target purely by declaring it.

### 4.2 The principal-gated command handler
Pilot's inbound path recognises an **orchestrator command** (`implement {repo}#{N}` / `review {repo}#{N}`) and, **only when the sender is the principal's Discord id**, performs a *dispatch action* instead of a chat/`claude -p` turn. Gate enforced at the command boundary (mirrors the openOnboarding/admission gates). Every non-principal sender is ignored. *Inbound-routing hook is open Q2.*

### 4.3 The dispatch publish (wire-protocol-native)
`Pilot.implement(repo, issue)` → read the issue via `gh` → build the brief (intent + refs, not a context dump) → `buildDevImplementRequestEvent(...)` (`src/bus/dev-events.ts`) → `runtime.publish(envelope)`. cortex derives `local.{principal}.{stack}.tasks.dev.implement` and routes it. The live `dev` consumer claims it. **This is the in-process equivalent of pilot's `publishDevImplement` — same builder family, but on the stack runtime.**

### 4.4 The loop reactor
Pilot subscribes to the `dispatch.task.*` lifecycle + review verdict envelopes (it already runs in the daemon that sees them) and drives: PR-open → review request → verdict → fix-cycle or **principal merge gate**. **The merge stays a human gate (Andreas).** Lift the state machine from the `pilot-review-loop` skill.

### 4.5 Deployment
`agents.d/vega.yaml` + `personas/vega.md` in the meta-factory config, shipped via **`arc upgrade cortex`** — identical to every other agent. One daemon, one config, one lifecycle. No plist, no pilot.env, no blueprint, no standalone process.

## 5. Slices (build order — each a thin, reviewable PR via the auto-dev SOP)

- **S1 — command → dispatch (the core).** Pilot agent fragment + persona; gated command handler for `implement {repo}#{N}`; publish `dev.implement` via `dev-events` + runtime. **Acceptance:** Andreas posts `@pilot implement cortex#1196` in grove → an Offer lands on `local.andreas.meta-factory.tasks.dev.implement` → the live `dev` agent claims it → opens a PR. *(This alone is the Spike-A1 end-to-end validation.)*
- **S2 — review leg.** On `dispatch.task.completed`/PR-open, Pilot requests `code-review.<flavor>` from `echo`; surfaces the verdict.
- **S3 — fix-cycle + merge gate.** changes-requested → re-dispatch to `dev`; approved → HOLD at the principal merge gate; Andreas merges.
- **S4 — hardening.** dedupe/idempotency (no double-dispatch on the same issue), status surfaced to the proposal channel, `stop`/cancel command.

## 6. Open questions

- **Q1 — naming. RESOLVED (S1).** "Pilot" is the orchestrator *role*; **vega** is the principal's instance/name for it, and the principal addresses her as `@vega`. The `agents.d` id + `displayName` are therefore `vega`/`Vega`, and the dispatch target is selected by the `dev.orchestrate` capability (agent-agnostic), not by the id.
- **Q2 — inbound command hook.** Exactly where a Discord message reaches an agent handler that can branch to a *dispatch action* vs a `claude -p` turn (dispatch-listener? the runner's inbound path? a new orchestrator handler?). S1 begins by mapping this precisely.
- **Q3 — reuse vs reimplement pilot logic.** Lift the `pilot-review-loop` state machine into the in-process reactor (S2/S3) vs a thin new reactor. Lean: lift the *pattern*, write fresh for the in-process runtime (the standalone CLI assumptions don't carry).
- **Q4 — does the existing `dev` consumer brief format match what `dev-events` builds?** Confirm `buildDevImplementRequestEvent` produces what `dev-consumer` parses (it should — same module family).

## 7. Build approach — in-session auto-dev

Per Andreas: build this **in session** as an auto-dev-loop task, following **`compass/sops/autonomous-work.md`** and the `pilot-review-loop` pattern — worktree-isolated slices, scoped tests + `tsc` + carve-out, `/code-review`, CI-green-before-merge, one PR per slice. (We can't dogfial the loop to build itself — `dev`/the orchestrator don't exist yet — so I drive it in-session.) Start with **S1**.
