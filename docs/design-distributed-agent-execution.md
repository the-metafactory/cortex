# Design — Distributed agent execution (Mode A: elastic execution)

**Status:** overarching design / pre-ADR · **Sequencing:** POST-release (per the release roadmap) · **Date:** 2026-06-19 (split 2026-06-26) · **Supersedes premise of:** `docs/design-spawn-integration.md` (on ice, grove-era) · **Companion:** `docs/design-isolated-stack-hosting.md` (Mode B — the hosting axis) · **Refs:** ADR-0013 (sovereign federation), ADR-0017 (surface bundles), the-metafactory/spawn (dormant since 2026-04)

![Distributed execution — head, hands & sandboxes](diagrams/cortex-distributed-execution.jpg)

*Head/hands/session split, the configurable `local` ↔ `managed` execution backend, off-host Cloudflare sandboxes for ephemeral hands, and a fully-isolated stack on its own VM (the latter is Mode B — see the companion doc).*

> **This is the overarching, cross-layer design.** Distributed agent execution spans M7 (cortex) → M6 (substrate harness) → M4/M3 (myelin) and two repos (cortex, myelin). §6 maps each concern to the layer that owns it and the existing abstraction it extends; §7 breaks the work into an epic + 5 trackable slices. The **hosting** axis (a stack on its own infrastructure) is a *separate* concern on the pre-release federation track — see `design-isolated-stack-hosting.md`.

## 0. Why now

Two external products shipped since Spawn was designed, and they *are* what Spawn set out to build:

- **Anthropic Managed Agents** — a hosted service decomposing an agent into **Brain** (Claude + harness), **Hands** (sandboxes), **Session** (durable append-only log); Anthropic manages orchestration + session persistence + sandbox provisioning.
- **Cloudflare** provides the *hands*: code execution in lightweight V8 isolates **or** full microVMs (Cloudflare Containers — Linux, SSH), with credential-injecting egress proxies, Workers VPC / per-agent egress policies; deploy via fork-template → wrangler.

Spawn's own model was head/hands/session with "Claude Managed Agents as a fourth backend" (S-026). **So Spawn is superseded: integrate the shipped product, do not rebuild the engine.**

## 1. The frame: two orthogonal axes

A cortex *stack* today fuses three concerns onto one box (the principal's Mac):
- **head** — the daemon: bus presence, stack identity, surface adapters, orchestration.
- **hands** — the runner's CC sessions (local `Bun.spawn` today).
- **session** — Mission Control's event log.

| Axis | Question | Need | Home |
|---|---|---|---|
| **Execution** (hands) | where does agent work run? | *"scale horizontally for a stack"* | **this doc (Mode A)** |
| **Hosting** (head) | where does the daemon live? | *"a completely isolated stack on its own infrastructure"* | `design-isolated-stack-hosting.md` (Mode B) |

They compose (a Mode-B head can spawn Mode-A hands), but they are built differently and sequenced differently. **This doc is Mode A.**

## 2. Mode A — Elastic execution (scale the hands)

The stack stays where it is; the runner dispatches CC sessions to **Managed Agents / CF sandboxes** instead of local `Bun.spawn`. This is Spawn's `ManagedBackend`, now against a real API — and the seam already exists in code (`src/runner/execution-backend.ts`, §6).

- **Buys:** elastic, isolated, off-machine *capacity* per task; ephemeral sandboxes; no Mac saturation under concurrency.
- **Sovereignty:** the existing per-task sovereignty/policy checks still gate WHAT runs; this only changes WHERE.

### 2.1 What "scale horizontally" actually looks like (head + hands)

The **head** is the persistent, identity-bearing orchestrator — the cortex daemon. It holds the stack's identity, bus presence, surface adapters (Discord), dispatch + conversation state, and the durable session log. It is long-lived, stateful, connection-holding, and it *decides* what work happens.

The **hands** are ephemeral, stateless execution units — one sandboxed Claude session per unit of work (review a PR, implement a slice, answer a newcomer). They carry no identity of their own; the head lends each one scoped tools + credentials for its single task, then it's torn down.

Scaling horizontally means the head stops running CC sessions as local `Bun.spawn` — bounded by one machine's CPU/RAM, and a blast-radius risk (a runaway task shares the host) — and instead **spawns each task as a fresh sandboxed hand on separate infrastructure** (Managed Agents / CF). Concretely:

- N concurrent tasks → N sandboxes, not N processes contending for one box. Burst wide for a big review sweep; scale to zero when idle.
- The head stays light — orchestration + connections only; the heavy inference/execution is elastic and off-machine.
- Each hand is isolated: a compromised or runaway task can't reach the head, the stack identity, the secrets, or sibling tasks — egress proxies + per-agent policy enforce the boundary.

This very project is the pattern in miniature: a head spawns parallel adversarial-review hands (correctness / security / behavior lenses), collects their verdicts, and drives the merge — today locally. Moving those hands onto elastic sandboxes is the same shape at scale, off the machine.

The vocabulary is deliberate and now industry-aligned: cortex's "persistent heads vs anonymous hands" = Anthropic's Brain / Hands / Session. The head is **sovereign and persistent** (the hosting axis — Mode B); the hands are **fungible and ephemeral** (this axis — Mode A); the session is the **durable spine** that outlives any hand dying or the brain (model) being upgraded. The three can fail and be replaced independently — which is exactly why a head on a VM can keep spawning hands on CF while the model underneath improves.

### 2.2 Configurable execution backend (`local` | `sandboxed`) — the enterprise lever

WHERE a hand runs is a **per-stack config knob**, defaulting to local, selectable up to fully-sandboxed. The runner already has the pluggable `ExecutionBackend` seam (§6); the head/orchestration is unchanged:

| Backend | Where it runs | Privilege | Fit |
|---|---|---|---|
| `local` *(today)* | `Bun.spawn` on the host | **full host env**, constrained only by `allowedTools` / `allowedDirs` / bash-guard | solo / dev — lowest latency, zero infra |
| `subprocess-isolated` | host, via `@anthropic-ai/sandbox-runtime` (Spawn S-027) | reduced-privilege subprocess, no host env leakage | middle ground — isolation without going off-box |
| `managed` / `sandboxed` | CF sandbox / Managed Agents, off-host | **only the scoped tools + injected creds the head lends it**, egress-policed | **enterprise / regulated** |

Proposed config (per-agent, with a stack-level default):

```yaml
runtime:
  execution:
    backend: managed         # local | subprocess-isolated | managed
    sandbox: cloudflare      # managed-only: provider
```

**Decoupled by construction.** The head depends only on the `ExecutionBackend` *interface* — `spawn(opts) → session`. Concrete backends sit behind it and are injected by config (`BackendRegistry`); adding a substrate, or swapping CF for another sandbox provider, or an enterprise flipping the whole org to `managed`, never touches the head, the dispatch path, the agents, or the sovereignty checks. The selector is the *only* thing that knows which backend is live.

**The backend RELOCATES the harness — it never REPLACES it (load-bearing).** A real risk worth ruling out explicitly: do not let "managed" degrade into firing single-shot prompts at a thinner agent loop. Cortex already runs the *full* Claude Code harness headlessly — `claude --print --output-format stream-json --resume <sessionId> --allowedTools …` — the complete agent loop (tools, subagents, MCP, hooks), with `--resume` + the per-thread SessionManager giving multi-turn continuity and the *surface* supplying the human-in-the-loop turn. `--print` is not single-shot; it is Claude Code without the TUI. So `backend: managed` MUST mean **run that exact same `claude -p` hand inside a CF *Container* (full microVM)** — the container carries the full `claude` install; the egress proxy (§2.3) supplies `api.anthropic.com` + tool egress. Sandboxing changes *where* the harness runs, not *what* it is. Two thinner options — Anthropic Managed Agents' own *native* harness, or a lightweight V8 *isolate* that can't run full Claude Code — would trade the Claude Code harness for something lesser; they remain **separate, opt-in backends behind the same interface, never the default**. Full-harness hands → CF Containers, never isolates.

**Why this is the enterprise unlock.** With `backend: managed`, **no agent code ever runs with host privileges**. Every hand is a fresh isolated environment that holds only what the head hands it for one task — no host filesystem, no host env vars, no ambient credentials. A prompt-injected or supply-chain-compromised task can't read the host, exfiltrate data, or touch the stack identity/secrets — the blast radius is one disposable sandbox with reduced privileges. That is precisely the de-risking a regulated buyer needs, and it's a **config flip**, not a re-architecture.

### 2.3 Egress — sandboxed ≠ offline (the proxy *is* the feature)

"Egress denied-by-default" was imprecise and worth correcting: a useful agent must call APIs, search the web, hit GitHub, reach MCP servers. A sandboxed hand is **not cut off** — its outbound traffic runs through a **programmable zero-trust egress proxy** (Cloudflare Outbound Workers, GA Apr-2026) that makes internet access *safer* than raw host access, not absent:

- **Allowlist / denylist** — `allowedHosts` / `deniedHosts` (glob). Setting `allowedHosts` makes it a deny-by-default *allowlist*; the hand reaches the hosts its task needs and nothing else.
- **Credential injection (zero-trust)** — the hand makes a **plain** request; the proxy (running *outside* the sandbox) attaches the secret before forwarding. The agent authenticates to GitHub / an API **without ever holding the token** — so a compromised hand can't exfiltrate creds it never had. *This is the headline win over `local`, where a CC session inherits host env vars.*
- **TLS interception** — a per-sandbox ephemeral CA lets the proxy inspect/filter HTTPS (the private key never leaves the sidecar).
- **Audit** — via Workers VPC + Cloudflare Gateway, every DNS/HTTP/network call is logged; you can *prove* what an agent reached.
- **Private services** — Cloudflare Mesh / Workers VPC reach internal APIs without exposing them to the public internet.
- **Dynamic** — `setOutboundHandler()` adjusts a running hand's policy per task, no restart.

**What cortex hands need egress for → per-capability egress profiles:**

| Need | Hosts | Who |
|---|---|---|
| the Claude brain | `api.anthropic.com` | **always** |
| code work | `github.com`, `*.githubusercontent.com`, `registry.npmjs.org` (token injected) | dev / review agents |
| web research | broad web via Gateway category-filter | research agents |
| MCP tools | the configured MCP endpoints | per agent |
| task API | the one endpoint the task needs | per task |

```yaml
runtime:
  execution:
    backend: managed
    egress:
      profile: code              # code | research | narrow | custom — a per-capability preset
      allow: [api.anthropic.com, github.com, "*.githubusercontent.com"]
      credentials:               # held by the proxy, NEVER injected into the sandbox
        github.com: ${GITHUB_TOKEN}
```

**The reframed pitch:** the enterprise win is *not* "agents can't reach the internet." It's **"agents reach exactly what's allowed, with credentials they can never steal, every call audited"** — *more* useful and *more* secure than an agent on the host with raw env creds and unrestricted egress.

### 2.4 Auth + billing — OAuth (subscription) vs API, and the scaling tension

A sharp real-world constraint. The goal is **Claude OAuth** (a Pro/Max subscription, `sk-ant-oat01-`), not per-token API. Three facts (researched 2026-06):

- **OAuth is ToS-restricted to *official Anthropic clients*** (Feb-2026): Claude Code CLI, claude.ai, Desktop, Cowork. Using the OAuth token from any *other* tool is a ToS violation. **Implication — and another reason harness-preservation (§2.2) is load-bearing: the OAuth path is only legitimate when cortex runs the *real* `claude` CLI, never a wrapper that reuses the token.** `backend: managed` running `claude -p` in a Container is ToS-safe; extracting the token is not.
- **Headless/autonomous billing changed (June 15, 2026):** non-interactive `claude -p` draws from a *separate, limited* monthly "Agent SDK credit" pool, then API rates — NOT the unlimited interactive quota.
- **The subscription throttles parallelism:** caps (a 5-hour window + a 7-day roll; Max 5×/20×), reportedly *"~10 parallel agents exhaust a weekly quota in hours; switch to API beyond 3–5 concurrent."*

**Honest position:** OAuth hands *work* — official `claude -p` in a CF Container is a permitted client — but **OAuth and *heavy* horizontal scaling conflict by design.** And CF gives elastic *compute*, not elastic *Claude throughput*: the OAuth quota is **per-account**, shared across all hands, so N containers ≠ N× capacity. OAuth fits the head + a handful of hands; wide fan-out lands on API (or more subscription seats). The `ExecutionBackend` is therefore **auth-mode-aware** (`auth: oauth | api`). Provision OAuth creds via the egress credential-injection (§2.3). *(Billing is evolving — verify live before committing a scale plan.)*

## 3. Identity & privilege — agent proposes, principal approves, a scoped credential executes

The sandbox isolates *compute*; this isolates *authority*. **A hand never executes from a privileged position and never holds the principal's standing credentials.** When an action needs the principal's authority, the agent *proposes* it; the principal *approves* it (step-up authenticated for high stakes); a *just-in-time, narrowly-scoped, ephemeral* credential executes that one action — then expires.

**Industry patterns (researched 2026-06):**
- **Tier-zero rule:** no standing credentials, no unscoped tokens, no shared secrets across agents.
- **On-Behalf-Of (OBO), not impersonation:** the action token carries BOTH the agent's identity AND the principal's → least privilege *and* attribution.
- **Per-operation JIT scoping (RFC 8693 token exchange):** scope per-*action*, minutes-long ephemeral tokens.
- **HITL, step-up authenticated, for high-blast-radius actions:** the policy engine flags irreversible / costly / regulated / high-blast-radius actions → HITL gate → confirm with **MFA + signed request**, out-of-band (**CIBA**). EU AI Act Art. 14 + NIST AI RMF require it *provable*.

**Mapping to cortex:**

| Pattern | Cortex today | Gap → slice |
|---|---|---|
| Agent identity ≠ principal | ✅ each agent has its own NKey/DID | OBO claim on the action → **S5 (myelin)** |
| Policy gates WHAT runs | ✅ the policy engine (`engine.check`) | high-impact **classifier** → **S3** |
| Surface → approve → execute | ✅ the Pier/admission pattern + MC attention queue | **step-up MFA** on the approval → **S4** |
| Use-cred-without-holding | ✅ egress credential-injection (§2.3) | mint a **JIT, narrow, ephemeral** cred → **S2/S5** |

**Flow:** least-priv hand → policy engine classifies → low-impact proceeds on its scoped grant; high-impact **surfaces** (chat-grade for trivial, **MFA/CIBA step-up** for serious) → on approval cortex mints a **JIT, audience-restricted, minutes-long** credential (OBO claim), the egress proxy injects it, the sandbox never holds it → the action executes → the chain (agent identity, signed approval, scoped token, call) is **audited**.

Combined with sandboxed execution (§2.2) and proxied egress (§2.3): **no host privilege, no standing creds, no unapproved high-impact authority — three independent walls.**

## 4. Separation of concerns — what is cortex, what is NOT (CONTEXT.md layer discipline)

The boundary is already written down (CONTEXT.md §Substrate harness, §Layer discipline):

- **Cortex is M7** — *"consumes the bus, dispatches work, presents activity to the principal."* Dispatch + surface.
- **The substrate harness is M6** — *"the M6 runtime layer that executes a single dispatch on one execution substrate."* The harness boundary (`DispatchRequest` in → `dispatch.task.{action}` envelopes out) is what makes the runner substrate-agnostic.
- **Myelin (M2–M6) stays dumb** — routes envelopes, carries `correlation_id`, verifies the `signed_by` chain, seals payloads. *"Never push application logic down into the protocol."*

So **"run a hand in a CF sandbox" is a new harness/backend behind the existing M6 boundary — cortex dispatches the identical request and is unchanged.** The horizontal-scale work is substrate-execution (M6), not an M7 concern; the identity/OBO bits are myelin (M3–M4); only the dispatch routing and the approval surface are genuinely M7.

| Concept | Layer | Slice |
|---|---|---|
| Execution backend `local` vs CF-sandbox; harness preservation | **M6** (cortex `src/runner`/`src/substrates`) | S1 |
| Egress allowlist + credential-injection + auth-mode | **M6** | S2 |
| Risk **detection** (Claude permission mechanism) | **M6** | S3 |
| OBO claim on `signed_by` + escalation/approval envelope types | **Myelin M3–M4** | S5 |
| Dispatch routing | **M7** (built) | — |
| Async HITL approval **surface** (MC) | **M7** | S4 |

## 5. What already exists (the seams are built)

Distributed execution is **filling in seams that exist**, not greenfield:

- **`src/runner/execution-backend.ts`** — `ExecutionBackend` interface, `LocalBackend`, **`RemoteBackendConfig` with `"cloudflare" | "e2b" | "ssh"` placeholders**, `BackendRegistry`, config-driven (`execution` section marked "future"). *"This interface ensures we don't paint ourselves into a corner."*
- **`src/common/substrates/types.ts`** — `HarnessId` enum + `SessionHarness` interface; per-substrate harnesses in `src/substrates/` (`claude-code`, `agent-team`).
- **M3/M4 signing** — `loadStackSigningKey`, myelin `signEnvelope`, the `signed_by` chain (verified in `cortex.ts`), `deriveNatsSubject`. Myelin protocol lives in `the-metafactory/myelin` (public), vendored in `src/bus/myelin/`.
- **MC surface (for S4)** — the **attention queue** is built (`src/surface/mc/attention-notify.ts`, `dashboard-v2/components/attention-view.tsx`, `hooks/use-attention.ts`); MC is a dispatch sink (the `review-sink` → attention-notify path is the precedent); AAA `GrantScope` (read/review/**control**) in `user-auth/authorize.ts`. **No MFA/step-up found in `user-auth/`** — that is the genuine new piece for S4.

## 6. Workstream — epic + slices

One epic, five slices, two repos. Sequencing: **post-release** per the roadmap.

| Slice | Layer / repo | Scope | Deps |
|---|---|---|---|
| **S1** | M6 / cortex | `CloudflareBackend` behind `ExecutionBackend` + wire the `execution` config section + harness-preservation (`claude -p` in a CF Container) | — |
| **S2** | M6 / cortex | Egress allowlist + credential-injection + auth-mode (`oauth`\|`api`) per backend | S1 |
| **S3** | M6 / cortex | Risk **detection** — catch Claude Code permission escalations → emit escalation envelope (behind the harness boundary) | S5 |
| **S4** | M7 / cortex | **MC approval-surface extension** — new attention-item type + approve/deny `control` action emitting the verdict envelope + step-up MFA on that action; swarm-wide because MC aggregates the pane of glass | S3, S5 |
| **S5** | M4/M3 / **myelin** | OBO claim on `signed_by` + escalation/approval **envelope types** | — |

**Cross-repo:** S5 lives in `the-metafactory/myelin`; cortex slices link it as `myelin:S5`. The epic umbrella is a cortex issue with native sub-issues.

## 7. Spawn disposition + spike

`the-metafactory/spawn` stays on ice. Its valuable thinking (head/hands/session, capacity gauge, dispatch UX) is now embodied by Managed Agents + this design + the existing `ExecutionBackend` seam. Forward work is **integration**, not reviving the engine. Close/relabel the grove-era Spawn issues.

**Spike A1 (proves the direction):** wire a `CloudflareBackend` to run one `claude -p` hand inside a CF Container and bridge the result back onto the bus. Outcome: proof of full-harness, OAuth-capable, off-machine execution behind the existing `ExecutionBackend` interface.

## 8. Open questions

- How cortex's own Mission Control session/event log relates to Managed Agents' durable Session (dedupe, or MC consumes it?).
- Step-up MFA mechanism at the MC surface (TOTP / WebAuthn) — S4.
- OBO-claim wire shape on `signed_by` — does it extend the existing chain or add a parallel claim (myelin S5)?
- Provisioning + rotation of OAuth creds into a remote Container (CF vault/egress vs mounted secret).

## 9. FND-2 recovery additions — D-7, D-13, D-14 (`docs/plan-mc-future-state.md` §7)

This document was recovered from a closed, unmerged PR (#1189, branch deleted) as part of the
`docs/plan-mc-future-state.md` FND-2 slice. §§0–8 above are the **original PR content, preserved
as written** (2026-06-19, split 2026-06-26). This §9 is the recovery task's addition: the future-state
plan's §7 "Open decisions" table flags three forks this doc must speak to **explicitly**, rather than
let the original content's framing silently stand in for a decision.

### D-7 — Runner permission-arbitration channel design

**Fork:** how does a blocked tool-call actually wait on a human decision, given hooks must stay
non-blocking toward the bus (a constitutional rule — see CLAUDE.md Critical Rules)?

**Options on the table:** (a) a blocking `PreToolUse` hook waiting on a decision file/socket, with a
timeout that denies; (b) a harness-level permission-mode switch driving the wait; (c) a session
restart-with-grant — deny now, restart the session once the grant lands.

**Framing (recorded here per plan §7 row D-7):** the blocking wait lives **runner-side**, never
hook-side. A `PreToolUse` hook fires synchronously inside the harness and must return fast — it never
calls out to the bus itself. Instead, the hook (or the runner's own tool-call interception) flags the
call as pending, and the **runner** — the process wrapping the `claude -p --output-format stream-json
--resume` session (§5) — is what actually blocks that one tool-call while it asynchronously surfaces
the approval request over the bus (→ MC attention queue, §3 / §6 S4) and awaits the verdict envelope.
The hook itself stays fast and non-blocking (satisfying the constitutional rule); the real wait —
and the real block — is the runner's, not the hook's.

**Fail-closed on timeout:** if no decision arrives within the runner's wait window, the arbitration
channel resolves to **DENY**, never allow-by-default — consistent with invariant 14 (§3) and the
plan's zero-trust posture. Which of the three mechanical options above is the concrete implementation
is deferred to slice **S4** (§6) at build time; this note fixes the non-negotiable shape (runner-side
block, hook stays non-blocking, timeout ⇒ deny) so an executor can't improvise past it.

### D-13 — Sandbox substrate (OPEN — not silently Cloudflare)

**Fork:** CF Managed Agents vs a self-hosted sandbox vs both, behind the `ExecutionBackend` interface
(§2.2, §5).

§§0, 2.2, 2.3 and 7 above are written **Cloudflare-shaped** — that reflects the research available
when the original PR explored this space (Anthropic Managed Agents + CF Outbound Workers shipping in
the same window), **not** a resolved architectural decision. Per plan §7 row D-13, this was **silently
pre-decided in v1** and is **reopened here explicitly**: the `ExecutionBackend` interface (§5 —
`LocalBackend`, `RemoteBackendConfig` with `"cloudflare" | "e2b" | "ssh"` placeholders,
`BackendRegistry`) is substrate-neutral **by construction**, so nothing about the recommended S1 spike
(§6, a `CloudflareBackend`) forecloses a self-hosted sandbox backend (e.g. a Firecracker/E2B-style
microVM cortex operates itself) or supporting both side-by-side later. **This decision is NOT made by
this doc** — it stays open for the S1/SPX-4/SPX-6 implementation work to resolve against real
constraints (cost, control, egress-proxy ownership per D-14, enterprise on-prem requirements) when
that work actually starts.

### D-14 — Egress-proxy ownership (OPEN — not silently Cloudflare)

**Fork:** substrate-provided (CF Outbound Workers, §2.3) vs a cortex-owned proxy vs a standalone
service.

Same caveat as D-13: §2.3's zero-trust egress proxy design is written against Cloudflare's Outbound
Workers because that's the concrete product this doc researched, not because ownership has been
decided. Per plan §7 row D-14, this was **silently pre-decided in v1** and is **reopened here**:
whichever substrate D-13 lands on, the egress proxy could still be substrate-provided, or a separate
cortex-owned service (giving cortex control of the audit log + per-sandbox identity described in
§2.3 regardless of which sandbox substrate runs the hand), or a standalone proxy shared across
backends. Ownership determines where the audit log and per-sandbox identity (§2.3, §3) actually live
— that is a real design fork, not an implementation detail, and it is **left open** for the SPX-5
threat-model doc to resolve.
