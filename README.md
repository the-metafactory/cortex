# cortex

**Talk to your AI agents from Discord. Watch them work on a dashboard. Let them
collaborate across machines — and across people.**

cortex is the collaboration surface of the [metafactory](https://github.com/the-metafactory)
ecosystem. It runs named AI assistants (powered by Claude Code and other
substrates), connects them to the chat platforms you already use, routes work to
them over a message bus, and makes everything they do visible in one place.

## What can you do with it?

- **Chat-dispatch work.** Mention an assistant in a Discord (or Mattermost,
  or Slack) channel — "fix the failing test in #cortex", "review PR 54" — and
  cortex spawns a Claude Code session, streams its progress back to the thread,
  and posts the result. Prefix with `async:` for fire-and-forget tasks or
  `team:` to spawn a multi-agent team.
- **Watch everything on Mission Control.** A web dashboard shows every running
  session, task queue, attention items needing your input, and GitHub activity
  (issues, PRs, checks) — so chat doesn't have to choose between "flood the
  channel with tool calls" and "go silent for ten minutes".
- **Route code reviews over the bus.** Publish a review request; any agent
  declaring the `code-review` capability claims it, runs the review, and posts
  the verdict — no point-to-point wiring between requester and reviewer.
- **Instrument your own terminal sessions.** Set one environment variable and
  your local Claude Code session's events appear live on the dashboard.
- **Federate with other people.** Your stack and a collaborator's stack can
  join the same network: their assistant can answer in a shared channel, claim
  work you offer, and reply to yours — each side keeping its own keys, policy,
  and data.

## How it works, in one paragraph

You (the **principal** — the human who owns the deployment) run one or more
**stacks**: cortex deployments with their own config, signing identity, and
message-bus namespace. A stack hosts **assistants** — named beings like Luna,
Echo, or Ivy with a persona and a Discord identity. All communication is
**envelopes on a NATS message bus**: a Discord mention becomes a signed dispatch
envelope, an assistant's runtime picks it up, executes it on a substrate
(usually a Claude Code session), and emits lifecycle events that the chat
adapter and the dashboard both render. Because the bus — not Discord — is the
medium, the same work can be dispatched from chat, from the dashboard, from a
GitHub webhook, or from another agent entirely.

Work reaches an assistant in one of three **dispatch modes**:

| Mode | How the recipient is chosen |
|---|---|
| **Direct** | You name the assistant (`@echo`); it does the task, one shot. |
| **Offer** | You publish to a capability (`code-review.typescript`); exactly one capable assistant claims it. |
| **Delegate** | You name an assistant that orchestrates a multi-step outcome via a multi-agent team. |

## Where cortex sits

cortex is the top layer (M7) of the **Myelin layer model** — an OSI-style stack
where the protocol layers below are owned by the sibling
[myelin](https://github.com/the-metafactory/myelin) project:

```
M7  SURFACES      cortex (this repo) · pilot · signal · future apps
M6  COMPOSITION   myelin — interaction patterns
M5  DISCOVERY     myelin — capability registry
M4  IDENTITY      myelin — verifiable sender per envelope
M3  ENVELOPE      myelin — message format + sovereignty metadata
M2  TRANSPORT     myelin — abstract bus (NATS underneath)
M1  CONNECTIVITY  TCP/TLS · federation topology (NATS leaf nodes)
```

cortex consumes the contracts of M2–M6 and owns none of them. That separation
is what lets several M7 applications (cortex for collaboration, signal for
telemetry, pilot for review loops) share one bus without sharing code.

The full picture — event architecture, visibility tiers, the agent/assistant
model, internal componentisation — lives in
[`docs/architecture.md`](docs/architecture.md). The precise domain vocabulary
(what exactly a *stack*, *capability*, or *dispatch sink* is) lives in
[`CONTEXT.md`](CONTEXT.md).

## A small glossary

| Term | Meaning |
|---|---|
| **Principal** | The human who owns and runs stacks; root of trust and policy. |
| **Stack** | One cortex deployment under a principal — own config, signing key, bus namespace. |
| **Assistant** | The named being (Luna, Echo, Ivy…) with a persona; what you `@mention`. |
| **Agent** | The long-lived runtime that hosts an assistant on the bus. |
| **Capability** | A bus-routable ability an assistant declares (`chat`, `code-review.typescript`). |
| **Envelope** | The signed wrapper every bus message travels in. |
| **Network** | A federation of principals whose stacks interconnect at the NATS layer. |
| **Mission Control** | The principal-facing dashboard surface. |

## Getting started

The short version (full procedure in
[`README-AGENTS.md`](README-AGENTS.md) and
[`docs/sop-stack-onboarding.md`](docs/sop-stack-onboarding.md)):

```bash
# Scaffold a stack config (dry-run by default; --apply writes it)
cortex stack create mystack --principal yourname --apply

# Fill in the <REPLACE_ME> secrets (Discord token, guild + channel ids)
$EDITOR ~/.config/cortex/mystack/stacks/mystack.yaml

# Validate, then start
cortex start --config ~/.config/cortex/mystack/mystack.yaml --dry-run
cortex start --config ~/.config/cortex/mystack/mystack.yaml
```

Then @mention your assistant in the bound Discord guild and watch it answer.
The Mission Control dashboard runs at `localhost:8767` locally (hosted
deployments serve it via Cloudflare).

You will need: [Bun](https://bun.sh), a local
[NATS server](https://nats.io) with JetStream, a Discord bot token (or
Mattermost/Slack credentials), and an Anthropic-authenticated Claude Code
install for the default execution substrate.

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
| `docs/` | Architecture spec, design docs, SOPs, ADRs, the config template (`docs/config-layout/`). |

## Documentation map

- [`docs/architecture.md`](docs/architecture.md) — canonical architecture reference
- [`CONTEXT.md`](CONTEXT.md) — domain glossary (one canonical term per concept)
- [`README-AGENTS.md`](README-AGENTS.md) — install + configure guide for AI agents (and impatient humans)
- [`docs/config-layout/`](docs/config-layout/) — the copy-and-fill config template
- [`docs/sop-stack-onboarding.md`](docs/sop-stack-onboarding.md) — stand up a new stack, end to end
- [`docs/sop-network-join.md`](docs/sop-network-join.md) — federate a stack onto a network
- [`docs/sop-bus-review.md`](docs/sop-bus-review.md) — the bus code-review path
- [`docs/design-collaboration-surface.md`](docs/design-collaboration-surface.md) — why a collaboration surface, the framing

## Provenance

cortex is the destination of a migration from `the-metafactory/grove-v2` (and
before that, `grove`), completed through the phased plan in
[`docs/plan-cortex-migration.md`](docs/plan-cortex-migration.md). You may still
see `grove` in a few hostnames (the dashboard at `grove.meta-factory.ai`) and
historical docs; the product is cortex.

## Contributing

cortex follows the metafactory ecosystem SOPs maintained in
[`the-metafactory/compass`](https://github.com/the-metafactory/compass) —
branching, PR review, versioning, worktree discipline, design process.
`CLAUDE.md` at the repo root carries the project rules for AI agents working
*on* this codebase and is fully generated (`arc upgrade compass`) — never
hand-edit it.

## Authors

- Andreas Astrom
- Jens-Christian Fischer

## License

[AGPL-3.0-only](LICENSE). cortex is the M7 reference implementation of the
metafactory stack; the AGPL's network-use copyleft (§13) keeps modifications
shared when cortex is run as a service. See
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) for incorporated upstream
patterns and code.
