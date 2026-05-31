# Pi.dev Review Agent — Design Specification

**Status:** Draft — architecture design for a pi.dev-based review agent that plugs into the cortex/myelin infrastructure.
**Date:** 2026-05-11
**Driver:** Ivy (for Jens-Christian)
**Related docs:** `docs/architecture.md` (§6 bus contracts; §9 agent + presence/renderer model), `docs/design-arc-agent-bots.md` (substrate-pluggable bot packaging via arc — the natural follow-on to this doc). Earlier drafts referenced `docs/design-event-taxonomy.md` and `myelin/docs/design-agent-task-routing.md`; the event-taxonomy content lives inline in `docs/architecture.md` §6, and the task-routing model is tracked in myelin issue #36 (not a checked-in document). Pointer corrections per cortex#58 round-2 review.

---

## 1. The Problem with the Current Framing

Cortex bundles two concerns: **agent runtime** (spawns Claude Code processes) and **chat surface** (Discord/Mattermost adapters). The `CortexConfigSchema` reflects this conflation — an agent's `presence:` block mixes surface credentials (Discord token, guild ID) with runtime assignment (the agent runs inside the cortex process).

**pi.dev decouples these:**

| Concern | Cortex | pi.dev |
|---------|--------|--------|
| Execution runtime | Cortex process → Claude Code subprocess | pi.dev process → model API calls |
| Chat surface | Discord/Mattermost adapters in cortex | Any surface (none yet, or separate adapter) |
| Bus participation | Via cortex runtime | Via NATS connection directly |

The review agent on pi.dev is the **same agent persona** (Echo, Holly, Ivy) running on a **different substrate**, speaking the **same bus contracts**. It doesn't need a new "pi-dev presence" in cortex.yaml. It needs:

1. Its identity declared in `cortex.yaml` (agent registry, trust, roles)
2. Its own NATS connection (independent of cortex)
3. Its own surface connection if it wants to (could be Discord, could be no surface — just bus tasks)

---

## 2. Architecture — Separating Substrate from Presence

```
  ┌──────────────────────────────────────────────────────────────┐
  │                    cortex (M7 app)                           │
  │  ┌──────────┐   ┌──────────┐   ┌──────────┐                  │
  │  │ Runtime   │   │ Surface   │   │ Surface   │                 │
  │  │ (CC spawn)│   │ (Discord)│   │ (MM)      │                 │
  │  └─────┬────┘   └─────┬────┘   └─────┬────┘                  │
  │        │ Surface       │ Envelopes     │ Envelopes           │
  │        └─────┬─────────┼──────────────┼──┘                    │
  │              ▼         ▼              ▼                      │
  │         ┌─────────────────────────────────┐                   │
  │         │       NATS bus (JetStream)      │                   │
  │         └─────────────┬───────────────────┘                   │
  └─────────────────────────┼───────────────────────────────────┘
                            │
               local.*.dispatch.task.received
                            │
  ┌─────────────────────────▼───────────────────────────────────┐
  │                    pi.dev (separate process)                │
  │                                                             │
  │  ┌──────────────┐  ┌────────────────────┐                   │
  │  │ Bus Bridge   │  │ Review Agent       │                   │
  │  │ (NATS pub/sub)│  │ (CodeReview skill) │                   │
  │  │ + capability  │  │ + GH CLI bridge   │                   │
  │  │   registry    │  │ + lifecycle emit  │                   │
  │  └──────────────┘  └────────────────────┘                   │
  │                                                             │
  │  Substrate: pi.dev runtime (not cortex)                     │
  │  Surface:  none (or could connect independently to Discord) │
  └─────────────────────────────────────────────────────────────┘
                            │
               local.*.dispatch.task.completed
               local.*.review.verdict.*
                            │
                            ▼
  cortex dashboard ◄── envelope render ────────────────────────
  pilot loop     ◄── review.decision events ──────────────────
```

**The key separation:** Presence and substrate are independent axes. Cortex couples them; pi.dev decouples them. The bus sees only envelopes — it doesn't care which substrate produced them.

---

## 3. Configuration — Two Files, One Agent

### 3.1 cortex.yaml — declares the agent identity

The agent appears in `CortexConfigSchema.agents[]` with its identity, trust, and roles. The `presence:` block stays discord/mattermost for the **cortex-hosted** instances:

```yaml
agents:
  - id: echo
    displayName: Echo
    persona: ./personas/echo.md
    roles: [agent-restricted]
    trust: [luna, holly, ivy]
    presence:
      discord:                     # Echo's cortex-hosted Discord presence
        enabled: true
        token: ...
        guildId: "1487..."
```

**The pi.dev review agent doesn't modify this config.** It connects to NATS with its own credentials and publishes envelopes as `agent_id: echo`. The cortex agent registry already contains echo's definition — the pi.dev process is just running echo's persona on a different substrate.

### 3.2 pi.settings.json — declares the runtime config

pi.dev's own config declares the bus connection and agent identity:

```json
{
  "bus": {
    "enabled": true,
    "natsUrl": "nats://localhost:4222",
    "credentials": "~/.config/nats/creds/echo.creds",
    "agentId": "echo",
    "capabilities": ["code-review"],
    "sovereignty": "selective"
  }
}
```

The `agentId` matches a `CortexConfigSchema.agents[].id`. That's the bridge — pi.dev doesn't register new agents; it uses existing ones from the agent registry.

---

## 4. Bus Contracts — Unchanged

Same subjects, same envelopes as any cortex agent. The only difference is the source process.

### 4.1 Inbound

| Subject | Carries | Purpose |
|---------|---------|---------|
| `local.{org}.dispatch.task.received` | Task: review a PR | Claim work when capability matches |
| `local.{org}.tasks.code-review.*` | Capability-based task routing | Broadcast-mode consumer |

### 4.2 Outbound

| Subject | When |
|---------|------|
| `dispatch.task.started` | Review begins |
| `dispatch.task.progress` | After each lens completes |
| `dispatch.task.completed` | Review finished |
| `dispatch.task.failed` | Error/crash |
| `review.verdict.approved` | Clean review |
| `review.verdict.changes-requested` | Blocking findings |
| `review.verdict.commented` | Non-blocking findings |

Nak reasons: `cant_do`, `wont_do`, `not_now`, `compliance_block` (unchanged per architecture §7.3).

#### 4.2.1 `review.verdict.*` envelope payload — canonical contract

The three `review.verdict.*` subjects share a single payload shape. This is the **canonical contract** that any review-capable agent (Echo, future reviewers) MUST emit, and any caller (pilot, dashboard, future review consumers) MAY rely on. Originating proposal: `docs/design-pilot-restructure.md` §4.2; ratified here as the authoritative spec per Wave 0 PR-A.0c (refs cortex#238).

**Subjects** (one per verdict kind):

- `local.{org}.review.verdict.approved`
- `local.{org}.review.verdict.changes-requested`
- `local.{org}.review.verdict.commented`

**Envelope payload (`payload.*`):**

```json
{
  "repo": "the-metafactory/cortex",
  "pr": 229,
  "reviewer": "echo",
  "verdict": "changes-requested",
  "summary": "verdict: blockers=0 majors=2 nits=3 — recommend: request-changes",
  "github_review_id": 2459183744,
  "github_review_url": "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459183744",
  "submitted_at": "2026-05-16T09:51:30Z",
  "commit_id": "a1b2c3d4e5f6789012345678901234567890abcd",
  "findings": { "blockers": 0, "majors": 2, "nits": 3 },
  "inline_comments": 5
}
```

**Field semantics:**

| Field | Type | Semantics |
|-------|------|-----------|
| `repo` | string | `owner/repo` GitHub form (e.g. `the-metafactory/cortex`). |
| `pr` | integer | PR number on the GitHub repo. |
| `reviewer` | string | GitHub login of the reviewer (e.g. `echo`). |
| `verdict` | enum | Discriminator: `approved` \| `changes-requested` \| `commented`. MUST match the subject suffix. |
| `summary` | string | Reviewer's one-line verdict text. Mirrors the verdict line in the reviewer's GitHub review body so the bus payload and the GitHub-side artefact stay in sync. |
| `github_review_id` | integer (int64-compatible; today's IDs are well below 2^53) | Numeric GitHub review ID. Used for GitHub API correlation (e.g. fetching inline comments, audit cross-reference). |
| `github_review_url` | string | Direct GitHub URL to the review. For human navigation from dashboard / Discord / CLI output. |
| `submitted_at` | string (ISO 8601) | Timestamp the reviewer submitted on GitHub. Distinct from the envelope's `timestamp`, which is the bus-publish moment. |
| `commit_id` | string (SHA) | Commit SHA the review was conducted against. Lets consumers detect "review is stale" when subsequent commits land. |
| `findings` | object | Counts by severity (`blockers`, `majors`, `nits`). The machine-parsed form of the numbers in `summary`. |
| `inline_comments` | integer | Number of inline comments posted on the PR as part of this review. |

**Envelope-level requirement — `correlation_id`:**

The reviewer MUST set the verdict envelope's `correlation_id` to the **`id` of the originating request envelope** (the envelope that asked for the review — typically a `dispatch.task.requested` or capability-dispatch request). Pilot's `pilot wait-for-verdict --correlation-id <uuid>` relies on this to filter unambiguously across N parallel reviews in flight on the same `review.verdict.>` subject. Without this, parallel callers cannot disambiguate which verdict belongs to which request.

**Payload-shape compatibility:** This shape deliberately mirrors `nats-review-io.ts`'s legacy `ReviewCompletedPayload` (the `mf.{network}.review.completed` shape from cortex's pre-capability-dispatch era). Workflow-side consumers (e.g. the existing `runReviewCycle` ReviewCycleIO) MUST NOT need behavioural changes when migrating from the legacy subject to the canonical `review.verdict.*` subjects — only the subject string and the `correlation_id` field are new.

**Out of scope for this contract** (deliberately): retry semantics, multi-agent quorum, persistence. See `docs/design-pilot-restructure.md` §4.6 for what pilot's verdict subscriber does NOT do.

**Follow-up:** `docs/design-pilot-restructure.md` §4 maturity table currently marks §4.2 as "Proposed — cortex#237 (or a companion PR to `design-pi-dev-review-agent.md`) must ratify." With this ratification merged at cortex#238, that row should flip to "Shipped — ratified at cortex#238 §4.2.1" in a follow-up pilot-spec PR.

---

## 5. Implementation — PAI-pi Extension (two layers)

### 5.1 Layer 1: Bus Bridge (substrate-agnostic)

```
~/.config/PAI-pi/
  extensions/
    pai-bus-bridge/
      index.ts         # NATS pub/sub + envelope validation (M3)
      publisher.ts     # Publish envelopes to the bus
      subscriber.ts    # Subscribe to task subjects
```

This extension could be used by any agent that needs to participate in the cortex ecosystem — review agent, research agent, etc. It's purely transport.

### 5.2 Layer 2: Review Agent (persona-specific)

```
~/.config/PAI-pi/
  extensions/
    pai-review-agent/
      index.ts         # Subscribe to review tasks, execute workflow
      workflow.ts      # Fetch PR → lens execution → post comments → publish verdict
      gh-bridge.ts     # GitHub CLI integration
```

### 5.3 How it starts

```
pi.dev starts → pai-bus-bridge connects to NATS
             → publishes capability registration (local.{org}.agents.capabilities.{agentId})
             → pai-review-agent subscribes to local.{org}.tasks.code-review.*
             → ready for review tasks from the bus
```

No cortex involvement in startup. The pi.dev process is independent — it just connects to the same bus cortex is on.

---

## 6. What Changes in cortex (minimal)

### 6.1 TrustResolver — `Platform` union (optional)

Currently `{ discord: true, mattermost: true }`. If we want cortex's `TrustResolver` to know about pi.dev agents, add `"pi-dev"`. Not strictly necessary for the review agent to work — the bus contracts don't depend on `TrustResolver`. But if cortex needs to resolve "platform user id → agent id" for pi.dev, this matters.

Actually, for the review agent this is **not needed**. The review agent publishes envelopes with `agent_id: echo` — cortex already knows who echo is from the agent registry. The TrustResolver is for resolving inbound messages from Discord/Mattermost platform user IDs. Pi.dev doesn't send platform user IDs — it publishes directly as its agent.

### 6.2 Capabilities

The cortex bus router and dispatch handler filter tasks by capability. The pi.dev agent registers its capabilities in the NATS KV bucket (`local.{org}.agents.capabilities`) on startup, just like any other agent would.

### 6.3 What does NOT change

- `PresenceSchema` — no "pi-dev" variant needed (presence = chat surface, not substrate)
- `CortexConfigSchema` — no new top-level config blocks
- `cortex.ts` — no new adapters or wiring
- `PresenceBinding` — not applicable (pi.dev has no adapter to bind)

---

## 7. Review Workflow (maps to CodeReview skill)

```
1. Receive dispatch.task.received envelope
   └── validate, extract repo + PR number

2. Emit dispatch.task.started

3. Fetch PR context
   └── gh pr view <N> --json title,body,files
   └── gh pr diff <N>

4. Execute CodeReview skill (PAI-pi built-in)
   ├── Lens 1: CodeQuality (always)
   ├── Lens 2: Security (if auth/input/DB/API)
   ├── Lens 3: Architecture (if new modules/structure)
   ├── Lens 4: EcosystemCompliance (if config/SOPs touched)
   ├── Lens 5: Performance (if hot-path queries/loops)
   └── After each lens → emit dispatch.task.progress

5. Post inline review comments via gh CLI
   └── gh pr review <N> --comment --body <findings>

6. Publish verdict envelope
   └── review.verdict.{approved,changes-requested,commented}
   └── dispatch.task.completed
```

---

## 8. Distribution Modes

### 8.1 Broadcast — "someone review PR #42"

```
cortex publishes → local.meta-factory.tasks.code-review.typescript
                 → competing consumers: Echo (cortex), Echo (pi.dev), ...
                 → first to claim executes
```

NATS pull consumer group handles competing-consumer fairness.

### 8.2 Direct — "Echo, review PR #42"

```
cortex publishes → with target_principal: "echo"
                 → both Echo instances (cortex + pi.dev) receive
                 → pi.dev claims if cortex's Echo is busy/not available
```

### 8.3 Delegate — "Echo, drive PR #42 to merge"

```
pi.dev Echo internally:
  ├── Review PR
  ├── Post inline comments
  ├── Wait for principal to push fixes
  ├── Re-run CodeReview on new commits
  └── Approve when clean
```

Requires sub-step progress envelopes for Tier 2 visibility on the dashboard.

---

## 9. Security and Sovereignty

### 9.1 Sandbox

- Read-only on target repository (clone to temp, no write)
- GH CLI scoped to review operations only (comments, reviews — no merge, no push)
- pi.dev's security middleware restricts Bash to `gh pr view/diff/review` and `git` read-only

### 9.2 Envelope sovereignty

Pi.dev publishes with `sovereignty: { mode: "selective", signed_by: "<agentId>" }`. Same sovereignty model as cortex agents — the bus doesn't distinguish substrate.

---

## 10. Migration Path

### Phase 1: Bus Bridge + Local Review (standalone)

No cortex changes needed at all.

- [ ] Create `pai-bus-bridge` extension
- [ ] Create `pai-review-agent` extension
- [ ] Test: manual NATS publish → pi.dev reviews → GitHub comments → NATS publish verdict

### Phase 2: Capability Registry Integration

- [ ] pi.dev registers capabilities in NATS KV on startup
- [ ] cortex dispatch handler reads capability registry for task routing
- [ ] Test: `tasks.code-review.*` subject routing works between cortex and pi.dev

### Phase 3: Full Protocol

- [ ] Three distribution modes (Broadcast/Direct/Delegate)
- [ ] OTLP trace spans for Tier 3 visibility (signal compatibility)
- [ ] Delegate-mode multi-step workflow
- [ ] Security hardening

---

## 11. Testing Strategy

| Test | Method |
|------|--------|
| Bus connection | Mock NATS server, assert subscribe/publish |
| Envelope validation | Valid + invalid fixtures from `myelin/examples/` |
| CodeReview execution | Trigger with real PR diff, assert skill completes |
| Lifecycle emission | Full workflow → all `dispatch.task.*` events emitted |
| Competing consumers | Start 2 agents, publish 1 task, only 1 claims |
| GH CLI bridge | `gh pr view/diff/review` against test repo |
| Sandbox | Attempt repo write → assert blocked |

---

## 12. Failure Modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| NATS disconnect | No heartbeat | Auto-reconnect, replay from last_event_id |
| Review timeout (>5 min) | TaskTracker timeout | Emit `dispatch.task.failed` |
| Model unavailable | API error | Fallback to secondary model |
| GitHub rate limit | GH CLI 403 | `dispatch.task.failed` with `not_now` |
| pi.dev crash | Process exit | Dashboard shows failed; principal re-dispatches |

---

## 13. Open Questions

| # | Question | Impact |
|---|----------|--------|
| 1 | Should pi.dev also have a Discord surface? Independent of cortex, or coordinated? | Presence strategy |
| 2 | How do we prevent two substrate instances of the same agent from racing on the same task? | Consumer group discipline |
| 3 | Delegate mode: should pi.dev spawn a full interactive CC session or stay in-process? | Architecture |
| 4 | OTLP spans: new publisher in bus-bridge, or piggyback on signal's tap pattern? | Integration |

---

*This document is the design specification for the pi.dev review agent. Implementation follows the phased plan in §10.*
