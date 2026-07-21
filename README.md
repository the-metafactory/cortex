<!--
  cortex
-->

<!-- hero: pending art — replace this comment with the illustration when it lands:
<p align="center">
  <img src="docs/diagrams/cortex-hero.jpg" alt="cortex, the collaboration surface" width="320" />
</p>
-->

<h1 align="center">cortex</h1>

<p align="center">
  <strong>The foundation for an internet of agentic work — starting with your own stack.</strong>
</p>

<p align="center">
  Humans and assistants working together as one team: your surfaces, your machines, one supervised bus.<br />
  Built on the <a href="https://github.com/the-metafactory/myelin">myelin</a> protocol stack below; an assistant is a thin persona on top — cortex is everything in between.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-6.10.3-2A3F6A?labelColor=0E1726" />
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-2A3F6A?labelColor=0E1726" />
  <img alt="macOS" src="https://img.shields.io/badge/macOS-supported-2A3F6A?labelColor=0E1726&logo=apple&logoColor=white" />
  <img alt="Linux" src="https://img.shields.io/badge/Linux-supported-2A3F6A?labelColor=0E1726&logo=linux&logoColor=white" />
  <img alt="Container" src="https://img.shields.io/badge/container-supported-2A3F6A?labelColor=0E1726&logo=docker&logoColor=white" />
</p>

<p align="center">
  cortex is <a href="https://meta-factory.ai">Meta Factory</a>'s second Arc-distributed package.<br />
  Join the Meta Factory community on <a href="https://discord.gg/32xa5ev6Tq">Discord</a>.
</p>

---

## Why this project?

A coding agent in a terminal is a solo instrument. The moment your assistant
does real work — fixing tests, reviewing PRs, running long tasks — you want to
reach it from wherever you are, see what it is doing without scrolling a
terminal, and let more than one agent share the load. Chat platforms give you
reach but no structure; dashboards give you visibility but no dispatch; and
none of it composes across machines.

cortex closes that gap by putting a **message bus between you and your
agents**. You (the **principal** — the human who owns the deployment) run a
**stack**: a cortex deployment with its own config, signing identity, and bus
namespace. A stack hosts **assistants** — named beings like Luna, Echo, or Ivy
with a persona and a chat identity. All communication is **envelopes on a NATS
message bus**: a Discord mention becomes a signed dispatch envelope, an
assistant's runtime picks it up, executes it on a substrate (usually a Claude
Code session), and emits lifecycle events that the chat adapter and the
dashboard both render. Because the bus — not the chat platform — is the medium,
the same work can be dispatched from chat, from the dashboard, from a GitHub
webhook, or from another agent entirely.

What that buys you in practice:

- **Chat-dispatch work.** Mention an assistant in a Discord channel — "fix the
  failing test in #cortex", "review PR 54" — and cortex spawns a Claude Code
  session, streams its progress back to the thread, and posts the result.
  Prefix with `async:` for fire-and-forget tasks or `team:` to spawn a
  multi-agent team.
- **Watch everything on Mission Control.** A web dashboard shows every running
  session, task queue, attention items needing your input, and GitHub activity
  (issues, PRs, checks) — so chat doesn't have to choose between "flood the
  channel with tool calls" and "go silent for ten minutes".
- **Route code reviews over the bus.** Publish a review request; any agent
  declaring the `code-review` capability claims it, runs the review, and posts
  the verdict — no point-to-point wiring between requester and reviewer.
- **Instrument your own terminal sessions.** Set one environment variable and
  your local Claude Code session's events appear live on the dashboard.

Work reaches an assistant in one of three **dispatch modes**:

| Mode | How the recipient is chosen |
|---|---|
| **Direct** | You name the assistant (`@echo`); it does the task, one shot. |
| **Offer** | You publish to a capability (`code-review.typescript`); exactly one capable assistant claims it. |
| **Delegate** | You name an assistant that orchestrates a multi-step outcome via a multi-agent team. |

---

## In the wild

The same engine already wears three different faces:

- **cortex builds cortex.** This release was diagnosed, fixed, reviewed, and
  shipped by humans and assistants working together *through* cortex —
  dispatched over its own bus, with community testers in the loop.
- **A web agent in production.** A production web application serves its
  assistant through cortex's Web/SSE adapter — same engine, no chat platform
  involved.
- **A community onboarding engine.** Metafactory Quests runs its onboarding
  assistants on cortex.

An assistant is a thin layer — a persona and a binding. The bus, identity,
dispatch, supervision, guardrails, and surfaces underneath are cortex, which is
why one engine can field a Discord colleague, a web agent, and a community
guide at the same time.

---

## Features at a glance

| Area | What ships |
|---|---|
| **Dispatch** | Mention an assistant → a signed dispatch envelope → a real working session on your machine, streamed back to the thread. `async:` fire-and-forget and `team:` multi-agent modes. |
| **Surfaces** | Discord out of the box; extensible plug-and-play adapters — Web/SSE, Slack, Mattermost — ship as arc-installed bundles that snap onto the same engine. |
| **The bus** | NATS-backed myelin envelopes (M2–M6 contracts): every message signed, addressed, and observable. |
| **Guardrails** | Built in, not bolted on: a policy engine (principals, roles, verified signing chains), inbound prompt scanning, a principal-only gate, and capability declarations enforced at dispatch. |
| **Supervision** | Mission Control dashboard — live sessions, task queues, attention items, GitHub activity — plus a healthy-boot gate that tells the truth (macOS, Linux, container). |
| **Capability routing** | Agents claim work by declared capability (e.g. `code-review.*`) over the bus — no point-to-point wiring. |
| **Agents** | An agent registry (inline + drop-in fragments), personas as thin config, multi-agent teams. |
| **Distribution** | Deterministic, apt-style: [arc](https://github.com/the-metafactory/arc) installs pinned, signed packages with declared capabilities from a trust-based marketplace — an install is a decision you can audit, not a `curl \| bash`. |
| **Operations** | One-command `cortex quickstart`, recovery that actually restarts on re-run, systemd / launchd / compose supervision, arc-native install + upgrade cascade. |
| **Observability** | Instrument your own terminal sessions with one env var — events appear live on the dashboard. |

---

## The shape

```text
  principal (you)
      |
      |  @mention · dashboard · webhook
      v
+---------------------+
|      surfaces       |   Discord adapter · web adapter · Mission Control
+----------+----------+
           |  signed envelopes
           v
+---------------------+
|        bus          |   NATS + the myelin protocol layers (M2–M6)
+----------+----------+
           |  dispatch · lifecycle events
           v
+---------------------+
|   agents / daemon   |   assistant runtimes -> Claude Code sessions
+---------------------+
```

cortex is the top layer (M7) of the **Myelin layer model** — an OSI-style stack
where the protocol layers below are owned by the sibling
[myelin](https://github.com/the-metafactory/myelin) project:

```text
M7  SURFACES      cortex (this repo) · pilot · signal · future apps
M6  COMPOSITION   myelin — interaction patterns
M5  DISCOVERY     myelin — capability registry
M4  IDENTITY      myelin — verifiable sender per envelope
M3  ENVELOPE      myelin — message format + sovereignty metadata
M2  TRANSPORT     myelin — abstract bus (NATS underneath)
M1  CONNECTIVITY  TCP/TLS · cross-stack topology (NATS leaf nodes)
```

cortex consumes the contracts of M2–M6 and owns none of them. That separation
is what lets several M7 applications (cortex for collaboration, signal for
telemetry, pilot for review loops) share one bus without sharing code.

cortex deliberately does not own:

- **the model provider** — execution runs on a substrate (a
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session by
  default); the model relationship and credentials stay yours
- **the package manager** — installation and upgrades belong to
  [arc](https://github.com/the-metafactory/arc)
- **the assistant's memory and identity home** — that is
  [soma](https://github.com/the-metafactory/soma)'s job; cortex hosts the
  runtime, not the durable self
- **the chat UI** — Discord (and the other platforms) keep their own clients;
  cortex only joins them as an adapter
- **the protocol layers** — envelope, identity, discovery, and transport
  contracts are [myelin](https://github.com/the-metafactory/myelin)'s

### Why the myelin foundation matters

Because cortex speaks myelin all the way down, the local stack you run today
already has the properties an internet of agentic work requires:

- **Signed envelopes.** Every message on the bus carries a verifiable signing
  chain — work is attributable to the identity that dispatched it, and the
  policy engine rejects what it cannot verify. An assistant's action is never
  anonymous.
- **Zones of trust.** Two zones exist today: your **local stack** (its own
  namespace, identities, and policy — principals, roles, capability
  permissions) and the **federated network** (stacks that explicitly join one
  another). Crossing the boundary is always an explicit decision — admission on
  the way in, sovereignty checks on the way out — never a default.
- **Encrypted envelopes.** Traffic that crosses a network boundary is encrypted
  with per-network keys — joining a network never means broadcasting to the
  world. (Mechanism shipped; hardening in the open during the preview.)
- **Sovereignty.** The whole stack runs in your tenancy — your machines, your
  keys, your bus. No third party sits in the message path.

**This first release is the local stack — and the local stack is the on-ramp.**
Federation (connecting stacks into shared networks) is experimental and
unreleased, but every property above exists to enable it: when stacks connect,
trust extends explicitly — signed, encrypted, zone by zone — never implicitly.
Standing up a local stack today is standing up your own sovereign node of that
future network.

The full picture — event architecture, visibility tiers, the agent/assistant
model, internal componentisation — lives in
[`docs/architecture.md`](docs/architecture.md). The precise domain vocabulary
(what exactly a *stack*, *capability*, or *dispatch sink* is) lives in
[`CONTEXT.md`](CONTEXT.md).

---

## See it work (~10 minutes)

The fastest way to understand cortex is to stand up one stack with one
assistant and @mention it. Three host paths below — macOS, Debian, container —
all driven by the same `CTX_*` env contract and the same idempotent
`cortex quickstart` command.

### Prerequisites (all hosts)

**Arc.** cortex is distributed as an Arc package. If you do not have `arc`
yet, install the Arc CLI first:

https://meta-factory.ai/download

If your Arc setup requires authentication, run `arc login` before installing
cortex.

**A Discord bot** (one-time, manual — the Developer Portal has no API for it).
Create an application + bot, enable the **Message Content intent**, invite it
to your server, and copy the bot token. Full walkthrough:
[`README-AGENTS.md`](README-AGENTS.md) Appendix A / §3.

**Native hosts additionally need:** [Bun](https://bun.sh), a
[NATS server](https://nats.io) binary on PATH, and a Claude Code install
logged in to Anthropic (the default execution substrate). The container path
bundles all of these in the image.

**The env contract.** Every path is driven by the same small set of `CTX_*`
variables — your principal id, a stack slug, bus ports, and the Discord ids
(placeholders only; never commit real values):

```bash
# cortex.env — fill in your own values
CTX_PRINCIPAL=ada-lovelace          # your principal id
CTX_SLUG=mystack                    # this stack's slug
CTX_NATS_PORT=4222
CTX_NATS_MON=8222
CTX_GUILD_ID=<REPLACE_ME>           # Discord snowflakes: right-click → Copy ID
CTX_CHANNEL_ID=<REPLACE_ME>
CTX_LOG_CHANNEL_ID=<REPLACE_ME>
CTX_MY_DISCORD_ID=<REPLACE_ME>
CTX_DISCORD_TOKEN=<REPLACE_ME>      # bot token — keep out of git
```

### macOS

```bash
# 1. Install with arc (by git URL; use the latest release tag).
#    The surface plugins (Discord adapter and friends) install
#    automatically via the manifest's depends_on.
arc install https://github.com/the-metafactory/cortex --pin v6.10.3

# 2. Provision the stack from the env contract (idempotent; re-run freely)
set -a; . ./cortex.env; set +a
cortex quickstart

# 3. Load the launchd agents for the newly scaffolded stack
#    (service management on macOS is arc's job, not quickstart's)
arc upgrade cortex

# 4. Green light: re-run quickstart and watch step 8
cortex quickstart
```

**Green light:** quickstart's step 8 — the healthy-boot gate — prints its
✓ table (daemon log lines + NATS `/healthz`). Then @mention your assistant in
the bound channel and watch it answer.

### Debian

Same contract, one command — quickstart enables the systemd user units itself
(step 7) and then runs the gate in the same pass:

```bash
arc install https://github.com/the-metafactory/cortex --pin v6.10.3

set -a; . ./cortex.env; set +a
cortex quickstart
```

**Green light:** step 8's healthy-boot gate passes in the same run —
`systemctl --user status nats@$CTX_SLUG cortex@$CTX_SLUG` shows both active,
and your assistant answers an @mention.

### Container

`docker compose up -d` = a running assistant. Everything lives in
[`deploy/compose/`](deploy/compose/):

```bash
cd deploy/compose
cp .env.example .env        # fill in every <REPLACE_ME> + the two secrets
docker compose up -d
```

The container is headless, so `.env` also needs `CLAUDE_CODE_OAUTH_TOKEN` —
generate it on a machine already logged into Claude Code with
`claude setup-token`.

**Green light:** `docker compose ps` shows the `cortex` service **healthy**.
The healthcheck watches the daemon's actual bus connection (not just a
liveness ping), so healthy means the assistant is really on the bus. Verify
end-to-end with `docker compose logs cortex | grep -E "Stack:|connected"` and
an @mention.

**Reset:** `docker compose down -v` wipes the named volumes (stack identity,
seeds, sessions) for a from-scratch re-provision; plain `down`/`restart`
preserves them. Details: [`deploy/compose/README.md`](deploy/compose/README.md).

### A small glossary

| Term | Meaning |
|---|---|
| **Principal** | The human who owns and runs stacks; root of trust and policy. |
| **Stack** | One cortex deployment under a principal — own config, signing key, bus namespace. |
| **Assistant** | The named being (Luna, Echo, Ivy…) with a persona; what you `@mention`. |
| **Agent** | The long-lived runtime that hosts an assistant on the bus. |
| **Capability** | A bus-routable ability an assistant declares (`chat`, `code-review.typescript`). |
| **Envelope** | The signed wrapper every bus message travels in. |
| **Network** | A group of principals whose stacks interconnect at the NATS layer. |
| **Mission Control** | The principal-facing dashboard surface. |

---

## Install

**With Arc (preferred).** cortex is not published to the Arc registry by name
yet — install by git URL (the repo ships an `arc-manifest.yaml`, so arc
installs it directly). Use the latest tag from the
[releases page](https://github.com/the-metafactory/cortex/releases):

```bash
arc install https://github.com/the-metafactory/cortex --pin v6.10.3
```

This installs the released package, pulls in the first-party surface plugins
(Discord, web, Mattermost, Slack adapters and the PagerDuty renderer) via the
manifest's `depends_on`, and renders the service files for your platform
(launchd agents on macOS, systemd user units on Linux). Track new releases
with `arc upgrade cortex`.

**From source** (contributors / the fork-and-PR workflow):

```bash
git clone https://github.com/the-metafactory/cortex
cd cortex
bun install
bun link                  # puts `cortex` on PATH via ~/.bun/bin
cortex --version          # confirm it resolves
./scripts/postinstall.sh  # scaffold runtime dirs, relay policy, service files
```

Do not skip `./scripts/postinstall.sh` — the arc path runs it automatically
via the manifest lifecycle; a manual clone does not, and without it the daemon
starts against missing scaffolding.

Then provision a stack (`cortex quickstart`, above) or follow the manual
procedure in [`README-AGENTS.md`](README-AGENTS.md) and
[`docs/sop-stack-onboarding.md`](docs/sop-stack-onboarding.md).

---

## Status

cortex is a **community preview (beta)**. What that means, concretely:

- **Single principal.** A stack serves one principal; the principal-only gate
  means only you can drive your assistant.
- **Discord is the preview surface.** A web chat adapter exists in the
  codebase, but the preview claim is Discord: mention → dispatch → threaded
  reply, plus the Mission Control dashboard.
- **Federation is experimental and unreleased.** Connecting stacks across
  principals into a shared network is designed and under active development,
  but it is not part of this preview — no setup instructions are provided or
  supported yet.
- **The wire protocol is still evolving.** The envelope and identity contracts
  (the myelin RFCs) are pre-1.0; breaking changes between releases are
  possible. `cortex migrate-config` covers config migrations, but expect to
  read release notes before upgrading.

See the [release notes](https://github.com/the-metafactory/cortex/releases)
for what changed in each version.

---

## What's in this repo

| Path | What it is |
|---|---|
| `src/cortex.ts` | Top-level entrypoint — wires bus + adapters + runner + taps + renderers. |
| `src/bus/` | Bus client: NATS connection, envelope validation, subscriptions, routing. |
| `src/adapters/` | Platform adapters — Discord, Mattermost, Slack presence per assistant. |
| `src/runner/` | Workflow runner — spawns and supervises Claude Code sessions per conversation. |
| `src/surface/mc/` | Mission Control — REST/WebSocket API, state DB, React dashboard, CF Worker. |
| `src/taps/` | Publishers onto the bus — Claude Code hook events, GitHub webhooks. |
| `src/cli/` | CLIs — `cortex` (stack + network management), `discord` (post/read from terminal). |
| `src/renderers/` | Dispatch sinks — dashboard renderer, PagerDuty fail-safe. |
| `deploy/compose/` | The L4 container path — compose file, image, entrypoint, env contract. |
| `docs/` | Architecture spec, design docs, SOPs, ADRs, the config template (`docs/config-layout/`). |

---

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — canonical architecture reference
- [`CONTEXT.md`](CONTEXT.md) — domain glossary (one canonical term per concept)
- [`README-AGENTS.md`](README-AGENTS.md) — install + configure guide for AI agents (and impatient humans)
- [`docs/config-layout/`](docs/config-layout/) — the copy-and-fill config template
- [`deploy/compose/README.md`](deploy/compose/README.md) — the container path, end to end
- [`docs/sop-stack-onboarding.md`](docs/sop-stack-onboarding.md) — stand up a new stack, end to end
- [`docs/sop-network-join.md`](docs/sop-network-join.md) — connect a stack to a shared network (experimental — see Status)
- [`docs/sop-bus-review.md`](docs/sop-bus-review.md) — the bus code-review path
- [`docs/design-collaboration-surface.md`](docs/design-collaboration-surface.md) — why a collaboration surface, the framing

---

## Provenance

cortex is the destination of a migration from `the-metafactory/grove-v2` (and
before that, `grove`), completed through the phased plan in
[`docs/plan-cortex-migration.md`](docs/plan-cortex-migration.md). You may still
see `grove` in a few hostnames (the dashboard at `grove.meta-factory.ai`) and
historical docs; the product is cortex.

---

## Contributing

cortex follows the metafactory ecosystem SOPs maintained in
[`the-metafactory/compass`](https://github.com/the-metafactory/compass) —
branching, PR review, versioning, worktree discipline, design process.
`CLAUDE.md` at the repo root carries the project rules for AI agents working
*on* this codebase and is fully generated (`arc upgrade compass`) — never
hand-edit it.

---

## Authors

- Andreas Astrom
- Jens-Christian Fischer

---

## Contributors

<a href="https://github.com/the-metafactory/cortex/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=the-metafactory/cortex" alt="cortex contributors" />
</a>

…and the community testers whose Debian, container, and macOS runs shaped the
6.10.x hardening series. Want in? Say hello on
[Discord](https://discord.gg/32xa5ev6Tq) — testers, playbook writers, and
adapter builders all welcome.

---

## License

[AGPL-3.0-only](LICENSE). cortex is the M7 reference implementation of the
metafactory stack; the AGPL's network-use copyleft (§13) keeps modifications
shared when cortex is run as a service. See
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) for incorporated upstream
patterns and code.

---

<p align="center">
  <sub>A <a href="https://meta-factory.ai">Meta Factory</a> project, by
  <a href="https://github.com/mellanon">Andreas Aaström</a> and
  <a href="https://github.com/jcfischer">Jens-Christian Fischer</a>.</sub>
</p>
