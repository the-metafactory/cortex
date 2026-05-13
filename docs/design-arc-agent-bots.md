# Arc-Installable Sub-Bots — Design Specification

**Status:** Draft — design for hosting + installing sub-bot agents (review, copy-edit, research, custom) under arc + cortex + meta-factory.
**Date:** 2026-05-11
**Driver:** Ivy (for Jens-Christian Fischer)
**Related docs:**
- `docs/design-pi-dev-review-agent.md` — substrate/presence decoupling that motivates this
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
  → signals cortex     → SIGHUP or `cortex agents reload`
                         (loader+watcher, extended per §6.1, pick up the fragment;
                          daemon registers foo BEFORE creds issue so it can scope
                          the credential to foo's runtime.capabilities)
  → mints NATS creds   → cortex creds issue foo
                         (cortex daemon mints with foo's capability scope,
                          writes ~/.config/nats/creds/foo.creds)
```

**No new process. No new launchd plist.** The watcher (`src/common/config/watcher.ts`) hot-reloads `cortex.yaml` today and is extended in §6.1 to also watch `~/.config/cortex/agents.d/`. Cortex's runner spawns CC for foo on the next dispatch matching foo's capability.

Use this shape for: simple persona-based agents on the cortex's Claude-Code substrate.

### 3.2 Standalone bot (substrate: codex | pi-dev | cursor | custom, mode: standalone)

Substrate-flexibility lives here. Codex / pi.dev / Cursor / custom-binary bots run as their own daemons, connect directly to the same NATS bus cortex is on, and self-register capabilities.

**Standalone bots install into multiple arc targets** (per arc#117's HostAdapter pattern): the `cortex` host receives the identity fragment + persona + NATS creds; the OS supervision host (`darwin-launchd` or `linux-systemd`) receives the daemon binary + service unit. Both targets land in a single `arc install` transaction.

```yaml
# foo-codex-review-bot/arc-manifest.yaml — standalone shape
targets: [cortex, darwin-launchd]   # arc#117 multi-target install
type: agent
runtime:
  substrate: codex
  mode: standalone
  capabilities: [code-review]
```

```
arc install foo-codex-review-bot
  → cortex target:
      drops persona.md   → ~/.config/cortex/personas/foo.md
      drops fragment     → ~/.config/cortex/agents.d/foo.yaml
      signals cortex     → SIGHUP or `cortex agents reload`
                            (daemon registers foo from agents.d/ before creds issue)
      mints NATS creds   → cortex creds issue foo
                            (now scoped to foo's runtime.capabilities)
                            → ~/.config/nats/creds/foo.creds (cortex daemon-signed)
  → darwin-launchd target:
      installs binary    → ~/bin/foo-bot   (symlink to package)
      installs plist     → ~/Library/LaunchAgents/ai.meta-factory.foo.plist
      launchctl load     → daemon starts LAST — connects bus with the creds,
                            publishes capability registration to NATS KV
```

**Daemon-down resilience:** if cortex is briefly unreachable when `arc install` runs the signal step, the install can fail fast OR proceed (arc-side flag). When cortex comes back, the watcher (§6.1) picks up `agents.d/` on next poll cycle. Standalone daemons retry their NATS connect with backoff. No bespoke retry logic needed in `installArtifact` — the eventual-consistency guarantee from the watcher + the NATS reconnect both already cover this. Implementers should NOT add their own retry loops here.

The bot daemon is wholly owned by the OS supervision target's lifecycle (its own pre/post install scripts within that HostAdapter). Cortex sees the agent only via:
1. The fragment file in `agents.d/` (identity + trust + presence)
2. The NATS capability registry (`local.{org}.agents.capabilities.foo`)
3. Envelopes published by the bot on the bus

Use this shape for: any non-Claude-Code substrate, anything that needs a separate process boundary (different model API, different security sandbox, different language runtime).

**Cursor-substrate note (cortex#70):** the Cursor CLI (`cursor-agent`) is a one-shot binary with no `--system-prompt` flag and no daemon mode. Cursor-substrate bots therefore stage the persona per dispatch by writing the persona content into `<workdir>/.cursor/rules/persona.mdc` before each `cursor-agent -p --force --output-format stream-json` invocation. The standalone daemon is the long-lived bus subscriber; each claimed envelope spawns a fresh `cursor-agent` process in a workdir whose lifecycle the daemon owns. Detailed treatment in `docs/design-cursor-substrate-bot.md`.

**Platform note (process supervision):** the sequence above shows the macOS path (`launchctl` + `~/Library/LaunchAgents/`). On Linux the equivalent is systemd user units (`systemctl --user` + `~/.config/systemd/user/`). The bot's `arc-manifest.yaml` declares OS-specific `provides` entries (`provides.plist` for darwin, `provides.systemd-unit` for linux), and arc renders + loads the appropriate one. The launchd shape is documented here as the operator's day-1 target since cortex's MIG-7 cutover ships only macOS plists; systemd ships in a follow-on milestone once a Linux host enters the deployment topology. The bus contracts and fragment files are platform-agnostic; only the daemon supervision layer differs.

### 3.3 Shape selection

| Question | In-process | Standalone |
|---|---|---|
| Substrate is Claude Code? | yes | no — Codex/pi.dev/Cursor/custom |
| Need separate process boundary? | no | yes |
| Need different security sandbox? | no | yes |
| Memory-cheap (per-bot)? | yes (~CC subprocess) | no (per-bot daemon + bus client) |
| Cortex restart on install? | no (hot-reload) | no (daemon self-starts) |

Default to in-process when substrate is `claude-code` and the bot doesn't need an isolated boundary. Otherwise standalone.

---

## 4. Bot Arc-Manifest Schema

Extends arc's existing manifest schema with an `agent` type. Cortex itself stays `type: component` (per the current `arc-manifest.yaml` at the cortex root). The install destination is declared via arc#117's `targets:` field — cortex registers as a `HostAdapter` (see §14 for the relationship to arc#117's multi-backend work).

```yaml
# foo-review-bot/arc-manifest.yaml
name: foo-review-bot
version: 0.1.0
type: agent                       # NEW — arc artifact type for bus-participating agents
targets: [cortex]                 # arc#117 — bot installs into cortex's HostAdapter
description: Code review bot for TypeScript repos

runtime:
  substrate: claude-code          # claude-code | codex | pi-dev | cursor | custom-binary
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
    - scripts/check-cortex-version.sh    # CortexHostAdapter.detect() + version range check
  postinstall:
    - scripts/signal-cortex-reload.sh    # FIRST — daemon learns about agent from agents.d/
    - scripts/issue-nats-creds.sh        # THEN — mints per-agent NATS user (Q2; daemon scopes creds to capabilities)
  preuninstall:
    - scripts/drain-tasks.sh             # D1 (was Q4) — stop accepting, wait, then remove
    - scripts/signal-cortex-reload.sh    # cortex drops the agent from registry (creds revoked in removeArtifact per D7)
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

### 6.2 Arc — ship a `CortexHostAdapter` (per arc#117)

**Scope:** new `CortexHostAdapter` implementing arc#117's `HostAdapter` interface. Lands alongside the `ClaudeCodeHostAdapter`, `CodexHostAdapter`, `CursorHostAdapter`, etc. that arc#117 introduces.

This supersedes the earlier draft's "extend arc with `type: agent` + `parent:` schema" proposal — cortex doesn't need a parent-dependency mechanism specific to itself. Arc#117's `targets:` field + HostAdapter detection covers the same surface: a bot declares `targets: [cortex]`, arc detects whether cortex is installed (via its `CortexHostAdapter.detect()`), and refuses the install if the target isn't available.

```ts
// arc/src/hosts/cortex.ts (proposed)
export class CortexHostAdapter implements HostAdapter {
  id = "cortex" as const;

  detect(): boolean {
    // cortex daemon reachable via NATS request/reply on local.{org}.cortex.health
    // OR cortex binary on PATH + cortex.yaml at expected location
  }

  paths: HostPaths & CortexPaths = {
    skillsDir:    "",                                  // n/a — cortex isn't a skills host
    agentsDir:    "~/.config/cortex/agents.d/",        // arc#117 HostPaths field — identity fragments
    binDir:       "~/bin/",                            // arc#117 HostPaths field — standalone bot binaries
    settingsPath: "~/.config/cortex/cortex.yaml",      // arc#117 HostPaths field — operator-edited core config
    hooksFormat:  "none",                              // arc#117 HostPaths field — no claude-code-style hooks
    // Cortex-internal extensions (not in arc#117 HostPaths today):
    personasDir:  "~/.config/cortex/personas/",        // persona markdown files
    credsDir:     "~/.config/nats/creds/",             // per-agent NATS creds (daemon-written)
  };

  supports(type: ArtifactType): boolean {
    return type === "agent";                           // cortex hosts agents; skills go elsewhere
  }

  installArtifact(pkg, type): void {
    // ORDER MATTERS — fragment must be visible to daemon BEFORE creds issue
    // (daemon scopes the credential to the agent's capabilities, which it
    // reads from the fragment).
    // 1. Drop persona.md into paths.personasDir
    // 2. Render + drop agent.yaml fragment into paths.agentsDir
    // 3. Signal cortex via SIGHUP or `cortex agents reload`
    //      → daemon re-reads agents.d/ and adds the new agent to registry
    // 4. Invoke `cortex creds issue <agent-id>` (daemon-mediated; see §6.3)
    //      → daemon now knows about the agent, scopes creds to its capabilities
  }

  removeArtifact(pkg): void {
    // Reverse order per §8.3 — revoke creds BEFORE removing files
    // 1. Drain (per D1) if standalone — emit agents.{id}.draining, wait
    // 2. cortex creds revoke <agent-id>   (server-side first, then local file)
    //      → abort uninstall on revoke failure (D7)
    // 3. Remove fragment + persona
    // 4. Signal cortex reload (registry rebuilt without the agent)
  }
}
```

**Note on `HostPaths` extension:** arc#117's current `HostPaths` interface (per the issue body) defines `skillsDir`, `agentsDir`, `promptsDir`, `binDir`, `settingsPath`, `hooksFormat`. Cortex's adapter introduces two additional fields (`personasDir`, `credsDir`) shown above as a `HostPaths & CortexPaths` intersection — these are cortex-internal extensions, not modifications to arc#117's interface. Two arc-side paths forward:
1. **Cortex-internal (preferred for v1):** `personasDir` and `credsDir` live only on `CortexHostAdapter.paths`. Arc#117's generic `arc list --target cortex` doesn't know about them; cortex's own diagnostics do.
2. **Promote to `HostPaths` (deferrable):** if another future host adapter wants the same paths (unlikely — personas are cortex-specific; creds are NATS-specific), propose `HostPaths` extension on arc#117.

Either way, no contract break on arc#117. Carry-forward to §14 intersection points.

**Multi-target install ordering** (per arc#117 §3): a standalone bot with `targets: [cortex, darwin-launchd]` MUST install to `cortex` FIRST (fragment + creds — daemon needs to know about the agent before it shows up on the bus) then `darwin-launchd` (binary + plist + load). Uninstall reverses (unload daemon first, then revoke creds + remove fragment). **How arc#117 expresses this ordering is an open coordination item** — proposed shape: cortex declares `installOrder: "before"` for the `agent` artifact type on its `CortexHostAdapter`. Whether arc#117 adopts that field name or a different mechanism is tracked in §14 open intersection points; the invariant (cortex-target-first, reverse on uninstall) is non-negotiable regardless of how it's spelled in the adapter API.

**`arc list --target cortex`** (per arc#117 §3 CLI) lists all installed cortex agents — replaces the earlier draft's proposed cortex-specific `arc agents` subcommand. Reuses arc's generic per-target listing.

Estimated ~250 LOC (`CortexHostAdapter` + tests) + ~50 LOC in cortex (the `cortex agents reload` CLI subcommand for adapter postinstall to call). Lands as two PRs: arc-side `feat(hosts): CortexHostAdapter` and cortex-side `feat(cli/cortex): agents reload command`.

**Phasing note:** this depends on arc#117 Phase 1 (the `PaiPaths` → `ArcPaths` + `HostAdapter` legacy cut) being merged. arc#117 sits at "future" priority today; cortex#58's Phase A.3 (`CortexHostAdapter` itself) unblocks once arc#117 Phase 1 lands. Phase A.1 (cortex `agents.d/`) and Phase A.2 (cortex `cortex creds` CLI) are independent of arc#117 and can land first.

### 6.3 Cortex — `cortex creds *` CLI (arc-delegated; cortex#79)

**Scope:** `src/cli/cortex/commands/creds.ts` (thin shell-out client). No cortex-side daemon RPC, no signing-key handling in cortex. arc owns nsc and the operator's `$SYS` account.

**Signing model — arc-delegated (locked, cortex#79):**

The CLI shells out to `arc nats … --json` (schema `arc.nats.v1`, contract pinned at [`the-metafactory/arc:docs/integrations/cortex-creds.md`](https://github.com/the-metafactory/arc/blob/main/docs/integrations/cortex-creds.md)). cortex never touches the operator account signing key — it only invokes the arc CLI, parses the JSON envelope, and surfaces the result to the operator. Supersedes the cortex#67 daemon-IPC design (which loaded the signing key into cortex daemon memory).

This matters because (a) arc already owns nsc and the `$SYS` account boundary, so two places-of-truth was an unnecessary divergence; (b) cortex stops needing to track NATS protocol changes — arc's stable `--json` contract is the only API; (c) the cortex daemon is one moving piece smaller. The operator-signature verifier in `TrustResolver` (cortex#76) keeps using `loadAccountSigningKey` independently for inbound envelope signature checks — that's a *consumer* of the public side of the key, not a signing surface.

**Verb mapping (cortex → arc):**

| cortex verb | arc invocation |
|---|---|
| `cortex creds issue <id>` | `arc nats add-bot <id> [--account <name>] --json` |
| `cortex creds rotate <id>` | `arc nats reissue-bot <id> [--account <name>] --json` |
| `cortex creds revoke <id>` | `arc nats remove-bot <id> [--account <name>] --delete-creds --json` |
| `cortex creds list` | local filesystem scan of `~/.config/nats/creds/` (no arc call) |

**Surface:**

- `cortex creds issue <agent-id>` mints a NATS user via `arc nats add-bot`. arc writes the `.creds` file to `~/.config/nats/<agent-id>.creds` (mode 600) and returns the path, JWT body, and durable U-prefixed pubkey. cortex surfaces the path + pubkey to the operator. Per-agent user — each agent gets its own NATS identity, separate keypair, separate creds file. Revocation is per-agent.
- `cortex creds revoke <agent-id>` shells out to `arc nats remove-bot … --delete-creds`. arc revokes the user JWT server-side (adds the pubkey to the account revocation map and pushes), then deletes the local file. cortex surfaces the revoked pubkey + `credsFileDeleted` outcome. `USER_NOT_FOUND` is treated as idempotent (exit 0) — the agent is already gone server-side. `PUSH_FAILED` is surfaced with a loud WARNING: the old creds remain valid on the bus until the operator retries.
- `cortex creds rotate <agent-id>` shells out to `arc nats reissue-bot`. arc atomically revokes the old pubkey, mints a new keypair, writes a new creds file, returns both `newPubKey` (the post-rotation identifier the bot should bind to) and `revokedPubKey` (the now-dead identifier).
- `cortex creds list` enumerates local `.creds` files under `~/.config/nats/creds/` (default; override with `--creds-dir`). No arc call; filesystem-only. Filenames whose stem fails `/^[a-z0-9-]+$/` are skipped with a warning; symlinks are skipped (lstatSync).
- `cortex.yaml` `nats.accountSigningKeyPath` survives the cortex#79 cut for `TrustResolver`'s operator-signature verifier (cortex#76). It is no longer required for `cortex creds *` — arc owns the nsc-side signing key, not cortex.
- Lifecycle integration: `arc install <bot>`'s `issue-nats-creds.sh` invokes `cortex creds issue <bot.identity.id>`. cortex shells out to `arc nats add-bot`; the script fails (and arc rolls back the install) if (a) arc binary missing on PATH; (b) `arc.nats.v1` envelope returns `ok:false` with any code other than the revoke-only-idempotent `USER_NOT_FOUND`; (c) the agent fragment isn't yet visible to the cortex registry. The chicken-and-egg sequencing — drop fragment → signal reload → issue creds — is unchanged.
- Required arc version: `>= 0.25.0` (the release that ships the stable `arc.nats.v1` contract per arc#134). Pinned in cortex's `arc-manifest.yaml` under `dependencies`.

**Error-code taxonomy** (closed set, surfaced to operator via `code` + `message`): `NSC_NOT_INSTALLED`, `USER_NOT_FOUND`, `ACCOUNT_NOT_FOUND`, `ALREADY_EXISTS`, `PUSH_FAILED`, `REVOKE_FAILED`, `VALIDATION_ERROR`, `INVALID_USER_KEY`, `ROLLBACK_FAILED`, `UNKNOWN`. Definitions live in arc's `docs/integrations/cortex-creds.md` — this is arc's authoritative contract, not cortex's.

---

## 7. Worked Examples

### 7.1 In-process review bot

```yaml
# claude-review-bot/arc-manifest.yaml
name: claude-review-bot
version: 0.1.0
type: agent
targets: [cortex]                  # arc#117 single-target install
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
    - scripts/signal-cortex-reload.sh    # FIRST — daemon registers rev
    - scripts/issue-nats-creds.sh        # THEN — daemon scopes creds to rev's capabilities
```

`arc install claude-review-bot` → 4 files dropped, cortex hot-reloads, rev appears in dashboard as `rev (in-process / claude-code)`. First `tasks.code-review.*` task on the bus is claimed by rev's CC subprocess. No restart, no manual config edits.

### 7.2 Standalone Codex review bot

```yaml
# codex-review-bot/arc-manifest.yaml
name: codex-review-bot
version: 0.1.0
type: agent
targets: [cortex, darwin-launchd]  # arc#117 multi-target install
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
    - scripts/signal-cortex-reload.sh    # 1. daemon registers codex-rev
    - scripts/issue-nats-creds.sh        # 2. daemon scopes creds (capabilities visible now)
    - scripts/launchctl-load.sh          # 3. daemon starts last — needs creds + registry
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
arc:      preinstall: scripts/check-cortex-version.sh        [verify cortex target compat via CortexHostAdapter.detect()]
arc:      drop persona.md   → ~/.config/cortex/personas/foo.md
arc:      drop agent.yaml   → ~/.config/cortex/agents.d/foo.yaml
arc:      postinstall: scripts/signal-cortex-reload.sh        [signal BEFORE creds]
            → SIGHUP cortex bot pid (or `cortex agents reload`)
            → config-watcher.ts re-reads agents.d/
            → agents[] now includes foo
            → AgentRegistry rebuilt — daemon now knows foo + its capabilities
arc:      postinstall: scripts/issue-nats-creds.sh
            → cortex creds issue foo
            → daemon scopes the cred to foo's runtime.capabilities (which it
              just loaded from the fragment)
            → ~/.config/nats/creds/foo.creds written
operator: foo appears in dashboard, can take tasks
```

### 8.2 Install (standalone)

```
operator: arc install codex-review-bot
arc:      preinstall: scripts/check-cortex-version.sh         [via CortexHostAdapter.detect()]
arc:      drop persona, agent.yaml, binary (~/bin/codex-rev-bot)
arc:      drop plist → ~/Library/LaunchAgents/ai.meta-factory.codex-rev.plist
arc:      postinstall: scripts/signal-cortex-reload.sh        [signal FIRST so daemon learns about agent]
            → cortex re-reads agents.d/, registers codex-rev
arc:      postinstall: scripts/issue-nats-creds.sh            [now daemon can scope creds]
            → cortex creds issue codex-rev
            → ~/.config/nats/creds/codex-rev.creds written
arc:      postinstall: scripts/launchctl-load.sh              [start daemon LAST — needs creds + registry]
            → daemon starts
            → connects NATS with codex-rev.creds
            → publishes capabilities to local.{org}.agents.capabilities.codex-rev
operator: codex-rev appears in dashboard alongside cortex-hosted agents
```

**Ordering invariant across both shapes (matches §6.2 `installArtifact` and §6.3 chicken-and-egg sequencing):** drop fragment → signal reload → issue creds → (standalone only) start daemon. The daemon needs the fragment loaded before it can scope the credential; the daemon (standalone shape) needs the credential before it can connect.

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
| D8 | **Signing model:** arc-delegated (cortex#79). cortex shells out to `arc nats … --json`; arc owns nsc and the operator's $SYS account. Supersedes the cortex#67 daemon-mediated design — the operator signing key is no longer loaded into cortex memory for credential minting. The operator-signature verifier in `TrustResolver` (cortex#76) still loads the *public* side of the key independently for inbound envelope checks. | Holly review feedback (major #5); cortex#79 supersedes the cortex#67 daemon-IPC implementation |
| D9 | **Arc integration shape:** cortex registers as a `HostAdapter` per arc#117's multi-backend pattern; bots declare `targets: [cortex]` (multi-target for standalone shape: `targets: [cortex, darwin-launchd]`). Supersedes the earlier draft's `type: agent` + `parent: cortex` schema extension proposal. | arc#117 alignment |

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

- [ ] **A.1** Cortex `agents.d/` fragment support (§6.1) — `feat(common/config)` PR. Independent of arc#117.
- [ ] **A.2** `cortex creds issue/revoke/rotate` CLI (§6.3) — `feat(cli/cortex)` PR. Independent of arc#117.
- [ ] **A.3** `CortexHostAdapter` in arc (§6.2) — arc-repo `feat(hosts): CortexHostAdapter` PR. **Blocked on arc#117 Phase 1** (the `PaiPaths` → `ArcPaths` + `HostAdapter` legacy cut). Lands after arc#117 Phase 1 merges.
- [ ] **A.4** `cortex agents reload` CLI subcommand — `feat(cli/cortex)` PR. Called by `CortexHostAdapter.installArtifact` postinstall step + by SIGHUP signal handler.
- [ ] **A.5** Persona format spec doc — `docs/persona-format.md`

### Phase B — First bot package + lifecycle scripts

- [ ] **B.1** `claude-review-bot` repo with arc-manifest (`targets: [cortex]`) + persona + lifecycle scripts (in-process pattern)
- [ ] **B.2** Operator runbook: `docs/operator-installing-bots.md`

### Phase C — First standalone bot

- [ ] **C.1** `pi-dev-review-bot` repo — packages the pi.dev design's bus-bridge + review-agent as an arc package with `targets: [cortex, darwin-launchd]`
- [ ] **C.2** Verify dashboard renders in-process vs standalone correctly
- [ ] **C.3** `linux-systemd` HostAdapter in arc (once first Linux host enters deployment topology — arc#117 Phase 3 timing)

### Phase D — Operator polish

- [ ] **D.1** Drain-on-uninstall semantics + timeout config (D1)
- [ ] **D.2** Creds rotation scheduler (D2)

---

## 12. Out of Scope (Explicitly Deferred)

- **Cross-host bot installs** — assumes all bots install on the same host as cortex. Distributed deployments (cortex on host X, bot on host Y, shared NATS leaf) deferred to a separate "federated agents" design.
- **Hot-swap substrate** — a bot can't switch from `claude-code` to `codex` without a reinstall. Acceptable for v1.
- **Live persona reload** — persona changes require either a `arc upgrade <bot>` or a manual `cortex agents reload`. Live persona watch is a future enhancement.
- **Permission/role-based install authority** — assumes operator has unilateral install authority. Multi-operator orgs with install policies deferred.
- **Mixed-mode (same agent identity on both in-process AND standalone substrates simultaneously)** — possible per pi.dev design §8.2, but install machinery treats each as a separate bot package (`claude-rev` + `codex-rev` ids). Re-using a single identity across substrates is allowed via fragment override but considered an operator-side advanced pattern; not a primary install flow.

---

## 13. References

- `docs/design-pi-dev-review-agent.md` — substrate decoupling that this builds on
- `docs/architecture.md` §6 (bus contracts: subjects + envelope shape), §9 (agent + presence/renderer model), §9.2 (renderer interface), §9.3 (trust rules)
- `arc-manifest.yaml` (cortex root) — current arc manifest example
- `the-metafactory/arc#117` — multi-backend `HostAdapter` + `targets:` field. cortex registers as a host via this pattern (see §14).
- `src/common/agents/registry.ts` — `AgentRegistry` rules §9.3 (trust must resolve at construction; `UnknownAgentReferenceError` thrown otherwise)
- `src/common/agents/trust-resolver.ts` — `TrustResolver` (platformId ↔ agentId)
- `src/common/config/loader.ts` + `watcher.ts` — config hot-reload surface (`agents.d/` support lands per §6.1)

---

## 14. Relationship to arc#117 (multi-backend `HostAdapter`)

[arc#117](https://github.com/the-metafactory/arc/issues/117) reshapes arc from `~/.claude/`-pinned to a multi-backend tool that installs into Claude Code, Codex CLI, Cursor, Continue, Zed, Roo Code, and other agentic backends via a `HostAdapter` abstraction. Each adapter declares per-host paths (`skillsDir`, `agentsDir`, `binDir`, `settingsPath`, `hooksFormat`) and an `installArtifact()` / `removeArtifact()` lifecycle. Manifests gain an optional `targets:` field that pins an artifact to specific hosts; default is "every detected host that supports the artifact type."

**Cortex's place in arc#117's model:** cortex is a host. Not a *peer* of Claude Code / Codex / Cursor (those are claude-code-style hosts where users write `*.md` skills); cortex is a runtime host for bus-participating agents. It registers via a `CortexHostAdapter` whose `supports(type)` returns true only for `type: agent`. Skills, slash-commands, and rules go elsewhere; bots go to cortex.

**How the two designs compose:**

1. **arc#117 invents the abstraction.** Before arc#117, arc had no concept of "install into multiple distinct backends with different paths." `PaiPaths` was a single global path table. arc#117 unifies this around `HostAdapter`.

2. **cortex#58 plugs into the abstraction.** Instead of cortex#58 inventing cortex-specific arc schema (`type: agent` + `parent: cortex` as proposed in the v1 draft of this doc), cortex ships a `CortexHostAdapter` that fits arc#117's interface. `targets: [cortex]` replaces `parent: cortex`. Multi-target installs (`targets: [cortex, darwin-launchd]`) cleanly express the standalone shape's split-install.

3. **Independence of decisions.** D1–D8 are unaffected — the substrate/presence decoupling, persona ownership, per-agent NATS keys, daemon-mediated signing, strict trust, revoke-before-remove, all hold regardless of arc#117's interface. arc#117 changes HOW arc routes the install to cortex (HostAdapter dispatch vs hard-coded paths); D1–D8 describe WHAT happens once it lands.

4. **Sequencing.** Cortex#58 Phase A.1 (`agents.d/` support) and A.2 (`cortex creds issue` CLI) are independent of arc#117 — they land in cortex first and can be exercised manually (without arc) for testing. Phase A.3 (`CortexHostAdapter`) is blocked on arc#117 Phase 1 (the `PaiPaths` → `ArcPaths` + first `HostAdapter` legacy cut) merging. Until then, operators run a thin shell wrapper (`cortex install-bot <path>`) that does what `arc install` will eventually do.

**Open intersection points (carry-forward for arc#117 review):**

- **`hooksFormat: "none"` for cortex** — arc#117's `HostPaths` includes a `hooksFormat` field (`"json"` for claude-code, `"toml"` for codex). Cortex doesn't have settings hooks in the claude-code sense. Declaring `"none"` is the natural fit but the precise semantics ("attempts to install hooks into cortex error out cleanly") should be confirmed with arc#117's spec.
- **Multi-target install order** — arc#117 §3 sketches `targets:` but doesn't yet specify install-order semantics across targets in a single transaction. cortex#58 §6.2 names a need (cortex target FIRST, then OS-supervision target) — coordinate with arc#117 to ensure the HostAdapter scheduler exposes this.
- **Detect impl for `CortexHostAdapter.detect()`** — preferred path: NATS request/reply on `local.{org}.cortex.health` (returns daemon version). Fallback: cortex binary on PATH + valid `cortex.yaml`. Both are testable.

---

*This document is the design specification for arc-installable sub-bots. Implementation follows the phased plan in §11. Review owners: Holly (cortex#58 + cortex#60 reviewer), Andreas (ecosystem fit + arc schema impact). This follow-up updates the design against [arc#117](https://github.com/the-metafactory/arc/issues/117) — multi-backend `HostAdapter` pattern.*
