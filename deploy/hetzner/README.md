# First off-Mac cortex host on Hetzner (headless)

Phase 1 of `docs/design-sovereign-agent-stack.md` (§8.1): one **new** stack on a Hetzner Cloud server in the EU, running the existing compose path (`deploy/compose/`). Your Mac stack keeps running; the new one gets its own Discord bot account and identity.

Everything runs from your Mac terminal: no Hetzner console and no interactive login on the server. Only the three one-time steps marked **(human)** need a browser.

## One-time setup

1. **(human) Hetzner account + project.** Create an API token (Security → API tokens, read & write). Then:
   ```bash
   brew install hcloud
   hcloud context create cortex-eu      # paste the token when prompted
   ```
2. **(human) Discord bot.** Developer Portal → New Application → Bot → enable **Message Content intent** → Reset Token. Invite it to your server, and create a test channel plus a log channel. A bot token can only be connected from one place at a time, so **don't reuse the Mac bot's token**.
3. **(human) Claude token**, on a Mac already logged into Claude Code:
   ```bash
   claude setup-token
   ```
4. **Fill the env file, outside any git repo:**
   ```bash
   mkdir -p ~/.config/metafactory/cortex/hosts
   cp deploy/compose/.env.example ~/.config/metafactory/cortex/hosts/cortex-eu-1.env
   chmod 600 ~/.config/metafactory/cortex/hosts/cortex-eu-1.env
   # edit: CTX_PRINCIPAL, CTX_SLUG (a NEW slug), the four Discord IDs,
   #       CTX_DISCORD_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
   ```

## Provision (headless)

```bash
cd deploy/hetzner
./provision.sh            # dry run: shows server, firewall, key
./provision.sh --apply    # creates cax21 in fsn1 (~€11/month)
```

What it creates:
- an SSH key entry;
- a firewall that allows **only tcp/22 from your current IP** and drops everything else inbound;
- an Ubuntu 24.04 server whose cloud-init:
  - creates user `ops` (key-only login, root and password logins disabled);
  - installs Docker and turns on unattended security upgrades;
  - clones cortex at the pinned tag into `/opt/cortex`.

**cloud-init carries no secrets**, because user-data is readable from the host's metadata service.

## Start

```bash
HOST=<ip> ENV_FILE=~/.config/metafactory/cortex/hosts/cortex-eu-1.env ./push-env-and-start.sh
```

This streams the `.env` over SSH into a 0600 file, builds the image on the server (ARM64), and runs `docker compose up -d`.

## Verify (the §8.1 exit criteria)

```bash
ssh ops@<ip> 'cd /opt/cortex/deploy/compose && docker compose ps'          # cortex: healthy
ssh ops@<ip> 'cd /opt/cortex/deploy/compose && docker compose logs cortex | grep -E "Stack:|connected"'
```

- `@mention` the new bot in the test channel. It replies, including with your Mac switched off.
- `ssh ops@<ip> sudo reboot`. The stack comes back unattended (`restart: unless-stopped`).

## Day-2

| Task | Command |
|---|---|
| Upgrade cortex | `ssh ops@<ip> 'cd /opt/cortex && git fetch --depth 1 origin tag vX.Y.Z && git checkout vX.Y.Z'`, then re-run `push-env-and-start.sh` with `CORTEX_REF=vX.Y.Z` |
| Rotate the Claude token | `claude setup-token`, update the env file, re-run `push-env-and-start.sh` |
| Your IP changed | `./provision.sh --apply` (re-applies the firewall rules with the new IP; the server is left alone) |
| Tear down | `hcloud server delete cortex-eu-1 && hcloud firewall delete cortex-eu-1-fw` (destroys the stack identity) |

## Known limits (Phase 1)

- No federation with the Mac stack. The bus is standalone (Q5 deferred).
- No Mission Control exposure yet. Cloudflare Tunnel + Access comes next; no ports will be opened.
- Created by script, not yet by an OpenTofu module. A Hetzner `vm-*` module below the crucible seam comes later.
- No business credentials on this host until Phases 2 and 2b.
- Claude OAuth token lifetime in a long-running headless container is an open observation (see `deploy/compose/README.md`).
