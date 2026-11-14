# First off-Mac cortex host on Hetzner (headless)

Phase 1 of `docs/design-sovereign-agent-stack.md` (§8.1): one **new** stack on a Hetzner Cloud server in the EU, running the existing compose path (`deploy/compose/`). Your Mac stack keeps running; the new one gets its own Discord bot account and identity.

Everything runs from your Mac terminal: no Hetzner console and no interactive login on the server. Only the one-time steps marked **(human)** need a browser.

**Network posture: no public inbound at all.** The Hetzner firewall has zero inbound rules. The server joins your **tailnet** (outbound-only, NAT traversal), and SSH is reachable only over it. ufw on the host is a second layer that allows tcp/22 only on `tailscale0`. So there are two independent gates: tailnet identity (device + ACL), then your SSH key.

## One-time setup

1. **(human) Hetzner account + project.** Create an API token (Security → API tokens, read & write). Then:
   ```bash
   brew install hcloud
   hcloud context create cortex-eu      # paste the token when prompted
   ```
2. **(human) Tailscale.**
   - **Tailnet policy (Access controls).** Make sure the default "allow all" rule is gone. Then add:
     ```jsonc
     "tagOwners": { "tag:cortex-host": ["autogroup:admin"] },
     "grants": [
       // you → the host, SSH only
       { "src": ["autogroup:admin"], "dst": ["tag:cortex-host"], "ip": ["tcp:22"] }
       // NOTHING from tag:cortex-host → anything: a compromised host can't reach your Mac
     ]
     ```
   - **Auth key.** Admin console → Settings → Keys → *Generate auth key*. Set it **not reusable**, **pre-approved**, tags `tag:cortex-host`, **expiry 1 hour**. Generate it just before `provision.sh --apply`. It is single-use because it ends up in cloud-init user-data.
   - **SSH from your Mac.** With Tailscale running, `ssh ops@cortex-eu-1` resolves through MagicDNS.
3. **(human) Discord bot.** Developer Portal → New Application → Bot → enable **Message Content intent** → Reset Token. Invite it to your server, and create a test channel plus a log channel. A bot token can only be connected from one place at a time, so **don't reuse the Mac bot's token**.
4. **(human) Claude token**, on a Mac already logged into Claude Code:
   ```bash
   claude setup-token
   ```
5. **Fill the env file, outside any git repo:**
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
TS_AUTHKEY=tskey-auth-... ./provision.sh --apply    # creates cax21 in fsn1 (~€11/month)
```

What it creates:
- an SSH key entry;
- a firewall with **no inbound rules**, so Hetzner drops every inbound packet;
- an Ubuntu 24.04 server whose cloud-init:
  - joins your tailnet as `cortex-eu-1` with `tag:cortex-host`;
  - turns on ufw: deny all incoming, except tcp/22 on `tailscale0`;
  - creates user `ops` (key-only login, root and password logins disabled);
  - installs Docker and turns on unattended security upgrades;
  - clones cortex at the pinned tag into `/opt/cortex`.

**cloud-init carries no cortex secrets**, because user-data is readable from the host's metadata service. The one exception is the Tailscale key, which is single-use and expires within the hour.

## Start

```bash
HOST=cortex-eu-1 ENV_FILE=~/.config/metafactory/cortex/hosts/cortex-eu-1.env ./push-env-and-start.sh
```

This streams the `.env` over SSH into a 0600 file, builds the image on the server (ARM64), and runs `docker compose up -d`.

## Verify (the §8.1 exit criteria)

```bash
ssh ops@cortex-eu-1 'cd /opt/cortex/deploy/compose && docker compose ps'          # cortex: healthy
ssh ops@cortex-eu-1 'cd /opt/cortex/deploy/compose && docker compose logs cortex | grep -E "Stack:|connected"'
```

- `@mention` the new bot in the test channel. It replies, including with your Mac switched off.
- `ssh ops@cortex-eu-1 sudo reboot`. The stack comes back unattended (`restart: unless-stopped`).

## Day-2

| Task | Command |
|---|---|
| Upgrade cortex | `ssh ops@cortex-eu-1 'cd /opt/cortex && git fetch --depth 1 origin tag vX.Y.Z && git checkout vX.Y.Z'`, then re-run `push-env-and-start.sh` with `CORTEX_REF=vX.Y.Z` |
| Rotate the Claude token | `claude setup-token`, update the env file, re-run `push-env-and-start.sh` |
| Break-glass (tailnet down) | There's no public SSH path by design. Use the Hetzner rescue system: `hcloud server enable-rescue cortex-eu-1 --ssh-key cortex-eu-1-key && hcloud server reboot cortex-eu-1`. Temporarily add an inbound tcp/22 rule for your IP, `ssh root@<public-ip>`, mount the disk, fix it, then remove the rule. |
| Tear down | `hcloud server delete cortex-eu-1 && hcloud firewall delete cortex-eu-1-fw`, then remove the machine in the Tailscale admin console (this destroys the stack identity) |

## Known limits (Phase 1)

- No federation with the Mac stack. The bus is standalone (Q5 deferred).
- No Mission Control exposure yet. Cloudflare Tunnel + Access comes next; no ports will be opened.
- Created by script, not yet by an OpenTofu module. A Hetzner `vm-*` module below the crucible seam comes later.
- No business credentials on this host until Phases 2 and 2b.
- Tailscale is a hosted control plane. Provider-independent fallback: Headscale (self-hosted, same client) or plain WireGuard. A Tailscale outage means access goes through the Hetzner rescue system; the stack itself keeps running.
- Claude OAuth token lifetime in a long-running headless container is an open observation (see `deploy/compose/README.md`).
