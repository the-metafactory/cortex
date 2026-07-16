# cortex on Docker Compose (L4)

`docker compose up -d` = a running assistant. This is the container path from
arc's `design/linux-host-support.md` (§L4 / DD-L4): compose supervises via
`restart:` policies — systemd is absent by design.

## Quickstart

1. **Create the Discord bot** (one-time, manual — the Developer Portal has no
   API for it). Create an application + bot, enable the **Message Content
   intent**, invite it to your server, and copy the bot token. Full walkthrough:
   [`README-AGENTS.md`](../../README-AGENTS.md) Appendix A / §3.
2. **Generate a Claude OAuth token** on a machine already logged into Claude
   Code: `claude setup-token`.
3. `cp .env.example .env` and fill in every `<REPLACE_ME>` plus the two secrets
   (`CTX_DISCORD_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`). `.env` is git-ignored.
4. `docker compose up -d`
5. **Verify:** `docker compose logs cortex | grep -E "Stack:|connected"` then
   `@mention` the assistant in your channel as the principal — it replies.

## What each file is

| File | Role |
|------|------|
| `docker-compose.yaml` | Two services: `nats` (bus) + `cortex` (assistant). |
| `Dockerfile.cortex` | The cortex image — bun + claude CLI + cortex + arc + surface adapter bundle(s), all pinned. |
| `docker-entrypoint.sh` | Provisions (idempotent `cortex quickstart`) then `exec`s the daemon. |
| `nats.conf` | The isolated per-stack JetStream bus config (mounted read-only). |
| `.env.example` | The DD-L5 `CTX_*` env contract — placeholders only. |

## Networking model (why `network_mode: "service:nats"`)

cortex's scaffolded `system.yaml` sets `nats.url` to `nats://127.0.0.1:4222`, and
cortex requires a **loopback** bus (`src/surface/mc/.../sibling-discovery.ts`).
`cortex quickstart` patches only the bus *port*, never the *host*. So rather than
rewrite the host to a service name, the `cortex` service **shares the `nats`
container's network namespace** — cortex reaches the bus on `127.0.0.1:4222`
exactly as on a native host, and `nats.conf` binds loopback so the bus is
unreachable from outside the compose project (the project is the isolation
boundary). `depends_on: condition: service_healthy` still gates cortex on the
bus being up.

_Alternative considered:_ a standard bridge network with cortex dialing
`nats:4222`. That needs the entrypoint to rewrite `nats.url`'s host (which
quickstart can't do) and breaks the loopback assumption. The shared-namespace
approach needs zero config patching and mirrors the native single-host model. A
future quickstart `--container` mode could make either explicit.

## Why nats-server is baked into the cortex image

`cortex quickstart`'s preflight (step 1) checks for `nats-server` on `PATH` — a
native-host assumption. The cortex image therefore carries the pinned
`nats-server` **binary solely to satisfy that check**. It is never launched as a
daemon: the running bus is the separate official `nats` service. A quickstart
`--container` / `--skip-preflight-nats` mode (recommended L3 follow-up) would let
this binary be dropped.

## The healthy-boot gate is deferred, not skipped

quickstart's step 8 greps the cortex daemon's own log for healthy-boot lines, but
in a container the daemon only starts *after* quickstart returns (`exec cortex
start`). The entrypoint tolerates a **lone** step-8 failure and aborts on any
earlier one. The real health signal in a container is the running daemon under
`restart: unless-stopped` plus the nats healthcheck — verify with the `logs`
grep in step 5 and by `@mention`.

## Lifecycle

- **Restart** (`docker compose restart`) preserves stack identity, seeds, and
  sessions — all mutable state lives on the named volumes
  (`cortex-config`, `cortex-state`, `cortex-nats`, `nats-jetstream`). quickstart
  re-runs idempotently (every step a verified no-op).
- **Stop/start** (`docker compose down && docker compose up -d`) with volumes
  intact behaves identically. `docker compose down -v` **destroys** the stack
  identity — don't, unless you mean to re-provision from scratch.
- **Upgrade** — bump `CORTEX_REF` in `.env` (or the compose default) and
  `docker compose build --pull && docker compose up -d`. (An automated
  build+publish pipeline is the sibling L4b issue, cortex#2096.)

## Surface adapters are arc-installed

cortex core ships **zero** in-tree platform adapters — `discord`, `web`,
`slack`, and `mattermost` are each a first-party [arc](https://github.com/the-metafactory/arc)
**adapter bundle** (`metafactory-cortex-adapter-*`), discovered at boot via
`arc list --json` (`src/adapters/loader.ts`). A git-clone of cortex alone
installs none of them, so `cortex start` would FATAL at surface boot with
`no adapter installed for platform "…"` (cortex#2156). This image therefore
bakes `arc` and `arc install`s the bundle(s) named by the **`CORTEX_SURFACES`**
build arg:

- **`CORTEX_SURFACES`** — space-separated surface short-names. Default
  `discord` (matches the quickstart above). Each entry `X` installs
  `the-metafactory/metafactory-cortex-adapter-X`. At least one is required — an
  empty value bakes no adapter and reproduces cortex#2156. Examples:

  ```bash
  # discord only (default)
  docker compose build

  # a web/gateway surface instead
  docker compose build --build-arg CORTEX_SURFACES=web

  # multiple surfaces in one image
  docker compose build --build-arg CORTEX_SURFACES="discord web"
  ```

The bundles install as the runtime `cortex` user into arc's per-user repos dir
(`~/.local/share/metafactory/arc/repos`) — **not** one of the named volumes, so
they are part of the image and survive restart. Installing from the
`the-metafactory` repo URL records the org-trusted `repoUrl` the loader's
first-party-adapter exemption checks against (ADR-0024), so the adapter loads at
boot even with `system.plugins.external` off. Surface **tokens** are still
provided at runtime via the `CTX_*` contract in `.env` (never baked); `arc
install --skip-secrets` keeps the build itself non-interactive.

Match `CORTEX_SURFACES` to the surface your stack actually configures: the
default Discord quickstart needs `discord`; a `web:`-only stack should build
`--build-arg CORTEX_SURFACES=web`.

## Pinned versions

All are build ARGs, overridable from `.env`: `CORTEX_REF` (a release tag, **not**
`main` — default `v6.10.0`, the first release that carries `cortex quickstart`
and the L4 container fixes; earlier tags lack `quickstart` and abort at boot,
cortex#2154), `BUN_VERSION`, `CLAUDE_VERSION`, `NATS_SERVER_VERSION`, `ARC_REF` (the
arc release tag used to install the surface-adapter package manager),
`CORTEX_SURFACES` (which adapter bundle(s) to bake — see above), and the
`NATS_IMAGE` tag. Bump one, rebuild, redeploy.

## Known limitation: Claude OAuth token lifetime

Whether `CLAUDE_CODE_OAUTH_TOKEN` survives a long-lived headless container
(≥ 48 h) without mid-flight expiry is an open observation (arc §L4 known
challenge). If the token expires, the cortex#2068 auth-failure classifier is the
safety net (it surfaces a clear re-auth message rather than failing silently).
Refresh procedure: regenerate with `claude setup-token`, update `.env`, and
`docker compose up -d` to recreate the cortex container with the new token.

## Troubleshooting

- **quickstart aborts before the gate** — an earlier step failed. Read
  `docker compose logs cortex`; the ✓/✗ step table names the failure (a missing
  `CTX_*`, an unauthenticated `claude`, etc.).
- **No reply to @mention** — confirm the bot has the Message Content intent, is
  in the guild, and that `CTX_MY_DISCORD_ID` is *your* id (the principal-only
  gate stays silent for non-principals by design).
- **Verify no secrets in the image** — `docker history cortex:local` and
  `docker compose config` should show zero tokens (they arrive via `env_file`
  at runtime only).
