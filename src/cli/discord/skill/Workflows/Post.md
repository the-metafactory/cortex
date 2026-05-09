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
   ```

4. **Confirm** — report success or failure to the user.

## Notes

- For multi-line messages, use quotes and `\n` or write to a temp file first.
- If posting fails with "Bot token required", run `discord config show` and guide setup.
- Channel names are resolved automatically on first use and cached.
