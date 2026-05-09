# Read Discord Messages

Read recent messages from a Discord channel.

## Steps

1. **Determine the channel** — if the user specifies a channel, use `--channel <name>`. Otherwise the default channel is used.

2. **Determine the count** — default is 10. If the user asks for more or fewer, use `--limit <n>`.

3. **Read messages:**
   ```bash
   discord read
   # Or with options:
   discord read --channel <name> --limit <n>
   ```

4. **Present** — format or summarize the output as the user needs.

## Notes

- Messages are shown in chronological order (oldest first).
- Format: `[HH:MM] Author: Content`
- To list available channels: `discord channels`
- To list active threads: `discord threads`
