# `gh-repo-recon-agent` — First Deterministic Agent Spec

**Status:** Draft. Lands after cortex#92 (`SessionHarness`) merges. Untracked working doc.
**Date:** 2026-05-14
**Driver:** Andreas
**Depends on:** cortex#92 (substrate harness interface), cortex#91 (multi-substrate dispatch)
**Introduces:** `deterministic-agent` as a new `HarnessId` and a new agent class on the bus
**Related:** `feedback_check_prs_first` (the user-facing rule this agent automates), `design-collaboration-surface.md` §reference to Stripe Minions

---

## 1. Goal + Non-Goals

### Goal

Land the first **deterministic-class agent** on cortex's bus. Validate the agent class itself, prove the trust boundary (sealed execution, no LLM in the loop, no judgment), and absorb the highest-frequency recurring read pattern in observed PAI usage (multi-call GitHub repo recon before any non-trivial work).

`gh-repo-recon-agent` takes an owner+repo, performs a fixed sequence of `gh` calls, and emits a single structured verdict envelope describing what is in flight for that repo. It is consumable by any judgment agent (Luna deciding what to work on, a Mission Control task curator, the pilot loop) and by the dashboard.

### Non-goals

- Not a general-purpose GitHub agent. This agent runs **one** fixed query shape. Other GitHub operations (PR creation, label apply, merge) are separate deterministic agents.
- Not a substrate for LLM work. The whole point is no model in the loop.
- Not a write surface. Read-only, declared at capability level, enforced at NATS account level.
- Not a replacement for `gh` CLI usage by Cortex's existing `claude-code` adapter. Existing flows keep working; this is an additional bus primitive.

---

## 2. Class — Deterministic Agent

This agent is the first instance of a new class on the bus. The class introduces these invariants, none of which existing judgment-class agents (Luna, Echo, Forge, Sage, Alpha, Gorse) satisfy:

| Property | Means |
|---|---|
| **Deterministic** | Same input + same upstream state always produce the same verdict |
| **Sealed** | The execution path is fixed at agent-definition time. No caller (including the judgment agent that dispatched it) can inject, modify, or steer mid-flight. The handler code is the contract. |
| **Judgment-free** | No LLM call, no model output, no tool selection. The body is a registered TypeScript function loaded from a path declared in config. |
| **Identity-bearing** | Has a `did:mf:` identity, claims tasks on the bus, publishes verdict envelopes, shows up in the dashboard — same fabric, different inside. |

The trust value of the class lives in the seal: a judgment agent that dispatches a deterministic agent does not need to be trusted to faithfully execute the operation. The operation is fixed. The judgment agent decides *whether* to dispatch; it does not decide *what runs*. Two trust boundaries, cleanly separated.

---

## 3. Identity + Capability Declaration

```yaml
identity: did:mf:gh-repo-recon-agent

capabilities:
  - github-read              # reads PRs, issues, repos, commits — no write surface
  - identity-aware-read      # uses caller identity to filter "mine" but does not impersonate
```

The agent declares **zero write capabilities**. Its NATS account is scoped to publishing only on `recon.>`. Any attempt to dispatch it on a write subject is rejected at the bus layer (matches the existing capability-scoped NKey pattern Sage uses).

---

## 4. Trigger Shapes

The deterministic-agent class supports all three trigger shapes. `gh-repo-recon-agent` ships with the first; the others are forward-compatible and require no agent-side changes.

| Shape | Subject | When |
|---|---|---|
| **Call-style** *(MVP)* | `dispatch.recon.<request-id>` | Judgment agent dispatches and awaits verdict |
| **Scheduled** *(future)* | cron-driven, no caller | Nightly tick to populate dashboard cache for active repos |
| **Event-style** *(future)* | subscribes to `code.pr.opened` | Auto-emits recon for the affected repo on PR open |

---

## 5. Envelope Contracts

### 5.1 Input envelope (call-style)

```yaml
subject: dispatch.recon.<request-id>
correlation_id: <uuid>
source: did:mf:luna                    # or any judgment-class agent
sovereignty: { classification: internal }
payload:
  owner: the-metafactory               # required
  repo: cortex                         # required
  include:                             # optional, default = all five
    - prs
    - issues
    - branches
    - commits
    - mine
  state: open                          # optional, default "open"; "closed" | "all"
  pr_limit: 30                         # optional, default 30
  issue_limit: 30                      # optional, default 30
  commit_limit: 20                     # optional, default 20
hints:
  operator: andreas                    # optional — needed for "mine" filtering; falls back to no filtering
```

### 5.2 Output envelope (verdict)

```yaml
subject: recon.<request-id>.complete
correlation_id: <uuid>                 # echoes input
source: did:mf:gh-repo-recon-agent
status: complete | partial | error
payload:
  repo:
    owner: the-metafactory
    name: cortex
    default_branch: main
    visibility: private
    pushed_at: 2026-05-14T03:00:00Z
  prs:
    - number: 92
      title: "docs(design): substrate harness interface ..."
      author: andreas
      state: open
      created_at: 2026-05-13T09:00:00Z
      head: feat/c-091-substrate-harness-design
      base: main
      additions: 582
      deletions: 0
      mergeable: true
      review_decision: REVIEW_REQUIRED
      assignees: [andreas]
      labels: [feature, next]
  issues:
    - number: 91
      title: "design: SessionHarness interface ..."
      state: open
      author: andreas
      assignees: [andreas]
      labels: [feature, next]
      created_at: 2026-05-13T05:27:48Z
  branches:                            # active only (commit within last 14 days)
    - name: feat/c-091-substrate-harness-design
      last_commit_at: 2026-05-13T...
      pr: 92
  commits:                             # recent on default branch
    - sha: 7371f8e
      author: andreas
      date: 2026-05-13T22:00:00Z
      message: "docs: add Grove integration ..."
  mine:                                # cross-cut, only if hints.operator was provided
    open_prs: [92]
    open_issues: [91, 107]
metadata:
  duration_ms: 1840
  gh_calls: 5
  partial_sections: []                 # populated when status=partial
```

### 5.3 Error envelope

```yaml
subject: recon.<request-id>.error
status: error
payload:
  code: NOT_FOUND | RATE_LIMITED | TIMEOUT | GH_AUTH_FAILED | UNKNOWN
  message: "human-readable detail"
  retry_after_ms: 60000                # populated when code = RATE_LIMITED
```

---

## 6. Sealed Execution Sequence

The handler executes exactly this sequence and nothing else. The sequence is fixed at code-review time and verifiable by reading the implementation file.

```
1.  gh repo view <owner>/<repo>
      --json defaultBranchRef,visibility,pushedAt

2.  if "prs" in include:
      gh pr list -R <owner>/<repo> --state <state> --limit <pr_limit>
        --json number,title,author,state,createdAt,headRefName,baseRefName,
                additions,deletions,mergeable,reviewDecision,assignees,labels

3.  if "issues" in include:
      gh issue list -R <owner>/<repo> --state <state> --limit <issue_limit>
        --json number,title,state,author,labels,assignees,createdAt

4.  if "branches" in include:
      gh api repos/<owner>/<repo>/branches?per_page=100
      → filter by commit.committer.date within last 14 days

5.  if "commits" in include:
      gh api repos/<owner>/<repo>/commits?per_page=<commit_limit>
      → project to {sha, author, date, message}

6.  if "mine" in include AND hints.operator present:
      derive open_prs / open_issues from steps 2+3 where
        assignees[].login == hints.operator OR author.login == hints.operator
```

No conditional branching beyond the `include` flag set, which is data, not judgment. No retries inside the handler — retries are the harness's responsibility per the agent config.

---

## 7. Cortex Config Block

Registered as a fragment under `~/.config/cortex/agents.d/gh-repo-recon-agent.yaml`. Loaded by cortex's existing fragment loader. Discriminator: `runtime.harness: deterministic-agent` (the new `HarnessId` entry).

```yaml
agents:
  - name: gh-repo-recon-agent
    identity: did:mf:gh-repo-recon-agent
    persona:
      kind: behavior-contract                  # not a system prompt — links to this doc
      path: ./design-gh-repo-recon-agent-agent.md
    runtime:
      harness: deterministic-agent             # NEW HarnessId entry
      handler: cortex/handlers/gh-repo-recon-agent.ts:recon
      timeout_ms: 10000
      retry:
        max_attempts: 2
        backoff: linear-2s
    capabilities:
      - github-read
      - identity-aware-read
    task_subjects:
      - dispatch.recon.>
    publish_subjects:
      - recon.>
    secrets:
      - GH_TOKEN_READONLY                      # scoped read-only PAT
```

### Schema delta from cortex#92

Two additions to `AgentRuntimeSchema`:

1. `HarnessId` gains `"deterministic-agent"` as a new closed-enum value.
2. The `deterministic-agent` variant of the discriminated union adds:
   - `handler: string` (required, path:exportName)
   - `retry: { max_attempts: number, backoff: string }` (optional)

The `persona` field gains an optional `kind` discriminator: `system-prompt` (existing, default) or `behavior-contract` (new, for deterministic agents — the linked doc is the contract, not a prompt).

---

## 8. Harness Implementation Sketch

A new `DeterministicAgentHarness` implementing `SessionHarness` per cortex#92. Single responsibility: load the registered handler, invoke it with the parsed envelope, capture the return value as a verdict envelope, emit.

```ts
// src/substrates/deterministic-agent/harness.ts (NEW)

import type { SessionHarness, DispatchRequest } from "../../common/substrates/types";
import type { Envelope as MyelinEnvelope } from "../../bus/myelin/envelope-validator";

export class DeterministicAgentHarness implements SessionHarness {
  readonly id = "deterministic-agent" as const;
  readonly capabilities = ["file-ops", "tool-use"] as const;  // varies by handler

  constructor(
    private readonly handlerSpec: string,        // "cortex/handlers/gh-repo-recon-agent.ts:recon"
    private readonly timeoutMs: number,
  ) {}

  async *dispatch(req: DispatchRequest): AsyncIterable<MyelinEnvelope> {
    const handler = await loadHandler(this.handlerSpec);

    yield envelope("dispatch.task.started", {
      taskId: req.taskId, agentId: req.agentId,
    });

    try {
      const result = await withTimeout(
        handler(req.payload, { caller: req.hints?.operator }),
        this.timeoutMs,
      );

      yield envelope("dispatch.task.completed", {
        taskId: req.taskId, durationMs: result.metadata.duration_ms,
      });

      yield envelope(`recon.${req.taskId}.complete`, {
        status: result.status,
        payload: result,
      });
    } catch (err) {
      yield envelope(`recon.${req.taskId}.error`, errorPayload(err));
      yield envelope("dispatch.task.failed", {
        taskId: req.taskId, error: serializeError(err),
      });
    }
  }
}
```

The handler itself is a normal TypeScript function — no harness coupling, no envelope plumbing, no NATS knowledge. The harness handles the lifecycle envelopes; the handler handles the work.

```ts
// cortex/handlers/gh-repo-recon-agent.ts (NEW)

import { $ } from "bun";
import { ReconInputSchema, type ReconInput, type ReconVerdict } from "./types";

export async function recon(
  rawInput: unknown,
  ctx: { caller?: string },
): Promise<ReconVerdict> {
  const input = ReconInputSchema.parse(rawInput);
  const start = Date.now();

  // Step 1: repo metadata
  const repo = await ghRepoView(input.owner, input.repo);

  // Steps 2–5: parallel where independent
  const [prs, issues, branches, commits] = await Promise.all([
    input.include.has("prs") ? ghPrList(input) : null,
    input.include.has("issues") ? ghIssueList(input) : null,
    input.include.has("branches") ? ghBranches(input) : null,
    input.include.has("commits") ? ghCommits(input) : null,
  ]);

  // Step 6: cross-cut "mine"
  const mine = input.include.has("mine") && ctx.caller
    ? crossCutMine(prs ?? [], issues ?? [], ctx.caller)
    : null;

  return {
    status: "complete",
    payload: { repo, prs, issues, branches, commits, mine },
    metadata: {
      duration_ms: Date.now() - start,
      gh_calls: 1 + [prs, issues, branches, commits].filter(Boolean).length,
      partial_sections: [],
    },
  };
}
```

The whole handler is testable as a pure function: mock `ghPrList` etc. with fixtures, assert the verdict shape. No bus, no harness, no envelope concerns.

---

## 9. Error Modes

| Code | Triggered by | Behavior |
|---|---|---|
| `NOT_FOUND` | `gh repo view` returns 404 | Emit `recon.<id>.error`, no retry |
| `RATE_LIMITED` | gh returns 403 with X-RateLimit-Remaining: 0 | Emit error with `retry_after_ms`, harness retries after backoff |
| `TIMEOUT` | Handler exceeds `timeout_ms` | Emit `dispatch.task.failed` with `code: TIMEOUT`, no partial verdict |
| `GH_AUTH_FAILED` | gh returns 401 | Emit error, no retry (config issue, needs operator) |
| `partial` | Some sections succeed, some fail | Emit verdict with `status: partial` and `metadata.partial_sections: [...]` |
| `UNKNOWN` | Any other exception | Emit error with stack trace in payload |

The harness enforces the timeout. The handler enforces nothing — if `gh` hangs, the harness aborts.

---

## 10. Testing Strategy

Deterministic agents test like functions, not like LLM agents. No eval suite needed.

### 10.1 Unit tests (handler)

Mock the gh calls with JSON fixtures captured from real cortex repos. Assert verdict shape, partial-section handling, mine cross-cut correctness, identity fallback.

```
src/handlers/__tests__/gh-repo-recon-agent.test.ts
  ✓ returns complete verdict for happy-path cortex repo
  ✓ omits sections not in include
  ✓ returns partial verdict when commits section fails
  ✓ NOT_FOUND when repo doesn't exist
  ✓ skips mine when caller absent
  ✓ filters mine to assignee + author match
  ✓ verdict passes ReconVerdictSchema validation
```

### 10.2 Integration test (harness)

Use a fixture repo (`the-metafactory/hello-world` or similar low-traffic test repo). Dispatch a real recon envelope, assert end-to-end:

- `dispatch.task.started` published
- `recon.<id>.complete` published within 5s
- Verdict envelope schema-valid
- Verdict content matches the live repo's actual PR/issue state at time of test

### 10.3 Property test

For any well-formed input that passes `ReconInputSchema`, the output passes `ReconVerdictSchema`. No need for property fuzzing on actual gh output (gh's contract is upstream).

---

## 11. Acceptance Criteria

- [ ] `HarnessId` gains `"deterministic-agent"` in `src/common/substrates/types.ts`
- [ ] `DeterministicAgentHarness` implements `SessionHarness`, passes the existing contract tests applicable to all harnesses
- [ ] `cortex/handlers/gh-repo-recon-agent.ts` exports `recon()` matching this spec
- [ ] `ReconInputSchema` + `ReconVerdictSchema` Zod schemas land in `cortex/handlers/types.ts`
- [ ] Agent fragment at `~/.config/cortex/agents.d/gh-repo-recon-agent.yaml` is loaded by the fragment loader without rejection
- [ ] Unit tests reach 100% branch coverage on the handler
- [ ] Integration test passes against a real low-traffic repo
- [ ] Manual smoke: Luna in `#cortex` channel emits `dispatch.recon.cortex`, receives verdict within 5s, summarizes "what's in flight for cortex" without making any gh calls herself
- [ ] Verdict envelope is renderable in the Mission Control dashboard (existing envelope-viewer surfaces it)

---

## 12. Open Questions

1. **Caching policy.** MVP is no caching — every dispatch is a fresh fetch. If rate limits bite, add a 60-second TTL cache keyed by `(owner, repo, include-set, state)`. Defer until measured.
2. **One agent per ecosystem, or per-org?** MVP: one agent, takes `owner` in the envelope. If we later want per-org scoping for credential reasons (different PATs for different orgs), split.
3. **GH token storage.** MVP reuses cortex's existing `GH_TOKEN` env var. Eventually a dedicated `GH_TOKEN_READONLY` scoped to the orgs cortex cares about, minted via the per-service secrets pattern at `~/.config/pai/secrets/gh-repo-recon-agent.env`.
4. **NATS queue group behavior.** Single subscriber for MVP. If a second instance is ever wanted (fan-out, redundancy), queue-group semantics apply for free — no agent-side changes.
5. **Behavior-contract persona field.** Naming the new persona `kind` value: `behavior-contract` reads well but is a new concept. Alternatives: `function-spec`, `handler-contract`. Decide before cortex schema lands.
6. **`mine` cross-cut for non-GitHub identity.** Operators identified as `did:mf:...` in metafactory might not have a corresponding GitHub login. Need a mapping. Defer until first non-Andreas operator.
7. **Streaming progress.** For typical-size repos (<30 PRs), the verdict completes in ~2s — no need for streaming. For very large repos (Linux-kernel sized), would the deterministic-agent class want to emit `dispatch.task.progress` envelopes for each section? Defer until measured.

---

## 13. Why This Is the Right First Deterministic Agent

Three reasons grounded in observation, not speculation.

1. **Frequency.** Mining 499 sessions in `~/.claude/projects/-Users-andreas-Developer/`: the multi-call gh recon pattern (`gh pr list` + `gh issue list` + `gh repo view`, often 3–6 calls together) is the most-frequent investigation primitive across PAI history. `feedback_check_prs_first` mandates it before any non-trivial work, which means every judgment agent should be doing it constantly. Today they don't, because the prompting overhead is high. A bus primitive collapses that overhead.

2. **Pure read.** No side effects on the world, no auth surface beyond the read-only GH token, no risk on rollback. The cheapest possible production target for validating the class.

3. **Clear verdict shape.** Structured "what's in flight" — list of PRs, list of issues, recent commits, my-assigned items. That envelope is consumable by judgment agents and by the dashboard alike. No ambiguity about what the agent produces.

The trust-bearing demonstration of the class (a deterministic agent that *does something* to the world) is best deferred to the second deterministic agent — likely `cortex-restart` or a generalized `pai-pkg-restart`. Starting with a pure read lets the class itself be debugged before the trust boundary is exercised on a write.

---

## 14. Migration

Single PR after cortex#92 merges:

| Lands | Files |
|---|---|
| `HarnessId` += `"deterministic-agent"` | `src/common/substrates/types.ts` |
| `AgentRuntimeSchema` variant + persona kind | `src/common/types/cortex-config.ts` |
| `DeterministicAgentHarness` impl + tests | `src/substrates/deterministic-agent/` |
| `gh-repo-recon-agent` handler + Zod schemas + unit tests | `src/handlers/gh-repo-recon-agent.ts`, `__tests__/` |
| Fragment example | `docs/examples/agents.d/gh-repo-recon-agent.yaml` |
| This doc, promoted | `docs/design-gh-repo-recon-agent-agent.md` (currently untracked) |

Operator-side fragment install at `~/.config/cortex/agents.d/gh-repo-recon-agent.yaml` is documented but not auto-installed.

---

## 15. Anti-Scope

- No second deterministic agent in this PR. `cortex-restart`, `wrangler-deploy`, `vault-snapshot` are follow-ups.
- No deterministic-agent SDK or registry yet. The handler-by-path pattern is intentionally minimal. SDKs come after we have 3+ deterministic agents and can see the actual abstraction shape.
- No multi-agent orchestration features (callable_agents, sub-dispatch). Deterministic agents publish verdicts; judgment agents read them. Composition happens at the bus layer, not in the agent.
- No deterministic-agent specific dashboard. Mission Control's existing envelope viewer renders the verdict; a dedicated deterministic-agents panel can come if and when the pattern proliferates.

---

## 16. References

- cortex#91 — design: SessionHarness interface — multi-substrate agent dispatch
- cortex#92 — design doc on `feat/c-091-substrate-harness-design` (this spec lands after)
- `~/.claude/projects/-Users-andreas-Developer/memory/feedback_check_prs_first.md` — the rule this agent automates
- `~/.claude/projects/-Users-andreas-Developer/memory/feedback_unify_cross_cutting.md` — relevant if `wrangler-deploy` (in spawn) and `cortex-restart` (in cortex) need unification
- `docs/design-collaboration-surface.md` — Stripe Minions reference (deterministic agent graphs as prior inspiration)
- `docs/design-pi-dev-review-agent.md` — Sage as judgment-class peer; this agent's verdict is a likely input to Sage's review context
