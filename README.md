# cortex

The metafactory ecosystem's **layer-7 collaboration surface** — the M7
application that consumes the Myelin stack (M2–M6) and presents collaboration,
dispatch, and observability to operators across Discord, Mattermost, and the
Mission Control dashboard.

## What cortex is

Cortex is the conscious processing surface of the metafactory stack. It is one
M7 application among siblings (alongside pilot, signal, future apps); it does
not own M1–M6, it consumes their contracts.

In one sentence: cortex is what operators talk to when they ask an AI agent to
do work, and it is where that work becomes visible.

Concretely, cortex provides:

- **Platform adapters** — Discord and Mattermost presence per agent. Inbound
  messages route to a workflow runner; outbound replies + lifecycle events
  render back to the surface.
- **Workflow runner** — spawns and supervises Claude Code sessions per
  conversation, with per-thread session persistence, attachment handling,
  multi-agent teams, async tasks, and a content-policy filter.
- **Myelin bus client** — NATS-backed M2–M6 transport with vendored envelope
  schema validation, subject-pattern subscriptions, and reconnect-aware
  subscription lifecycle.
- **Mission Control dashboard** — React surface at `grove.meta-factory.ai` for
  task observation, dispatch, and principal input.
- **GitHub taps** — webhook proxy + in-bot handlers for issues/PRs/checks
  visibility into Discord threads.
- **CC event pipeline** — Claude Code hook events flow through a relay (with
  declarative policy filtering) into the bus and onward to renderers.

## Status

**MIG-7 complete; v1.0.0 cutover candidate.**

Cortex is the destination of the `the-metafactory/grove-v2` → `cortex`
migration. MIG-7 lands the entrypoint, agent registry, trust resolver, presence
adapters, renderers, config migration helper, and arc-manifest cutover. The
next principal-facing milestones:

- **MIG-7.9** — principal config rename (`~/.config/grove/bot.yaml` →
  `~/.config/cortex/cortex.yaml`) via the `migrate-config` helper.
- **MIG-7.13** — final integration test (all adapters connect, dashboard
  renders, NATS+myelin operational, fixture inbound round-trips).
- **MIG-7.14** — version bump to **v1.0.0** (per plan §6.3 lean).
- **MIG-8** — archive `the-metafactory/grove` (legacy v0.29.0) and
  `the-metafactory/grove-v2` on GitHub.

Until MIG-7.14 lands the version stays at v0.1.0 / v0.2.0. See
[`docs/plan-cortex-migration.md`](docs/plan-cortex-migration.md) for the
authoritative phase-by-phase tracker.

## Install

Cortex installs via the metafactory package manager (`arc`):

```bash
arc upgrade Cortex
```

This is the single command that performs the full cutover from legacy grove
(if present): it kills any lingering `~/bin/grove-bot` / `~/bin/grove-relay`
PIDs, unloads + removes the legacy `com.grove.{bot,relay}.plist` launchd
agents, renders cortex's `ai.meta-factory.cortex.{bot,relay}.plist` into
`~/Library/LaunchAgents/`, and loads them. See plan §4 MIG-7.7 / MIG-7.8 for
the lifecycle-script detail.

**Pre-flight (recommended, no longer load-bearing):**

```bash
arc uninstall Grove          # remove legacy if installed
```

**Verify:**

```bash
launchctl list | grep ai.meta-factory.cortex   # two entries (bot + relay)
pgrep -f "${HOME}/bin/cortex start"            # non-empty PID
```

## Quick start

```bash
# Migrate your config from grove-v2 if you had one
mkdir -p ~/.config/cortex/
bun src/cli/cortex/commands/migrate-config.ts \
    ~/.config/grove/bot.yaml > ~/.config/cortex/cortex.yaml

# Dry-run validates schema + agent registry resolution
cortex start --config ~/.config/cortex/cortex.yaml --dry-run

# Start cortex (launchd handles this automatically post-install)
cortex start --config ~/.config/cortex/cortex.yaml
```

The Mission Control dashboard is at **https://grove.meta-factory.ai** (the
domain name stays during the cortex cutover for principal continuity; it can be
renamed post-MIG-8).

From Discord, mention any configured agent in a configured channel and cortex
routes the message through the workflow runner to a Claude Code session.

From any terminal, post to Discord:

```bash
discord post "deploy notes here"            # default channel
discord post --channel tasks "shipping"     # specific channel
```

From any Claude Code session, instrument events into the dashboard:

```bash
CORTEX_CHANNEL=andreas CORTEX_AGENT_NAME=Andreas claude
```

(The `cldyo-live` wrapper at `~/.local/bin/` does this for you.)

## Bus Review Path

Cortex owns the code-review bus consumer. Pilot or sage-shaped publishers send
`tasks.code-review.*` envelopes to `local.{principal}.{stack}.tasks.code-review.*`;
Cortex claims them through a JetStream durable, runs the configured review
substrate, and emits `dispatch.task.started`, `review.verdict.*`, and
`dispatch.task.completed` with `correlation_id` set to the request envelope id.

Principal checks:

```bash
arc nats provision-streams --network <principal> --agent <agent>
nats stream info CODE_REVIEW
nats consumer info CODE_REVIEW cortex-review-consumer-<principal>-<agent>
```

Use `bus.review` in `cortex.yaml` to tune stream retention/storage and durable
redelivery. Keep `nats.subjects: []` for pull-only capability dispatch unless
you also need broad push-mode fan-out. See
[`docs/sop-bus-review.md`](docs/sop-bus-review.md).

## Architecture

The canonical architecture spec is
**[`docs/architecture.md`](docs/architecture.md)** — M1–M7 stack model, agent +
presence/renderer model, M7 application architecture, agent task routing,
three-tier visibility, internal componentisation.

cortex is one M7 application among siblings:

```
M7  cortex (this repo) · pilot · signal · future apps
M6  Composition (myelin)
M5  Discovery (myelin)
M4  Identity (myelin — MY-400)
M3  Envelope (myelin — schema + namespace)
M2  Transport (myelin — NATS abstraction)
M1  Connectivity (NATS)
```

See `docs/architecture.md` §2 for the layered model and §5 for sibling-app
context.

Selected design references inside `docs/`:

- `design-collaboration-surface.md` — layer-7 framing + flybridge-cockpit + event architecture
- `design-mission-control.md` — the mc-v3 dashboard architecture
- `iteration-collaboration-surface.md` — G-1100..G-1110 ladder retro
- `design-agent-visibility.md` + `design-github-visibility.md` — visibility tiers

The full `design-*.md` and `iteration-*.md` set is lifted from grove-v2 at
MIG-7.11.

## Migration provenance

This repo is the destination of the grove-v2 → cortex migration. While the
migration is in flight (MIG-0 through MIG-8), the migration plan is itself
load-bearing:

- **[`docs/plan-cortex-migration.md`](docs/plan-cortex-migration.md)** — phase
  plan, per-file inventory, checklist per phase, acceptance criteria, open
  questions. Retires when MIG-8 closes.

Once MIG-8 closes (legacy + grove-v2 archived), the migration plan becomes
historical reference rather than active tracker.

## Contributing

Cortex follows the metafactory ecosystem SOPs maintained in
[`the-metafactory/compass`](https://github.com/the-metafactory/compass). The
ones most often activated here:

- `compass/sops/dev-pipeline.md` — branches, PRs, merge flow
- `compass/sops/worktree-discipline.md` — multi-agent worktree pattern
- `compass/sops/versioning.md` — version bumps, releases
- `compass/sops/design-process.md` — specs, design docs, research docs
- `compass/sops/pr-review.md` — PR review checklist
- `compass/sops/retrospective-and-process-mining.md` — post-work retros

`CLAUDE.md` at the repo root captures the project-specific rules and is
**fully generated** by `arc upgrade compass` — never hand-edit.

## Authors

- Andreas Astrom
- Jens-Christian Fischer

## License

[MIT](LICENSE). See [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) for
upstream patterns + code incorporated into cortex.
