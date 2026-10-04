# Design — Sovereign agent stack (a reusable foundation for hosting cortex agents off the Mac)

**Status:** design / pre-ADR · **Date:** 2026-10-04 · **Author:** Luna (with Andreas) · **Extends:** `docs/design-isolated-stack-hosting.md` (Mode B — the hosting axis), `docs/design-distributed-agent-execution.md` (Mode A — slices S2–S5) · **Refs:** `docs/design-session-sandbox-platforms.md` (DD-8, E5), `EBH-HARDENING-LEDGER.md` (epic #2341), ADR-0013, ADR-0019, ADR-0024

> **One sentence.** Run a cortex stack on infrastructure off the principal's Mac that hosts several always-on agents, each in its own container. Privileged actions go through an approval broker with passkey step-up. Every action is recorded in a tamper-evident audit log kept outside the agents' reach. Every layer of the stack is defined in git, in open formats.

---

## 0. Why now

Three developments make this timely:

1. **Always-on agents are now a product.** xAI's Grok Bot (launched 2026-08-11) gives each user a persistent cloud computer with a browser, terminal, logins, connectors, scheduled routines and "teach-a-task" skills. It shows what users want. Its security model also shows what to avoid (§1.1).
2. **Claude Code cloud sessions became generally available** (2026-09-23). They give us managed, sandboxed execution with credential-injecting proxies (§1.2).
3. **Cortex already has most of the parts.** It has a container deploy path (cortex#2095), TOTP step-up, a gate that only accepts the principal's replies, signed envelopes, a hosting design and a distributed-execution design. They have never been assembled into one shape.

**Why the earlier attempt stalled.** The sandbox work (EBH-1..3) tried to make *many sessions safe on one shared host*. That path is unsound at L1 (string guards; TOCTOU, `design-session-sandbox-platforms.md` §1). L2 cannot be built in our container shape: `bwrap` cannot create namespaces in the Debian image, even as root (E5). The spec's own answer, DD-8 "delegate, don't nest", points the way out: **make the container the boundary, one per agent.** That removes the sandbox work from the critical path.

---

## 1. Research summary

### 1.1 Grok Bot (xAI, early beta)

- **One persistent VM per user, shared by all of that user's bots,** including cookies, signed-in sessions and CLI credentials. It runs on Cursor infrastructure. Connector OAuth tokens stay on Cursor's servers, outside the VM. ([docs](https://docs.x.ai/grok-bot/computer-and-apps), [AIMultiple](https://aimultiple.com/always-on-agents))
- **Approvals:** each action can be Allowed once, Always allowed (which saves a rule) or Denied. A separate model ("Auto Review") screens actions before they run. Explicit approval is always required for sending messages, publishing, purchases and financial transfers, deletes, permission changes, production changes and accepting legal terms. Passwords, 2FA and payment confirmations use a "secure handoff": the user takes over the VM, so secrets never pass through chat. ([approvals & security](https://docs.x.ai/grok-bot/approvals-security-and-privacy))
- **Self-declared limits:** "Do not use separate Bots as a security boundary." There is no per-bot credential scoping, no native tamper-evident audit log and no published threat model. ([Kingy.ai](https://kingy.ai/blog/grok-bot-ai-teammate-price-security/), [The Rundown](https://www.therundown.ai/tools/grok-bot))
- **A related incident** (Grok, not Bot): a prompt injection led to a ~$150k crypto transfer in May 2026. ([Giskard](https://www.giskard.ai/knowledge/how-grok-got-prompt-injected-an-x-user-drained-150-000-from-an-ai-wallet))

**What we take from it:** the product shape (always-on agents, connectors, routines, skills, approval categories, secure handoff).
**What we do better:** a separate container per agent with its own credentials, and an audit log that can be checked for tampering.

### 1.2 Claude Code cloud sessions

- **The VM:** Anthropic-hosted, 4 vCPU, 16 GB RAM, 30 GB disk. Started with `claude --cloud`, from claude.ai/code or from mobile. `--teleport` pulls a session into the terminal. ([docs](https://code.claude.com/docs/en/claude-code-on-the-web), [environments](https://code.claude.com/docs/en/cloud-environments))
- **Credentials:** API credentials and GitHub tokens are injected by a proxy *outside* the VM. The key never enters the VM.
- **Network:** levels None / Trusted / Full / Custom. MCP connector traffic bypasses the allowlist.
- **Inbound messages:** `claude -p --cloud <id>` queues a message into a running session. A routine API trigger posts an untrusted payload. Arbitrary webhooks into a session are not supported. ([routines](https://code.claude.com/docs/en/routines))
- **⚠ Routines run without stopping for approval.** A fired prompt "can't act as approval or consent". Approving from a phone is documented for *local* sessions via Remote Control. ([remote-control](https://code.claude.com/docs/en/remote-control))

**What we take from it:** the approval gate must live **outside** the agent's session, whether that session is local or cloud. Cloud sessions suit low-risk unattended work. They are never where a privileged credential lives.

### 1.3 Step-up for agent actions: current practice

| Mechanism | What it gives us |
|---|---|
| **CIBA + RAR (RFC 9396)** | An out-of-band approval on a separate device, carrying the exact transaction (amount, payee). Auth0 ships it as "Asynchronous Authorization". ([Auth0](https://auth0.com/ai/docs/intro/asynchronous-authorization)) |
| **Token vault + RFC 8693 token exchange** | The agent never holds long-lived credentials. It gets tokens scoped to one task, just in time. |
| **MCP authorization (rev 2026-07-28)** | OAuth 2.1 + PKCE, audience binding (RFC 8707), and step-up on 403 `insufficient_scope`. ([spec](https://modelcontextprotocol.io/specification/draft/basic/authorization)) |
| **WebAuthn / Secure Payment Confirmation** | A signed ceremony over the transaction details. It proves the user saw *these* details. ([W3C SPC](https://www.w3.org/TR/secure-payment-confirmation/)) |

**Pattern adopted:** short-lived, audience-bound tokens; secrets injected outside the sandbox; per-transaction approval bound to the exact details, on the principal's phone, never inside the agent's own chat.

### 1.4 Xero: where money actually moves (NZ)

- **The API records payments; it does not make them.** `/Payments` and `/BatchPayments` mark bills paid in the ledger. In NZ, money moves when a human uploads a bank file and approves it with the bank's MFA. Bill payment from inside Xero (Melio) is US-only, and I found no public API for it. ([Payments](https://developer.xero.com/documentation/api/accounting/payments), [BatchPayments](https://developer.xero.com/documentation/api/accounting/batchpayments/))
- **The real attack surface is earlier.** An agent with write scopes can authorise a fraudulent bill, **change a contact's bank details**, or record false payments. Xero's user-role approval does not apply to API apps: any token with `accounting.invoices` can set a bill to AUTHORISED.
- **Scopes and tokens:** granular scopes (`accounting.invoices`, `accounting.payments`, …, each with a `.read` variant) became mandatory for new apps in 2026. Access tokens last 30 minutes. Refresh tokens last 60 days, rotate and are single-use. ([scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/))

**What we take from it:** the step-up gate belongs on *authorise bill / send invoice / edit payee bank details / record payment*. The bank's own approval stays the last human gate for money.

---

## 2. Shape: one foundation, many use cases

The doc has two parts. The **foundation** is generic and project-agnostic. **Use cases** are agents that run on it and add only connectors, policy rules and agent bundles.

| Foundation (build once) | Use cases (add per project) |
|---|---|
| Host + provisioning (§5.1, §5.7) | **A. Personal agents:** bookkeeping, inbox, research (§5.3 Xero tiers, §5.5) |
| `<stack>-deploy` repo + stack wiring (§6) | **B. Ops responders:** bots that react to monitoring events (§5.8) |
| One container/VM per agent, workspace = git repo (§5.2, §5.9) | **C. Future:** anything that's an event source plus agents plus gated actions |
| Action broker: generic proposal → approval → execute, with **connectors as plugins** (§5.3) | |
| Tamper-evident audit (§5.4) | |
| Step-up via grove-auth (DD-4) | |

**A use case is "done" when it needs no foundation change:** a new agent bundle, a connector, policy and tier rules in its deploy repo, and optionally an event source. If a use case forces a foundation change, the foundation was wrong. Fix it there, generically.

**Every stack is an instance of the foundation.** A monitoring-responder stack for another project is a second `<stack>-deploy` repo pointing at the same roles, images and broker, with its own identity, credentials and audit trail.

## 2.1 Goals and non-goals

**Goals**

- G1. A cortex stack runs 24/7 on a host off the Mac. The Mac can be off.
- G2. Several agents, each with a different job, each in its own container with its own credentials, volume and egress allowlist.
- G3. Privileged actions are *proposed* by agents and *executed* by a broker only after the principal approves the exact action with passkey step-up. Low-risk work runs unattended.
- G4. A tamper-evident audit log, recorded at points the agents don't control and stored off the host.
- G5. **Open:** every layer of the stack is defined in git in open formats. The running host is disposable.

**Non-goals (this doc)**

- Moving money. The bank approval stays human.
- Third-party (non-first-party) agent bundles. EBH-5 stays trigger-gated.
- Replacing Claude Code as the agent runtime.
- Multi-principal hosting. One principal per host.

---

## 3. Design decisions

| # | Decision | Grounded in |
|---|---|---|
| **DD-1** | **The container (or VM) is the agent boundary.** One container per agent, with **no host directories mounted**: its working state is a cloned workspace repo (DD-11). The DD-8a mount-table check confirms nothing from the host is mounted. No nested sandbox. | sandbox-platforms E5, DD-8; §1.1 (Grok's shared VM is not a boundary) |
| **DD-2** | **Agents propose, the broker executes.** Write credentials for business systems live only in the action broker. Agents get read scopes or no credentials. | §1.2, §1.3, §1.4; distributed-execution S2/S4 |
| **DD-3** | **An approval is bound to the exact action.** It is single-use, tied to a hash of the full proposal (action, target, amount, payee, rendered artefact), expires after hours rather than minutes, and is void if the target changes after approval. | §1.3 (RAR, SPC); gap: the current gate is word-matched and expires after 5 minutes |
| **DD-4** | **Passkey (WebAuthn) for money-adjacent actions; TOTP is not enough.** A TOTP code doesn't show what is being approved, so it can't protect against approving the wrong thing. This revisits D-2 in `decisions-mc-future-state.md` *for runner actions only*. TOTP stays valid for the federation-admin routes. **Reuse `grove-auth`** (`docs/design-auth-aaa.md`, already designed): passkeys with `rpId` set to the ecosystem domain, and single-use signed **action tokens** for the highest-stakes operations. Money-adjacent actions use action tokens, never grove-auth's sliding "elevation window". | §1.3; grove-auth design |
| **DD-5** | **Review, then approve.** For artefacts (invoices, emails, documents), the agent creates a draft (for example a Xero DRAFT invoice). The approval page renders the artefact (for example the invoice PDF), and the approval hash covers the rendered bytes. | principal requirement; §1.4 |
| **DD-6** | **Audit is recorded outside the agent and stored append-only off the host.** Hash-chained batches go to object storage with compliance-mode retention. Signed hourly checkpoints are published to a public git repo. A heartbeat makes silence detectable. | gap: no tamper-evident log exists today |
| **DD-7** | **Every layer in git, in open formats; the host only pulls.** Config is YAML, secrets are SOPS+age, data is markdown+YAML+JSON Schema, audit is JSONL. Changes made on the host are drift: detected and audited. | principal requirement (§6) |
| **DD-8** | **The NATS hub leaves the Mac.** A stable hub on the new host; the Mac stack joins as a leaf. Fully sovereign per-stack operators come later. | isolated-stack-hosting §2 |
| **DD-9** | **Cloud sessions are for low-risk hands only.** They never hold a privileged credential. They reach the broker as an MCP connector, which is the only route to a write. | §1.2 |
| **DD-11** | **An agent's world is a git repo, from the start.** Each agent (and each task, where useful) gets a workspace repo created by code from a template, with a token scoped to that one repo. The container clones it at start and pushes commits; nothing else persists. Agent outputs are commits, and a proposal's `artefact_sha256` is the commit hash. The **workspace store is pluggable**: Cloudflare Artifacts first, with a self-hosted git fallback, so the foundation never depends on one beta service (§5.9). | §5.9; DD-7; principal requirement |
| **DD-10** | **The session sandbox is re-scoped, not abandoned.** The *primary* boundary on hosted stacks is the container or VM (DD-1). The session sandbox becomes defence in depth: <br>• **macOS SBPL** stays the boundary for sessions on a Mac (E1/E2 proved it works). <br>• **`linux-bwrap`** applies inside a per-agent **VM** where unprivileged user namespaces work (E6). <br>• **`container-delegated`** plus the DD-8a mount check covers per-agent containers. <br>• The **L1 string guards** stay as fail-closed tripwires whose denials feed the audit log, but we stop chasing L1 bypass rounds: L1 can never be sound (TOCTOU). <br>EBH-3b (container-delegated) moves onto the critical path; further L1 hardening comes off it. | sandbox-platforms §1, E1/E2/E5/E6, DD-8 |

---

## 4. Architecture

```
 principal's phone ── passkey step-up ──┐
                                        ▼
 ┌──────────────── host (off-Mac VPS / VM) ──────────────────────────────┐
 │                                                                       │
 │  ┌────────┐   ┌──────────────┐   ┌──────────────────────────────┐     │
 │  │  NATS  │◀─▶│ cortex daemon│◀─▶│ action broker                │     │
 │  │  hub   │   │ (head, MC,   │   │ • holds write creds (vault)  │     │
 │  └───┬────┘   │  policy)     │   │ • proposal → approval → exec │     │
 │      │        └──────┬───────┘   └──────────────┬───────────────┘     │
 │      │               │ dispatch                  │ executes           │
 │      │     ┌─────────┴─────────┬───────────────┐ ▼                    │
 │      │     │ agent container A │ agent cont. B │  Xero / mail / …     │
 │      │     │ own volume+creds  │ own vol+creds │                      │
 │      │     └─────────┬─────────┴───────┬───────┘                      │
 │      │               └── egress proxy ─┘ (per-agent allowlist)        │
 │      │                                                                │
 │      └──▶ audit shipper (read-only consumer; write-only sink creds)   │
 └──────────────┬────────────────────────────────────────────────────────┘
                │ hash-chained JSONL batches, every ~10 s
                ▼
   object store (compliance-mode lock)    ──hourly signed checkpoint──▶  public git repo
                ▲
   verifier (Mac / CF cron): chain + signatures + gaps → Discord alert

 Mac stack ── leaf ──▶ hub          cloud sessions ── MCP connector ──▶ broker (via CF Tunnel + Access)
```

Mission Control is exposed via **Cloudflare Tunnel + Access**. No inbound ports are open on the host.

---

## 5. Components

### 5.1 Host and stack (Phase 1)

- **Deploy:** the existing compose path (`deploy/compose/`, cortex#2095), or systemd on a VM using the Smithy Ansible roles (`nats_server`, `bun`, `claude`, `docker`, `metafactory_arc`). A prior EC2 + systemd agent-host deployment has already run a cortex work stack off a Mac.
- **Identity:** generate a fresh NKey seed and NSC operator **on the host**, never copied from the Mac. Back them up encrypted and offline.
- **Federation:** the hub runs on the host (DD-8). The Mac stack joins as a leaf (`cortex network join`).
- **Sizing:** a head-only host needs 1–2 GB of RAM. Running agent containers locally needs 8–16 GB, with session restarts to contain Claude Code's memory growth (isolated-stack-hosting §3).
- **Claude Code auth:** headless via `CLAUDE_CODE_OAUTH_TOKEN` at runtime, or an API key. ⚠ Check plan limits and terms before running 24/7 agents on a subscription token (R4).

### 5.2 One container per agent (Phase 2)

- Each agent is a container with **no host mounts**. At start it clones its workspace repo (DD-11, §5.9) using a token scoped to that repo, works in an ephemeral volume, and pushes commits. It has its own credentials (none for business write actions; DD-2).
- **Boundary check:** the DD-8a mount-table check resolves to `container-delegated` only when the scoping is proven. A broad bind-mount is a misconfiguration warning.
- **Egress:** each agent's Docker network has no default route. The only way out is the egress proxy (EBH-4) with a per-agent allowlist. Without a default route this is a network-level boundary, not a request for cooperation.
- **Prerequisite fixes before any business credential exists:**
  - `scopeSessionEnv` (`src/runner/session-settings.ts:652`) becomes an allowlist; today it strips only `CLAUDE_*`.
  - Close the guard-off principal-DM Bash bypass (#2377).

### 5.3 Action broker and approvals (Phase 3)

1. **Propose.** The agent publishes a signed `action.proposed` envelope: `{action, target, params, artefact_ref, artefact_sha256, requested_by, request_id}`. When the artefact lives in the agent's workspace repo, `artefact_ref` is `repo@commit` and the commit hash is the binding. A workspace push event can raise the proposal directly (§5.9).
2. **Classify.** Policy maps the action to a capability with limits (for example `action.xero.bill.authorise`, `max_amount`) and to an approval tier: `auto`, `review`, or `step-up`. This replaces today's whole-agent `dispatch.<agent>` granularity for privileged actions. The rules are YAML in the deployment repo (§6).
3. **Review.** The Mission Control attention queue plus a Discord or push ping with a deep link. The page renders the artefact (DD-5) and the exact parameters.
4. **Approve.** A WebAuthn assertion whose challenge = `H(request_id ‖ artefact_sha256 ‖ params)` (DD-3, DD-4). The resulting verdict is single-use and has an expiry.
5. **Execute.** The broker re-fetches the target, checks it still matches the hash, executes with a short-lived scoped token (Xero access tokens last 30 minutes; the refresh token never leaves the broker's vault), and emits `action.executed` or `action.rejected` with an "on behalf of" claim (distributed-execution S5).

**Connectors are plugins.** The broker core knows only *proposal → policy tier → approval → execute → audit*. A connector supplies: its action names, parameter schema, how to render the artefact for review, how to re-fetch and hash the target, and how to execute with a scoped credential. Xero (use case A) and infrastructure runbooks (use case B, §5.8) are two connectors on the same core. Connectors are first-party bundles under the same trust rule as surface plugins (ADR-0024): no third-party connector without EBH-5 signing.

**Tiers for the first connector (Xero):**

| Action | Tier |
|---|---|
| Read anything | auto |
| Create DRAFT invoice or bill | auto |
| Authorise bill, send invoice, record payment | step-up |
| Create or edit a contact's bank details, billing email or payee | step-up, always, with no amount threshold |

### 5.4 Tamper-evident audit (Phase 2b)

- **Recording points the agents don't control:**
  - the NATS stream (every envelope);
  - the daemon (dispatch and policy decisions, `system.access.*`);
  - the broker (proposals, approvals, executions);
  - the egress proxy (every outbound connection).

  An agent's own Claude Code hook events are recorded but labelled `testimony`, which is lower trust. Mismatches between recording points raise alerts. For example, an agent claims one host and the proxy saw another.
- **Shipper:** a separate container with a read-only JetStream consumer. It writes JSONL batches every ~10 s, *including empty ones* (heartbeat). Each batch carries `prev_batch_sha256`. Its credentials can write to the store but not delete. Agent containers have no route to it.
- **Store:** S3 Object Lock in compliance mode, or R2 bucket lock (Q6). Payloads are encrypted before shipping (ADR-0019); hashes are computed over the ciphertext, so the log can be verified without decrypting it.
- **Checkpoints:** every hour, a tree head signed with a dedicated **audit key** (not the stack key), committed to a public `audit-checkpoints` git repo (Q7). It contains hashes only.
- **Verifier:** `cortex audit verify` is open source and runs off-host (on the Mac or a Cloudflare cron). It checks the chain, signatures, checkpoints and gaps (`gap > N × interval` → alert).
- **Limit:** whoever compromises the host can forge *future* events but cannot alter batches already shipped. The window is the batch interval.

### 5.5 Business data

The principal's customer and engagement registry moves to a private git repo: one markdown + YAML file per entity, a JSON Schema, a validator in CI, a generated SQLite/CSV index (never the source of truth), a small CLI and skill, and a one-way export to Drive. Fields such as billing email, bank details and payee are marked `sensitive` in the schema. A diff touching them goes through broker step-up (§5.3). This is built separately, outside cortex. The broker and agents treat it as one more git-backed data source.

### 5.6 Where the code lives

Most of the work is in cortex. The two parts that hold credentials or judge cortex's honesty get their own small repos. A small codebase can be audited on its own, and the audit verifier must not depend on the system it checks.

| Concern | Repo | Why |
|---|---|---|
| This design, per-agent containers (execution backend), DD-8a check, env allowlist, proposal envelope, MC review page | `cortex` | Runner and Mission Control concerns; companion designs already live here |
| Passkey enrolment, step-up, action tokens | `grove-auth` (existing, design-only since 2026-04) | Already designed for exactly this; revive rather than reinvent |
| Action broker + vault + business connectors (Xero first) | **new**: `the-metafactory/<broker>` | Holds write credentials, so it's a separate trust domain and process; small and reviewable on its own |
| Audit shipper + `audit verify` | **new**: `the-metafactory/<audit>` | Must not trust cortex; open source so anyone can verify |
| "On behalf of" claim on `signed_by` | `myelin` | Envelope-level (distributed-execution S5) |
| Host infrastructure roles | `smithy` | Existing Ansible roles |
| Stack deployment (infra, config, policy, encrypted secrets) | **new, private, principal-owned**: `<stack>-deploy` | Deployment-specific; never in a metafactory product repo |
| Audit checkpoints | **new, public, principal-owned**: `audit-checkpoints` | The public witness |
| Business registry | principal's business org | Not ecosystem code |

### 5.7 Portability — decoupled from the infrastructure layer

The architecture sits **above** the seam described in crucible (`docs/design-infrastructure-factory.md` §3). Only the bottom layer depends on the provider.

| Layer | What | Provider-dependent? |
|---|---|---|
| L0 Provision | OpenTofu module per provider: `vm-pve` (Smithy, built), `vm-aws` (crucible spec, not built), Hetzner etc. (not built). An existing host can skip L0 and go straight to L1 over SSH. | **Yes** — the only layer that is |
| L1 Configure | Smithy Ansible roles (upstream `vpzed-dev/smithy`): `base`, `nats_server`, `bun`, `claude`, `docker`, `metafactory_arc`, `metafactory_cortex` (installs cortex natively via arc at a pinned commit, and checks that the pin took), `assay_env` (environment fingerprint) | No, but **Ubuntu/apt only** today |
| L1.5 Stack wiring | **Missing:** a `cortex_stack` role that renders the `<stack>-deploy` config, decrypts SOPS secrets and starts the stack. `metafactory_cortex` deliberately leaves stack, secrets and NATS wiring to "a later layer"; this is that layer. Native (systemd) and compose are alternatives here. | No |
| L2 Stack | compose: NATS, cortex, broker, audit shipper, one container per agent | No — anywhere Docker runs (amd64 and arm64; the Dockerfile uses `TARGETARCH`) |
| External services | S3-API object lock, Cloudflare Tunnel + Access, git remotes, WebAuthn domain | No — reached over standard protocols |

**Where it runs:**
- **Linux box / Proxmox VM / Hetzner:** yes, today (Hetzner needs an L0 module, or skip L0).
- **EC2:** yes once `vm-aws` exists. A prior EC2 + systemd agent-host (Ubuntu 24.04 arm64) has already run a cortex stack.
- **macOS:** L2 runs (compose under OrbStack/Colima; the container bench already runs this way). L1 does not: the roles are apt-only, so a macOS host would need a brew/launchd role set or manual setup. Fine for a dedicated Mac mini; not the recommended primary host.

**Rules that keep it decoupled:**
- **No provider secret stores.** Secrets are SOPS+age. The only per-host secret, the age key, is delivered by cloud-init or SSH.
- **No provider-specific audit storage.** The store is addressed through the S3 API only. Put it in a different account or provider from the host, so one stolen cloud credential doesn't reach both.
- **Isolation strength is a deployment choice, not an architecture change.** On a single box an agent is a container (shared kernel). Where Smithy/crucible can provision VMs, a credentialled agent can be a **VM** reached through the existing `ssh` execution backend (`src/runner/execution-backend.ts`). That is a stronger boundary, and crucible's own rule ("the sandbox tier must be a real VM") already prefers it. Same envelopes, same broker, different backend.
- **The host's identity is recorded.** At boot the host emits its crucible environment fingerprint and digest as the first audit event. A changed host shows up in the log.

### 5.8 Use case B — ops responders (monitoring events)

This shows the foundation generalises. Nothing below is new foundation work.

- **Event in.** Alerts reach the bus through a tap. The pattern is the existing GitHub webhook path (`src/taps/gh-webhook/`): a Cloudflare Worker checks the sender's signature and forwards the alert to a localhost receiver, which publishes an envelope. New sources (Alertmanager, Grafana, uptime checks) are new taps of that shape. `cue` (the trigger daemon) covers condition-based and scheduled triggers.
- **Triage.** A responder agent in its own container gets **read-only** access to logs and metrics. It correlates the alert and posts a summary to the stack's channel or thread.
- **Act.** Remediation is a broker proposal through an infrastructure-runbook connector. Tiers come from policy:

  | Action | Tier |
  |---|---|
  | Read logs and metrics, open an incident thread | auto |
  | Idempotent, allowlisted runbook (restart one named container, clear a named cache) | auto, rate-limited |
  | Scale, roll back a deploy, change config | review |
  | Delete data, change credentials or firewall | step-up |

- **Escalate.** If the responder can't resolve the alert, it pages through the PagerDuty renderer bundle.
- **Audit.** The incident timeline (alert, triage, proposals, approvals, actions) is the audit log, with no extra work.
- **Loop guard.** Responders must not trigger on their own effects. Every action carries the triggering `request_id`, and the policy rate limit per alert fingerprint stops remediation storms.

### 5.9 Agent workspaces as git repos (DD-11)

**What.** Every agent works in a git repo instead of host folders. Optionally, every task does too, as a fork of the agent's repo.

| Lifecycle | How |
|---|---|
| Create | The broker or daemon creates the repo from a template (persona-specific scaffold, `CLAUDE.md`, skills config) and mints a **token scoped to that one repo** |
| Start | The agent container receives only that token and the repo URL, clones it into an ephemeral volume, and starts the Claude Code session there |
| Work | The agent commits as it goes: outputs, notes, memory, and optionally session transcripts |
| Propose | A push to a `proposals/*` ref fires a push event → Worker → broker `action.proposed {repo@commit}` |
| Approve | Review in Mission Control renders the diff at that commit. The passkey challenge covers the commit hash (DD-3). |
| Land | The broker, not the agent, merges or copies the approved commit into the canonical repo (GitHub: registry, deploy, docs) with its own credential |
| End | The container is destroyed. The repo stays as the inspectable record of what the agent did and knew. |

**Why it's better than mounted folders.**
- **No host access by construction.** There is no host directory to escape into, so the DD-8a check only has to confirm "nothing mounted" rather than "the right things mounted".
- **Inspectable memory.** Agent memory and context are versioned and readable. Grok Bot's memory can't be inspected or exported; this fixes that.
- **Approvals bind to content for free.** A commit hash changes if one byte changes.
- **Disposable hosts.** Agent state lives in repos, not on the host. Rebuilding the host loses no agent state, which strengthens §8.1's rebuild criterion.
- **Cheap forks for parallel work.** Many tasks can run at once without sharing a working tree.

**What does *not* go in a workspace repo.**
- Secrets. Tokens arrive at container start and are never committed; the `shippable-hygiene` and gitleaks checks run on workspace pushes too.
- Toolchains and caches. They belong in the container image or the ephemeral volume.
- Large binaries.
- The audit log. It isn't append-only in git (§5.4).

**Pluggable store (`WorkspaceStore`).** Interface: `create(template) / fork(repo) / mintToken(repo, scope, ttl) / subscribe(events) / archive(repo)`.

| Backend | Use | Notes |
|---|---|---|
| **Cloudflare Artifacts** | Default for general agents | Programmatic create/fork, repo-scoped tokens, push events. Open beta; billing from 2026-10-15; data held in the **US or EU only**. ([blog](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)) |
| **Self-hosted git** (a small git server on the host or a sibling VM, e.g. Forgejo or soft-serve) | Client-confidential agents that must stay in-region; offline or Artifacts outage; Phase 1 rehearsal on Smithy | The same interface. Push events come from server hooks. |
| GitHub | Canonical repos only | Not a workspace store. Agents never hold write tokens to canonical repos. |

**Rule:** which store a given agent uses is set in `<stack>-deploy` per agent (`workspace.store: artifacts | local-git`). Moving an agent between stores is a `git push --mirror`. This keeps §5.7's "no provider lock-in" true even though the default is a Cloudflare service.

**Dev agents** (the existing review and implementation agents) clone their *target* GitHub repo as today. Their workspace repo holds their notes and state, not the code they work on.

---

## 6. Open: every layer in git (DD-7)

| Layer | Format | Repo | Notes |
|---|---|---|---|
| Code, event schemas, verifier | TS, JSON Schema | `cortex` (public) | Unchanged |
| Infrastructure | OpenTofu, Ansible, compose YAML | `<stack>-deploy` (private) | Smithy roles reused |
| Stack config | config-split YAML | `<stack>-deploy` | Never in the cortex repo (Critical Rules) |
| Secrets | **SOPS + age** encrypted YAML | `<stack>-deploy` | The age key lives only on the host and in an offline backup |
| Agents, personas, skills | YAML, markdown | arc bundles | Already done |
| Agent workspaces (state, memory, outputs) | git repos | Artifacts or self-hosted git (§5.9) | One per agent/task; host keeps none |
| Policy and approval rules | YAML | `<stack>-deploy` | A change to the rules is a reviewed diff |
| Business data | markdown + YAML + JSON Schema | `registry` (private) | §5.5 |
| Audit log | JSONL + hash chain | object store | Git is not append-only (force-push), so only checkpoints go to git |
| Audit checkpoints | signed JSON | `audit-checkpoints` (public) | Hashes only |
| Runtime state (JetStream, MC SQLite, live sessions) | — | none | Operational state, not source. The host is disposable: rebuild = git + age key, losing only in-flight work. |

**GitOps rule:** the host deploys a tagged version of `<stack>-deploy` and never edits it in place. A `cortex doctor` drift check compares the running config with the deployed tag and emits an audit event on any difference.

**Cloudflare Artifacts** is the default **workspace** store (§5.9, DD-11). It is not used for canonical principal data (deploy repo, registry) until it leaves beta and data residency is resolved.

---

## 7. Existing assets and gaps

| Have | Where |
|---|---|
| Container deploy + release bench | `deploy/compose/`, `deploy/test/container-compose.sh` |
| TOTP step-up (MC federation-admin routes) | `src/common/step-up/`, `src/surface/mc/api/step-up-mfa.ts` |
| Gate that only accepts the principal's replies | `src/bus/surface-principal-gate.ts` |
| Signed envelopes + chain verification | `src/bus/verify-signed-by-chain.ts` |
| Policy engine | `src/common/policy/` |
| Audit-shaped events | `src/bus/system-events.ts` (`system.access.*`) |
| Egress proxy (needs a no-default-route network) | `src/runner/egress-proxy.ts` |
| Container-delegated sandbox design | `docs/design-session-sandbox-platforms.md` DD-8 |

| Gap | Phase |
|---|---|
| Daemon env leaks to the session (`scopeSessionEnv` strips only `CLAUDE_*`) | 2 |
| Guard-off DM Bash bypass (#2377) | 2 |
| Session sandbox is **dormant**: the macOS SBPL backend is built and the boot probe resolves it, but no dispatch path passes `sandboxMode`, so `system.sandbox.mode` is parsed and ignored (`cc-session.ts:658` defaults to `off`). On Linux the probe resolves to `none`. | 2 (wire it; enabling is a principal decision) |
| `container-delegated` backend + DD-8a check not built (EBH-3b) | 2 |
| No tamper-evident audit (no chain, no off-host store, step-up decisions not logged) | 2b |
| No way to hold a running session until approval (SPX-8); verdicts are word-matched and not bound to the action | 3 |
| No per-action capabilities, no risk tiers (S3) | 3 |
| No vault, no business connectors | 3 |
| No WebAuthn | 3 |
| TOTP reuse not prevented within the window | 3 |

---

## 8. Phases

| Phase | Scope | Exit criteria | Estimate* |
|---|---|---|---|
| **1 — Off the Mac** | Host, compose/systemd, NKey + operator generated on the host, hub on the host, Mac joins as a leaf, MC via Tunnel + Access. **No business credentials.** Rehearse on a Smithy VM first, then apply the same Ansible to the real host. | The stack keeps serving Discord with the Mac off; the federation link survives a restart | 1–3 days |
| **2 — One container per agent** | Per-agent containers with no host mounts + DD-8a check; `WorkspaceStore` with the Artifacts and local-git backends, repo-scoped tokens, clone-on-start; no-default-route networks + egress proxy, env allowlist, #2377 | An Assay case: an out-of-scope host path is unreadable from an agent container; outbound traffic to a non-allowlisted host fails | ~1 week |
| **2b — Audit** | Shipper, hash chain, locked store, audit key + checkpoints, verifier, heartbeat alert | An Assay case: deleting or altering a batch makes `cortex audit verify` fail; stopping the shipper raises an alert | 1–2 weeks |
| **3 — Broker + approvals** | Proposal envelope, policy tiers, MC review page with artefact rendering, WebAuthn, vault, Xero connector (read + draft + step-up writes) | A draft invoice is reviewed and approved on the phone → authorised + sent; changing it after approval voids the approval | 1–2 weeks |
| **4 — Agents** | First agents (bookkeeping, inbox/research, existing dev agents); routines via reflex-edge; low-risk work optionally on cloud sessions via the MCP connector | Each agent runs in its own container with an audited action history | ongoing |

\*Estimates are judgement, not measurement. Phase 2b runs in parallel with Phase 2 and must be finished before Phase 3, so that approvals are audited from the first one.

**Crucible, Assay and Smithy** check each phase's exit criteria. They are not a gate before Phase 1 starts.

### 8.1 Phase 1 runbook — first stack off the Mac

**Approach: stand up a new stack, don't migrate the Mac one.** The new stack is created on the host, born aligned (`cortex stack create`), with fresh identity. The Mac stack keeps running throughout, so the rollback is "nothing changed". Agents move over one at a time once the host has proven itself.

**Deliberately out of scope:** business credentials, the broker, per-agent containers, audit. The host runs the stack exactly as the Mac does today.

| # | Step | Produces | Who |
|---|---|---|---|
| 1 | Decide the host (Q4) and the hub shape (Q5) | decisions | principal |
| 2 | Create `<stack>-deploy` (private): inventory, config-split YAML from `docs/config-layout/`, `.sops.yaml` with the host's age recipient plus an offline recipient | repo skeleton | agent, principal reviews |
| 3 | Write the **`cortex_stack` Ansible role**: render config from the deploy repo, decrypt SOPS secrets, generate the NKey seed + NSC operator **on the host** if absent, start the stack (systemd or compose). It's foundation work that every future stack reuses. | role (in Smithy, above the seam) | agent |
| 4 | Rehearse on a Smithy Proxmox VM: `base, nats_server, bun, claude, docker, metafactory_arc, metafactory_cortex, cortex_stack, assay_env` | a running test stack + environment digest | agent |
| 5 | Apply the same roles to the real host. Only L0 differs, or there's no L0 if the box already exists. | the live stack | principal runs `apply` |
| 6 | Hub on the host. Mac stack joins as a leaf (`cortex network join`, dry-run first). | federation link | principal |
| 7 | Mission Control via Cloudflare Tunnel + Access (no inbound ports, no bypass policies) | MC reachable | principal |
| 8 | Bind one surface (a Discord channel or bot) and one low-risk agent | first agent live off-Mac | agent |

**Exit criteria (become Assay cases):**
- With the Mac powered off, the agent answers in Discord.
- Rebooting the host brings the stack back unattended (supervisor + healthcheck).
- Rebuilding from scratch on a fresh VM, from `<stack>-deploy` + the age key, gives a working stack with the **same `stack.id`**, without copying anything off the old host. The identity seed comes from encrypted backup.
- `assay_env` digest recorded; the same role set on a second VM gives the same core digest.

**Reuse check:** a second stack (for example an ops-responder stack for another project) is created by copying `<stack>-deploy`, changing the slug, identity and agents, and re-running step 5. If that needs a role change, step 3 wasn't generic enough.

---

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Prompt injection from email or invoice content leads to a fraudulent bill or payee bank change | DD-2/DD-3/DD-5: proposals only; step-up shows the exact details; bank-detail edits always need step-up |
| R2 | Xero's API ignores its UI roles (any `accounting.invoices` token can authorise) | Write scopes only in the broker; agents read-only |
| R3 | Shared credentials across agents (Grok's model) | DD-1: per-agent containers, volumes, credentials |
| R4 | Subscription OAuth token for 24/7 agents hits plan limits or terms | Verify before Phase 4; an API key is the safe default |
| R5 | Seeds, operator root and age key on the host are the most valuable secrets | Generate on the host, encrypted offline backup, rotation runbook |
| R6 | Host compromise forges future audit events | Short batch interval; several independent recording points; off-host verifier |
| R7 | Approval fatigue (the principal rubber-stamps) | Tiers keep step-up rare; the review page shows a diff against the previous state, not just the new state |

---

## 10. Open questions (principal decisions)

- **Q1** Passkey for money-adjacent actions (recommended), or TOTP as an interim?
- **Q2** Does the broker run on the off-Mac host (recommended, follows from G1) or the Mac?
- **Q3** Execution: own containers (recommended for anything credentialled) vs cloud sessions for low-risk hands. Both are allowed under DD-9; the question is the default.
- **Q4** Host: Hetzner VPS (recommended: cheapest, fully separate), Proxmox via Smithy (free, but on-premises), or a personal AWS account.
- **Q5** Hub shape: stable hub on the host (recommended first) vs sovereign per-stack operators.
- **Q6** Audit store: S3 Object Lock compliance mode (proven) vs R2 bucket lock (stays on Cloudflare; confirm it matches compliance-mode semantics).
- **Q7** Checkpoints: public git repo (fits DD-7) — Sigstore Rekor as an optional second witness?
- **Q8** Workspace store default: Cloudflare Artifacts (recommended for general agents) with local-git for client-confidential agents — or local-git everywhere until Artifacts leaves beta?

---

## 11. Next steps

1. The principal answers Q1–Q7.
2. Turn §8 into an epic with sub-issues (`plan-breakdown`), cross-linked to #2341 (EBH) and the distributed-execution slices.
3. Start Phase 1 on a Smithy VM.
