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
| **Deterministic** | No LLM nondeterminism in the loop. Given identical CLI tool outputs for a given input, the verdict envelope is bytewise-identical. This is **not** a cache or reproducibility guarantee against upstream state changes; the live GitHub world is allowed to move between invocations. |
| **Sealed** | Execution path is fixed at agent-definition time. The caller (including the judgment agent that dispatched it) cannot inject, modify, or steer execution mid-flight. The handler code is the contract. **Trust assumption: the seal is only as strong as the integrity of the YAML fragment that registers the handler. The fragment must be git-tracked and operator-signed; an operator with edit access to the fragment can swap the handler. Out-of-band fragment tampering is out of scope for this design and is the responsibility of the operator's deployment pipeline.** |
| **Judgment-free** | No LLM call, no model output, no tool selection. The body is a registered TypeScript function loaded from a path declared in config. |
| **Identity-bearing** | Has a `did:mf:` identity, claims tasks on the bus, publishes verdict envelopes, shows up in the dashboard. Same fabric as judgment agents, different inside. |

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
correlation_id: <uuid>                 # = DispatchRequest.requestId
source: did:mf:luna                    # or any judgment-class agent
sovereignty: { classification: internal }
context:
  # Recon-specific input. The dispatcher attaches this as a context entry
  # with kind: "recon-input" when constructing the DispatchRequest; the
  # harness reads it via req.context.find(c => c.kind === "recon-input").
  - kind: recon-input
    data:
      owner: the-metafactory           # required
      repo: cortex                     # required
      include:                         # optional, default = all five
        - prs
        - issues
        - branches
        - commits
        - mine
      state: open                      # optional, default "open"; "closed" | "all"
      pr_limit: 30                     # optional, default 30
      issue_limit: 30                  # optional, default 30
      commit_limit: 20                 # optional, default 20
  # Operator identity for the "mine" cross-cut. Uses the existing "env"
  # context kind per cortex's convention; absent → no mine filtering.
  - kind: env
    data:
      operator: andreas                # optional GitHub login of the caller
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
  mine:                                # cross-cut, only if env-context "operator" was provided
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
      gh api graphql -f query='
        query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            refs(first: 100, refPrefix: "refs/heads/", orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
              nodes {
                name
                target { ... on Commit { committedDate oid } }
              }
            }
          }
        }' -F owner=<owner> -F repo=<repo>
      → filter to refs with committedDate within last 14 days

5.  if "commits" in include:
      gh api repos/<owner>/<repo>/commits?per_page=<commit_limit>
      → project to {sha, author, date, message}

6.  if "mine" in include AND env-context "operator" present:
      derive open_prs / open_issues from steps 2+3 where
        assignees[].login == operator OR author.login == operator
```

No conditional branching beyond the `include` flag set, which is data, not judgment. No retries inside the handler — retries are the harness's responsibility per the agent config.

**Call count is bounded and deterministic:** at most six external calls (steps 1, 2, 3, 4, 5, plus optionally `gh api user` if operator-identity is needed for `mine` and not supplied via context). The §5.2 `metadata.gh_calls` field reflects the actual count for the dispatch. Step 4 uses GraphQL deliberately to keep step count flat regardless of branch count — a per-branch REST loop would make the call count vary with repo size and weaken the seal.

---

## 7. Cortex Config Block

Registered as a fragment under `~/.config/cortex/agents.d/gh-repo-recon-agent.yaml`. Loaded by cortex's existing fragment loader. Discriminator: `runtime.harness: deterministic-agent` (the new `HarnessId` entry).

```yaml
agents:
  - name: gh-repo-recon-agent
    identity: did:mf:gh-repo-recon-agent
    persona:
      kind: behavior-contract                  # not a system prompt — links to this doc
      path: ./design-gh-repo-recon-agent.md
    runtime:
      substrate: deterministic-agent           # NEW AgentRuntimeSchema.substrate value
      mode: in-process                         # required by current schema
      harness: deterministic-agent             # NEW HarnessId value (informational; runner picks the actual harness)
      handler:                                 # object form — no path:export string parsing
        module: cortex/handlers/gh-repo-recon-agent.ts
        export: recon
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
      - GH_TOKEN                               # MVP reuses existing env var; see §12 R2 for the eventual GH_TOKEN_READONLY follow-up
```

### Schema delta — TWO parallel enums + one shape change

Cortex currently has two substrate enums living in different files. They are not unified today; this design touches both and acknowledges the unification work as out of scope for this PR.

**1. `AgentRuntimeSchema.substrate` (operator-facing, `src/common/types/cortex-config.ts`).** Today a flat `z.enum(["claude-code", "codex", "pi-dev", "custom"])`. Gains `"deterministic-agent"` as a fifth value. The schema is NOT a discriminated union today; this design does not propose restructuring it. Instead, `handler` and `retry` land as **optional top-level fields on `AgentRuntimeSchema`**, gated by a `.refine()` that requires them when `substrate === "deterministic-agent"` and rejects them otherwise. No breaking change to existing claude-code / codex / pi-dev / custom configs.

```ts
// Sketch — actual implementation lands in the follow-up PR
AgentRuntimeSchema.extend({
  handler: z.object({ module: z.string(), export: z.string() }).optional(),
  retry: z.object({
    max_attempts: z.number().int().min(1).max(10),
    backoff: z.string(),
  }).optional(),
}).refine(
  (rt) => rt.substrate !== "deterministic-agent" || rt.handler !== undefined,
  { message: "runtime.handler required when substrate is 'deterministic-agent'", path: ["handler"] },
);
```

**2. `HarnessId` (runner-facing, `src/common/substrates/types.ts`).** Today a TypeScript union of seven values. Gains `"deterministic-agent"` as an eighth. This is the type the runner uses to select a `SessionHarness` implementation; not operator-facing.

The two enums are deliberately separate today (operator vocabulary vs runner vocabulary) and unifying them is a separate piece of work that belongs in cortex#92's follow-ups, not here. This design adds the new value to both lists.

**3. `persona` shape — additive via union, not breaking.** Today `persona: z.string().min(1)` is a bare path. Becomes `persona: z.union([z.string().min(1), z.object({ kind, path })])`. A bare string is interpreted as `{ kind: "system-prompt", path: <string> }` for backward compatibility. Existing operator configs continue to parse without migration. The new `kind: "behavior-contract"` variant signals that the linked file IS the contract (deterministic agents) rather than a system prompt (judgment agents).

---

## 8. Harness Implementation Sketch

A new `DeterministicAgentHarness` implementing `SessionHarness` per cortex#92. Single responsibility: load the registered handler, invoke it with the parsed envelope, capture the return value as a verdict envelope, emit.

```ts
// src/substrates/deterministic-agent/harness.ts (NEW)

import type { Capability, SessionHarness, DispatchRequest } from "../../common/substrates/types";
import type { Envelope as MyelinEnvelope } from "../../bus/myelin/envelope-validator";

const CAPABILITIES: Capability[] = [
  { id: "github-read", description: "Reads GitHub repo metadata, PRs, issues, branches, commits via gh CLI", tags: ["github", "read-only"] },
  { id: "identity-aware-read", description: "Optionally filters results by caller identity supplied via env context", tags: ["read-only"] },
];

export class DeterministicAgentHarness implements SessionHarness {
  readonly id: "deterministic-agent" = "deterministic-agent";
  readonly capabilities: Capability[] = CAPABILITIES;

  constructor(
    private readonly handler: { module: string; export: string },  // object form, no path:export string parsing
    private readonly timeoutMs: number,
  ) {}

  async *dispatch(req: DispatchRequest): AsyncIterable<MyelinEnvelope> {
    const fn = await loadHandler(this.handler);

    // Extract recon input from context. The dispatcher attaches a "recon-input"
    // context kind whose .data is the ReconInput shape from §5.1. The "operator"
    // for the mine cross-cut comes from the existing "env" context kind.
    const reconInput = req.context.find((c) => c.kind === "recon-input")?.data;
    const operator = (req.context.find((c) => c.kind === "env")?.data as { operator?: string } | undefined)?.operator;

    yield envelope("dispatch.task.started", {
      requestId: req.requestId,
      agentId: req.agent.id,
    });

    try {
      const result = await withTimeout(
        fn(reconInput, { caller: operator }),
        this.timeoutMs,
      );

      yield envelope("dispatch.task.completed", {
        requestId: req.requestId,
        durationMs: result.metadata.duration_ms,
      });

      yield envelope(`recon.${req.requestId}.complete`, {
        status: result.status,
        payload: result,
      });
    } catch (err) {
      yield envelope(`recon.${req.requestId}.error`, errorPayload(err));
      yield envelope("dispatch.task.failed", {
        requestId: req.requestId,
        error: serializeError(err),
      });
    }
  }
}
```

Field-name notes for implementers:

- `req.requestId` — the dispatch-correlation id (the documented field per `DispatchRequest`'s Q5 lock-in).
- `req.agent.id` — logical agent id (`gh-repo-recon-agent`).
- Input arrives via `req.context[]` with `kind: "recon-input"` (or whatever kind the dispatcher chooses — that decision is for cortex#92's dispatcher work, not this design). Recon must not assume an arbitrary `payload` field on the request.
- Operator identity (for the `mine` cross-cut) arrives via `req.context[]` with `kind: "env"` per the existing convention. If absent, the cross-cut is skipped.
- `capabilities` must be `Capability[]` — array of `{ id, description, tags? }` objects, not bare strings. The shape matches the merged `Capability` interface.

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
    input.include.has("branches") ? ghBranchesGraphQL(input) : null,  // GraphQL — one call regardless of branch count
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
- [ ] `AgentRuntimeSchema.substrate` gains `"deterministic-agent"` in `src/common/types/cortex-config.ts`
- [ ] `AgentRuntimeSchema` extended with optional `handler` + `retry` fields, gated by `.refine()` requiring them when `substrate === "deterministic-agent"`
- [ ] `persona` field changed from `z.string()` to `z.union([z.string(), z.object({ kind, path })])` with bare-string interpreted as `kind: "system-prompt"` for backward compatibility
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

### Resolved in this design (Echo round-1 feedback)

- **R1. Persona `kind` naming → `behavior-contract`.** Considered `function-spec` and `handler-contract`; rejected both. `function-spec` underweights the trust contract (the doc isn't just a function signature, it's the sealed-execution contract). `handler-contract` is fine but less general — future deterministic agents may have multiple handlers (e.g. one per trigger shape). `behavior-contract` reads as "this doc declares the behavior; the linked handler IS that behavior" and generalises cleanly. Locked.
- **R2. GH token → reuse `GH_TOKEN` in MVP.** The §7 fragment uses `GH_TOKEN`. A dedicated read-only PAT (`GH_TOKEN_READONLY`) scoped to the orgs cortex cares about is the eventual target, minted via the per-service secrets pattern at `~/.config/pai/secrets/gh-repo-recon-agent.env` — but is a follow-up, not a blocker for first land.

### Remaining open

1. **Caching policy.** MVP is no caching — every dispatch is a fresh fetch. If rate limits bite, add a 60-second TTL cache keyed by `(owner, repo, include-set, state)`. Defer until measured.
2. **One agent per ecosystem, or per-org?** MVP: one agent, takes `owner` in the envelope. If we later want per-org scoping for credential reasons (different PATs for different orgs), split.
3. **NATS queue group behavior.** Single subscriber for MVP. If a second instance is ever wanted (fan-out, redundancy), queue-group semantics apply for free — no agent-side changes.
4. **`mine` cross-cut for non-GitHub identity.** Operators identified as `did:mf:...` in metafactory might not have a corresponding GitHub login. Need a mapping. Defer until first non-Andreas operator.
5. **Streaming progress.** For typical-size repos (<30 PRs), the verdict completes in ~2s — no need for streaming. For very large repos (Linux-kernel sized), would the deterministic-agent class want to emit `dispatch.task.progress` envelopes for each section? Defer until measured.
6. **`AgentRuntimeSchema.substrate` and `HarnessId` unification.** The two enums are deliberately separate today (operator vocabulary vs runner vocabulary). This design adds `"deterministic-agent"` to both. Unification is a real piece of cortex#92 follow-up work; not blocking this design but worth tracking. File as `cortex#92` follow-up.

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
| This doc, promoted | `docs/design-gh-repo-recon-agent.md` |

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
