---
name: Discord
description: >-
  Post messages, read channels, and manage threads on Discord from the terminal.
  USE WHEN discord, post to discord, send message, notify channel, read discord,
  check discord, update discord, discord thread, discord channel, announce.
---

# Discord Skill

Discord CLI for posting updates and reading channels — like `gh` for GitHub.

> *"From PAI to Discord. Discord to PAI is done through Grove."*

## CLI Tool

Discord uses a CLI at `~/bin/discord`. **All commands are bash commands:**

```bash
discord post "Your message here"           # Post to default channel
discord post --channel tasks "PR merged"   # Post to specific channel
discord read                               # Read last 10 messages
discord channels                           # List server channels
discord threads                            # List active threads
```

Run `discord --help` for full command list.

### Multi-server (posting to a guild other than grove)

The bot can be in several guilds with the same token. Target another guild
either by a one-off `--guild <id>` (overrides the guild used for channel/thread
name resolution) or by a saved `--server <name>` profile:

```bash
# One-off: resolve the channel name in the halden guild
discord post --guild 1512054429023731884 --channel general "Deployed halden"

# Saved profile (register once, then reference by name):
discord config set-server halden 1512054429023731884 general
discord post --server halden "Deployed halden"
discord read  --server halden
```

Precedence: explicit `--guild`/`--channel` flags  >  `--server` profile  >
top-level config. With neither flag, behaviour is identical to single-guild.
A cached `channels.<name>.id` posts by id directly and is guild-agnostic; the
`--guild`/`--server` override only changes how a channel *name* is resolved.

---

## Workflow Routing

**When executing operations:**
-> **READ:** The workflow file first
-> **EXECUTE:** Follow the workflow steps

| Action | Workflow | Trigger Examples |
|--------|----------|------------------|
| **Post** | [Post](Workflows/Post.md) | "post to discord", "send message to discord", "notify channel", "announce" |
| **Read** | [Read](Workflows/Read.md) | "read discord", "check discord messages", "what's happening on discord" |

---

## Setup

If `discord config show` returns empty, guide the user:

1. `discord config set botToken <token>`
2. `discord config set guildId <id>`
3. `discord config set defaultChannel <name>`

For a second guild the bot has joined (e.g. halden), register a profile:

4. `discord config set-server halden <guildId> [defaultChannel]`

Or hand-edit the `servers:` block in the config file:

```yaml
servers:
  halden:
    guildId: "1512054429023731884"
    defaultChannel: general   # optional; falls back to top-level
    # botToken / channels optional — omitted fields fall back to top-level
```

Config stored at `~/.config/grove/cli.yaml`.

## Attachments

`discord post --file <path>` attaches a local file (repeatable); the message text is optional when a file is present. Files are read + existence-checked before the post, so a bad path posts nothing.
