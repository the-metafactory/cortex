# Getting started with cortex

The one page a fresh install needs after `arc install cortex` (or a manual
`git clone` + `bun install`) finishes. Each section below is a stable anchor —
`scripts/postinstall.sh` links here instead of printing the full procedure.

For everything else — federation, bus internals, Discord binding mechanics —
see [`README-AGENTS.md`](../README-AGENTS.md) (the full install & configure
guide) and [`docs/sop-stack-onboarding.md`](sop-stack-onboarding.md) (the
stack-onboarding SOP).

---

## Fresh install

If you have never run cortex before, you have no `~/.config/cortex/*.yaml`
yet — that's expected. `cortex start --config …` has nothing to validate until
you create a stack config, and the migrate path below is only for those
coming from an existing **grove** install.

**Prerequisite — nats-server with JetStream.** cortex needs its own,
already-running NATS server (JetStream enabled); it does not install or
start one for you. Install it now — macOS: `brew install nats-server`;
Linux: a release binary from
[nats-io/nats-server releases](https://github.com/nats-io/nats-server/releases)
or your distro package (JetStream is built in) — and keep it running before
step 4 below. [`README-AGENTS.md` §1](../README-AGENTS.md#1-prerequisites)
and [§4](../README-AGENTS.md#4-stand-up-the-bus) are the authoritative
reference for the full prerequisite list and the isolated per-stack bus
config; this page only orders the steps.

The fresh-install happy path, in order:

0. **Stand up the bus** — run an isolated NATS server for this stack (one
   server per stack; see [`README-AGENTS.md` §4](../README-AGENTS.md#4-stand-up-the-bus)
   for the `.conf` template and port-allocation rules). You'll point
   `system/system.yaml`'s `nats.url` at it in step 2.

1. **Create your first stack config** with [`cortex stack create`](../src/cli/cortex/commands/stack.ts)
   (dry-run by default; verified against the command's own `--help` output —
   nothing here is invented):

   ```bash
   # Dry-run first — prints the file set it would write, touches nothing:
   cortex stack create <slug> --principal <principal>

   # Write it for real:
   cortex stack create <slug> --principal <principal> --apply
   ```

   - `<slug>` is your stack's label (e.g. `work`, `community`) — becomes the
     config dir name `~/.config/cortex/<slug>/` and the trailing segment of
     `stack.id`.
   - `<principal>` is your identity (e.g. your name, lowercase) — the first
     half of `stack.id = <principal>/<slug>`. **Required on a fresh install**:
     `--principal` can only be inferred when exactly one stack already exists
     under `--config-dir`, which is never true the first time.
   - This writes a config-split skeleton (`system/`, `stacks/`, `surfaces/`,
     `personas/`, and the `<slug>.yaml` pointer) with `<REPLACE_ME>` markers
     left only for true secrets (Discord token/guild/channels).

2. **Fill the `<REPLACE_ME>` markers** in the generated
   `~/.config/cortex/<slug>/stacks/<slug>.yaml` and `surfaces/surfaces.yaml`
   (Discord bot token, guild id, channel ids, your Discord id), and point
   `system/system.yaml`'s `nats.url` at the bus from step 0.

3. **Generate the stack's signing identity** — mints the `nkey_pub` that
   `stacks/<slug>.yaml` records for this stack:

   ```bash
   cortex provision-stack generate <principal> \
     --seed-path ~/.config/nats/cortex-<slug>.nk \
     --stack-id <principal>/<slug>
   ```

   Not a hard requirement to *start* a purely local, non-federated stack —
   own-stack implicit trust works with `security.signing: off` and no
   identity block — but it's the standard step, and it's required before you
   federate later (§6). An `arc`-managed install (`arc upgrade cortex`)
   auto-provisions this seed for you, so you can skip running it by hand in
   that case. See
   [`README-AGENTS.md` §3.3](../README-AGENTS.md#33-signing-identity) for the
   exact flags and the local-vs-federated distinction.

4. **Validate, then start:**

   ```bash
   # Validate schema + agent registry resolution without starting:
   cortex start --config ~/.config/cortex/<slug>/<slug>.yaml --dry-run

   # Start for real:
   cortex start --config ~/.config/cortex/<slug>/<slug>.yaml
   ```

   See [`docs/sop-stack-onboarding.md`](sop-stack-onboarding.md) for the full
   walkthrough — Discord bot setup, bus port allocation, plist/systemd — and,
   only once you're ready to federate, the network-join steps (Part 2).

## Migrating from grove

If you're moving an existing **grove** bot config forward (this does *not*
apply to a fresh install — skip straight to [Fresh install](#fresh-install)
above if you have no `~/.config/grove/bot.yaml`):

```bash
bun <cortex-repo>/src/cli/cortex/commands/migrate-config.ts \
    ~/.config/grove/bot.yaml \
    --out ~/.config/cortex/cortex.yaml
```

Then validate the converted config the same way:

```bash
cortex start --config ~/.config/cortex/cortex.yaml --dry-run
```

`migrate-config.ts` supports `--check` (validate + print a conversion report
without writing) and `--strict` (fail on warnings instead of just printing
them). See the file's header comment for the full flag list.

## CORTEX_CHANNEL

`CORTEX_CHANNEL` is the environment variable that turns on session
instrumentation — it's the channel/identity label that scopes a Claude Code
session's events so they show up correctly on the Mission Control dashboard
(and, previously, in `~/.claude/events/raw/*.jsonl` regardless of whether a
dashboard is even running — see [below](#event-relay-and-cortex_ingest_url)).
Without it, the `EventLogger` hook silently no-ops — no events are captured or
sent anywhere.

Set it when you launch a Claude Code session you want visible:

```bash
CORTEX_CHANNEL=<name> CORTEX_AGENT_NAME=<display> CORTEX_AGENT_ID=<id> claude
```

`<name>` is any label you choose — typically your principal or stack slug
(e.g. `andreas`). `CORTEX_AGENT_NAME`/`CORTEX_AGENT_ID` are optional cosmetic
fields for the dashboard's agent cards. The legacy `GROVE_CHANNEL` name is
still honored during the migration window. See
[`docs/agents-md/pai-integration.md`](agents-md/pai-integration.md) for the
full env-var table (including `CORTEX_PRINCIPAL`).

## Event relay and CORTEX_INGEST_URL

The event relay is **optional** — you do not need it running for cortex to
work. Every hook-captured event is always written to
`~/.claude/events/raw/*.jsonl`, regardless of whether anything is listening
on the network.

Before that local write, the `EventLogger` hook first tries to `POST` each
event to an ingest endpoint so it shows up live on the Mission Control
dashboard. That endpoint defaults to `http://localhost:8766/api/events/ingest`;
`CORTEX_INGEST_URL` overrides it (e.g. if your relay/dashboard listens on a
different host or port). If nothing is listening — the common case on a
fresh install before you've stood up a relay — the `POST` fails fast (a
500ms timeout) and is silently swallowed. Nothing blocks, nothing errors:
the local JSONL write always follows, whether or not the POST succeeded.

## Services

Once a stack config is in place, run cortex as a background service so it
survives logout/reboot:

- **macOS** — `arc upgrade cortex` (and `scripts/postinstall.sh` on a fresh
  install) renders a launchd plist per discovered stack config under
  `~/Library/LaunchAgents/`. Load it with:

  ```bash
  launchctl load ~/Library/LaunchAgents/ai.meta-factory.cortex.<slug>.plist
  ```

- **Linux** — systemd unit rendering is not automated yet
  ([cortex#1692](https://github.com/the-metafactory/cortex/issues/1692)).
  Hand-write a systemd **user** unit mirroring the launchd plist
  (`ExecStart=<path>/cortex start --config <pointer>`, `Restart=always`,
  `CORTEX_CHANNEL` set, `~/.bun/bin` on `PATH`), then:

  ```bash
  systemctl --user enable --now ai.meta-factory.cortex.<slug>.service
  ```

  Or skip the service manager entirely and run the daemon directly:
  `bun src/cortex.ts start --config <pointer>`.
