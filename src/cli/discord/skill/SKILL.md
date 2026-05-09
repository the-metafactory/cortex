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

Config stored at `~/.config/grove/cli.yaml`.
