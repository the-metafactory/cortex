# Runbook — Bootstrap Luna (zero → MVP software-factory assistant)

**What this is.** One path, followed top to bottom, from a clean machine to a
`@luna` that responds in Discord **and can write code** — clone a repo, run
tests, open a PR. No cross-doc stitching: everything you need to reach a
responding, coding Luna is on this page.

**Audience.** A newcomer standing up their first metafactory assistant stack on
**macOS** or **Debian-based Linux**. (WSL2 works too, with one caveat called out
in [Troubleshooting](#7-troubleshooting) — it is a fast-follow, not a gate.)

**The MVP you end up with** (per `#bootstrap`): not a chat toy — a *minimum
viable software-factory assistant*. Luna runs on **Claude Code**, talks on
**Discord**, lives on a **local** stack (no federation), and codes against **one
GitHub repo you name**, confirming before she pushes or opens a PR.

**The one path, at a glance:**

```
1. Prereqs        bun · nats-server · Claude Code (authenticated) · gh · git
2. Discord bot    create the app + token + IDs   ← the ONE manual edge, front-loaded
3. Install cortex arc install cortex             (native; renders your service units)
4. Stand up Luna  cortex quickstart --surface discord   (scaffold → bind → seed → boot → gate)
5. Verify         say hi in the channel → @luna replies
6. Make her code  install the luna-stack bundle (the software-factory capability delta)
7. Troubleshoot   the known edges (macOS load, missing token, WSL2 systemd)
```

> **Design provenance.** This runbook is the executable form of
> `docs/design-bootstrap-luna.md` (DD-1 runbook-first, DD-4 solo/local/simple-bus,
> DD-5 Discord-first) and `docs/design-luna-stack-bundle.md` (the Phase-2 bundle).
> Every command below is verified against the real cortex CLI
> (`src/cli/cortex/commands/{quickstart,stack,provision-stack,agents}.ts` and the
> `start`/`stop`/`status` verbs in `src/cortex.ts`).

**Out of scope (on purpose).** Federation (joining a network of other
principals' stacks) is an opt-in upgrade, not on this path — see
`docs/sop-network-join.md` when you want it. The **web surface** is the
first-class *alternative* to Discord (it avoids the manual bot-app edge and suits
a headless Luna); this runbook mentions it in one line at
[Step 4](#surface-alternative-web) but does not walk it — Discord is the
recommended default (DD-5).

---

## 1. Prereqs

Luna needs five things on your `PATH` before anything else: **bun**,
**nats-server**, **Claude Code** (authenticated), **gh**, and **git**. Install
them per your OS, then run the one-line check at the end of this section.

### macOS

```bash
# bun
curl -fsSL https://bun.sh/install | bash        # then restart your shell

# NATS server + GitHub CLI + git (Homebrew)
brew install nats-server gh git

# Claude Code — install per https://claude.com/claude-code, then log in:
claude          # completes the interactive OAuth login on first run
```

### Debian-based Linux (Ubuntu, Debian, …)

```bash
# bun
curl -fsSL https://bun.sh/install | bash        # then restart your shell

# git + GitHub CLI (gh’s official apt repo — see https://github.com/cli/cli)
sudo apt-get update && sudo apt-get install -y git

# nats-server — grab the latest release binary from https://github.com/nats-io/nats-server/releases
#   (download the linux-amd64 tarball, extract, move `nats-server` onto your PATH)

# Claude Code — install per https://claude.com/claude-code, then log in:
claude          # completes the interactive OAuth login on first run
```

> **Debian only — enable systemd linger.** cortex runs as a systemd *user*
> service; without linger it stops the moment your SSH session ends. Enable it
> once:
>
> ```bash
> sudo loginctl enable-linger "$USER"
> ```
>
> `cortex quickstart`'s preflight (Step 4) checks this and refuses to proceed if
> it's off.

### Authenticate GitHub (both OSes)

Luna codes against GitHub, so `gh` must hold its own login (the luna-stack bundle
**bakes no token** — it grants the *ability* to reach GitHub; your own `gh`
credentials authorize it):

```bash
gh auth login          # choose GitHub.com → HTTPS → authenticate in browser
gh auth status         # confirm: "Logged in to github.com as <you>"
```

### Verify the toolchain

```bash
bun --version && nats-server --version && claude --version && gh --version && git --version
```

All five must print a version. `claude --version` must succeed **without** an
auth error — if it complains you're not logged in, run `claude` once and complete
the login. (`cortex quickstart`'s Step 1 preflight re-checks bun, `claude`
authenticated, and `nats-server` on `PATH`, so a miss here is caught again there,
never silently.)

---

## 2. Create the Discord bot app  — the one manual edge, front-loaded

**No tooling can do this step for you.** The Discord Developer Portal has no API
for creating an application or minting a bot token — `cortex quickstart` only
*validates* the IDs and token you produce here; it cannot create them. Because
this runbook is Discord-first (DD-5), this manual edge is on the critical path,
so we do it **first** and spell out every click. Do this once and you'll never
touch the portal again.

### 2a. Create the application + bot

1. Go to **https://discord.com/developers/applications** and click **New
   Application**. Give it a name (e.g. *Luna*) and create it.
2. Open the **Bot** tab in the left sidebar.
3. Click **Reset Token** → **Copy**. This is your bot token. **Save it
   somewhere safe now** — Discord shows it only once. You'll export it as
   `CTX_DISCORD_TOKEN` (or `LUNA_BOT_TOKEN` for the bundle) in Step 4.
   - Treat this token like a password. It is a secret; never commit it, never
     paste it into a channel, never echo it in a script.
4. Scroll to **Privileged Gateway Intents** and enable **MESSAGE CONTENT
   INTENT** (Luna can't read message text without it). Save changes.

### 2b. Invite the bot to your server

1. Open **OAuth2 → URL Generator**.
2. Under **Scopes**, tick **`bot`**.
3. Under **Bot Permissions**, tick at least: **Send Messages**, **Read Message
   History**, **Create Public Threads**, **Send Messages in Threads**. (These
   cover the Discord channel-routing model — repos get channels, entities get
   threads.)
4. Copy the **Generated URL** at the bottom, open it in your browser, choose
   your server, and **Authorize**. The bot now appears (offline) in your
   server's member list.

### 2c. Copy the four IDs cortex needs

Turn on Discord's Developer Mode so you can copy IDs: **User Settings →
Advanced → Developer Mode → ON**. Then:

| ID you need | How to get it |
|---|---|
| **Guild (server) ID** | Right-click your server icon → **Copy Server ID** |
| **Channel ID** | Right-click the channel Luna should live in → **Copy Channel ID** |
| **Log channel ID** | Right-click a channel for worklog output → **Copy Channel ID** (reuse the main channel if you want them together) |
| **Your own user ID** | Right-click your own name → **Copy User ID** (this is the principal Luna answers to) |

Keep these four numbers plus the token from 2a within reach — Step 4 exports
them. Every one is a numeric *snowflake* (a long integer); `cortex quickstart`
shape-checks them and rejects anything that isn't.

---

## 3. Install cortex (native)

cortex is distributed and updated with **arc**. A native install renders your
per-stack service units (systemd on Linux, launchd on macOS) and puts the
`cortex` CLI on your `PATH`:

```bash
arc install cortex
cortex --help          # confirm the CLI is available
```

- On **Debian**, this renders the `nats@.service` + `cortex@.service` systemd
  user unit templates that `cortex quickstart`'s service step requires — so
  installing cortex *before* running quickstart is mandatory, not optional.
- On **macOS**, this installs the launchd stack service template. See the macOS
  note in [Step 4](#4-stand-up-luna) and [Troubleshooting F2](#f2-macos-a-fresh-host-needs-an-explicit-cortex-start).

Later, to update cortex, run `arc upgrade cortex` (the same command that
re-provisions your stack's signing seed).

---

## 4. Stand up Luna

`cortex quickstart` is the verified one-command stand-up spine. Driven entirely
by a set of `CTX_*` environment variables, it runs eight idempotent steps —
**preflight → validate env → write nats conf → scaffold the stack → patch the
Discord binding → provision the signing seed → start services → healthy-boot
gate** — and is safe to re-run after fixing any single value.

### 4a. Fill in the `CTX_*` env contract

Create a file `cortex.env` (keep it out of git — it holds your token) and fill
every value from the table below:

```bash
# cortex.env  — DO NOT COMMIT (contains a secret)

# --- identity + transport (shared) ---
export CTX_PRINCIPAL=<your-handle>     # you, the principal: lowercase letters/digits/hyphen, letter-first (e.g. "ada")
export CTX_SLUG=luna                   # your stack's name: lowercase letters/digits/hyphen/underscore, letter-first
export CTX_NATS_PORT=4222              # NATS client port (4222 is the default; any free port 1-65535)
export CTX_NATS_MON=8222               # NATS monitoring port (used by the healthy-boot gate's /healthz probe)

# --- Discord surface (from Step 2) ---
export CTX_GUILD_ID=<your-guild-id>            # Step 2c — Copy Server ID
export CTX_CHANNEL_ID=<your-channel-id>        # Step 2c — Copy Channel ID (where @luna lives)
export CTX_LOG_CHANNEL_ID=<your-log-channel-id># Step 2c — worklog channel (reuse CHANNEL_ID if you like)
export CTX_MY_DISCORD_ID=<your-user-id>        # Step 2c — Copy User ID (the principal Luna answers to)

# --- secret (from Step 2a) — never echoed by quickstart ---
export CTX_DISCORD_TOKEN=<your-bot-token>      # Step 2a — Reset Token → Copy. GATES success.

# --- optional: only needed on a headless host with no interactive `claude` login ---
# export CLAUDE_CODE_OAUTH_TOKEN=<token>       # native hosts with a `claude` login don't need this
```

**Where each value comes from — the full contract:**

| Key | Required | Shape | Where to get it |
|---|---|---|---|
| `CTX_PRINCIPAL` | ✅ | lowercase alnum + hyphen, letter-first | Your own handle — the human running the stack |
| `CTX_SLUG` | ✅ | lowercase alnum + hyphen/underscore, letter-first | You choose it (`luna` is the reference name); becomes `stack.id = <principal>/<slug>` |
| `CTX_NATS_PORT` | ✅ | numeric port 1–65535 | Any free port; `4222` is the NATS default |
| `CTX_NATS_MON` | ✅ | numeric port 1–65535 | Any free port; `8222` is conventional (the gate probes `/healthz` here) |
| `CTX_GUILD_ID` | ✅ | numeric snowflake | Step 2c — Copy Server ID |
| `CTX_CHANNEL_ID` | ✅ | numeric snowflake | Step 2c — Copy Channel ID |
| `CTX_LOG_CHANNEL_ID` | ✅ | numeric snowflake | Step 2c — worklog channel (may equal `CTX_CHANNEL_ID`) |
| `CTX_MY_DISCORD_ID` | ✅ | numeric snowflake | Step 2c — your own Copy User ID |
| `CTX_DISCORD_TOKEN` | ✅ (gates) | non-empty secret | Step 2a — Reset Token → Copy. Never printed; a miss stops the run cleanly |
| `CLAUDE_CODE_OAUTH_TOKEN` | optional | non-empty secret | Only for a headless host with no interactive `claude` login — native hosts skip it |

### 4b. Run quickstart

```bash
set -a; . ./cortex.env; set +a      # load the env contract
cortex quickstart --surface discord # discord is the default; shown for clarity
```

Each step prints a ✓/✗ table before the next runs. On success you'll see
`cortex quickstart: complete ✓`. What it did:

1. **Preflight** — bun / `claude` (authenticated) / `nats-server` on `PATH`;
   on Linux, systemd linger enabled.
2. **Validate env** — every `CTX_*` present and shape-checked (the token shows
   only `set`/`missing`, never its value).
3. **nats conf** — writes `~/.config/nats/<slug>.conf` (skips if identical).
4. **Scaffold** — runs `cortex stack create <slug> --principal <principal>
   --apply`: a born-aligned config-split stack at
   `~/.config/metafactory/cortex/<slug>/`, with `stack.id = <principal>/<slug>`.
5. **Patch configs** — writes your Discord binding into `surfaces/surfaces.yaml`
   and `stacks/<slug>.yaml` (token set, never echoed).
6. **Seed provisioning** — provisions the stack's ed25519 signing seed (the same
   entry `arc upgrade cortex` uses). A solo/local Luna needs only this seed — no
   federation account-tree.
7. **Services** — Linux: enables + starts the `nats@<slug>` + `cortex@<slug>`
   systemd user units. macOS: restarts an *already-loaded* launchd service (see
   the macOS note below).
8. **Healthy-boot gate** — waits (bounded) for the daemon to log a healthy boot
   and answer `/healthz`. On a dead bus it fails fast with the real error rather
   than hanging.

This is **local / simple-bus** by design (DD-4): no `cortex network provision`
or `make-live` runs, and nothing federates. Federation is a separate, opt-in
upgrade.

> **macOS: expect one extra step.** `cortex quickstart`'s service step on macOS
> only *restarts* a launchd service that arc has already loaded; a fresh host
> won't have it loaded yet, so quickstart prints a skip. Bring the daemon up
> explicitly with the backstop (idempotent, works on every OS):
>
> ```bash
> cortex start --config ~/.config/metafactory/cortex/<slug>/<slug>.yaml
> ```
>
> See [Troubleshooting F2](#f2-macos-a-fresh-host-needs-an-explicit-cortex-start).

> <a id="surface-alternative-web"></a>**Surface alternative — web.** Prefer a
> headless Luna with no Discord bot app at all? `cortex quickstart --surface web`
> takes a `CTX_WEB_HOST` / `CTX_WEB_PORT` / `CTX_WEB_TOKEN` contract instead of
> the Discord snowflakes and scaffolds a `web:` binding. It avoids Step 2
> entirely. Discord remains the recommended default (DD-5); the web path is the
> documented alternative, not walked here.

---

## 5. Verify `@luna` responds

1. In your Discord server, open the channel whose ID you set as
   `CTX_CHANNEL_ID`. The bot should show **online**.
2. Post a plain message, e.g. `@luna hello — are you there?`
3. Luna replies in the channel. A no-prefix message is a synchronous chat; she
   posts her response when Claude Code finishes.

Check the daemon from the shell any time:

```bash
cortex status --config ~/.config/metafactory/cortex/<slug>/<slug>.yaml
```

If she's silent, jump to [Troubleshooting](#7-troubleshooting) — the usual cause
is a missing/incorrect token (Step 8's gate stops on it) or, on macOS, the
daemon not yet started (F2).

**At this point you have a responding chat Luna.** To make her a *software-factory*
assistant that can code, continue to Step 6.

---

## 6. Make her code — install the luna-stack bundle

A chat Luna is the *floor*. The **MVP** is that floor **plus a software-factory
capability delta**: Claude Code coding tools, `bash`, `gh`/`git`, and
read+write access scoped to **one repo you name**. That delta ships as the
**luna-stack** arc bundle, whose install stands up (or extends) the stack and
grants exactly those capabilities — least-privilege by construction.

> **Status.** The luna-stack bundle is the Phase-2 deliverable of
> `docs/design-luna-stack-bundle.md` (a validated prototype exists; the public
> repo is being finalized). Until it's published, Steps 1–5 above already give
> you a working chat Luna, and the bundle below is the one-command wrapper that
> automates them plus the coding grant. Its published siblings you can install
> and read *today* as reference shapes are cited at the end of this step.

### What the bundle does

Once published, one command stands up the whole MVP:

```bash
# set the bundle's env (it maps LUNA_* → the CTX_* contract internally),
# then install — the preinstall gate refuses cleanly if the token is missing,
# writing nothing:
export LUNA_BOT_TOKEN=<your-bot-token>     # same token from Step 2a
export LUNA_SLUG=luna                       # your stack slug
export LUNA_PRINCIPAL=<your-handle>
export LUNA_GUILD_ID=<your-guild-id>
export LUNA_CHANNEL_ID=<your-channel-id>
export LUNA_MY_DISCORD_ID=<your-user-id>
export LUNA_REPO=<owner/repo>               # the ONE repo Luna may read+write

arc install https://github.com/the-metafactory/metafactory-cortex-agent-luna-stack
```

Under the hood the bundle:

- **Gates first (preinstall).** Hard-fails — writing nothing — if `cortex` is
  missing/too old, if `git` or `gh` aren't on `PATH`, or if `LUNA_BOT_TOKEN` is
  unset (it prints the exact Step 2 click-path). Softer warnings for an
  unauthenticated `gh auth status` or a systemd-less WSL2.
- **Drives `cortex quickstart` (postinstall).** The same verified spine from
  Step 4 — scaffold → bind Discord → seed → boot → gate — with a
  `cortex start --config <pointer>` backstop so macOS and WSL2 reach a running
  daemon too.
- **Grants the software-factory delta**, each an explicit, least-privilege
  widening over the chat floor:

  | Grant | Chat floor | luna-stack MVP |
  |---|---|---|
  | shell | off | `bash` allowed |
  | filesystem | read-only config | read+write **one** repo (`LUNA_REPO`) — *not* your whole dev tree |
  | network | none | `github.com` + `api.github.com` (git/gh over HTTPS) |
  | tools | none | `gh` + `git` on `PATH` |
  | agent tools | `Read`-class | `Read, Edit, Write, Bash, Grep, Glob` |

`gh` holds its own auth — **no secret is baked into the bundle**. The honest
boundary: the bundle grants the *ability* to reach GitHub; your `gh auth login`
authorizes it. Luna confirms before she pushes or opens a PR, and her write
scope is that single named repo — widen it only by a reviewed allowlist edit,
never by default.

### Verify she can code

Ask her in the Discord channel to do a real task in `LUNA_REPO` — e.g.
*"clone `<owner/repo>`, create a branch, run the tests, and show me the diff"*.
An MVP software-factory Luna clones, branches, runs tests, and prepares a PR
(pausing for your confirm before the push) — not just chats.

### Reference bundles you can install and read today

The luna-stack bundle follows a published family of agent-bundle blueprints —
all public, MIT/least-privilege, `arc install`-able, and worth reading as
clone-me templates (see `docs/bundle-blueprints.md`):

- **`metafactory-cortex-agent-luna-lite`** — the assistant *floor*: a plain chat
  Luna, zero tools. The simplest possible agent bundle and the front door.
  <https://github.com/the-metafactory/metafactory-cortex-agent-luna-lite>
- **`metafactory-cortex-agent-escort`** — the canonical concierge sample: a
  surface-bound, stateful onboarding agent. Shows the *guide-don't-grant*
  boundary a bundle-shipped agent uses.
  <https://github.com/the-metafactory/metafactory-cortex-agent-escort>

`arc install` either one from its URL and read its `arc-manifest.yaml` +
`personas/` + `agents.d/` — luna-stack is the same shape with the
software-factory capability delta added.

---

## 7. Troubleshooting

The known edges, front-loaded so you recognize them before they bite.

### F2 — macOS: a fresh host reaches a running daemon automatically (cortex#2322)

`cortex quickstart`'s Step 7 on macOS has two paths, split on whether arc has
already **loaded** the launchd stack service (load/unload stays arc-owned):

- **arc-loaded service** → Step 7 restarts it (`launchctl kickstart -k`) so the
  daemon picks up the configs Step 5 patched.
- **fresh Mac (not loaded)** → Step 7 now **starts the daemon directly** via a
  detached `cortex start --config <pointer>` backstop, so the healthy-boot gate
  (Step 8) reaches a **running** daemon. No manual pre-load step is required.
  A re-run is idempotent: if that backstop daemon is already running, Step 7
  skips cleanly (no double-start).

Symptom you should NO LONGER see: quickstart's gate can't find a running daemon
on a fresh Mac. If you do (e.g. the `cortex` binary isn't on `PATH` at
`~/.local/bin/cortex`), Step 7 fails with the reason — start the daemon by hand
(idempotent):

```bash
cortex start --config ~/.config/metafactory/cortex/<slug>/<slug>.yaml
```

`arc upgrade cortex` (which loads the launchd plist, converting the deployment
to the arc-loaded path above) is the alternative. Then re-check with
`cortex status --config <pointer>`.

> **Backstop config re-apply.** The fresh-Mac backstop does not restart an
> already-running backstop daemon to pick up a *later* config edit (only the
> arc-loaded launchd path does). To apply a config change on the backstop
> daemon, `cortex stop && cortex start --config <pointer>` (see "Stopping /
> restarting the stack" below).

### Missing / wrong token: the gate stops cleanly

`CTX_DISCORD_TOKEN` **gates** the run. If it's unset or invalid, quickstart stops
at env validation (Step 2) or the healthy-boot gate (Step 8) — it never prints
the token's value, only `set`/`missing`. Fix the value in `cortex.env`, re-source
it, and **re-run `cortex quickstart`** — every step is idempotent, so a re-run
after fixing one variable clobbers nothing already wired up. (For the bundle in
Step 6, a missing `LUNA_BOT_TOKEN` fails the *preinstall* gate, writing nothing —
so you never get a half-built stack.)

### Bus won't connect: the gate fails fast

If the daemon can't reach NATS, Step 8's gate surfaces the real bus-connect error
(read from the daemon's `.error.log`) and fails immediately instead of waiting
out the timeout. Check that `nats-server` is running on `CTX_NATS_PORT`, that no
other process holds that port, then re-run quickstart.

### F5 — WSL2: systemd may be off (fast-follow, not a release gate)

`cortex quickstart`'s Linux service step assumes systemd user units, but WSL2
only runs systemd when the distro opts in. Enable it once, then restart WSL:

```ini
# /etc/wsl.conf
[boot]
systemd=true
```

```powershell
# from Windows PowerShell:
wsl --shutdown
```

On a systemd-less WSL2, fall back to the same daemon backstop used on macOS:

```bash
cortex start --config ~/.config/metafactory/cortex/<slug>/<slug>.yaml
```

Full three-OS parity (macOS + Debian gating this release; WSL2 fast-follow) is
tracked in epic #2319.

### Reloading the agent after a config edit

If you hand-edit Luna's fragment or persona, revalidate and reload without a full
restart:

```bash
cortex agents list                   # show discovered agents
cortex agents reload                 # validate agents.d/ fragments + reload the runtime
```

### Stopping / restarting the stack

```bash
cortex stop   --config ~/.config/metafactory/cortex/<slug>/<slug>.yaml
cortex start  --config ~/.config/metafactory/cortex/<slug>/<slug>.yaml
```

> **Always pass `--config <pointer>`.** The bare `cortex start` default points at
> the legacy single-file config path, not your new config-split stack. Point it
> at your pointer file — `~/.config/metafactory/cortex/<slug>/<slug>.yaml` — every
> time.

---

## What you have now

- A **local, solo** cortex stack (`stack.id = <principal>/<slug>`), no federation.
- `@luna` **responding in Discord** on the channel you bound.
- With the luna-stack bundle: a **software-factory Luna** — Claude Code + `bash`
  + `gh`/`git`, scoped to one repo you named, confirming before push/PR.

### Where to go next

- **Federate** onto a network of other principals' stacks →
  `docs/sop-network-join.md` (opt-in; not needed for a solo Luna).
- **Give Luna real memory + identity** via a soma projection (persona, purpose,
  skills) instead of the scaffold stub → the "better Luna" upgrade in
  `docs/design-bootstrap-luna.md` §3.
- **Read the blueprints** to build your own agents →
  `docs/bundle-blueprints.md`.
