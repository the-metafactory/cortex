# Arc-Installable Sub-Bots — Design Specification

**Status:** Draft — design for hosting + installing sub-bot agents (review, copy-edit, research, custom) under arc + cortex + meta-factory.
**Date:** 2026-05-11
**Driver:** Ivy (for Jens-Christian Fischer)
**Related docs:**
- `docs/design-pi-dev-review-agent.md` — substrate/presence decoupling that motivates this (committed in this same PR; previously untracked)
- `docs/architecture.md` §6 (bus contracts: subjects + envelopes) and §9 (agent + presence/renderer model)
- `src/common/agents/registry.ts` — `AgentRegistry` rules §9.3 (trust must resolve at construction)
- `arc-manifest.yaml` (cortex root) — current arc package shape for cortex itself

---

## 1. Goal

`arc install foo-review-bot` should be a single command that:

1. Pulls the bot package (binaries, persona, fragment config) onto the host.
2. Registers the bot's identity into cortex's agent registry.
3. Mints the bot's NATS credentials.
4. Wires the bot's lifecycle (in-process under cortex's runner, or standalone daemon under launchd) so it's available immediately.
5. Hot-reloads cortex (no restart required for in-process bots).

`arc uninstall foo-review-bot` reverses all of the above.

Today this surface does not exist. Each new bot is a bespoke setup: hand-edit cortex.yaml, hand-mint NATS creds, hand-write a launchd plist, hand-update trust lists. The pi.dev review agent design doc surfaced the orthogonality but did not propose the packaging path. This doc does.

---

## 2. The Four Orthogonal Axes

The pi.dev design doc's central insight: **presence and substrate are independent.** A bot package must declare four axes, and the install machinery must respect that they vary independently.

| Axis | Values | Where it persists | Who owns it |
|---|---|---|---|
| **Identity** | `id`, `displayName`, `roles`, `trust` | Fragment in `~/.config/cortex/agents.d/<id>.yaml` | Bot package (Q1 answer) |
| **Capabilities** | `[code-review]`, `[research]`, `[copy-edit]`, ... | NATS KV `local.{org}.agents.capabilities.{id}` on start | Bot daemon |
| **Substrate** | `claude-code` / `codex` / `pi-dev` / `custom-binary` | Fragment + bot's arc-manifest | Bot package |
| **Presence** | `discord` / `mattermost` / `slack` / none | Fragment under `presence:` (optional) | Bot package |

The bus sees only envelopes — it doesn't care which substrate produced them, nor what surface (if any) the agent attaches to. Cortex's agent registry maps `agent_id → identity`. Capabilities register dynamically via the NATS KV bucket. Substrate is what process runs the agent. Presence is whether (and where) it talks to humans.

The packaging surface (`arc install`) must let a bot author declare all four axes in one place — the bot's `arc-manifest.yaml`.

---

## 3. Two Install Shapes

Substrate axis drives the install shape. Cortex hosts some agents in-process (CC subprocesses spawned by cortex's runner); others are standalone daemons (pi.dev, Codex, custom binary) that connect to the same bus.

### 3.1 In-process bot (substrate: claude-code, mode: in-process)

Cortex's runner (after MIG-7.1 lands `src/cortex.ts`) spawns Claude Code subprocesses per agent. An in-process bot needs to appear in `agents[]` and have a persona file on disk.

```
arc install foo-review-bot
  → drops persona.md   → ~/.config/cortex/personas/foo.md
  → drops fragment     → ~/.config/cortex/agents.d/foo.yaml
  → mints NATS creds   → cortex creds issue foo
                         (cortex daemon mints, writes ~/.config/nats/creds/foo.creds)
  → signals cortex     → SIGHUP or `cortex agents reload`
                         (loader+watcher, extended per §6.1, pick up the fragment)
```

**No new process. No new launchd plist.** The watcher (`src/common/config/watcher.ts`) hot-reloads `cortex.yaml` today and is extended in §6.1 to also watch `~/.config/cortex/agents.d/`. Cortex's runner spawns CC for foo on the next dispatch matching foo's capability.

Use this shape for: simple persona-based agents on the cortex's Claude-Code substrate.

### 3.2 Standalone bot (substrate: codex | pi-dev | custom, mode: standalone)

Substrate-flexibility lives here. Codex / pi.dev / custom-binary bots run as their own daemons, connect directly to the same NATS bus cortex is on, and self-register capabilities.

```
arc install foo-codex-review-bot
  → drops persona.md   → ~/.config/cortex/personas/foo.md
  → drops fragment     → ~/.config/cortex/agents.d/foo.yaml
  → mints NATS creds   → ~/.config/nats/creds/foo.creds
  → installs binary    → ~/bin/foo-bot   (symlink to package)
  → installs plist     → ~/Library/LaunchAgents/ai.meta-factory.foo.plist
  → launchctl load     → daemon starts, connects bus, registers capability
  → signals cortex     → cortex sees new fragment, agent appears in registry
```

The bot daemon is wholly owned by arc's lifecycle (its own pre/post install scripts). Cortex sees the agent only via:
1. The fragment file in `agents.d/` (identity + trust + presence)
2. The NATS capability registry (`local.{org}.agents.capabilities.foo`)
3. Envelopes published by the bot on the bus

Use this shape for: any non-Claude-Code substrate, anything that needs a separate process boundary (different model API, different security sandbox, different language runtime).

**Platform note (process supervision):** the sequence above shows the macOS path (`launchctl` + `~/Library/LaunchAgents/`). On Linux the equivalent is systemd user units (`systemctl --user` + `~/.config/systemd/user/`). The bot's `arc-manifest.yaml` declares OS-specific `provides` entries (`provides.plist` for darwin, `provides.systemd-unit` for linux), and arc renders + loads the appropriate one. The launchd shape is documented here as the operator's day-1 target since cortex's MIG-7 cutover ships only macOS plists; systemd ships in a follow-on milestone once a Linux host enters the deployment topology. The bus contracts and fragment files are platform-agnostic; only the daemon supervision layer differs.

### 3.3 Shape selection

| Question | In-process | Standalone |
|---|---|---|
| Substrate is Claude Code? | yes | no — Codex/pi.dev/custom |
| Need separate process boundary? | no | yes |
| Need different security sandbox? | no | yes |
| Memory-cheap (per-bot)? | yes (~CC subprocess) | no (per-bot daemon + bus client) |
| Cortex restart on install? | no (hot-reload) | no (daemon self-starts) |

Default to in-process when substrate is `claude-code` and the bot doesn't need an isolated boundary. Otherwise standalone.

---

## 4. Bot Arc-Manifest Schema

Extends arc's existing manifest schema with an `agent` type. Cortex itself stays `type: component` (per the current `arc-manifest.yaml` at the cortex root).

```yaml
# foo-review-bot/arc-manifest.yaml
name: foo-review-bot
version: 0.1.0
type: agent                       # NEW — arc enforces parent-installed-first
parent: cortex                    # NEW — dependency on cortex package
description: Code review bot for TypeScript repos

runtime:
  substrate: claude-code          # claude-code | codex | pi-dev | custom-binary
  mode: in-process                # in-process | standalone
  capabilities:
    - code-review                 # registered to NATS KV on start
    - typescript

identity:
  id: foo                         # MUST match agents[].id consumers expect
  displayName: Foo
  roles: [agent-restricted]       # propagated into Discord role bindings
  trust: [luna, holly, ivy]       # other agents this one trusts

# Optional presence — only if the bot speaks to humans
presence:
  discord:
    enabled: true
    # token + guildId resolved at install time from operator env or vault

provides:
  files:
    persona.md: ~/.config/cortex/personas/foo.md
    agent.yaml: ~/.config/cortex/agents.d/foo.yaml

  # standalone-only — omitted for in-process
  binary: foo-bot                 # → ~/bin/foo-bot
  plist: services/ai.meta-factory.foo.plist

lifecycle:
  preinstall:
    - scripts/check-cortex-version.sh    # require parent at compatible version
  postinstall:
    - scripts/issue-nats-creds.sh        # mints per-agent NATS user (Q2 answer)
    - scripts/signal-cortex-reload.sh    # SIGHUP cortex or call `cortex agents reload`
  preuninstall:
    - scripts/drain-tasks.sh             # OPEN Q4 — stop accepting, wait, then remove
    - scripts/signal-cortex-reload.sh    # cortex drops the agent from registry
```

**Schema decisions (locked):**

- **Q1 — persona ownership:** the bot package ships its own `persona.md` under `provides.files`. Bot author edits the persona in the bot's source repo; arc upgrades carry persona updates. Cortex's `~/.config/cortex/personas/` is rendered output, not source of truth.
- **Q3 — substrate + mode in fragment:** the rendered `agent.yaml` fragment (next section) includes `runtime.substrate` and `runtime.mode` so cortex's dashboard renders accurate provenance ("foo (in-process / claude-code)") without inferring from capability registry.

**`roles:` semantics** (per `docs/architecture.md` §9 + cortex's role-resolution model): roles declare the **maximum** capability bundle an agent is allowed to exercise. The agent's effective capability set at dispatch time is the **intersection** of `runtime.capabilities` (declared by the bot package) and the bundle implied by `roles:`. Declaring a capability that the role doesn't grant is a load-time warning, not an error — the role wins. An empty `roles: []` means no capability is granted regardless of `runtime.capabilities`; agents must declare at least one role to be dispatched against. The role → capability bundle mapping is owned by cortex (G-121 family) and is out of scope for this design — bots reference role names, cortex resolves them.

---

## 5. Rendered Agent Fragment

`provides.files.agent.yaml` is rendered by arc at install time. Example for the manifest above:

```yaml
# ~/.config/cortex/agents.d/foo.yaml
id: foo
displayName: Foo
persona: ~/.config/cortex/personas/foo.md
roles: [agent-restricted]
trust: [luna, holly, ivy]

# Q3: substrate + mode are persisted, not inferred
runtime:
  substrate: claude-code
  mode: in-process
  capabilities: [code-review, typescript]

presence:
  discord:
    enabled: true
    token: ${FOO_DISCORD_TOKEN}    # env-resolved at cortex load
    guildId: "1487..."             # operator-provided at install
```

Cortex's `common/config/loader.ts` (extended per §6.1) merges all `agents.d/*.yaml` fragments into `CortexConfig.agents[]` on every reload. Order is filename-alphabetical (stable).

**Merge conflict rules — explicit:**

| Collision case | Resolution | Operator-visible signal |
|---|---|---|
| Same `id` appears in two fragments under `agents.d/` | **Load-time error.** Cortex refuses to start (or refuses the reload — old config retained). | Error logged with both filenames + the conflicting `id`. |
| Same `id` appears in `cortex.yaml` inline `agents[]` AND a fragment | **Inline wins** (operator override semantics). Fragment is shadowed. | Warning logged at load time naming the inline source as winner and the shadowed fragment file. Useful during migration when an operator pins a hand-tuned identity over a stale arc-installed one. |
| Trust references an `id` that doesn't resolve in the merged registry | **Load-time error** per `AgentRegistry` §9.3 rule 1 (see registry.ts header). Cortex refuses to start until trust resolves. See §9 for install-order implications. |

**`CortexConfig.agents[]` semantics change** (back-compat note): today `agents[]` is populated solely from `cortex.yaml`. After §6.1 lands, `agents[]` is the *merge* of `cortex.yaml`'s inline `agents[]` and all fragments under `agents.d/` per the rules above. This is additive; existing deployments using only inline `agents[]` see no behaviour change.

---

## 6. Three Plumbing Pieces

These are the prerequisites for `arc install <bot>` to work end-to-end. None of them ship today; each is its own small landable PR.

### 6.1 Cortex — `agents.d/` fragment support

**Scope:** `src/common/config/loader.ts` + `watcher.ts`.

- Loader walks `~/.config/cortex/agents.d/*.yaml` after parsing `cortex.yaml`, merges into `agents[]`.
- Watcher watches the directory; emits the same reload event as `cortex.yaml` does today.
- New CLI: `cortex agents reload` — manual trigger for operators / lifecycle scripts. Calls into the same reload code path. SIGHUP also routes here.
- Fragment schema = subset of `CortexConfigAgent` (no `operator:` block; cortex.yaml stays the source of truth for operator identity).

Estimated ~150 LOC + tests. Lands as a `feat(common/config)` PR.

### 6.2 Arc — `type: agent` + `parent:` dependency

**Scope:** arc's manifest schema + install order.

- Schema extension: `type: agent` is a distinct kind from `type: component` (cortex's kind). Arc validates `parent` is installed (or being installed in the same transaction) and at a compatible version range.
- Install order: agents install after their parent. Lifecycle scripts can reference parent's installation root (`PAI_PARENT_INSTALL_PATH`).
- Uninstall order: agents uninstall before their parent.
- `arc list --type agent` filters to agents.
- `arc agents` subcommand (optional): groups agents by parent for legibility.

Estimated ~200 LOC in arc + schema doc + a couple integration tests. Lands in arc repo, not cortex.

### 6.3 Cortex — `cortex creds issue` CLI (Q2)

**Scope:** `src/cli/cortex/commands/creds.ts` (thin client) + creds-issuer RPC handler inside cortex daemon + NATS account hierarchy doc.

**Signing model — daemon-mediated (locked):**

The CLI is a **thin client**. It does NOT load the operator account's signing key from disk. The signing key lives in the running cortex daemon's memory (loaded at startup from a path declared in `cortex.yaml`, owned by `chmod 600` operator-only). The CLI talks to the daemon over a local channel (preferred: NATS request/reply on `local.{org}.cortex.creds.issue` using the daemon's own ops creds; fallback: UNIX domain socket at `~/.config/cortex/cortex.sock`). The daemon validates the request, mints the user creds, writes the creds file with `chmod 600`, and returns success. **No CLI-side access to the operator signing key.**

This matters because lifecycle scripts (`arc install <bot>` calls `cortex creds issue …`) run in the operator's shell. If the CLI loaded the signing key from disk every invocation, any script — or a compromised dependency — could read the key. The daemon-mediated path means the key never leaves the daemon process even on a creds-issue-spammed host.

**Surface:**

- `cortex creds issue <agent-id>` mints a NATS user creds file at `~/.config/nats/creds/<agent-id>.creds`. Per-agent user (Q2 answer) — each agent gets its own NATS identity, separate keypair, separate creds file. Revocation is per-agent.
- `cortex creds revoke <agent-id>` instructs the daemon to revoke the agent's NATS user (server-side via JWT account update), then removes the local creds file. Order matters — server revocation first so a phantom local file never authenticates again.
- `cortex creds rotate <agent-id>` is `revoke + issue` atomically (revoke server-side, mint new server-side, write new file, only then signal the bot to reload its connection).
- `cortex creds list` enumerates all minted creds with `issued`, `last-rotated`, `expires` timestamps.
- Permissions scoped to the agent's subjects: pub on `local.{org}.dispatch.*`, `local.{org}.review.*`, `local.{org}.agents.capabilities.{agentId}`; sub on `local.{org}.dispatch.task.received`, `local.{org}.tasks.{capability}.*`. The capability list comes from the agent's fragment (loaded at issue time).
- Lifecycle integration: `arc install <bot>`'s `issue-nats-creds.sh` calls `cortex creds issue <bot.identity.id>`. Script fails (and arc rolls back the install) if the daemon isn't running, the operator's account key isn't loaded, or the agent fragment isn't yet visible to the daemon (chicken-and-egg avoided by sequencing: drop fragment first, signal reload, then issue creds).

Estimated ~300 LOC + tests + NATS account scaffolding doc. Lands as a `feat(cli/cortex)` PR.

---

## 7. Worked Examples

### 7.1 In-process review bot

```yaml
# claude-review-bot/arc-manifest.yaml
name: claude-review-bot
version: 0.1.0
type: agent
parent: cortex
runtime:
  substrate: claude-code
  mode: in-process
  capabilities: [code-review]
identity:
  id: rev
  displayName: Rev
  roles: [agent-restricted]
  trust: [luna, holly]
provides:
  files:
    persona.md: ~/.config/cortex/personas/rev.md
    agent.yaml: ~/.config/cortex/agents.d/rev.yaml
lifecycle:
  postinstall:
    - scripts/issue-nats-creds.sh
    - scripts/signal-cortex-reload.sh
```

`arc install claude-review-bot` → 4 files dropped, cortex hot-reloads, rev appears in dashboard as `rev (in-process / claude-code)`. First `tasks.code-review.*` task on the bus is claimed by rev's CC subprocess. No restart, no manual config edits.

### 7.2 Standalone Codex review bot

```yaml
# codex-review-bot/arc-manifest.yaml
name: codex-review-bot
version: 0.1.0
type: agent
parent: cortex
runtime:
  substrate: codex
  mode: standalone
  capabilities: [code-review]
identity:
  id: codex-rev
  displayName: Codex-Rev
  roles: [agent-restricted]
  trust: [luna, holly]
provides:
  files:
    persona.md: ~/.config/cortex/personas/codex-rev.md
    agent.yaml: ~/.config/cortex/agents.d/codex-rev.yaml
  binary: codex-rev-bot
  plist: services/ai.meta-factory.codex-rev.plist
lifecycle:
  postinstall:
    - scripts/issue-nats-creds.sh
    - scripts/signal-cortex-reload.sh
    - scripts/launchctl-load.sh
```

`arc install codex-review-bot` → fragment + persona drop, plist rendered + loaded, daemon connects bus, registers `code-review` capability. Cortex sees codex-rev in fragments and on the capability KV — same agent identity (just on a different substrate). On the bus, codex-rev and rev are competing consumers for `tasks.code-review.*` per pull-consumer-group semantics.

### 7.3 No-presence research bot

A bot that has no Discord/Mattermost surface — only takes tasks from the bus, no human chat.

```yaml
runtime:
  substrate: pi-dev
  mode: standalone
  capabilities: [research, web-scrape]
identity:
  id: scout
  displayName: Scout
  roles: [agent-restricted]     # required even for bus-only agents — see §4
  trust: [luna]
# no presence: block — Scout speaks bus only
```

Operator interacts with Scout indirectly: another agent (Luna) dispatches a research task on the bus, Scout claims, executes, publishes results back. The dashboard renders Scout's lifecycle envelopes; humans don't chat with Scout directly. Even though Scout has no chat surface, it still declares `roles: [agent-restricted]` — per §4 the role-bundle's intersection with `runtime.capabilities` is what cortex actually dispatches against, so an empty roles list would leave Scout unable to claim any task. Roles are an authorization axis (what cortex permits), separate from presence (where the agent shows up).

---

## 8. Lifecycle Sequence Diagrams

### 8.1 Install (in-process)

```
operator: arc install foo-review-bot
arc:      preinstall: scripts/check-cortex-version.sh        [verify parent compat]
arc:      drop persona.md   → ~/.config/cortex/personas/foo.md
arc:      drop agent.yaml   → ~/.config/cortex/agents.d/foo.yaml
arc:      postinstall: scripts/issue-nats-creds.sh
            → cortex creds issue foo
            → ~/.config/nats/creds/foo.creds written
arc:      postinstall: scripts/signal-cortex-reload.sh
            → SIGHUP cortex bot pid (or `cortex agents reload`)
            → config-watcher.ts re-reads agents.d/
            → agents[] now includes foo
            → AgentRegistry rebuilt
operator: foo appears in dashboard, can take tasks
```

### 8.2 Install (standalone)

```
operator: arc install codex-review-bot
arc:      preinstall: scripts/check-cortex-version.sh
arc:      drop persona, agent.yaml, binary (~/bin/codex-rev-bot)
arc:      drop plist → ~/Library/LaunchAgents/ai.meta-factory.codex-rev.plist
arc:      postinstall: scripts/issue-nats-creds.sh
arc:      postinstall: scripts/launchctl-load.sh
            → daemon starts
            → connects NATS with codex-rev.creds
            → publishes capabilities to local.{org}.agents.capabilities.codex-rev
arc:      postinstall: scripts/signal-cortex-reload.sh
            → cortex sees agent.yaml fragment in agents.d/
operator: codex-rev appears in dashboard alongside cortex-hosted agents
```

### 8.3 Uninstall

**Ordering rule: revoke credentials BEFORE removing files.** Server-side revocation is the only authoritative invalidation. If file removal succeeded but server revocation failed (network blip, daemon crash mid-uninstall), the credential would remain valid on the NATS server with no local management surface to find it. Reversing the order is safer — a server-revoked credential with a still-on-disk creds file is harmless (next connect attempt fails authentication and the file is removed at the end of uninstall anyway); the inverse is a silent phantom.

```
operator: arc uninstall foo-review-bot
arc:      preuninstall: scripts/drain-tasks.sh        [OPEN — see §10]
            → publish local.{org}.agents.foo.draining
            → wait for in-flight dispatch.task.completed (with timeout)
arc:      preuninstall: scripts/launchctl-unload.sh   [standalone only]
            → daemon stops, releases NATS connection
arc:      preuninstall: cortex creds revoke foo
            → server-side: NATS user revoked via JWT account update
            → local: ~/.config/nats/creds/foo.creds deleted
            → revocation MUST succeed; if not, arc aborts uninstall and
              leaves the package in place so operator can investigate
arc:      remove persona.md, agent.yaml, plist (if standalone), binary
arc:      postuninstall: signal cortex reload (now sees no foo fragment)
            → AgentRegistry rebuilt without foo
            → any peers' trust references to foo are now unresolvable;
              cortex refuses the reload per §9 (operator either: 1) edits
              dependent agents' trust lists, or 2) uninstalls them too in
              an arc transaction). Until resolved, the prior cortex state
              remains live.
```

**Abort-on-revoke-failure rationale:** arc rolls back on a failed `creds revoke` rather than continuing. The alternative (continue, log) leaves the operator with a phantom credential they cannot easily discover. `cortex creds list` makes orphans discoverable retroactively, but prevention is cleaner than detection.

---

## 9. Trust + Cross-Agent References

Bot fragments declare `trust: [other-agent-ids]`. The trust list is propagated to the runtime via `TrustResolver` (existing — `src/common/agents/trust-resolver.ts`).

**Bootstrapping aligns with `AgentRegistry` §9.3 rule 1** — every id in any agent's `trust:` list MUST be a known agent in the registry at construction time. `AgentRegistry` throws `UnknownAgentReferenceError` if a trust reference doesn't resolve. Cortex refuses to start (or refuses a reload) under that error and retains the prior valid state. The design adopts this contract — strict, fail-fast — for v1 of arc-installable bots.

**Implication for install order:** if bot A trusts bot B (and B is not yet installed), `arc install foo-A-bot` alone would render an `agents.d/a.yaml` fragment whose `trust: [b]` cannot resolve, and the subsequent `cortex agents reload` would refuse the load. Three options for operators:

1. **Install B first, then A** — sequential install commands. Simplest when the trust graph is acyclic and known.
2. **Use an arc transaction** — `arc install foo-A-bot foo-B-bot` in one command. Arc renders all fragments into a staging area, lets cortex validate the merged registry, then commits both or rolls back both. (Requires arc-side transaction support — listed in §10 as open Q2.)
3. **Soft-trust opt-in (proposed but not adopted in v1)** — fragment field `trust: [{id: b, ifAvailable: true}]` lets A install before B, with B's binding picked up at the next reload after B exists. Cleaner for evolving deployments but weakens the registry's fail-fast invariant. **§10 Q7 captures this as an explicit future-iteration question.**

The strict contract is the right v1 default because it surfaces config errors at install time (operator-fixable) rather than at runtime (silent miss). Soft-trust can be added later without breaking strict-trust deployments.

**`AgentRegistry` rule 2** (self-trust silently allowed but filtered from `getTrustedPeers()`) and **rule 3** (registry is immutable per construction) both carry over unchanged for arc-installed bots.

---

## 10. Decisions and Open Questions

### 10.1 Decisions (locked — no further input needed)

| # | Decision | Source |
|---|----------|--------|
| D1 | **Drain-on-uninstall:** in-process bots no drain (cortex's dispatcher nak's on agent removal anyway); standalone bots emit `agents.{id}.draining` and wait for in-flight `dispatch.task.completed` with a 30s default timeout. Per-bot override via `lifecycle.drainTimeout` in the arc-manifest. | JC sign-off (Q4 — "no strong feelings", defaults proposed and accepted) |
| D2 | **NATS creds rotation cadence:** operator policy by default — `cortex creds rotate --all` on operator schedule. Per-bot opt-in via fragment field `runtime.credsRotation: 90d` (or other ISO 8601 duration). | Inferred from per-agent-keys decision (Q2) |
| D3 | **NATS server URL discovery:** creds file carries the URL by NATS convention. Bot daemon reads it from creds; no separate config field needed. | NATS standard, low-risk |
| D4 | **Dashboard rendering:** badge per `runtime.mode` (in-process / standalone) and per `runtime.substrate` (claude-code / codex / pi-dev / custom). | Q3 answer |
| D5 | **Persona format authority:** bot package is source of truth (Q1). Cortex documents the persona schema in `docs/persona-format.md` (separate forthcoming spec); bot authors test against that. Version-skew handled by cortex publishing schema with semver; bot package declares supported range. | Q1 sign-off |
| D6 | **Trust contract:** strict — `AgentRegistry` `UnknownAgentReferenceError` on unresolved trust at construction. Multi-bot install with cross-trust requires arc transaction (Q2). | Holly review feedback + alignment with `registry.ts` §9.3 |
| D7 | **Uninstall ordering:** revoke creds (server-side first, then local file) BEFORE removing fragment + persona + binary + plist. Arc aborts on revoke failure rather than continuing. | Holly review feedback (major #3) |
| D8 | **Signing model:** daemon-mediated (CLI is thin client; operator account key lives in cortex daemon memory; CLI talks via NATS or UNIX socket). | Holly review feedback (major #5) |

### 10.2 Open Questions (need decision before Phase A starts)

| # | Question | Bias |
|---|----------|------|
| Q1 | Should arc transactions be atomic across multiple agent installs? Needed for D6 trust-cycle bootstrap. | yes — arc's job |
| Q2 | Should fragment-side soft-trust (`trust: [{id: b, ifAvailable: true}]`) be added in a future iteration to relax D6? Or is strict-trust correct for the lifetime of the system? | defer — revisit after first 3 real bots ship |
| Q3 | macOS/launchd → Linux/systemd parity (§3.2 platform note) — when does the systemd path land? | after first Linux host enters deployment topology |
| Q4 | Should `cortex creds list` include `last-used` timestamp (requires NATS server-side audit log integration)? | yes if cheap; defer if it adds infra burden |
| Q5 | Should the fragment carry a `parent-package:` field naming the arc package that installed it, so `cortex agents` can show provenance? | yes — light, useful for debugging "where did this agent come from?" |

---

## 11. Migration Path

### Phase A — Plumbing (no bots installable yet)

- [ ] **A.1** Cortex `agents.d/` fragment support (§6.1) — `feat(common/config)` PR
- [ ] **A.2** `cortex creds issue/revoke/rotate` CLI (§6.3) — `feat(cli/cortex)` PR
- [ ] **A.3** Arc `type: agent` + `parent:` schema extension (§6.2) — arc-repo PR
- [ ] **A.4** Persona format spec doc — `docs/persona-format.md`

### Phase B — First bot package + lifecycle scripts

- [ ] **B.1** `claude-review-bot` repo with arc-manifest + persona + lifecycle scripts (in-process pattern)
- [ ] **B.2** `cortex agents reload` CLI command
- [ ] **B.3** Operator runbook: `docs/operator-installing-bots.md`

### Phase C — First standalone bot

- [ ] **C.1** `pi-dev-review-bot` repo — packages the pi.dev design's bus-bridge + review-agent as an arc package
- [ ] **C.2** Plist template + lifecycle scripts for standalone bots
- [ ] **C.3** Verify dashboard renders in-process vs standalone correctly

### Phase D — Operator polish

- [ ] **D.1** `arc agents` subcommand for grouped listing
- [ ] **D.2** Drain-on-uninstall semantics + timeout config
- [ ] **D.3** Creds rotation scheduler

---

## 12. Out of Scope (Explicitly Deferred)

- **Cross-host bot installs** — assumes all bots install on the same host as cortex. Distributed deployments (cortex on host X, bot on host Y, shared NATS leaf) deferred to a separate "federated agents" design.
- **Hot-swap substrate** — a bot can't switch from `claude-code` to `codex` without a reinstall. Acceptable for v1.
- **Live persona reload** — persona changes require either a `arc upgrade <bot>` or a manual `cortex agents reload`. Live persona watch is a future enhancement.
- **Permission/role-based install authority** — assumes operator has unilateral install authority. Multi-operator orgs with install policies deferred.
- **Mixed-mode (same agent identity on both in-process AND standalone substrates simultaneously)** — possible per pi.dev design §8.2, but install machinery treats each as a separate bot package (`claude-rev` + `codex-rev` ids). Re-using a single identity across substrates is allowed via fragment override but considered an operator-side advanced pattern; not a primary install flow.

---

## 13. References

- `docs/design-pi-dev-review-agent.md` — substrate decoupling that this builds on (committed in this same PR)
- `docs/architecture.md` §6 (bus contracts: subjects + envelope shape), §9 (agent + presence/renderer model), §9.2 (renderer interface), §9.3 (trust rules)
- `arc-manifest.yaml` (cortex root) — current arc manifest example
- `src/common/agents/registry.ts` — `AgentRegistry` rules §9.3 (trust must resolve at construction; `UnknownAgentReferenceError` thrown otherwise)
- `src/common/agents/trust-resolver.ts` — `TrustResolver` (platformId ↔ agentId)
- `src/common/config/loader.ts` + `watcher.ts` — config hot-reload surface (`agents.d/` support lands per §6.1)

---

*This document is the design specification for arc-installable sub-bots. Implementation follows the phased plan in §11. Review owners: Luna (architecture), Andreas (ecosystem fit + arc schema impact).*
