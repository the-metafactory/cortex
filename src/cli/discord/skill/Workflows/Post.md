# Post to Discord

Post a message to a Discord channel.

## Steps

1. **Determine the message** — extract or compose the message content from the user's request.

2. **Determine the channel** — if the user specifies a channel name, use `--channel <name>`. Otherwise the default channel is used.

3. **Post the message:**
   ```bash
   discord post "Your message here"
   # Or with a specific channel:
   discord post --channel <name> "Your message here"
   # Or into a thread:
   discord post --thread <id> "Your message here"
   # Attach one or more files (repeatable; message becomes optional):
   discord post --channel <name> --file ./report.pdf "Monthly report"
   discord post --file ./a.md --file ./a.envelope.json
   ```

4. **Confirm** — report success or failure to the user.

## Posting to another guild (multi-server)

The same bot can post to any guild it has joined (e.g. grove + halden). Pick the
guild for channel/thread name resolution with one of:

```bash
# Saved profile (preferred — register once with `discord config set-server`):
discord post --server halden "Deployed v0.6.0 to halden"

# One-off by guild ID:
discord post --guild 1512054429023731884 --channel general "Deployed halden"
```

Precedence: `--guild`/`--channel` beat a `--server` profile, which beats the
top-level config. With no `--server`/`--guild`, posting is exactly as before.

## Notes

- For multi-line messages, use quotes and `\n` or write to a temp file first.
- `--file <path>` attaches a local file (repeatable). The message is optional when at least one file is given. Each path is existence-checked before anything is posted, so a bad path fails cleanly with nothing sent.
- If posting fails with "Bot token required", run `discord config show` and guide setup.
- Channel names are resolved automatically on first use and cached per guild. Raw channel IDs are accepted only after the bot sees that ID in the selected guild channel list.
- `--guild` and `--server` must not disagree on the guild — the CLI errors if they do.
